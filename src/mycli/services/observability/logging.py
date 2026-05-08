from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

_RESERVED_LOG_RECORD_KEYS = set(logging.makeLogRecord({}).__dict__)


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED_LOG_RECORD_KEYS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)

    def formatTime(
        self,
        record: logging.LogRecord,
        datefmt: str | None = None,
    ) -> str:
        created = datetime.fromtimestamp(record.created, tz=timezone.utc)
        if datefmt is not None:
            return created.strftime(datefmt)
        return created.isoformat().replace("+00:00", "Z")
