from __future__ import annotations

import importlib
from pathlib import Path
from types import ModuleType
from typing import Any


TEXT_EXTENSIONS = {
    ".bash",
    ".c",
    ".cfg",
    ".conf",
    ".cpp",
    ".css",
    ".env",
    ".go",
    ".h",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".kt",
    ".log",
    ".lua",
    ".markdown",
    ".md",
    ".mdx",
    ".php",
    ".py",
    ".r",
    ".rb",
    ".rs",
    ".rst",
    ".scala",
    ".sh",
    ".sql",
    ".swift",
    ".tex",
    ".toml",
    ".ts",
    ".txt",
    ".xml",
    ".yaml",
    ".zig",
    ".zsh",
}

HANDLER_MAP = {
    ".csv": "mycli.tools.read.csv_handler",
    ".tsv": "mycli.tools.read.csv_handler",
    ".xlsx": "mycli.tools.read.excel_handler",
    ".xls": "mycli.tools.read.excel_handler",
    ".pdf": "mycli.tools.read.pdf_handler",
    ".docx": "mycli.tools.read.docx_handler",
    ".ipynb": "mycli.tools.read.ipynb_handler",
}

LAZY_IMPORTS: dict[str, ModuleType] = {}


def read_file(
    file_path: str,
    offset: int = 1,
    limit: int = 2000,
    pages: str | None = None,
) -> dict[str, Any]:
    path = Path(file_path)
    if not path.exists():
        return {"error": f"[File not found: {file_path}]"}
    if path.is_dir():
        return {"error": f"[Path is a directory: {file_path}. Use LS to browse.]"}

    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS or ext == "":
        return _read_text(file_path, offset=offset, limit=limit)

    handler_mod = _get_handler(ext)
    if handler_mod is not None:
        try:
            return handler_mod.read_file(file_path, pages=pages)
        except ImportError:
            return {
                "error": (
                    f"[{ext} support not installed. "
                    "Install required dependency to read this file type.]"
                ),
            }

    if _looks_binary(path):
        return {
            "error": (
                f"[Cannot read binary file: {file_path}. "
                "Detected as non-text format.]"
            ),
        }

    try:
        return _read_text(file_path, offset=offset, limit=limit)
    except UnicodeDecodeError:
        return {
            "error": (
                f"[Cannot read binary file: {file_path}. "
                "Detected as non-text format.]"
            ),
        }


def _get_handler(ext: str) -> ModuleType | None:
    module_path = HANDLER_MAP.get(ext)
    if module_path is None:
        return None
    if module_path not in LAZY_IMPORTS:
        LAZY_IMPORTS[module_path] = importlib.import_module(module_path)
    return LAZY_IMPORTS[module_path]


def _looks_binary(path: Path) -> bool:
    sample = path.read_bytes()[:1024]
    if b"\x00" in sample:
        return True
    if not sample:
        return False
    text_controls = {7, 8, 9, 10, 12, 13, 27}
    suspicious = sum(
        1 for byte in sample if byte < 32 and byte not in text_controls
    )
    return suspicious / len(sample) > 0.30


def _read_text(file_path: str, offset: int, limit: int) -> dict[str, Any]:
    from mycli.tools.read.text import read_text

    return read_text(file_path, offset=offset, limit=limit)
