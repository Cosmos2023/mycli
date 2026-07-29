from __future__ import annotations

from mycli.services.context.token_counter import TokenCounter


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

    def test_literal_special_token_is_counted_as_ordinary_text(self) -> None:
        counter = TokenCounter()
        tokens = counter.count("文件结尾加 <|endoftext|>")
        assert tokens > 0

    def test_empty_string(self) -> None:
        counter = TokenCounter()
        assert counter.count("") == 0

    def test_cache_hit(self) -> None:
        counter = TokenCounter()
        text = "test string for caching"
        first = counter.count(text)
        second = counter.count(text)
        assert first == second
