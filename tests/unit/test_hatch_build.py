from __future__ import annotations

from pathlib import Path
import struct

import pytest

from hatch_build_utils import windows_wheel_platform


@pytest.mark.parametrize(
    ("machine", "expected"),
    (
        (0x8664, "win_amd64"),
        (0xAA64, "win_arm64"),
        (0x014C, "win32"),
    ),
)
def test_windows_wheel_platform_uses_pe_machine(
    tmp_path: Path,
    machine: int,
    expected: str,
) -> None:
    helper = tmp_path / "helper.exe"
    helper.write_bytes(_pe_image(machine))

    assert windows_wheel_platform(helper) == expected


@pytest.mark.parametrize("payload", (b"", b"not-pe", b"MZ" + b"\0" * 62))
def test_windows_wheel_platform_rejects_invalid_pe(
    tmp_path: Path,
    payload: bytes,
) -> None:
    helper = tmp_path / "helper.exe"
    helper.write_bytes(payload)

    with pytest.raises(RuntimeError, match="Invalid Windows helper executable"):
        windows_wheel_platform(helper)


def test_windows_wheel_platform_rejects_unknown_machine(tmp_path: Path) -> None:
    helper = tmp_path / "helper.exe"
    helper.write_bytes(_pe_image(0x9999))

    with pytest.raises(RuntimeError, match="Unsupported Windows helper architecture"):
        windows_wheel_platform(helper)


def _pe_image(machine: int) -> bytes:
    image = bytearray(0x86)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3C, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<H", image, 0x84, machine)
    return bytes(image)
