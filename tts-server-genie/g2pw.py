"""
g2pW 多音字预测（ONNX 推理的精简版）。

genie-tts 自带的 g2pM 分不清很多常用多音字（「我得走了」读成 de、「调大音量」读成 diao、
「很长」时对时错）。GPT-SoVITS 官方的中文前端用的是 g2pW：看整句上下文给每个多音字打分。
这里只保留推理部分，改编自 GPT-SoVITS/text/g2pw（源自 GitYCC/g2pW 与 PaddleSpeech，Apache-2.0）：
  - 分词器复用 GenieData 里 RoBERTa 的 tokenizer.json（与 bert-base-chinese 同一套 21128 词表），
    不需要 transformers；
  - g2pW 是在繁体语料上训练的，推理前用 OpenCC（s2tw，按词转换）把句子转成繁体，
    与 GPT-SoVITS 一致；不转的话会出「万」读 mò、「适」读 guā 这类错；
  - g2pW 学的是台湾读音（期 qí、着急 zhāojí）。和 GPT-SoVITS 不同，这里只让它判断大陆普通话里
    也是多音字的字，候选读音限定在 pypinyin 词典的大陆读音里；其余的字直接用 pypinyin。

模型由 download_models.py 下载（约 590 MB），下载后在本地量化成 int8（G2PWModel/g2pW.int8.onnx，160 MB）；
不存在时调用方退回 g2pM。
"""
from __future__ import annotations

import functools
import json
import os
import re
import shutil
import zipfile
from pathlib import Path

import numpy as np
import onnxruntime
import opencc
from pypinyin import Style, pinyin
from tokenizers import Tokenizer

# g2pW 官方实现里按单音字处理的字：模型对它们反而不如 pypinyin 的词典（一、不交给变调规则）
_NON_POLYPHONIC = set("一不和咋嗲剖差攢倒難奔勁拗肖瘙誒泊听噢")
# 一简对多繁、其中一个字形很少用的字，OpenCC 按词选字形常选错（「只增不减」→ 隻、「背着我」→ 揹、
# 「别着急」→ 彆）。这些字一律换成常用字形：模型认识就让它按上下文判断，否则按常用字形的读音
_UNRELIABLE_GLYPHS = {"只": "只", "背": "背", "别": "別"}
#: 只看多音字左右这么多字的上下文，长句不必整句推理
_CONTEXT_CHARS = 16
_MAX_TOKENS = 510
#: GPT-SoVITS 官方整合包用的同一份模型；HF_ENDPOINT 指向镜像时走镜像
_MODEL_REPO = "XXXXRT/GPT-SoVITS-Pretrained"
_MODEL_ZIP = "G2PWModel.zip"
_TABLES = ("POLYPHONIC_CHARS.txt", "MONOPHONIC_CHARS.txt", "bopomofo_to_pinyin_wo_tune_dict.json")
# 原版 fp32 模型 635 MB、常驻内存 1.1 GB；本地动态量化成 int8 后 160 MB、内存约 380 MB，快一倍，
# 读音几乎不变（语料 13280 个字里 9 个不同，多数是 int8 读对了）
_FULL_MODEL = "g2pW.onnx"
_INT8_MODEL = "g2pW.int8.onnx"


def model_ready(model_dir: str | os.PathLike) -> bool:
    model_dir = Path(model_dir)
    has_model = (model_dir / _INT8_MODEL).exists() or (model_dir / _FULL_MODEL).exists()
    return has_model and all((model_dir / name).exists() for name in _TABLES)


def quantized(model_dir: str | os.PathLike) -> bool:
    return (Path(model_dir) / _INT8_MODEL).exists()


