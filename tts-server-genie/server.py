"""
Genie-TTS Adapter Server

将 genie_tts 推理引擎包装为标准 /tts/generate API，与
tts-server（edge-tts）和 tts-server-nano 保持完全相同的接口规范。

API:
  POST /tts/generate  { text, speaker, language } → audio/wav 流
  GET  /speakers      → 可用音色列表
  GET  /health        → 健康检查

speaker 字段即角色名（如 "feibi"）。
language 字段传给 genie_tts text_language，支持 "auto"/"zh"/"en"/"ja"/"kr"。
"""
import io
import asyncio
import json
import logging
import os
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
import genie_tts as genie  # noqa: E402

# ── Logging ──────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("genie-tts-server")

# ── Config ───────────────────────────────────────────────────────────

CONFIG_PATH = THIS_DIR / "config.yaml"
CHAR_MODELS_DIR = THIS_DIR / "CharacterModels"


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


def _load_character(char_name: str, version: str = "v2ProPlus") -> Optional[CharacterEntry]:
    """从本地 CharacterModels 目录加载一个角色。"""
    char_dir = CHAR_MODELS_DIR / version / char_name
    tts_model_dir = char_dir / "tts_models"
    prompt_wav_json = char_dir / "prompt_wav.json"
    prompt_wav_dir = char_dir / "prompt_wav"

    if not tts_model_dir.exists():
        log.error("角色模型目录不存在: %s", tts_model_dir)
        return None
    if not prompt_wav_json.exists():
        log.error("prompt_wav.json 不存在: %s", prompt_wav_json)
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

    # 参考音频语言：根据文本内容粗判断（均为中文）
    ref_language = "Chinese"

    try:
        genie.load_character(
            character_name=char_name,
            onnx_model_dir=str(tts_model_dir),
            language="auto",
        )
        genie.set_reference_audio(
            character_name=char_name,
            audio_path=prompt_wav_path,
            audio_text=prompt_text,
            language="auto",
            ref_language=ref_language,
        )
        log.info("角色 '%s' 加载完毕（预设: %s）", char_name, preset_key)
    except Exception as e:
        log.error("加载角色 '%s' 失败: %s", char_name, e, exc_info=True)
        return None

    return CharacterEntry(
        name=char_name,
        model_dir=tts_model_dir,
        prompt_wav=prompt_wav_path,
        prompt_text=prompt_text,
        ref_language=ref_language,
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
        raise HTTPException(
            status_code=400,
            detail=f"未知角色 '{char_name}'，可用角色: {available}"
        )

    # 语言：前端传 "auto" / "zh" / "en" / "ja" / "ko"，全部接受
    language = req.language.strip() or "auto"

    log.info("TTS 排队: speaker=%s lang=%s text=%s", char_name, language, req.text[:60])

    # 获取序列化锁（CPU 推理不并发）
    async with _inference_lock:
        # 进锁后先确认客户端是否已断开
        if await request.is_disconnected():
            log.info("TTS 客户端在排队期间断开，跳过推理")
            return Response(status_code=204, content=b"")

        log.info("TTS 开始推理: speaker=%s lang=%s text=%s", char_name, language, req.text[:60])

        try:
            chunks: list[bytes] = []
            async for chunk in genie.tts_async(
                character_name=char_name,
                text=req.text.strip(),
                play=False,
                split_sentence=False,
                text_language=language,
            ):
                # 每个 chunk 后检查客户端是否已断开（防止白白消耗 CPU）
                if await request.is_disconnected():
                    log.info("TTS 客户端断开，中止推理（已生成 %d 块）", len(chunks))
                    return Response(status_code=204, content=b"")
                chunks.append(chunk)
                log.info(
                    "TTS chunk #%d: bytes=%d duration_ms=%d",
                    len(chunks),
                    len(chunk),
                    chunk_duration_ms(chunk),
                )

        except Exception as e:
            log.error("TTS synthesis failed: %s", e, exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))

    wav_bytes = pcm_chunks_to_wav(chunks)
    log.info(
        "TTS 完成: chunks=%d pcm_duration_ms=%d wav_bytes=%d",
        len(chunks),
        sum(chunk_duration_ms(chunk) for chunk in chunks),
        len(wav_bytes),
    )
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
