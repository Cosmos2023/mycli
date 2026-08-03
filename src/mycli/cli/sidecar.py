from __future__ import annotations

import argparse
import re
import sys

from mycli.cli.bootstrap import build_turn_service
from mycli.cli.node_tui.stdio import run_stdio_gateway

_ERROR_TEXT_LIMIT = 500
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+"
)


def build_sidecar_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m mycli.cli.sidecar")
    parser.add_argument("--session", default=None)
    parser.add_argument("--model", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = vars(build_sidecar_parser().parse_args(argv))
    try:
        service = build_turn_service(args)
    except (OSError, RuntimeError, ValueError) as exc:
        sys.stderr.write(f"[mycli-sidecar] {_sanitized_error(exc)}\n")
        return 2
    try:
        return run_stdio_gateway(
            service=service,
            input_stream=sys.stdin,
            output_stream=sys.stdout,
        )
    finally:
        service.close()


def _sanitized_error(error: Exception) -> str:
    message = " ".join(str(error).splitlines()).strip() or "Unable to start runtime."
    redacted = _SECRET_ASSIGNMENT.sub(r"\1=[REDACTED]", message)
    return redacted[:_ERROR_TEXT_LIMIT]


if __name__ == "__main__":
    raise SystemExit(main())
