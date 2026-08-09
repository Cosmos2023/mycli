from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator


def test_python_and_fixture_expectations_agree() -> None:
    root = Path("backend/packages/contracts")
    schema = json.loads(
        (root / "schemas/gateway-events.schema.json").read_text(encoding="utf-8")
    )
    fixtures = json.loads(
        (root / "fixtures/gateway-events.json").read_text(encoding="utf-8")
    )
    validator = Draft202012Validator(schema)

    for case in fixtures:
        actual = not any(validator.iter_errors(case["value"]))
        assert actual is case["valid"], case["name"]
