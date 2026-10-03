"""
Genie 文本前端：文本进 genie-tts 之前、以及它做 G2P（文字 → 音素）过程中的修正。

genie-tts 2.0.2 按角色语言只走一种发音规则，中文那一套还有不少读错的地方。这里把问题在源头修掉：

1. preprocess()：字符级清洗 —— 破折号变成停顿、会让 G2P 崩溃的字换成同音字、算式里的 + = 读出来。
2. 多语言混读（默认开启）：按分句判断中文还是日文（有假名就是日文），英文单词交给英文 G2P，
   各段的音素拼起来一起合成。GPT-SoVITS 的音素表中日英共用，任何一个音色都能这样读。
3. 中文读音：
   - 多音字用 g2pW（GPT-SoVITS 官方的做法），模型不在时退回 genie 自带的 g2pM；
   - 内置多音字词典之上再叠一层人工修正（pronunciation.txt）；
   - 修正 genie 数字规范化的问题：「第2名」读成「第两名」，「1000」逐位读成「幺零零零」。

用 tts-server-genie/tools/pronunciation_audit.py 检查改动有没有让哪句话读错。
"""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path

import numpy as np

log = logging.getLogger("genie-tts.frontend")

THIS_DIR = Path(__file__).parent.resolve()
OVERRIDES_PATH = THIS_DIR / "pronunciation.txt"

# ── 1. 字符级清洗 ────────────────────────────────────────────────────

# genie 的中文 G2P 遇到拼音没有韵母的字（嗯 n、呣 m、噷 hm）会抛异常，整句没有声音
_G2P_UNSAFE_CHARS = str.maketrans({"嗯": "恩", "呣": "姆", "噷": "哼"})
# 破折号在 genie 里只是一个很短的「-」，前后的字几乎连在一起读，听起来很怪；当逗号处理
_DASH = re.compile(r"\s*(?:[—―─]+|--+)\s*")
# 口语儿化（一会儿、这儿、一点儿、玩儿）：音素表里没有卷舌韵母，「儿」只能读成一个独立的 er，
# 实测时常被读成完整的「二」（「一会儿见」→「一挥二剑」）。这些常见的儿化去掉「儿」读；女儿、儿子等实词不动
_SUFFIX_ER = re.compile(r"(?<=[会这那哪点玩块事边样劲味])儿")
_PLUS = re.compile(r"(?<=[\w²³)）])\s*[+＋]\s*(?=[\w(（])")
_EQUALS = re.compile(r"(?<=[\w²³)）])\s*[=＝]\s*(?=[\w(（-])")


def preprocess(text: str) -> str:
    text = text.translate(_G2P_UNSAFE_CHARS)
    text = _DASH.sub("，", text)
    text = _SUFFIX_ER.sub("", text)
    text = _PLUS.sub("加", text)
    return _EQUALS.sub("等于", text)


# ── 2. 多语言混读 ────────────────────────────────────────────────────

_KANA = re.compile(r"[぀-ヿㇰ-ㇿｦ-ﾟ]")
# 按标点切成分句，每个分句单独判断中文还是日文：「ねえねえ、最近那个游戏你玩了吗？」前半句日文、后半句中文
_CLAUSE = re.compile(r"[^，。！？、；：,.!?;:…\n]*[，。！？、；：,.!?;:…\n]*")
# 英文片段：单词，连同夹在单词间的空格、连字符，以及紧跟的数字（"version 2"）
_ENGLISH_RUN = re.compile(r"[A-Za-z][A-Za-z'’\-]*(?:[\s\-]+[A-Za-z0-9][A-Za-z0-9'’\-]*)*[.!?,;:]*")
# 英文 G2P 把缩写逐字母拼读，但字母 A 按冠词读成「呃」（AI → 呃-爱）；短缩写里的 A、
# 以及单独出现的字母 a（a²+b²）改写成读音 Ay
_SHORT_ACRONYM_WITH_A = re.compile(r"\b(?=[A-Z]*A)[A-Z]{2,3}\b")
_LONE_LETTER_A = re.compile(r"[aA](?=[.!?,;:]*$)")
_READABLE = re.compile(r"[一-鿿぀-ヿA-Za-z0-9]")