def quantize(model_dir: str | os.PathLike) -> None:
    """把 fp32 模型量化成 int8（十几秒），成功后删掉 fp32 原件；原件正被加载占用时留到下次再删"""
    model_dir = Path(model_dir)
    full, int8 = model_dir / _FULL_MODEL, model_dir / _INT8_MODEL
    if not int8.exists():
        from onnxruntime.quantization import QuantType, quantize_dynamic
        partial = model_dir / (_INT8_MODEL + ".partial")
        quantize_dynamic(str(full), str(partial), weight_type=QuantType.QInt8)
        partial.replace(int8)
    try:
        full.unlink(missing_ok=True)
    except OSError:
        pass


def download_model(model_dir: str | os.PathLike) -> None:
    """下载、解压、量化到 model_dir。先在临时目录里做完再改名，中途失败不会留下半个模型"""
    from huggingface_hub import hf_hub_download

    model_dir = Path(model_dir)
    if model_ready(model_dir):
        return
    archive = Path(hf_hub_download(repo_id=_MODEL_REPO, filename=_MODEL_ZIP, local_dir=model_dir.parent / ".g2pw-download"))
    staging = model_dir.parent / ".g2pw-extract"
    shutil.rmtree(staging, ignore_errors=True)
    with zipfile.ZipFile(archive) as z:
        z.extractall(staging)
    extracted = next((p.parent for p in staging.rglob(_FULL_MODEL)), None)
    if extracted is None or not model_ready(extracted):
        raise RuntimeError(f"{_MODEL_ZIP} 里没有完整的 g2pW 模型")
    shutil.rmtree(archive.parent, ignore_errors=True)
    quantize(extracted)
    shutil.rmtree(model_dir, ignore_errors=True)
    extracted.rename(model_dir)
    shutil.rmtree(staging, ignore_errors=True)


