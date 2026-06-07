from __future__ import annotations

import json

from mycli.evaluation.provider_quirk_matrix import provider_quirk_matrix_rows


def test_provider_quirk_matrix_covers_provider_free_fixture_rows() -> None:
    rows = provider_quirk_matrix_rows()
    by_case = {str(row["case_id"]): row for row in rows}

    assert set(by_case) == {
        "openai_responses",
        "compatible_chat",
        "anthropic_messages",
        "deepseek_chat",
        "deepseek_anthropic_style",
    }
    assert by_case["openai_responses"]["cache_strategy"] == "prompt_cache_key"
    assert by_case["compatible_chat"]["prompt_cache_key_supported"] is True
    assert by_case["anthropic_messages"]["cache_control_supported"] is True
    assert by_case["deepseek_chat"]["automatic_prefix_cache"] is True
    assert by_case["deepseek_chat"]["wire_hints_supported"] is False
    assert by_case["deepseek_anthropic_style"]["provider_family"] == "deepseek"
    assert by_case["deepseek_anthropic_style"]["cache_control_supported"] is False


def test_provider_quirk_matrix_rows_are_bounded_metadata() -> None:
    encoded = json.dumps(provider_quirk_matrix_rows(), sort_keys=True)

    assert "api_key" not in encoded
    assert "secret" not in encoded
    assert "payload" not in encoded
    assert "prompt_cache_key_supported" in encoded
