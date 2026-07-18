import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert GPT-SoVITS V2/V2ProPlus voice to Genie-TTS ONNX files.")
    parser.add_argument("--ckpt", required=True, help="GPT model .ckpt path")
    parser.add_argument("--pth", required=True, help="SoVITS model .pth path")
    parser.add_argument("--out", required=True, help="Output tts_models directory")
    parser.add_argument("--genie-source", required=True, help="Genie-TTS source folder")
    args = parser.parse_args()

    source_dir = Path(args.genie_source).resolve()
    src_pkg = source_dir / "src"
    if src_pkg.exists():
        sys.path.insert(0, str(src_pkg))
    sys.path.insert(0, str(source_dir))

    os.environ.setdefault("GENIE_DATA_DIR", str(Path(__file__).resolve().parent / "GenieData"))
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

    import genie_tts as genie

    genie.convert_to_onnx(
        torch_ckpt_path=args.ckpt,
        torch_pth_path=args.pth,
        output_dir=args.out,
    )
    print("CONVERT_OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