class G2PW:
    def __init__(self, model_dir: str | os.PathLike, tokenizer_path: str | os.PathLike):
        model_dir = Path(model_dir)
        self._tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self._cls, self._sep, self._unk = (self._tokenizer.token_to_id(t) for t in ("[CLS]", "[SEP]", "[UNK]"))

        polyphonic = [line.split("\t") for line in (model_dir / "POLYPHONIC_CHARS.txt").read_text(encoding="utf-8").strip().split("\n")]
        monophonic = [line.split("\t") for line in (model_dir / "MONOPHONIC_CHARS.txt").read_text(encoding="utf-8").strip().split("\n")]
        self._labels = sorted({phoneme for _, phoneme in polyphonic})
        label_index = {label: i for i, label in enumerate(self._labels)}
        char2phonemes: dict[str, list[int]] = {}
        for char, phoneme in polyphonic:
            char2phonemes.setdefault(char, []).append(label_index[phoneme])
        self._char2id = {char: i for i, char in enumerate(sorted(char2phonemes))}
        self._masks = {char: np.isin(np.arange(len(self._labels)), ids).astype(np.float32) for char, ids in char2phonemes.items()}
        self._polyphonic = set(char2phonemes) - _NON_POLYPHONIC
        self._bopomofo_to_pinyin = json.loads((model_dir / "bopomofo_to_pinyin_wo_tune_dict.json").read_text(encoding="utf-8"))
        self._monophonic = {char: self._to_pinyin(phoneme) for char, phoneme in monophonic}
        self._label_pinyin = np.array([self._to_pinyin(label) or "" for label in self._labels])
        self._to_traditional = opencc.OpenCC("s2tw")

        options = onnxruntime.SessionOptions()
        options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.intra_op_num_threads = 2
        model = model_dir / (_INT8_MODEL if quantized(model_dir) else _FULL_MODEL)
        self._session = onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])

    @staticmethod
    @functools.lru_cache(maxsize=8192)
    def _mainland_readings(char: str) -> tuple[str, ...]:
        """pypinyin 词典里这个字在大陆普通话的全部读音"""
        return tuple(pinyin(char, style=Style.TONE3, heteronym=True, neutral_tone_with_five=True, errors=lambda x: [x])[0])

    def _to_pinyin(self, bopomofo: str) -> str | None:
        base = self._bopomofo_to_pinyin.get(bopomofo[:-1])
        return base + bopomofo[-1] if base else None

    def _tokenize(self, text: str) -> tuple[list[int], list[int]]:
        """token id 序列，以及每个字符对应第几个 token（英文、数字串整体切词）"""
        ids: list[int] = []
        char_to_token = [0] * len(text)
        for m in re.finditer(r"[a-z0-9]+|\s+|.", text.lower()):
            if m.group().isspace():
                continue
            pieces = self._tokenizer.encode(m.group(), add_special_tokens=False).ids or [self._unk]
            for i in range(m.start(), m.end()):
                char_to_token[i] = len(ids)
            ids.extend(pieces)
        return ids, char_to_token

    def __call__(self, sentence: str) -> list[str]:
        """逐字拼音（TONE3，轻声为 5）。非汉字原样返回字符本身"""
        result = [p[0] for p in pinyin(sentence, style=Style.TONE3, neutral_tone_with_five=True, errors=lambda x: list(x))]
        if len(result) != len(sentence):  # pypinyin 把连续的非汉字合成一项时，逐字对齐
            result = [p[0] for ch in sentence for p in pinyin(ch, style=Style.TONE3, neutral_tone_with_five=True, errors=lambda x: list(x))]
        simplified = sentence
        traditional = self._to_traditional.convert(sentence)
        if len(traditional) == len(sentence):  # 按字对齐的前提；极少数转换会改变字数，那就用原句
            sentence = traditional
        # 只问大陆普通话里也是多音字的字。g2pW 按台湾读音训练，它的单音字表（期 qí、危 wéi…）不用，
        # 这些字交给 pypinyin
        # 候选读音也收窄到大陆读音：台湾才有的读法（垃圾 lèsè）不让模型选
        queries, masks = [], []
        query_chars = list(sentence)
        for i, char in enumerate(sentence):
            readings = self._mainland_readings(simplified[i])
            if len(readings) < 2:
                continue
            char = query_chars[i] = _UNRELIABLE_GLYPHS.get(simplified[i], char)
            if char not in self._polyphonic:
                # 转繁体时按词选的字形定了读音（万 → 萬 wàn、干净 → 乾淨 gān）
                if self._monophonic.get(char) in readings:
                    result[i] = self._monophonic[char]
                continue
            mask = self._masks[char] * np.isin(self._label_pinyin, readings)
            if mask.any():
                queries.append(i)
                masks.append(mask)
        if not queries:
            return result

        left = max(0, queries[0] - _CONTEXT_CHARS)
        right = min(len(sentence), queries[-1] + _CONTEXT_CHARS + 1)
        window = sentence[left:right]
        ids, char_to_token = self._tokenize(window)
        if len(ids) > _MAX_TOKENS:  # 极长的无标点句子：只处理能放下的部分，其余用 pypinyin
            ids = ids[:_MAX_TOKENS]
            fits = [k for k, q in enumerate(queries) if char_to_token[q - left] < _MAX_TOKENS]
            queries, masks = [queries[k] for k in fits], [masks[k] for k in fits]
            if not queries:
                return result
        input_ids = np.array([[self._cls, *ids, self._sep]] * len(queries), dtype=np.int64)
        probs = self._session.run(None, {
            "input_ids": input_ids,
            "token_type_ids": np.zeros_like(input_ids),
            "attention_mask": np.ones_like(input_ids),
            "phoneme_mask": np.stack(masks).astype(np.float32),
            "char_ids": np.array([self._char2id[query_chars[q]] for q in queries], dtype=np.int64),
            "position_ids": np.array([char_to_token[q - left] + 1 for q in queries], dtype=np.int64),
        })[0]
        for q, label in zip(queries, np.argmax(probs, axis=1)):
            result[q] = self._to_pinyin(self._labels[label]) or result[q]
        return result
