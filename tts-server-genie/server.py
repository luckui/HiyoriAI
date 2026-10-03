"""
Genie-TTS Adapter Server

将 genie_tts 推理引擎包装为标准 /tts/generate API，与
tts-server（edge-tts）和 tts-server-nano 保持完全相同的接口规范。

API:
  POST /tts/generate  { text, speaker, language } → audio/wav 流
  GET  /speakers      → 可用音色列表
  GET  /health        → 健康检查

speaker 字段即角色名（如 "feibi"）。
language 字段目前只用于日志：genie-tts 2.0.x 按角色模型自己的语言合成。

长文本在这里切句、逐句合成后拼接（规则同 shared/spokenText.ts）；读不了的句子跳过，
整段都读不了返回 422。genie-tts 2.0.2 解码器的问题在下方「T2S 解码修正」里处理。
"""
import io
import asyncio
import json
import logging
import os
import re
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

# ── 路径解析 ─────────────────────────────────────────────────────────

THIS_DIR = Path(__file__).parent.resolve()

# GENIE_DATA_DIR 必须在任何 genie_tts import 之前设置
# Resources.py 在模块加载时读取此环境变量
os.environ.setdefault("GENIE_DATA_DIR", str(THIS_DIR / "GenieData"))

# ── 延迟导入 genie_tts（环境变量就位后）──────────────────────────────
import numpy as np  # noqa: E402
import genie_tts as genie  # noqa: E402
from genie_tts.Core import Inference as _genie_inference  # noqa: E402

# ── Logging ──────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("genie-tts-server")

# ── Config ───────────────────────────────────────────────────────────

CONFIG_PATH = THIS_DIR / "config.yaml"
CHAR_MODELS_DIR = THIS_DIR / "CharacterModels"

# genie-tts 2.0.x 加载角色时必须指定模型语言（Chinese / Japanese / English），不支持 "auto"。
# 可在 config.yaml 的 genie.character_language 中修改。
DEFAULT_CHARACTER_LANGUAGE = "Chinese"


# genie-tts 2.0.2 的中文 G2P 对一些语气词处理不了，合成前换成读音接近的字
# （已逐字验证替换后转出的音素正确）：
# - 没有韵母的字（嗯 ń / 呣 ḿ / 噷 hm）会在变调处理里 IndexError，整句静默产出空音频；
# - 词典里没有的音节（诶 ēi、喽 lou）会退化成 pan5，「诶？」被读成「谭」「台」。
_G2P_UNSAFE_CHARS = str.maketrans({"嗯": "恩", "呣": "姆", "噷": "哼", "诶": "欸", "喽": "楼"})


# ── genie-tts 2.0.2 的 T2S 解码修正 ──────────────────────────────────
#
# 库里的解码循环有两个问题，都实测复现过（逐句统计生成长度 + 语音识别核对）：
#
# 1. 返回 y[:, -idx:]，本意是「最后 idx 个生成的 token」，但 y 的前半段是参考音频的
#    语义 token。模型第一步就输出结束符时 idx == 0，y[:, -0:] 就是整个序列 ——
#    声码器把参考音频原样念出来（「……」「ありがとう。」之类读不出音素的句子必现，
#    其他短句因为采样随机，偶尔出现）。
# 2. 没有长度保护：模型一直不出结束符就生成满 500 步，是十几秒的乱码；
#    反过来，采样偶尔过早出结束符，一整句只剩零点几秒的一个怪音。
#
# 这里换成一个只取生成部分的版本（与 GPT-SoVITS 原版一致：丢掉第一个生成 token，
# 结束符位置置 0），并把「几乎没生成」和「失控」当作失败。库会吞掉推理里的异常、
# 表现为一个音频块都没有，失败原因记在 _last_failure 里供接口报告。

class _SynthesisFailure(Exception):
    pass


_last_failure: Optional[str] = None
#: 生成 token 少于这个数视为没合成出东西（不能把参考音频当结果）
_MIN_GENERATED_TOKENS = 3
#: 每个音素的 token 数：实测正常在 1.9–6 之间（含停顿）。低于下限是被截断，高于上限是失控
_MIN_TOKENS_PER_PHONE = 1.2
_MAX_TOKENS_PER_PHONE = 9
_MAX_STEPS = 500


