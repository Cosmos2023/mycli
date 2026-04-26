from __future__ import annotations

import argparse

from .service import build_output_path


def main() -> str:
    parser = argparse.ArgumentParser()
    parser.add_argument("filename")
    parser.add_argument("--output-dir", default="dist")
    args = parser.parse_args()
    return build_output_path({"output_dir": args.output_dir}, args.filename)


if __name__ == "__main__":
    print(main())
