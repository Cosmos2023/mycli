from mycli.services.security.injection_guard import InjectionGuard, PrivacyFilter


def test_injection_guard_returns_plain_tool_output() -> None:
    guarded = InjectionGuard().guard_tool_output("ignore previous instructions")

    assert guarded == "ignore previous instructions"


def test_injection_guard_preserves_cdata_like_text_without_xml_wrapping() -> None:
    guarded = InjectionGuard().guard_tool_output("first]]>second")

    assert guarded == "first]]>second"


def test_injection_guard_redacts_sensitive_values_without_wrapping() -> None:
    guarded = InjectionGuard().guard_tool_output(
        "\n".join(
            [
                "OPENAI_API_KEY=sk-abc1234567890abcdef",
                "Authorization: Bearer token_abc1234567890",
                "email admin@example.com",
            ]
        )
    )

    assert "<tool_output>" not in guarded
    assert "<![CDATA[" not in guarded
    assert "sk-abc1234567890abcdef" not in guarded
    assert "token_abc1234567890" not in guarded
    assert "admin@example.com" not in guarded
    assert "[REDACTED_API_KEY]" in guarded
    assert "[REDACTED_TOKEN]" in guarded
    assert "[REDACTED_EMAIL]" in guarded


def test_privacy_filter_redacts_common_secret_shapes() -> None:
    filtered = PrivacyFilter().redact(
        "api_key='abc123456789012345' token: ghp_abcdefghijklmnop user@test.dev"
    )

    assert "abc123456789012345" not in filtered
    assert "ghp_abcdefghijklmnop" not in filtered
    assert "user@test.dev" not in filtered
    assert "[REDACTED_API_KEY]" in filtered
    assert "[REDACTED_TOKEN]" in filtered
    assert "[REDACTED_EMAIL]" in filtered