def _t2s_guarded(self, ref_seq, ref_bert, text_seq, text_bert, ssl_content,
                 encoder, first_stage_decoder, stage_decoder):
    global _last_failure
    x, prompts = encoder.run(None, {
        "ref_seq": ref_seq, "text_seq": text_seq, "ref_bert": ref_bert,
        "text_bert": text_bert, "ssl_content": ssl_content,
    })
    y, y_emb, *present_key_values = first_stage_decoder.run(None, {"x": x, "prompts": prompts})
    prompt_len = prompts.shape[1]
    limit = min(_MAX_STEPS, 40 + _MAX_TOKENS_PER_PHONE * int(text_seq.shape[-1]))
    input_names = [inp.name for inp in stage_decoder.get_inputs()]
    for _ in range(limit):
        if self.stop_event.is_set():
            return None
        outputs = stage_decoder.run(None, dict(zip(input_names, [y, y_emb, *present_key_values])))
        y, y_emb, stop, *present_key_values = outputs
        if stop:
            break
    else:
        _last_failure = "runaway"
        raise _SynthesisFailure(f"解码 {limit} 步仍未结束（音素 {int(text_seq.shape[-1])} 个），判为乱码")
    generated = y[:, prompt_len + 1:].copy()  # 丢掉第一个生成 token，与原版 GPT-SoVITS 一致
    phones = int(text_seq.shape[-1])
    if generated.shape[1] - 1 < max(_MIN_GENERATED_TOKENS, _MIN_TOKENS_PER_PHONE * phones):  # 最后一个是结束符
        _last_failure = "empty"
        raise _SynthesisFailure(f"模型过早结束：{phones} 个音素只生成了 {generated.shape[1] - 1} 个 token")
    generated[0, -1] = 0
    return np.expand_dims(generated, axis=0)


_genie_inference.GENIE.t2s_cpu = _t2s_guarded

# 中文音色读不了纯外文（英文、假名）或纯标点：音素几乎为空，结果只会是杂音
_READABLE_BY_CHINESE_VOICE = re.compile(r"[\u4e00-\u9fff0-9]")


def _readable(text: str, character_language: str) -> bool:
    if character_language.lower().startswith("chinese"):
        return bool(_READABLE_BY_CHINESE_VOICE.search(text))
    return bool(re.search(r"\w", text))


# ── 切句 ─────────────────────────────────────────────────────────────
#
# 一次合成一句最稳：太长注意力会散，也可能超出单次生成的长度上限；太短（「诶？」）常读错音。
# 应用里的播放器已经按 shared/spokenText.ts 切好句子再来请求，这里对它们基本是原样通过；
# 主要照顾一次发整段话的调用方（比如微信语音按整段合成）。规则与 spokenText.ts 保持一致。

_SENTENCE_END = set("。！？!?；;")
_TRAILING = set("」』”’\"）)】]…～~！？!?。")
_CLAUSE_BREAK = set("，,、：:")
_MIN_SPEAKABLE_CHARS = 5
_LONG_SENTENCE_CHARS = 60
_TARGET_CLAUSE_CHARS = 40
_HARD_MAX_CHARS = 80
#: 句与句之间插入的停顿
_SENTENCE_GAP_SECONDS = 0.15


def _speakable_length(text: str) -> int:
    return sum(1 for ch in text if ch.isalnum())


def _is_sentence_period(text: str, i: int) -> bool:
    prev = text[i - 1] if i > 0 else ""
    nxt = text[i + 1] if i + 1 < len(text) else ""
    if prev.isdigit() and nxt.isdigit():  # 3.14
        return False
    if nxt.isascii() and (nxt.isalnum() or nxt == "."):  # example.com、v2.0、省略号中间
        return False
    return True


