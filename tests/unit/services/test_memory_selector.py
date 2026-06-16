from pathlib import Path

from mycli.domain.memory import MemoryKind
from mycli.memory.memdir import FileMemory
from mycli.memory.selector import ModelFileMemorySelector


class FakeCompletionClient:
    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        model: str,
        max_tokens: int,
    ) -> str:
        self.calls.append(
            {"messages": messages, "model": model, "max_tokens": max_tokens}
        )
        return self.response


def test_model_file_memory_selector_returns_valid_selected_filenames_only() -> None:
    client = FakeCompletionClient(
        '{"selected_memories":["tone.md","missing.md","tone.md","project.md"]}'
    )
    selector = ModelFileMemorySelector(client=client, model="selector-model", max_tokens=123)

    selected = selector.select(
        "how should I reply?",
        (
            _memory("tone.md", "User prefers concise replies"),
            _memory("project.md", "Project context"),
        ),
        limit=2,
    )

    assert selected == ("tone.md", "project.md")
    assert client.calls[0]["model"] == "selector-model"
    assert client.calls[0]["max_tokens"] == 123
    user_prompt = client.calls[0]["messages"][1]["content"]  # type: ignore[index]
    assert "User prefers concise replies" in user_prompt
    assert "Keep final replies concise" not in user_prompt


def test_model_file_memory_selector_accepts_fenced_json() -> None:
    client = FakeCompletionClient('```json\n{"selected_memories":["tone.md"]}\n```')
    selector = ModelFileMemorySelector(client=client, model="selector-model")

    selected = selector.select(
        "tone",
        (_memory("tone.md", "User prefers concise replies"),),
        limit=5,
    )

    assert selected == ("tone.md",)


def _memory(filename: str, description: str) -> FileMemory:
    return FileMemory(
        filename=filename,
        path=Path("/memory") / filename,
        mtime=1.0,
        kind=MemoryKind.USER,
        name=filename.removesuffix(".md"),
        description=description,
        content="Keep final replies concise.",
    )