def readable(text: str) -> bool:
    """有任何一种语言能读出来的字。纯标点送去合成只会得到杂音"""
    return bool(_READABLE.search(text))


def _spell_letters(run: str) -> str:
    if _LONE_LETTER_A.match(run):
        return _LONE_LETTER_A.sub("Ay", run)
    return _SHORT_ACRONYM_WITH_A.sub(lambda m: " ".join("Ay" if c == "A" else c for c in m.group()), run)


def segment(text: str) -> list[tuple[str, str]]:
    """把文本切成 (片段, 语言) 序列，语言为 chinese / japanese / english；相邻同语言的片段合并"""
    pieces: list[tuple[str, str]] = []

    def add(piece: str, language: str) -> None:
        if not piece:
            return
        if pieces and (pieces[-1][1] == language or not piece.strip()):
            pieces[-1] = (pieces[-1][0] + piece, pieces[-1][1])
        else:
            pieces.append((piece, language))

    for clause in _CLAUSE.findall(text):
        if not clause:
            continue
        cjk = "japanese" if _KANA.search(clause) else "chinese"
        pos = 0
        for m in _ENGLISH_RUN.finditer(clause):
            add(clause[pos:m.start()], cjk)
            add(_spell_letters(m.group()), "english")
            pos = m.end()
        add(clause[pos:], cjk)
    return pieces


def _mixed_phones_and_bert(original):
    def phones_and_bert(text: str, language: str = "japanese"):
        pieces = segment(text)
        if len(pieces) <= 1:
            return original(text, language=pieces[0][1] if pieces else language.lower())
        seqs, berts = [], []
        for piece, piece_language in pieces:
            if not readable(piece) and seqs:  # 只有标点：并进前一段
                piece_language = pieces[0][1]
            seq, bert = original(piece, language=piece_language)
            seqs.append(seq)
            berts.append(bert)
        return np.concatenate(seqs, axis=1), np.concatenate(berts, axis=0)

    return phones_and_bert


# ── 3. 中文读音 ──────────────────────────────────────────────────────

#: 词 → 拼音（人工修正，优先级最高）；拼音为 None 表示屏蔽内置词典里这个词的条目、交给模型判断
_overrides: dict[str, list[str] | None] = {}


def load_overrides(path: Path = OVERRIDES_PATH) -> dict[str, list[str] | None]:
    """格式见 pronunciation.txt 开头的说明。写错的行跳过并记日志，不影响其他行"""
    overrides: dict[str, list[str] | None] = {}
    if not path.exists():
        return overrides
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        word, *readings = line.split()
        if readings == ["auto"]:
            overrides[word] = None
        elif len(readings) == len(word) and all(re.fullmatch(r"[a-zü]+[1-5]", r) for r in readings):
            overrides[word] = [r.replace("ü", "v") for r in readings]
        else:
            log.warning("pronunciation.txt 第 %d 行格式不对，已跳过：%s", number, raw)
    return overrides


def _corrected_pronunciation(dictionary_correct):
    def correct(word: str, pinyins: list[str]) -> list[str]:
        result = list(pinyins) if word in _overrides else list(dictionary_correct(word, pinyins))
        # 分词结果可能比修正的词更长（genie 会把连续三声的词并在一起），所以按子串找；
        # 短的先套、长的后套，长词覆盖短词（知识分子 fèn 覆盖 分子 fēn）
        for key, reading in sorted(_overrides.items(), key=lambda kv: len(kv[0])):
            if reading is None:
                continue
            start = word.find(key)
            while start >= 0:
                result[start:start + len(key)] = reading
                start = word.find(key, start + len(key))
        return result

    return correct


_DIGIT_BY_DIGIT_CONTEXT = re.compile(r"电话|号码|手机|拨打|打给|热线|编号|工号|学号|单号|尾号|账号|验证码|密码|房间|门牌|车牌|邮编|区号|QQ|qq|ID")