def _split_sentences(text: str) -> list[str]:
    sentences, current, i = [], "", 0
    while i < len(text):
        ch = text[i]
        current += ch
        if ch in _SENTENCE_END or (ch == "." and _is_sentence_period(text, i)):
            while i + 1 < len(text) and text[i + 1] in _TRAILING:
                i += 1
                current += text[i]
            sentences.append(current.strip())
            current = ""
        i += 1
    if current.strip():
        sentences.append(current.strip())
    return [s for s in sentences if _speakable_length(s) > 0]


def _split_long(sentence: str) -> list[str]:
    if _speakable_length(sentence) <= _LONG_SENTENCE_CHARS:
        return [sentence]
    clauses, current = [], ""
    for ch in sentence:
        current += ch
        if ch in _CLAUSE_BREAK:
            clauses.append(current)
            current = ""
    if current:
        clauses.append(current)
    pieces, piece = [], ""
    for clause in clauses:
        if piece and _speakable_length(piece) + _speakable_length(clause) > _TARGET_CLAUSE_CHARS:
            pieces.append(piece)
            piece = ""
        piece += clause
    if piece:
        pieces.append(piece)
    out = []
    for p in pieces:
        out.extend(p[i:i + _HARD_MAX_CHARS] for i in range(0, len(p), _HARD_MAX_CHARS))
    return [p.strip() for p in out if p.strip()]


def split_for_synthesis(text: str) -> list[str]:
    pieces = [p for s in _split_sentences(text) for p in _split_long(s)]
    merged, pending = [], ""
    for piece in pieces:
        pending += piece
        if _speakable_length(pending) >= _MIN_SPEAKABLE_CHARS:
            merged.append(pending)
            pending = ""
    if pending:
        if merged:
            merged[-1] += pending
        else:
            merged.append(pending)
    return merged


def load_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


# ── 角色注册表 ────────────────────────────────────────────────────────

class CharacterEntry:
    def __init__(self, name: str, model_dir: Path, prompt_wav: str,
                 prompt_text: str, ref_language: str):
        self.name = name
        self.model_dir = model_dir
        self.prompt_wav = prompt_wav
        self.prompt_text = prompt_text
        self.ref_language = ref_language


_characters: dict[str, CharacterEntry] = {}
# 加载失败的角色及原因（通过 /health 与合成接口的报错暴露，避免"服务在线但一个角色都没有"时无从排查）
_load_errors: dict[str, str] = {}


def _load_character(char_name: str, version: str = "v2ProPlus") -> Optional[CharacterEntry]:
    """从本地 CharacterModels 目录加载一个角色。"""
    char_dir = CHAR_MODELS_DIR / version / char_name
    tts_model_dir = char_dir / "tts_models"
    prompt_wav_json = char_dir / "prompt_wav.json"
    prompt_wav_dir = char_dir / "prompt_wav"

    if not tts_model_dir.exists():
        log.error("角色模型目录不存在: %s", tts_model_dir)
        _load_errors[char_name] = f"角色模型目录不存在: {tts_model_dir}"
        return None
    if not prompt_wav_json.exists():
        log.error("prompt_wav.json 不存在: %s", prompt_wav_json)
        _load_errors[char_name] = f"prompt_wav.json 不存在: {prompt_wav_json}"
        return None

    with open(prompt_wav_json, encoding="utf-8") as f:
        presets: dict = json.load(f)

    # 取第一个预设
    cfg = load_config().get("genie", {})
    preset_key = cfg.get("default_preset", "Normal")
    if preset_key not in presets:
        preset_key = next(iter(presets))
    preset = presets[preset_key]

    prompt_wav_path = str(prompt_wav_dir / preset["wav"])
    prompt_text = preset["text"]

    # 模型语言与参考音频语言一致（内置 feibi 及导入的 GPT-SoVITS 音色均为中文）
    language = cfg.get("character_language", DEFAULT_CHARACTER_LANGUAGE)

    try:
        genie.load_character(
            character_name=char_name,
            onnx_model_dir=str(tts_model_dir),
            language=language,
        )
        genie.set_reference_audio(
            character_name=char_name,
            audio_path=prompt_wav_path,
            audio_text=prompt_text,
            language=language,
        )
        log.info("角色 '%s' 加载完毕（预设: %s，语言: %s）", char_name, preset_key, language)
    except Exception as e:
        log.error("加载角色 '%s' 失败: %s", char_name, e, exc_info=True)
        _load_errors[char_name] = f"{type(e).__name__}: {e}"
        return None

    _load_errors.pop(char_name, None)
    return CharacterEntry(
        name=char_name,
        model_dir=tts_model_dir,
        prompt_wav=prompt_wav_path,
        prompt_text=prompt_text,
        ref_language=language,
    )


