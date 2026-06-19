#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from mycli.tools.ripgrep_prepare import (
    RIPGREP_TARGETS,
    RIPGREP_VERSION,
    default_user_ripgrep_root,
    platform_key,
    prepare_user_ripgrep,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare a vendored ripgrep binary for mycli.")
    parser.add_argument("--target", choices=sorted(RIPGREP_TARGETS), default=platform_key())
    parser.add_argument(
        "--dest",
        type=Path,
        default=default_user_ripgrep_root(),
        help="Root directory where <target>/rg will be installed.",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite an existing rg binary.")
    args = parser.parse_args()

    result = prepare_user_ripgrep(
        target=args.target,
        dest_root=args.dest,
        force=args.force,
    )
    if result.installed:
        print(f"prepared ripgrep {RIPGREP_VERSION}: {result.path}")
    else:
        print(f"ripgrep already prepared: {result.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
