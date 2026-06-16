from mycli.domain.memory import MemoryKind
from mycli.memory.extraction import extract_explicit_memory_request


def test_extract_explicit_english_remember_request() -> None:
    extraction = extract_explicit_memory_request(
        "remember that I prefer concise final replies"
    )

    assert extraction is not None
    assert extraction.action == "remember"
    assert extraction.kind is MemoryKind.USER
    assert extraction.content == "I prefer concise final replies"


def test_extract_explicit_chinese_remember_request() -> None:
    extraction = extract_explicit_memory_request("请记住：以后你不要写太长的结尾总结")

    assert extraction is not None
    assert extraction.action == "remember"
    assert extraction.kind is MemoryKind.FEEDBACK
    assert extraction.content == "以后你不要写太长的结尾总结"


def test_extract_explicit_forget_request() -> None:
    extraction = extract_explicit_memory_request("forget terse replies")

    assert extraction is not None
    assert extraction.action == "forget"
    assert extraction.content == "terse replies"


def test_extract_ignores_ordinary_turns() -> None:
    assert extract_explicit_memory_request("inspect this repository") is None