def _discover_characters(version: str = "v2ProPlus") -> list[str]:
    """扫描 CharacterModels/version/ 下已下载的角色目录。"""
    base = CHAR_MODELS_DIR / version
    if not base.exists():
        return []
    return [
        d.name for d in base.iterdir()
        if d.is_dir() and (d / "tts_models").exists()
    ]


# ── WAV 工具 ─────────────────────────────────────────────────────────

SAMPLE_RATE = 32000  # genie_tts TTSPlayer 固定 32kHz
CHANNELS = 1
BYTES_PER_SAMPLE = 2  # int16


def pcm_chunks_to_wav(chunks: list[bytes]) -> bytes:
    """将 int16 PCM 字节块列表打包为 WAV bytes。"""
    buf = io.BytesIO()
    pcm_data = b"".join(chunks)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(BYTES_PER_SAMPLE)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def chunk_duration_ms(chunk: bytes) -> int:
    return int(len(chunk) / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1000)


# ── App ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = load_config().get("genie", {})
    default_char = cfg.get("default_character", "feibi")

    # 加载所有已下载的角色（默认角色优先）
    chars_to_load = _discover_characters()
    if default_char not in chars_to_load:
        chars_to_load.insert(0, default_char)
    else:
        chars_to_load.remove(default_char)
        chars_to_load.insert(0, default_char)

    for char in chars_to_load:
        entry = _load_character(char)
        if entry:
            _characters[char] = entry

    if not _characters:
        log.warning("没有可用角色，请先运行 download_models.py")
    else:
        log.info("已加载角色: %s", list(_characters.keys()))

    log.info("Genie-TTS server started on port %s",
             load_config().get("server", {}).get("port", 9882))
    yield
    log.info("Genie-TTS server shutting down")


app = FastAPI(
    title="Genie-TTS Adapter Server",
    description="GPT-SoVITS ONNX 本地语音合成服务",
    version="1.0.0",
    lifespan=lifespan,
)

# 全局推理锁：确保同一时刻只有一个请求占用 CPU 进行推理。
# CPU 模型同时并发多请求时互相争抜，实际吸吓更慢；序列化可把总延迟降至最低。
_inference_lock = asyncio.Lock()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request Model ────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str
    speaker: str = ""
    language: str = "auto"


# ── Endpoints ────────────────────────────────────────────────────────

class _ClientGone(Exception):
    pass


async def _synthesize_sentence(char_name: str, text: str, request: Request) -> bytes:
    """合成一句。采样是随机的：过早结束、失控这两种失败重试一次往往就好了。失败抛 RuntimeError。"""
    global _last_failure
    for attempt in range(2):
        _last_failure = None
        pcm = b""
        async for chunk in genie.tts_async(character_name=char_name, text=text, play=False, split_sentence=False):
            # 每个 chunk 后检查客户端是否已断开（防止白白消耗 CPU）
            if await request.is_disconnected():
                raise _ClientGone()
            pcm += chunk
        # genie-tts 会吞掉推理中的异常，只表现为一个音频块都没有
        if pcm:
            return pcm
        if _last_failure is None:
            break
        log.warning("TTS 第 %d 次合成失败（%s），%s text=%s", attempt + 1, _last_failure,
                    "重试" if attempt == 0 else "放弃", text[:60])
    reason = {"empty": "模型过早结束", "runaway": "生成失控（乱码）"}.get(_last_failure or "", "genie-tts 内部报错，详见服务日志")
    raise RuntimeError(reason)


