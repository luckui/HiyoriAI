"""
下载 Genie-TTS 运行所需的全部模型文件。

安装时由 ttsServerManager.ts 调用（HF_ENDPOINT 已由调用方注入，
snapshot_download 会自动读取该环境变量走国内镜像）。

下载内容：
  1. GenieData  — HuBERT + G2P + speaker_encoder + RoBERTa (~963 MB)
                  与官方 genie.download_genie_data() 行为完全一致
  2. feibi 模型 — CharacterModels/v2ProPlus/feibi (~320 MB)
                  官方 genie.load_predefined_character('feibi') 中内置的幂等下载
  3. g2pW       — GenieData/G2PWModel (~590 MB)，中文多音字预测（见 g2pw.py）
"""
import os
import sys
from pathlib import Path

THIS_DIR = Path(__file__).parent.resolve()

# ── GENIE_DATA_DIR 必须在任何 genie_tts import 之前设置 ──────────────
os.environ["GENIE_DATA_DIR"] = str(THIS_DIR / "GenieData")

# ── CWD 设为本脚本目录，snapshot_download 的 local_dir="." 才能落在此处 ──
os.chdir(THIS_DIR)

import time
from huggingface_hub import snapshot_download

GENIE_REPO = "High-Logic/Genie"
ROBERTA_REPO = "litagin/chinese-roberta-wwm-ext-large-onnx"

# 网络超时时间（秒）；国内镜像大文件时握手可能较慢
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")


def _step(n: int, total: int, msg: str) -> None:
    print(f"[{n}/{total}] {msg}", flush=True)


def _snapshot_with_retry(max_retries: int = 5, delay: int = 10, **kwargs) -> None:
    """对 snapshot_download 进行有限次数的重试（应对网络超时）。"""
    for attempt in range(1, max_retries + 1):
        try:
            snapshot_download(**kwargs)
            return
        except Exception as exc:
            if attempt == max_retries:
                raise
            print(f"  ⚠ 第 {attempt} 次失败：{exc!r}，{delay}s 后重试…", flush=True)
            time.sleep(delay)


def download_genie_data() -> None:
    """下载 GenieData（HuBERT + G2P + speaker_encoder），与官方行为一致。"""
    target = THIS_DIR / "GenieData"
    if (target / "speaker_encoder.onnx").exists():
        _step(1, 4, "GenieData 已存在，跳过。")
        return
    _step(1, 4, f"下载 GenieData → {target}")
    _snapshot_with_retry(
        repo_id=GENIE_REPO,
        repo_type="model",
        allow_patterns="GenieData/*",
        local_dir=str(THIS_DIR),
        local_dir_use_symlinks=False,
    )
    print("  GenieData ✓", flush=True)


def download_roberta() -> None:
    """下载 Chinese RoBERTa（官方 download_genie_data() 的默认行为）。"""
    roberta_dir = THIS_DIR / "GenieData" / "roberta-wwm-ext-large-onnx"
    if (roberta_dir / "model.onnx").exists():
        _step(2, 4, "Chinese RoBERTa 已存在，跳过。")
        return
    _step(2, 4, f"下载 Chinese RoBERTa → {roberta_dir}")
    roberta_dir.mkdir(parents=True, exist_ok=True)
    _snapshot_with_retry(
        repo_id=ROBERTA_REPO,
        repo_type="model",
        allow_patterns=["model.onnx", "tokenizer.json"],
        local_dir=str(roberta_dir),
        local_dir_use_symlinks=False,
    )
    print("  Chinese RoBERTa ✓", flush=True)


def download_feibi() -> None:
    """下载 feibi 角色模型（v2ProPlus）。"""
    target = THIS_DIR / "CharacterModels" / "v2ProPlus" / "feibi"
    # 以核心模型文件为幂等检查依据
    if (target / "tts_models" / "t2s_shared_fp16.bin").exists():
        _step(3, 4, "feibi 模型已存在，跳过。")
        return
    _step(3, 4, f"下载 feibi 模型 → {target}")
    _snapshot_with_retry(
        repo_id=GENIE_REPO,
        repo_type="model",
        allow_patterns="CharacterModels/v2ProPlus/feibi/**",
        local_dir=str(THIS_DIR),
        local_dir_use_symlinks=False,
    )
    print("  feibi ✓", flush=True)


def download_g2pw() -> None:
    """下载中文多音字模型 g2pW。"""
    from g2pw import download_model, model_ready

    target = THIS_DIR / "GenieData" / "G2PWModel"
    if model_ready(target):
        _step(4, 4, "g2pW 已存在，跳过。")
        return
    _step(4, 4, f"下载 g2pW 多音字模型 → {target}")
    for attempt in range(1, 6):
        try:
            download_model(target)
            break
        except Exception as exc:
            if attempt == 5:
                raise
            print(f"  ⚠ 第 {attempt} 次失败：{exc!r}，10s 后重试…", flush=True)
            time.sleep(10)
    print("  g2pW ✓", flush=True)


if __name__ == "__main__":
    print("=== Genie-TTS 模型下载 ===", flush=True)
    download_genie_data()
    download_roberta()
    download_feibi()
    download_g2pw()
    print("✅ 所有模型下载完毕。", flush=True)
