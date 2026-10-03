"""
Genie 中文读音审查：在不开 TTS 服务、不合成音频的情况下，检查文本前端会把每句话读成什么。

用 Genie 服务自己的 Python 环境运行（需要已安装 Genie TTS，g2pW 模型在 GenieData/G2PWModel）：

  回归用例（cases.txt），有读错时退出码为 1：
    tts-server-genie/.venv/Scripts/python scripts/genie-audit/audit.py [--tones]

  体检一批文本（每行一句的 .txt，或 JSON 字符串数组）：
    tts-server-genie/.venv/Scripts/python scripts/genie-audit/audit.py --lint replies.json [--tones]
  报告：前端读不出来被删掉的字符、合成会崩溃的句子、汉字和音节对不上的句子，
  以及和 pypinyin（大陆词典）读音不同的字 —— 后者多数是我们对、pypinyin 错，但真正的读错也在里面，
  逐条看一遍，确认是错的就加进 cases.txt 再修。

--tones：声调不同（三声变调、轻声以外）也报告。
"""
from __future__ import annotations

import collections
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER_DIR = ROOT / "tts-server-genie"
os.environ.setdefault("GENIE_DATA_DIR", str(SERVER_DIR / "GenieData"))
sys.path.insert(0, str(SERVER_DIR))
sys.stdout.reconfigure(encoding="utf-8")

from pypinyin import Style, pinyin  # noqa: E402
from pypinyin.contrib.tone_convert import to_finals_tone3, to_initials  # noqa: E402

import text_frontend  # noqa: E402
from genie_tts.G2P.Chinese.ChineseG2P import processor  # noqa: E402

PUNCT = set("!?…,.-")
HAN = re.compile(r"[一-鿿]")
SHOW_TONES = "--tones" in sys.argv

# 记下每个汉字最终的声母、韵母（变调、儿化之后），用来和预期逐字比对
_recorded: list[tuple[str, str]] = []
_to_phones = processor._pinyin_to_opencpop_phones


def _record(initial: str, final: str):
    _recorded.append((initial, final))
    return _to_phones(initial, final)


processor._pinyin_to_opencpop_phones = _record


def frontend(text: str) -> tuple[str, list[str]]:
    """文本 → (归一化后的中文, 逐字拼音)；与服务合成时走的是同一条路径"""
    _recorded.clear()
    normalized = processor.normalize_text(text_frontend.preprocess(text))
    processor.g2p(normalized)
    return normalized, [initial + final for initial, final in _recorded]


def expected_syllables(pinyins: str) -> list[str]:
    return [to_initials(p) + to_finals_tone3(p, neutral_tone_with_five=True) for p in pinyins.split()]


def severity(want: list[str], got: list[str]) -> str:
    """ok / tone（三声变调、轻声的出入）/ wrong（读成了别的音）"""
    if len(want) != len(got):
        return "wrong"
    level = "ok"
    for w, g in zip(want, got):
        if w == g:
            continue
        tones = {w[-1], g[-1]}
        if w[:-1] != g[:-1] or not (tones == {"2", "3"} or "5" in tones):
            return "wrong"
        level = "tone"
    return level


def run_cases() -> int:
    counts = collections.Counter()
    for raw in (Path(__file__).parent / "cases.txt").read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        text, want = (part.strip() for part in raw.split("|", 1))
        try:
            normalized, got = frontend(text)
        except Exception as e:  # noqa: BLE001
            counts["wrong"] += 1
            print(f"✗ {text}  崩溃 {type(e).__name__}: {e}")
            continue
        expected = expected_syllables(want)
        level = severity(expected, got)
        counts[level] += 1
        if level == "wrong" or (level == "tone" and SHOW_TONES):
            diff = [f"{e}→{g}" for e, g in zip(expected, got) if e != g]
            if len(expected) != len(got):
                diff.append(f"音节数 {len(expected)}→{len(got)}")
            print(f"{'✗' if level == 'wrong' else '~'} {text}  [{normalized}]  {'  '.join(diff)}")
    total = sum(counts.values())
    print(f"\n{total} 句：正确 {counts['ok']}，声调出入 {counts['tone']}，读错 {counts['wrong']}")
    return 1 if counts["wrong"] else 0


def lint(path: Path) -> int:
    content = path.read_text(encoding="utf-8")
    lines = json.loads(content) if path.suffix == ".json" else content.splitlines()
    dropped: collections.Counter[str] = collections.Counter()
    dropped_example: dict[str, str] = {}
    broken: list[str] = []
    differs: dict[str, list[str]] = collections.defaultdict(list)

    for line in lines:
        for sentence in re.split(r"(?<=[。！？!?\n])", line):
            prepared = text_frontend.preprocess(sentence)
            for piece, language in text_frontend.segment(prepared):
                if language != "chinese" or not HAN.search(piece):
                    continue
                try:
                    normalized, got = frontend(piece)
                except Exception as e:  # noqa: BLE001
                    broken.append(f"{sentence.strip()[:50]}  →  崩溃 {type(e).__name__}: {e}")
                    continue
                for ch in set(piece):
                    if HAN.match(ch) or ch.isspace() or ch.isdigit() or ch in "，。！？、；：,.!?;:…~～“”\"'‘’（）()「」『』《》":
                        continue
                    # 去掉这个字符读法完全不变，说明前端把它丢了
                    if processor.normalize_text(piece.replace(ch, "")) == normalized:
                        dropped[ch] += 1
                        dropped_example.setdefault(ch, sentence.strip())
                han = HAN.findall(normalized)
                if len(han) != len(got):
                    broken.append(f"{sentence.strip()[:50]}  →  {len(han)} 个汉字只有 {len(got)} 个音节  [{normalized}]")
                    continue
                reference = [p[0] for p in pinyin("".join(han), style=Style.TONE3, neutral_tone_with_five=True)]
                for i, (ch, ours, ref) in enumerate(zip(han, got, reference)):
                    theirs = to_initials(ref) + to_finals_tone3(ref, neutral_tone_with_five=True)
                    if ch == "儿" or ours == theirs:
                        continue
                    tones = {ours[-1], theirs[-1]}
                    tone_only = ours[:-1] == theirs[:-1]
                    if tone_only and (not SHOW_TONES or tones == {"2", "3"} or "5" in tones or ch in "一不"):
                        continue
                    differs[ch].append(f"{ours}/{theirs}「{''.join(han[max(0, i - 4):i + 5])}」")

    print("== 被删掉、读不出来的字符")
    for ch, n in dropped.most_common():
        print(f"  {ch!r} ×{n}   例：{dropped_example[ch][:60]}")
    print("\n== 崩溃 / 汉字和音节对不上")
    for row in broken:
        print(f"  {row}")
    print("\n== 和 pypinyin 读音不同的字（我们的/pypinyin「上下文」），逐条确认")
    for ch, rows in sorted(differs.items(), key=lambda kv: -len(kv[1])):
        print(f"  {ch} ×{len(rows)}: " + "  ".join(rows[:6]))
    return 1 if broken else 0


if __name__ == "__main__":
    text_frontend.install(Path(os.environ["GENIE_DATA_DIR"]), download_g2pw=False)
    if not text_frontend.using_g2pw():
        print("⚠ 没有 g2pW 模型（GenieData/G2PWModel），结果反映的是退回 g2pM 时的读音\n")
    if "--lint" in sys.argv:
        sys.exit(lint(Path(sys.argv[sys.argv.index("--lint") + 1])))
    sys.exit(run_cases())