@app.post("/tts/generate")
async def tts_generate(request: Request, req: TTSRequest):
    """Synthesize text to audio. Returns audio/wav stream."""
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")
    if len(req.text) > 5000:
        raise HTTPException(status_code=400, detail="Text too long (max 5000 chars)")

    # 解析角色
    cfg = load_config().get("genie", {})
    char_name = req.speaker.strip() or cfg.get("default_character", "feibi")
    if char_name not in _characters:
        available = list(_characters.keys())
        reason = _load_errors.get(char_name)
        raise HTTPException(
            status_code=400,
            detail=f"未知角色 '{char_name}'，可用角色: {available}"
            + (f"（该角色加载失败：{reason}）" if reason else ""),
        )

    # genie-tts 按角色模型的语言合成；请求里的 language（auto / zh / en…）仅用于日志
    language = req.language.strip() or "auto"
    character_language = _characters[char_name].ref_language
    sentences = [s for s in split_for_synthesis(req.text.strip().translate(_G2P_UNSAFE_CHARS))
                 if _readable(s, character_language)]
    if not sentences:
        # 422：客户端按「这句不读」处理，跳过而不是播一段杂音
        raise HTTPException(status_code=422, detail=f"该音色读不了这段文本：{req.text[:40]}")

    log.info("TTS 排队: speaker=%s lang=%s sentences=%d text=%s", char_name, language, len(sentences), req.text[:60])

    # 获取序列化锁（CPU 推理不并发）
    pcm_parts: list[bytes] = []
    failures: list[str] = []
    async with _inference_lock:
        # 进锁后先确认客户端是否已断开
        if await request.is_disconnected():
            log.info("TTS 客户端在排队期间断开，跳过推理")
            return Response(status_code=204, content=b"")
        try:
            for sentence in sentences:
                try:
                    pcm_parts.append(await _synthesize_sentence(char_name, sentence, request))
                except RuntimeError as e:
                    # 一句失败就跳过这一句，整段里的其他句子照常
                    failures.append(str(e))
                    log.error("TTS 一句合成失败（%s），跳过 text=%s", e, sentence[:60])
        except _ClientGone:
            log.info("TTS 客户端断开，中止推理（已完成 %d 句）", len(pcm_parts))
            return Response(status_code=204, content=b"")
        except Exception as e:
            log.error("TTS synthesis failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))

    if not pcm_parts:
        raise HTTPException(status_code=500, detail=f"合成失败：{failures[0] if failures else '未知原因'}")

    gap = b"\x00\x00" * int(SAMPLE_RATE * _SENTENCE_GAP_SECONDS)
    wav_bytes = pcm_chunks_to_wav([part for i, pcm in enumerate(pcm_parts) for part in ((gap, pcm) if i else (pcm,))])
    log.info("TTS 完成: sentences=%d/%d pcm_duration_ms=%d wav_bytes=%d",
             len(pcm_parts), len(sentences), sum(chunk_duration_ms(p) for p in pcm_parts), len(wav_bytes))
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": 'inline; filename="tts.wav"'},
    )


@app.get("/speakers")
async def list_speakers():
    """List available characters/speakers."""
    speakers = [
        {
            "id": name,
            "name": name,
            "description": f"Genie-TTS 角色 · {name}",
        }
        for name in _characters
    ]
    return {"speakers": speakers, "engine": "genie-tts"}


@app.get("/health")
@app.get("/health/")
async def health():
    """Health check endpoint."""
    loaded = list(_characters.keys())
    return {
        "engine": "genie-tts",
        "status": "ok" if loaded else "no_characters",
        "characters": loaded,
        **({"errors": _load_errors} if _load_errors else {}),
    }


@app.get("/")
async def root():
    return {
        "service": "Genie-TTS Adapter Server",
        "engine": "genie-tts",
        "characters": list(_characters.keys()),
        "endpoints": ["/tts/generate", "/speakers", "/health"],
    }


# ── Main ─────────────────────────────────────────────────────────────

def main():
    import uvicorn
    cfg = load_config()
    server_cfg = cfg.get("server", {})
    host = server_cfg.get("host", "127.0.0.1")
    port = server_cfg.get("port", 9882)
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
