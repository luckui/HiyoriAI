"""
把一个音频文件转成带时间戳的文字（B 站视频没有字幕时用）。

用法：python transcribe_file.py --file audio.m4s [--max-sec 600] [--model base] [--language zh]
输出：一行一个 JSON {"from": 秒, "to": 秒, "text": "..."}；最后一行 {"done": true, "language": "zh"}

faster-whisper 自己用 PyAV 解码，B 站的 m4s（fMP4 里的 AAC）不用 ffmpeg 也能读。
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--max-sec", type=float, default=600)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    device, compute_type = "cpu", "int8"
    if args.device in ("auto", "cuda"):
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                device, compute_type = "cuda", "float16"
        except Exception:
            pass

    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        args.file,
        language=args.language or None,
        vad_filter=True,
        # 只转前 max-sec 秒：直播里够用，也不至于等太久
        clip_timestamps=[0, args.max_sec] if args.max_sec > 0 else "0",
    )
    sys.stdout.reconfigure(encoding="utf-8")
    out = sys.stdout
    for seg in segments:
        text = seg.text.strip()
        if text:
            out.write(json.dumps({"from": round(seg.start, 2), "to": round(seg.end, 2), "text": text}, ensure_ascii=False) + "\n")
            out.flush()
    out.write(json.dumps({"done": True, "language": info.language}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
