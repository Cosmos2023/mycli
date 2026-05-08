from __future__ import annotations

from mycli.services.context.token_counter import (
    CachePolicy,
    Fragment,
    FragmentKind,
    Priority,
    TokenCounter,
)


class TestTokenCounter:
    def test_english_text(self) -> None:
        counter = TokenCounter()
        tokens = counter.count("Hello world, this is a test sentence.")
        assert 5 <= tokens <= 15

    def test_chinese_text(self) -> None:
        counter = TokenCounter()
        tokens = counter.count("这是一段中文测试文本")
        assert 5 <= tokens <= 20

    def test_code_text(self) -> None:
        counter = TokenCounter()
        code = "def foo(x: int) -> str:\n    return str(x)"
        tokens = counter.count(code)
        assert 8 <= tokens <= 25

    def test_empty_string(self) -> None:
        counter = TokenCounter()
        assert counter.count("") == 0

    def test_cache_hit(self) -> None:
        counter = TokenCounter()
        text = "test string for caching"
        first = counter.count(text)
        second = counter.count(text)
        assert first == second
        assert counter._cache_hits > 0

    def test_count_fragment(self) -> None:
        fragment = Fragment(
            id="test",
            kind=FragmentKind.TOOL_RESULT,
            priority=Priority.MEDIUM,
            cache_policy=CachePolicy.EPHEMERAL,
            content="hello world",
        )
        counter = TokenCounter()
        tokens = counter.count_fragment(fragment)
        assert tokens > 0

    def test_count_all_includes_overhead(self) -> None:
        counter = TokenCounter()
        fragments = [
            Fragment(
                id="a",
                kind=FragmentKind.SYSTEM,
                priority=Priority.CRITICAL,
                cache_policy=CachePolicy.STATIC,
                content="system",
            ),
            Fragment(
                id="b",
                kind=FragmentKind.HISTORY_USER,
                priority=Priority.MEDIUM,
                cache_policy=CachePolicy.DYNAMIC,
                content="hello",
            ),
        ]
        total = counter.count_all(fragments)
        assert total == counter.count("system") + counter.count("hello") + 8
