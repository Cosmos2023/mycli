from __future__ import annotations

from pathlib import Path
import struct


_PE_MACHINE_TO_WHEEL_PLATFORM = {
    0x014C: "win32",
    0x8664: "win_amd64",
    0xAA64: "win_arm64",
}


def windows_wheel_platform(helper: Path) -> str:
    try:
        size = helper.stat().st_size
        with helper.open("rb") as stream:
            dos_header = stream.read(64)
            if len(dos_header) != 64 or dos_header[:2] != b"MZ":
                raise ValueError
            pe_offset = struct.unpack_from("<I", dos_header, 0x3C)[0]
            if pe_offset > size - 6:
                raise ValueError
            stream.seek(pe_offset)
            pe_header = stream.read(6)
    except (OSError, struct.error, ValueError) as exc:
        raise RuntimeError("Invalid Windows helper executable") from exc

    if len(pe_header) != 6 or pe_header[:4] != b"PE\0\0":
        raise RuntimeError("Invalid Windows helper executable")
    machine = struct.unpack_from("<H", pe_header, 4)[0]
    try:
        return _PE_MACHINE_TO_WHEEL_PLATFORM[machine]
    except KeyError as exc:
        raise RuntimeError(
            f"Unsupported Windows helper architecture: 0x{machine:04x}"
        ) from exc


__all__ = ["windows_wheel_platform"]
