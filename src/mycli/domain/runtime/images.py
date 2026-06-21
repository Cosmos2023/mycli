from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import Literal

from mycli.domain.runtime.blocks import RuntimeBlock

ProviderImageFormat = Literal["openai", "anthropic"]

_SUPPORTED_IMAGE_MIME_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    }
)


def local_image_block(path: str | Path, *, detail: str | None = None) -> RuntimeBlock:
    metadata: dict[str, object] = {"path": str(path)}
    if detail:
        metadata["detail"] = detail
    return RuntimeBlock(type="image", metadata=metadata)


def remote_image_block(url: str, *, detail: str | None = None) -> RuntimeBlock:
    metadata: dict[str, object] = {"image_url": url}
    if detail:
        metadata["detail"] = detail
    return RuntimeBlock(type="image", metadata=metadata)


def image_block_to_provider_content(
    block: RuntimeBlock,
    *,
    format: ProviderImageFormat,
) -> dict[str, object]:
    if block.type != "image":
        raise ValueError("image provider content requires an image block")
    image_url = _image_url_for_block(block)
    detail = block.metadata.get("detail")
    if format == "anthropic":
        media_type, data = _data_url_parts(image_url)
        source: dict[str, object] = {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        }
        return {"type": "image", "source": source}
    content: dict[str, object] = {"type": "image_url", "image_url": {"url": image_url}}
    if isinstance(detail, str) and detail:
        image_url_payload = content["image_url"]
        if isinstance(image_url_payload, dict):
            image_url_payload["detail"] = detail
    return content


def image_block_to_responses_content(block: RuntimeBlock) -> dict[str, object]:
    if block.type != "image":
        raise ValueError("Responses image content requires an image block")
    content: dict[str, object] = {
        "type": "input_image",
        "image_url": _image_url_for_block(block),
    }
    detail = block.metadata.get("detail")
    if isinstance(detail, str) and detail:
        content["detail"] = detail
    return content


def _image_url_for_block(block: RuntimeBlock) -> str:
    image_url = block.metadata.get("image_url")
    if isinstance(image_url, str) and image_url:
        return image_url
    raw_path = block.metadata.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("image block requires metadata image_url or path")
    return _local_image_data_url(Path(raw_path).expanduser())


def _local_image_data_url(path: Path) -> str:
    if not path.is_file():
        raise ValueError(f"image path is not a file: {path}")
    mime_type = _supported_mime_type(path)
    if mime_type is None:
        raise ValueError(f"unsupported image type: {path}")
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{data}"


def _supported_mime_type(path: Path) -> str | None:
    mime_type, _ = mimetypes.guess_type(path)
    if mime_type in _SUPPORTED_IMAGE_MIME_TYPES:
        return mime_type
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".gif":
        return "image/gif"
    return None


def _data_url_parts(image_url: str) -> tuple[str, str]:
    prefix = "data:"
    marker = ";base64,"
    if not image_url.startswith(prefix) or marker not in image_url:
        raise ValueError("Anthropic image input requires a local image/data URL")
    media_type, data = image_url[len(prefix) :].split(marker, 1)
    if media_type not in _SUPPORTED_IMAGE_MIME_TYPES or not data:
        raise ValueError("Anthropic image input has unsupported data URL media type")
    return media_type, data


__all__ = [
    "image_block_to_provider_content",
    "image_block_to_responses_content",
    "local_image_block",
    "remote_image_block",
]