def _patch_number_normalization() -> None:
    from genie_tts.G2P.Chinese.Normalization import num
    from genie_tts.G2P.Chinese.Normalization import text_normlization as tn

    quantifier = tn.replace_positive_quantifier
    default_num = tn.replace_default_num

    def positive_quantifier(match: re.Match) -> str:
        # 「2个」读「两个」，但「第2名」是「第二名」
        if match.start() > 0 and match.string[match.start() - 1] == "第":
            more = {"+": "多"}.get(match.group(2) or "", match.group(2) or "")
            return f"{num.num2str(match.group(1))}{more}{match.group(3)}"
        return quantifier(match)

    def bare_number(match: re.Match) -> str:
        # genie 把三位以上的数字一律逐位读（1000 → 幺零零零）。只有电话、编号这类才该逐位读：
        # 0 开头、7 位以上、或前面提到了电话/号码/验证码之类的保持逐位，其余按数值读
        digits = match.group(0)
        before = match.string[max(0, match.start() - 8):match.start()]
        if digits.startswith("0") or len(digits) >= 7 or _DIGIT_BY_DIGIT_CONTEXT.search(before):
            return default_num(match)
        return num.num2str(digits)

    tn.replace_positive_quantifier = positive_quantifier
    tn.replace_default_num = bare_number


_g2pw_active = False


def using_g2pw() -> bool:
    return _g2pw_active


def _use_g2pw(data_dir: Path, quantize_later: bool = True) -> bool:
    """换上 g2pW；模型不在、依赖没装（opencc）或加载失败都返回 False，继续用 g2pM，不影响出声"""
    global _g2pw_active
    from genie_tts.G2P.Chinese.ChineseG2P import processor
    try:
        from g2pw import G2PW, model_ready, quantize, quantized
        model_dir = data_dir / "G2PWModel"
        if not model_ready(model_dir):
            return False
        if quantized(model_dir):
            quantize(model_dir)  # 清掉上次量化后没删成的 fp32 原件
        predictor = G2PW(model_dir, data_dir / "roberta-wwm-ext-large-onnx" / "tokenizer.json")
    except Exception as e:  # noqa: BLE001
        log.error("g2pW 不可用，继续使用 g2pM：%s", e)
        return False
    processor.g2pm = lambda sentence, char_split=True: predictor(sentence)
    _g2pw_active = True
    log.info("多音字预测：g2pW（%s）", "int8" if quantized(model_dir) else "fp32")
    if not quantized(model_dir) and quantize_later:
        # 早期下载的是 fp32 原版：先用着，后台量化好再换上，省下约 700 MB 内存
        threading.Thread(target=_quantize_then_switch, args=(data_dir,), daemon=True).start()
    return True


def _quantize_then_switch(data_dir: Path) -> None:
    try:
        from g2pw import quantize
        quantize(data_dir / "G2PWModel")
        _use_g2pw(data_dir, quantize_later=False)
    except Exception as e:  # noqa: BLE001
        log.error("g2pW 量化失败，继续使用 fp32 模型：%s", e)


def _download_g2pw_then_switch(data_dir: Path) -> None:
    try:
        from g2pw import download_model
        log.info("后台下载多音字模型 g2pW（约 590 MB），完成前先用 g2pM")
        download_model(data_dir / "G2PWModel")
        _use_g2pw(data_dir)
    except Exception as e:  # noqa: BLE001
        log.error("g2pW 下载失败，继续使用 g2pM：%s", e)


def install(data_dir: Path, download_g2pw: bool = True) -> None:
    """在 genie_tts 导入之后、加载角色之前调用一次。
    没有 g2pW 模型时（老安装）后台下载，下完自动换上；download_g2pw=False 时不下载"""
    import jieba_fast
    from genie_tts.Core import Inference
    from genie_tts.G2P.Chinese import ChineseG2P

    Inference.get_phones_and_bert = _mixed_phones_and_bert(Inference.get_phones_and_bert)

    _overrides.update(load_overrides())
    for word in _overrides:
        if len(word) > 1:
            jieba_fast.add_word(word)  # 让分词把它切成一个词，修正才对得上
    ChineseG2P.correct_pronunciation = _corrected_pronunciation(ChineseG2P.correct_pronunciation)
    log.info("读音修正：%d 条", len(_overrides))

    _patch_number_normalization()

    if not _use_g2pw(data_dir) and download_g2pw:
        threading.Thread(target=_download_g2pw_then_switch, args=(data_dir,), daemon=True).start()
