from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys

_SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "check_sub2api_cache.py"
_SPEC = spec_from_file_location("check_sub2api_cache", _SCRIPT_PATH)
assert _SPEC is not None
assert _SPEC.loader is not None
_MODULE = module_from_spec(_SPEC)
sys.modules["check_sub2api_cache"] = _MODULE
_SPEC.loader.exec_module(_MODULE)

ProbeResult = _MODULE.ProbeResult
cache_hit_rate = _MODULE.cache_hit_rate
normalized_rate_threshold = _MODULE.normalized_rate_threshold


def test_cache_hit_rate_uses_successful_cached_over_input_tokens() -> None:
    results = [
        ProbeResult(
            phase="text",
            round_index=1,
            ok=True,
            response_id="resp_1",
            cached_tokens=85,
            input_tokens=100,
            output_tokens=1,
            output_text="ok",
        ),
        ProbeResult(
            phase="text",
            round_index=2,
            ok=False,
            response_id=None,
            cached_tokens=1_000,
            input_tokens=1_000,
            output_tokens=None,
            output_text=None,
        ),
    ]

    assert cache_hit_rate(results) == 0.85


def test_normalized_rate_threshold_accepts_percent_or_ratio() -> None:
    assert normalized_rate_threshold(85) == 0.85
    assert normalized_rate_threshold(0.85) == 0.85
