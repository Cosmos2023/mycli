# mycli ReAct Agent V1 实现计划

> **给 agent 执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项执行本计划。步骤使用 checkbox（`- [ ]`）语法跟踪。

**目标：** 构建一个基于 Python 3.13、使用 `uv` 管理、由 CLI 承载的 ReAct personal coding agent。它需要在 half-auto 安全模型下主动使用 tools、memory、skills 和轻量 planning。

**架构：** 实现顺序采用“由内到外”的方式推进：先搭最薄的项目骨架，再补齐类型化领域模型、本地持久化、提示词型 skills、只读 tools、可 stub 的 ReAct runtime、CLI 宿主，最后再加入带审批的文件写入与 shell 执行。整个 runtime 保持单 agent、本地优先，并把 tools、memory、skills 和 planning 视为 agent 的原生能力，而不是可选插件。

**技术栈：** Python 3.13、`uv`、`argparse`、`dataclasses`、`pathlib`、`pytest`、`ruff`、`mypy`、标准库 HTTP 与 subprocess API

---

## 范围检查

这份 spec 涵盖了多个子系统，但它们本质上都属于同一个垂直切片：一个能够在本地工作区中进行 reason、act、observe、remember，并且安全执行动作的单一 ReAct agent runtime。因此本计划保留为一份文档，但会按阶段拆开，确保每个任务完成后仓库都处于可运行、可测试状态。

## 计划文件映射

### 项目与工具链

- 创建：`pyproject.toml`
  定义包元数据、`uv` 入口，以及 pytest、ruff、mypy 的配置。
- 创建：`README.md`
  提供 CLI 宿主的简要安装与运行说明。

### 源码结构

- 创建：`src/mycli/__init__.py`
  暴露包版本信息。
- 创建：`src/mycli/cli/__init__.py`
  标记 CLI 包。
- 创建：`src/mycli/cli/main.py`
  CLI 入口、REPL 循环启动，以及 slash command 分发接线。
- 创建：`src/mycli/application/__init__.py`
  标记 application 包。
- 创建：`src/mycli/application/turn_service.py`
  编排单次用户 turn，并协调 ReAct runtime 与 session 服务。
- 创建：`src/mycli/domain/__init__.py`
  标记 domain 包。
- 创建：`src/mycli/domain/conversation.py`
  定义 `Message`、`Conversation` 以及会话辅助逻辑。
- 创建：`src/mycli/domain/memory.py`
  定义 `MemoryKind` 与 `MemoryRecord`。
- 创建：`src/mycli/domain/runtime.py`
  定义 `AgentConfig`、`ExecutionContext`、`ModelDecision`、`TurnResponse`、`PendingApproval` 和 `RiskLevel`。
- 创建：`src/mycli/domain/skills.py`
  定义 `SkillDefinition`。
- 创建：`src/mycli/domain/tools.py`
  定义 `ToolCall`、`ToolResult` 以及 tool 相关类型。
- 创建：`src/mycli/agents/__init__.py`
  标记 agents 包。
- 创建：`src/mycli/agents/react_loop.py`
  运行 `Reason -> Act -> Observe` 循环，并强制执行最大步数限制。
- 创建：`src/mycli/tools/__init__.py`
  标记 tools 包。
- 创建：`src/mycli/tools/contracts.py`
  定义通用 tool 协议与注册器。
- 创建：`src/mycli/tools/list_directory.py`
  枚举安全的工作区路径。
- 创建：`src/mycli/tools/read_file.py`
  读取边界受控的文本文件。
- 创建：`src/mycli/tools/search_text.py`
  在工作区文件中搜索文本命中。
- 创建：`src/mycli/tools/edit_file.py`
  执行边界受控的文件编辑，并生成统一 diff 预览。
- 创建：`src/mycli/tools/run_shell.py`
  在工作区边界内执行结构化 shell 命令。
- 创建：`src/mycli/services/__init__.py`
  标记 services 包。
- 创建：`src/mycli/services/config_service.py`
  按 flags、env、项目配置、用户配置的优先级解析 config。
- 创建：`src/mycli/services/memory_service.py`
  负责偏好、项目笔记和 session summary 的加载、检索与写入。
- 创建：`src/mycli/services/session_service.py`
  负责会话和待审批动作的加载与保存。
- 创建：`src/mycli/services/skill_registry.py`
  加载内置与用户本地 skill，并为当前 turn 解析匹配的 skill。
- 创建：`src/mycli/services/safety_policy.py`
  将 tool call 分类为 `low`、`medium` 或 `high`。
- 创建：`src/mycli/infrastructure/__init__.py`
  标记 infrastructure 包。
- 创建：`src/mycli/infrastructure/filesystem.py`
  提供安全的工作区相对路径辅助，以及 JSON 持久化辅助。
- 创建：`src/mycli/infrastructure/openai_client.py`
  在可 stub 的接口之后实现 OpenAI 兼容模型适配器。
- 创建：`src/mycli/infrastructure/shell_adapter.py`
  封装结构化 subprocess 执行。
- 创建：`src/mycli/prompts/__init__.py`
  标记 prompts 包。
- 创建：`src/mycli/prompts/system.py`
  构建 agent 的基础 system prompt。
- 创建：`src/mycli/prompts/react.py`
  组织 ReAct 指令、tool 描述、memory 上下文和 skill 上下文。
- 创建：`src/mycli/prompts/skills/repository-analysis.md`
  用于主动仓库理解的内置 skill。
- 创建：`src/mycli/prompts/skills/code-review.md`
  用于代码评审行为约束的内置 skill。

### 测试

- 创建：`tests/unit/cli/test_main.py`
  验证 CLI parser 默认值与命令路由。
- 创建：`tests/unit/domain/test_runtime.py`
  验证 domain 默认值与 runtime 模型行为。
- 创建：`tests/unit/services/test_config_service.py`
  验证配置优先级。
- 创建：`tests/unit/services/test_memory_service.py`
  验证 memory 持久化与检索。
- 创建：`tests/unit/services/test_session_service.py`
  验证 session 往返持久化。
- 创建：`tests/unit/services/test_skill_registry.py`
  验证内置与用户本地 skill 的加载。
- 创建：`tests/unit/services/test_safety_policy.py`
  验证 tool 风险分类。
- 创建：`tests/unit/tools/test_read_only_tools.py`
  验证目录枚举、文件读取与文本搜索。
- 创建：`tests/unit/tools/test_edit_file_tool.py`
  验证 diff 预览与边界受控编辑。
- 创建：`tests/unit/tools/test_run_shell.py`
  验证 shell 校验与执行规则。
- 创建：`tests/unit/agents/test_react_loop.py`
  验证 ReAct 循环会调用 tools、遵守限制并返回最终回答。
- 创建：`tests/integration/test_turn_service.py`
  验证端到端的只读 turn。
- 创建：`tests/integration/test_cli_repl.py`
  验证 REPL 宿主、slash commands 和审批循环。

### 文档与配置状态

- 创建：`.gitignore`
  忽略 `.venv`、`.pytest_cache`、`.mypy_cache`、`__pycache__`、本地 memory 状态和 session 文件。

## 任务 1：初始化包结构和 CLI 外壳

**文件：**
- 创建：`pyproject.toml`
- 创建：`README.md`
- 创建：`.gitignore`
- 创建：`src/mycli/__init__.py`
- 创建：`src/mycli/cli/__init__.py`
- 创建：`src/mycli/cli/main.py`
- 测试：`tests/unit/cli/test_main.py`

- [ ] **步骤 1：编写失败的 CLI 初始化测试**

```python
from mycli.cli.main import build_parser


def test_build_parser_uses_mycli_prog_name() -> None:
    parser = build_parser()
    assert parser.prog == "mycli"


def test_build_parser_reads_session_argument() -> None:
    parser = build_parser()
    args = parser.parse_args(["--session", "demo-session"])
    assert args.session == "demo-session"
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/cli/test_main.py -v`  
预期：FAIL，并出现 `ModuleNotFoundError: No module named 'mycli'`

- [ ] **步骤 3：编写最小项目文件和 CLI 实现**

`pyproject.toml`

```toml
[project]
name = "mycli"
version = "0.1.0"
description = "CLI-hosted ReAct personal coding agent"
readme = "README.md"
requires-python = ">=3.13"
dependencies = []

[project.scripts]
mycli = "mycli.cli.main:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py313"

[tool.mypy]
python_version = "3.13"
strict = true
packages = ["mycli"]
```

`README.md`

```markdown
# mycli

Local-first ReAct personal coding agent hosted in the terminal.

## Development

    uv run pytest
    uv run ruff check .
    uv run mypy src
```

`.gitignore`

```gitignore
.venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.mycli/
*.pyc
```

`src/mycli/__init__.py`

```python
__all__ = ["__version__"]

__version__ = "0.1.0"
```

`src/mycli/cli/main.py`

```python
from __future__ import annotations

import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycli")
    parser.add_argument("--session", default="default", help="Session identifier")
    return parser


def main() -> int:
    build_parser().parse_args()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **步骤 4：运行初始化测试并检查 CLI help**

运行：`uv run pytest tests/unit/cli/test_main.py -v`  
预期：PASS

运行：`uv run mycli --help`  
预期：PASS，且 help 输出包含 `--session`

- [ ] **步骤 5：提交**

```bash
git add pyproject.toml README.md .gitignore src/mycli/__init__.py src/mycli/cli/__init__.py src/mycli/cli/main.py tests/unit/cli/test_main.py
git commit -m "chore: bootstrap mycli package and cli shell"
```

## 任务 2：定义类型化领域模型与配置解析

**文件：**
- 创建：`src/mycli/domain/__init__.py`
- 创建：`src/mycli/domain/conversation.py`
- 创建：`src/mycli/domain/memory.py`
- 创建：`src/mycli/domain/runtime.py`
- 创建：`src/mycli/domain/skills.py`
- 创建：`src/mycli/domain/tools.py`
- 创建：`src/mycli/services/config_service.py`
- 测试：`tests/unit/domain/test_runtime.py`
- 测试：`tests/unit/services/test_config_service.py`

- [ ] **步骤 1：编写失败的领域模型与配置测试**

`tests/unit/domain/test_runtime.py`

```python
from pathlib import Path

from mycli.domain.runtime import AgentConfig, RiskLevel


def test_agent_config_defaults_are_stable(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)
    assert config.max_steps == 4
    assert config.session_id == "default"
    assert config.auto_approve_medium is True


def test_risk_level_values_are_stringy() -> None:
    assert RiskLevel.LOW.value == "low"
    assert RiskLevel.HIGH.value == "high"
```

`tests/unit/services/test_config_service.py`

```python
from pathlib import Path

from mycli.services.config_service import resolve_config


def test_resolve_config_prefers_cli_over_env_and_files(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".config").mkdir()
    (home_dir / ".config" / "mycli").mkdir()
    (workspace / ".mycli").mkdir()

    (home_dir / ".config" / "mycli" / "config.toml").write_text(
        'model = "user-model"\nmax_steps = 9\n',
        encoding="utf-8",
    )
    (workspace / ".mycli" / "config.toml").write_text(
        'model = "project-model"\nmax_steps = 7\n',
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"model": "cli-model", "session": "cli-session"},
        env={
            "MYCLI_MODEL": "env-model",
            "MYCLI_BASE_URL": "https://example.invalid/v1",
            "MYCLI_API_KEY": "test-token",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.model == "cli-model"
    assert config.session_id == "cli-session"
    assert config.max_steps == 7
    assert config.api_base_url == "https://example.invalid/v1"
    assert config.api_key == "test-token"
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/domain/test_runtime.py tests/unit/services/test_config_service.py -v`  
预期：FAIL，并出现缺少 domain 和 service 模块的导入错误

- [ ] **步骤 3：编写最小领域模型与配置实现**

`src/mycli/domain/conversation.py`

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(slots=True, frozen=True)
class Message:
    role: Role
    content: str


@dataclass(slots=True)
class Conversation:
    session_id: str
    messages: list[Message] = field(default_factory=list)

    def append(self, message: Message) -> None:
        self.messages.append(message)
```

`src/mycli/domain/memory.py`

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class MemoryKind(StrEnum):
    PREFERENCE = "preference"
    PROJECT_NOTE = "project_note"
    SESSION_SUMMARY = "session_summary"


@dataclass(slots=True, frozen=True)
class MemoryRecord:
    kind: MemoryKind
    key: str
    value: str
    tags: tuple[str, ...] = field(default_factory=tuple)
```

`src/mycli/domain/skills.py`

```python
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class SkillDefinition:
    name: str
    description: str
    trigger_hints: tuple[str, ...]
    body: str
    source_path: str
    guardrails: tuple[str, ...] = field(default_factory=tuple)
```

`src/mycli/domain/tools.py`

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class ToolCall:
    name: str
    arguments: dict[str, Any]
    reason: str


@dataclass(slots=True, frozen=True)
class ToolResult:
    success: bool
    summary: str
    artifacts: dict[str, Any] = field(default_factory=dict)
    raw_payload: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
```

`src/mycli/domain/runtime.py`

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from mycli.domain.memory import MemoryRecord
from mycli.domain.skills import SkillDefinition
from mycli.domain.tools import ToolCall


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass(slots=True, frozen=True)
class AgentConfig:
    workspace_root: Path
    model: str = "gpt-5"
    api_base_url: str = "https://api.openai.com/v1"
    api_key: str | None = None
    session_id: str = "default"
    max_steps: int = 4
    auto_approve_medium: bool = True


@dataclass(slots=True, frozen=True)
class PendingApproval:
    tool_call: ToolCall
    risk_level: RiskLevel
    reason: str
    preview: str


@dataclass(slots=True, frozen=True)
class ExecutionContext:
    config: AgentConfig
    memory_records: tuple[MemoryRecord, ...] = ()
    active_skill: SkillDefinition | None = None


@dataclass(slots=True, frozen=True)
class ModelDecision:
    assistant_message: str | None = None
    progress_message: str | None = None
    tool_call: ToolCall | None = None
    done: bool = False


@dataclass(slots=True, frozen=True)
class TurnResponse:
    assistant_message: str
    progress_updates: tuple[str, ...] = field(default_factory=tuple)
    plan_steps: tuple[str, ...] = field(default_factory=tuple)
    pending_approval: PendingApproval | None = None
```

`src/mycli/services/config_service.py`

```python
from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Mapping

from mycli.domain.runtime import AgentConfig


def _read_toml(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        return tomllib.load(handle)


def resolve_config(
    cli_args: Mapping[str, object],
    env: Mapping[str, str],
    cwd: Path,
    home: Path,
) -> AgentConfig:
    user_config = _read_toml(home / ".config" / "mycli" / "config.toml")
    project_config = _read_toml(cwd / ".mycli" / "config.toml")

    model = str(
        cli_args.get("model")
        or env.get("MYCLI_MODEL")
        or project_config.get("model")
        or user_config.get("model")
        or "gpt-5"
    )
    api_base_url = str(
        env.get("MYCLI_BASE_URL")
        or project_config.get("api_base_url")
        or user_config.get("api_base_url")
        or "https://api.openai.com/v1"
    )
    api_key = env.get("MYCLI_API_KEY") or None
    session_id = str(cli_args.get("session") or "default")
    max_steps = int(project_config.get("max_steps") or user_config.get("max_steps") or 4)

    return AgentConfig(
        workspace_root=cwd,
        model=model,
        api_base_url=api_base_url,
        api_key=api_key,
        session_id=session_id,
        max_steps=max_steps,
        auto_approve_medium=True,
    )
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/domain/test_runtime.py tests/unit/services/test_config_service.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/domain src/mycli/services/config_service.py tests/unit/domain/test_runtime.py tests/unit/services/test_config_service.py
git commit -m "feat: add core domain models and config resolution"
```

## 任务 3：添加本地 memory 与 session 持久化

**文件：**
- 创建：`src/mycli/infrastructure/filesystem.py`
- 创建：`src/mycli/services/memory_service.py`
- 创建：`src/mycli/services/session_service.py`
- 测试：`tests/unit/services/test_memory_service.py`
- 测试：`tests/unit/services/test_session_service.py`

- [ ] **步骤 1：编写失败的 memory 与 session 测试**

`tests/unit/services/test_memory_service.py`

```python
from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.services.memory_service import MemoryService


def test_memory_service_round_trips_preferences_and_project_notes(tmp_path: Path) -> None:
    service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path / "workspace")

    service.save_preference("tone", "concise")
    service.save_project_note(
        MemoryRecord(kind=MemoryKind.PROJECT_NOTE, key="entrypoint", value="src/mycli/cli/main.py")
    )
    service.append_session_summary("demo", "Inspected the repo root")

    assert service.load_preferences()["tone"] == "concise"
    notes = service.search_project_notes("entry")
    assert notes[0].value == "src/mycli/cli/main.py"
    assert service.load_session_summaries("demo") == ["Inspected the repo root"]
```

`tests/unit/services/test_session_service.py`

```python
from pathlib import Path

from mycli.domain.conversation import Conversation, Message
from mycli.services.session_service import SessionService


def test_session_service_persists_conversation(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="hello"))

    service.save_conversation(conversation)
    loaded = service.load_conversation("demo")

    assert loaded.session_id == "demo"
    assert loaded.messages[0].content == "hello"
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/services/test_memory_service.py tests/unit/services/test_session_service.py -v`  
预期：FAIL，并出现缺少 service 或 infrastructure 模块的错误

- [ ] **步骤 3：编写本地持久化实现**

`src/mycli/infrastructure/filesystem.py`

```python
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    ensure_parent(path)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
```

`src/mycli/services/memory_service.py`

```python
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.infrastructure.filesystem import read_json, write_json


class MemoryService:
    def __init__(self, home_dir: Path, workspace_root: Path) -> None:
        self._preferences_path = home_dir / ".mycli" / "preferences.json"
        self._project_notes_path = workspace_root / ".mycli" / "project_memory.json"
        self._sessions_root = home_dir / ".mycli" / "sessions"

    def load_preferences(self) -> dict[str, str]:
        return dict(read_json(self._preferences_path, {}))

    def save_preference(self, key: str, value: str) -> None:
        payload = self.load_preferences()
        payload[key] = value
        write_json(self._preferences_path, payload)

    def save_project_note(self, record: MemoryRecord) -> None:
        payload = list(read_json(self._project_notes_path, []))
        payload.append(asdict(record))
        write_json(self._project_notes_path, payload)

    def search_project_notes(self, query: str) -> list[MemoryRecord]:
        payload = read_json(self._project_notes_path, [])
        matches: list[MemoryRecord] = []
        for item in payload:
            if query.lower() in item["key"].lower() or query.lower() in item["value"].lower():
                matches.append(
                    MemoryRecord(
                        kind=MemoryKind(item["kind"]),
                        key=item["key"],
                        value=item["value"],
                        tags=tuple(item.get("tags", [])),
                    )
                )
        return matches

    def append_session_summary(self, session_id: str, summary: str) -> None:
        path = self._sessions_root / f"{session_id}-summary.json"
        payload = list(read_json(path, []))
        payload.append(summary)
        write_json(path, payload)

    def load_session_summaries(self, session_id: str) -> list[str]:
        path = self._sessions_root / f"{session_id}-summary.json"
        return list(read_json(path, []))
```

`src/mycli/services/session_service.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Conversation, Message
from mycli.infrastructure.filesystem import read_json, write_json


class SessionService:
    def __init__(self, home_dir: Path) -> None:
        self._sessions_root = home_dir / ".mycli" / "sessions"

    def save_conversation(self, conversation: Conversation) -> None:
        payload = {
            "session_id": conversation.session_id,
            "messages": [
                {"role": message.role, "content": message.content}
                for message in conversation.messages
            ],
        }
        write_json(self._sessions_root / f"{conversation.session_id}.json", payload)

    def load_conversation(self, session_id: str) -> Conversation:
        payload = read_json(self._sessions_root / f"{session_id}.json", None)
        conversation = Conversation(session_id=session_id)
        if payload is None:
            return conversation
        for item in payload["messages"]:
            conversation.append(Message(role=item["role"], content=item["content"]))
        return conversation
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/services/test_memory_service.py tests/unit/services/test_session_service.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/infrastructure/filesystem.py src/mycli/services/memory_service.py src/mycli/services/session_service.py tests/unit/services/test_memory_service.py tests/unit/services/test_session_service.py
git commit -m "feat: add local memory and session persistence"
```

## 任务 4：从内置目录和用户本地目录加载提示词型 skills

**文件：**
- 创建：`src/mycli/services/skill_registry.py`
- 创建：`src/mycli/prompts/skills/repository-analysis.md`
- 创建：`src/mycli/prompts/skills/code-review.md`
- 测试：`tests/unit/services/test_skill_registry.py`

- [ ] **步骤 1：编写失败的 skill registry 测试**

```python
from pathlib import Path

from mycli.services.skill_registry import SkillRegistry


def test_skill_registry_prefers_user_skill_over_builtin(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)

    (builtin_dir / "repository-analysis.md").write_text(
        '---\nname = "repository-analysis"\ndescription = "Builtin"\ntrigger_hints = ["repo"]\n---\nBuiltin body\n',
        encoding="utf-8",
    )
    (user_dir / "repository-analysis.md").write_text(
        '---\nname = "repository-analysis"\ndescription = "User override"\ntrigger_hints = ["repo"]\n---\nUser body\n',
        encoding="utf-8",
    )

    registry = SkillRegistry(builtin_root=builtin_dir, user_root=user_dir)

    skill = registry.get("repository-analysis")
    assert skill is not None
    assert skill.description == "User override"
    assert skill.body == "User body"
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/services/test_skill_registry.py -v`  
预期：FAIL，并出现缺少 registry 实现的错误

- [ ] **步骤 3：编写 skill registry 与内置 skills**

`src/mycli/services/skill_registry.py`

```python
from __future__ import annotations

from pathlib import Path
import textwrap

import tomllib

from mycli.domain.skills import SkillDefinition


class SkillRegistry:
    def __init__(self, builtin_root: Path, user_root: Path) -> None:
        self._skills: dict[str, SkillDefinition] = {}
        self._load_directory(builtin_root)
        self._load_directory(user_root)

    def _load_directory(self, root: Path) -> None:
        if not root.exists():
            return
        for path in sorted(root.glob("*.md")):
            skill = self._parse_skill(path)
            self._skills[skill.name] = skill

    def _parse_skill(self, path: Path) -> SkillDefinition:
        raw_text = path.read_text(encoding="utf-8")
        _, frontmatter, body = raw_text.split("---", maxsplit=2)
        payload = tomllib.loads(frontmatter)
        return SkillDefinition(
            name=str(payload["name"]),
            description=str(payload["description"]),
            trigger_hints=tuple(payload.get("trigger_hints", [])),
            body=textwrap.dedent(body).strip(),
            source_path=str(path),
        )

    def get(self, name: str) -> SkillDefinition | None:
        return self._skills.get(name)

    def list_names(self) -> list[str]:
        return sorted(self._skills)
```

`src/mycli/prompts/skills/repository-analysis.md`

```markdown
---
name = "repository-analysis"
description = "Guide the agent to proactively inspect repository structure and summarize findings"
trigger_hints = ["repository", "repo", "project", "entrypoint"]
---
Inspect the repository before answering.
Prefer factual summaries grounded in files and directories.
Call tools when information is missing.
Explain likely entrypoints, responsibilities, and next reading steps.
```

`src/mycli/prompts/skills/code-review.md`

```markdown
---
name = "code-review"
description = "Guide the agent to prioritize correctness risks and missing tests"
trigger_hints = ["review", "bug", "risk", "regression"]
---
Look for correctness issues first.
Prefer concrete findings with file references.
Mention missing tests before style concerns.
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/services/test_skill_registry.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/services/skill_registry.py src/mycli/prompts/skills/repository-analysis.md src/mycli/prompts/skills/code-review.md tests/unit/services/test_skill_registry.py
git commit -m "feat: load builtin and user prompt skills"
```

## 任务 5：添加只读 tools 与 safety policy

**文件：**
- 创建：`src/mycli/tools/contracts.py`
- 创建：`src/mycli/tools/list_directory.py`
- 创建：`src/mycli/tools/read_file.py`
- 创建：`src/mycli/tools/search_text.py`
- 创建：`src/mycli/services/safety_policy.py`
- 测试：`tests/unit/tools/test_read_only_tools.py`
- 测试：`tests/unit/services/test_safety_policy.py`

- [ ] **步骤 1：编写失败的只读 tool 与 safety 测试**

`tests/unit/tools/test_read_only_tools.py`

```python
from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.read_file import ReadFileTool
from mycli.tools.search_text import SearchTextTool


def test_read_only_tools_return_grounded_results(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    list_tool = ListDirectoryTool(root)
    read_tool = ReadFileTool(root)
    search_tool = SearchTextTool(root)

    listed = list_tool.run(ToolCall(name="list_directory", arguments={"path": "."}, reason="inspect"))
    loaded = read_tool.run(ToolCall(name="read_file", arguments={"path": "README.md"}, reason="inspect"))
    searched = search_tool.run(ToolCall(name="search_text", arguments={"query": "hello"}, reason="inspect"))

    assert listed.success is True
    assert "README.md" in listed.summary
    assert loaded.raw_payload["content"] == "hello world\n"
    assert searched.raw_payload["matches"][0]["path"] == "README.md"
```

`tests/unit/services/test_safety_policy.py`

```python
from mycli.domain.runtime import RiskLevel
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy


def test_safety_policy_marks_read_only_tools_low_risk() -> None:
    policy = SafetyPolicy()
    call = ToolCall(name="read_file", arguments={"path": "README.md"}, reason="inspect")
    assert policy.classify(call) is RiskLevel.LOW
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/tools/test_read_only_tools.py tests/unit/services/test_safety_policy.py -v`  
预期：FAIL，并出现缺少 tools 或 safety policy 的错误

- [ ] **步骤 3：编写 tool 契约、只读 tools 与 safety policy**

`src/mycli/tools/contracts.py`

```python
from __future__ import annotations

from typing import Protocol

from mycli.domain.tools import ToolCall, ToolResult


class Tool(Protocol):
    name: str

    def run(self, call: ToolCall) -> ToolResult:
        ...


class ToolRegistry:
    def __init__(self, tools: list[Tool]) -> None:
        self._tools = {tool.name: tool for tool in tools}

    def run(self, call: ToolCall) -> ToolResult:
        return self._tools[call.name].run(call)

    def list_names(self) -> list[str]:
        return sorted(self._tools)
```

`src/mycli/tools/list_directory.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult


class ListDirectoryTool:
    name = "list_directory"

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def run(self, call: ToolCall) -> ToolResult:
        target = (self._workspace_root / call.arguments["path"]).resolve()
        entries = sorted(path.name for path in target.iterdir())
        return ToolResult(
            success=True,
            summary=", ".join(entries),
            raw_payload={"entries": entries},
        )
```

`src/mycli/tools/read_file.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult


class ReadFileTool:
    name = "read_file"

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def run(self, call: ToolCall) -> ToolResult:
        target = (self._workspace_root / call.arguments["path"]).resolve()
        content = target.read_text(encoding="utf-8")
        return ToolResult(
            success=True,
            summary=f"Read {call.arguments['path']}",
            raw_payload={"path": call.arguments["path"], "content": content},
        )
```

`src/mycli/tools/search_text.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult


class SearchTextTool:
    name = "search_text"

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def run(self, call: ToolCall) -> ToolResult:
        query = str(call.arguments["query"]).lower()
        matches: list[dict[str, object]] = []
        for path in self._workspace_root.rglob("*"):
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
            for line_number, line in enumerate(text.splitlines(), start=1):
                if query in line.lower():
                    matches.append(
                        {
                            "path": str(path.relative_to(self._workspace_root)),
                            "line_number": line_number,
                            "line": line,
                        }
                    )
        return ToolResult(
            success=True,
            summary=f"Found {len(matches)} matches for {call.arguments['query']}",
            raw_payload={"matches": matches},
        )
```

`src/mycli/services/safety_policy.py`

```python
from __future__ import annotations

from mycli.domain.runtime import RiskLevel
from mycli.domain.tools import ToolCall


class SafetyPolicy:
    def classify(self, call: ToolCall) -> RiskLevel:
        if call.name in {"list_directory", "read_file", "search_text"}:
            return RiskLevel.LOW
        if call.name in {"edit_file"}:
            return RiskLevel.MEDIUM
        return RiskLevel.HIGH
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/tools/test_read_only_tools.py tests/unit/services/test_safety_policy.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/tools/contracts.py src/mycli/tools/list_directory.py src/mycli/tools/read_file.py src/mycli/tools/search_text.py src/mycli/services/safety_policy.py tests/unit/tools/test_read_only_tools.py tests/unit/services/test_safety_policy.py
git commit -m "feat: add read-only tools and safety policy"
```

## 任务 6：构建可 stub 的 ReAct runtime 与只读 turn service

**文件：**
- 创建：`src/mycli/infrastructure/openai_client.py`
- 创建：`src/mycli/prompts/system.py`
- 创建：`src/mycli/prompts/react.py`
- 创建：`src/mycli/agents/react_loop.py`
- 创建：`src/mycli/application/turn_service.py`
- 测试：`tests/unit/agents/test_react_loop.py`
- 测试：`tests/integration/test_turn_service.py`

- [ ] **步骤 1：编写失败的 ReAct loop 与 turn service 测试**

`tests/unit/agents/test_react_loop.py`

```python
from pathlib import Path

from mycli.domain.runtime import AgentConfig, ExecutionContext, ModelDecision
from mycli.domain.tools import ToolCall, ToolResult
from mycli.agents.react_loop import ReactAgent


class FakeModel:
    def __init__(self) -> None:
        self._decisions = [
            ModelDecision(
                progress_message="Inspecting the workspace",
                tool_call=ToolCall(name="list_directory", arguments={"path": "."}, reason="find entrypoints"),
            ),
            ModelDecision(
                assistant_message="The workspace root contains README.md and src/",
                done=True,
            ),
        ]

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return self._decisions.pop(0)


class FakeToolRegistry:
    def run(self, call: ToolCall) -> ToolResult:
        return ToolResult(success=True, summary="README.md, src", raw_payload={"entries": ["README.md", "src"]})


def test_react_agent_runs_until_done(tmp_path: Path) -> None:
    agent = ReactAgent(model_client=FakeModel(), tool_registry=FakeToolRegistry())
    response = agent.run(
        user_message="Help me inspect the project",
        context=ExecutionContext(config=AgentConfig(workspace_root=tmp_path)),
    )

    assert response.assistant_message == "The workspace root contains README.md and src/"
    assert response.progress_updates == ("Inspecting the workspace",)
```

`tests/integration/test_turn_service.py`

```python
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.domain.runtime import AgentConfig, ExecutionContext, ModelDecision
from mycli.domain.tools import ToolCall, ToolResult


class FakeModel:
    def __init__(self) -> None:
        self._decisions = [
            ModelDecision(
                progress_message="Checking the repository structure",
                tool_call=ToolCall(name="list_directory", arguments={"path": "."}, reason="inspect root"),
            ),
            ModelDecision(assistant_message="The repo starts with src/ and tests/", done=True),
        ]

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return self._decisions.pop(0)


class FakeToolRegistry:
    def run(self, call: ToolCall) -> ToolResult:
        return ToolResult(success=True, summary="src, tests", raw_payload={"entries": ["src", "tests"]})


def test_turn_service_returns_assistant_message_and_persists_session(tmp_path: Path) -> None:
    service = TurnService(
        model_client=FakeModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("How does this repo start?")

    assert response.assistant_message == "The repo starts with src/ and tests/"
    assert response.progress_updates == ("Checking the repository structure",)
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/agents/test_react_loop.py tests/integration/test_turn_service.py -v`  
预期：FAIL，并出现缺少 runtime 模块的错误

- [ ] **步骤 3：编写 ReAct runtime、prompt 辅助与 turn service**

`src/mycli/infrastructure/openai_client.py`

```python
from __future__ import annotations

import json
from urllib import request

from mycli.domain.runtime import ModelDecision
from mycli.domain.tools import ToolCall


class OpenAIChatClient:
    def __init__(self, api_key: str, base_url: str, model: str) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model

    def decide(self, prompt: str) -> ModelDecision:
        body = json.dumps(
            {
                "model": self._model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
            }
        ).encode("utf-8")
        http_request = request.Request(
            url=f"{self._base_url}/chat/completions",
            data=body,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with request.urlopen(http_request) as response:
            payload = json.loads(response.read().decode("utf-8"))

        content = payload["choices"][0]["message"]["content"]
        decision_payload = json.loads(content)
        tool_call = None
        if decision_payload.get("tool_name"):
            tool_call = ToolCall(
                name=decision_payload["tool_name"],
                arguments=decision_payload.get("arguments", {}),
                reason=decision_payload.get("reason", "model requested tool"),
            )
        return ModelDecision(
            assistant_message=decision_payload.get("assistant_message"),
            progress_message=decision_payload.get("progress_message"),
            tool_call=tool_call,
            done=bool(decision_payload.get("done", False)),
        )
```

`src/mycli/prompts/system.py`

```python
from __future__ import annotations


def build_system_prompt() -> str:
    return (
        "You are mycli, a local-first ReAct coding agent. "
        "Prefer grounded answers. Use tools when facts are missing. "
        "Keep progress updates concise. "
        "Return JSON with keys assistant_message, progress_message, "
        "tool_name, arguments, reason, and done."
    )
```

`src/mycli/prompts/react.py`

```python
from __future__ import annotations

from mycli.domain.runtime import ExecutionContext


def build_react_prompt(user_message: str, context: ExecutionContext) -> str:
    skill_name = context.active_skill.name if context.active_skill else "none"
    memory_summary = "; ".join(record.value for record in context.memory_records) or "none"
    return (
        f"User goal: {user_message}\n"
        f"Active skill: {skill_name}\n"
        f"Memory: {memory_summary}\n"
        "Decide the next best action."
    )
```

`src/mycli/agents/react_loop.py`

```python
from __future__ import annotations

from mycli.domain.runtime import ExecutionContext, TurnResponse
from mycli.domain.tools import ToolResult
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt


class ReactAgent:
    def __init__(self, model_client, tool_registry) -> None:
        self._model_client = model_client
        self._tool_registry = tool_registry

    def run(self, user_message: str, context: ExecutionContext) -> TurnResponse:
        progress_updates: list[str] = []
        last_tool_result: ToolResult | None = None

        for _step in range(context.config.max_steps):
            prompt = "\n\n".join(
                [
                    build_system_prompt(),
                    build_react_prompt(user_message=user_message, context=context),
                    f"Last tool result: {last_tool_result.summary if last_tool_result else 'none'}",
                ]
            )
            decision = self._model_client.decide(prompt)
            if decision.progress_message:
                progress_updates.append(decision.progress_message)
            if decision.tool_call is not None:
                last_tool_result = self._tool_registry.run(decision.tool_call)
                continue
            if decision.done and decision.assistant_message:
                return TurnResponse(
                    assistant_message=decision.assistant_message,
                    progress_updates=tuple(progress_updates),
                )

        return TurnResponse(
            assistant_message="I hit the step limit before reaching a confident answer.",
            progress_updates=tuple(progress_updates),
        )
```

`src/mycli/application/turn_service.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.agents.react_loop import ReactAgent
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import AgentConfig, ExecutionContext, TurnResponse
from mycli.services.memory_service import MemoryService
from mycli.services.session_service import SessionService


class TurnService:
    def __init__(self, model_client, tool_registry, config: AgentConfig, home_dir: Path) -> None:
        self._agent = ReactAgent(model_client=model_client, tool_registry=tool_registry)
        self._config = config
        self._memory_service = MemoryService(home_dir=home_dir, workspace_root=config.workspace_root)
        self._session_service = SessionService(home_dir=home_dir)

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        conversation = self._session_service.load_conversation(self._config.session_id)
        conversation.append(Message(role="user", content=user_message))

        context = ExecutionContext(config=self._config)
        response = self._agent.run(user_message=user_message, context=context)

        conversation.append(Message(role="assistant", content=response.assistant_message))
        self._session_service.save_conversation(conversation)
        return response
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/agents/test_react_loop.py tests/integration/test_turn_service.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/infrastructure/openai_client.py src/mycli/prompts/system.py src/mycli/prompts/react.py src/mycli/agents/react_loop.py src/mycli/application/turn_service.py tests/unit/agents/test_react_loop.py tests/integration/test_turn_service.py
git commit -m "feat: add read-only react runtime and turn service"
```

## 任务 7：在带简洁进度反馈和 slash commands 的 REPL CLI 中承载 runtime

**文件：**
- 修改：`src/mycli/cli/main.py`
- 测试：`tests/integration/test_cli_repl.py`

- [ ] **步骤 1：编写失败的 CLI REPL 测试**

```python
from mycli.cli.main import run_repl


def test_run_repl_prints_help_and_stops_on_quit() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/help", "/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    assert any("/memory" in line for line in outputs)
    assert outputs[-1] == "Bye."
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/integration/test_cli_repl.py -v`  
预期：FAIL，并出现缺少 slash-command handler 的错误

- [ ] **步骤 3：扩展 CLI 宿主以支持 REPL 循环和 slash commands**

`src/mycli/cli/main.py`

```python
from __future__ import annotations

import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycli")
    parser.add_argument("--session", default="default", help="Session identifier")
    parser.add_argument("--model", default=None, help="Model override")
    return parser


def handle_slash_command(command: str) -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skill",
                "/skills",
                "/memory",
                "/plan",
                "/tools",
                "/session",
                "/confirm",
                "/quit",
            ]
        )
    if command == "/quit":
        return "quit"
    return f"Unknown command: {command}"


def run_repl(turn_handler, input_func=input, output_func=print) -> None:
    while True:
        raw = input_func("> ").strip()
        if not raw:
            continue
        if raw.startswith("/"):
            handled = handle_slash_command(raw)
            if handled == "quit":
                output_func("Bye.")
                return
            output_func(handled)
            continue
        output_func(turn_handler(raw))


def main() -> int:
    build_parser().parse_args()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **步骤 4：运行 REPL 命令测试**

运行：`uv run pytest tests/integration/test_cli_repl.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/cli/main.py tests/integration/test_cli_repl.py
git commit -m "feat: add repl command host and slash command surface"
```

## 任务 8：添加文件编辑、diff 预览与审批处理

**文件：**
- 创建：`src/mycli/tools/edit_file.py`
- 修改：`src/mycli/services/safety_policy.py`
- 修改：`src/mycli/agents/react_loop.py`
- 修改：`src/mycli/application/turn_service.py`
- 测试：`tests/unit/tools/test_edit_file_tool.py`
- 测试：`tests/integration/test_turn_service.py`

- [ ] **步骤 1：编写失败的 edit tool 与审批测试**

`tests/unit/tools/test_edit_file_tool.py`

```python
from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.edit_file import EditFileTool


def test_edit_file_tool_returns_diff_preview(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("old line\n", encoding="utf-8")

    tool = EditFileTool(root)
    result = tool.run(
        ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "new line\n"},
            reason="update text",
        )
    )

    assert result.success is True
    assert "--- notes.txt" in result.raw_payload["diff"]
```

`tests/integration/test_turn_service.py`

```python
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.domain.runtime import AgentConfig, ModelDecision
from mycli.domain.tools import ToolCall


class ApprovalModel:
    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return ModelDecision(
            progress_message="Preparing a file update",
            tool_call=ToolCall(
                name="edit_file",
                arguments={"path": "README.md", "new_content": "updated\n"},
                reason="refresh README",
            ),
        )


class UnusedToolRegistry:
    def run(self, _call):
        raise AssertionError("edit_file should not execute before approval")


def test_turn_service_returns_pending_approval_for_medium_risk_edit(tmp_path: Path) -> None:
    service = TurnService(
        model_client=ApprovalModel(),
        tool_registry=UnusedToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="approval", auto_approve_medium=False),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("Update the README")

    assert response.pending_approval is not None
    assert response.pending_approval.tool_call.name == "edit_file"
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/tools/test_edit_file_tool.py tests/integration/test_turn_service.py -v`  
预期：FAIL，并出现缺少 edit tool 或审批处理逻辑的错误

- [ ] **步骤 3：实现 edit tool、diff 预览与审批路径**

`src/mycli/tools/edit_file.py`

```python
from __future__ import annotations

from difflib import unified_diff
from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult


class EditFileTool:
    name = "edit_file"

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def run(self, call: ToolCall) -> ToolResult:
        target = (self._workspace_root / call.arguments["path"]).resolve()
        before = target.read_text(encoding="utf-8") if target.exists() else ""
        after = str(call.arguments["new_content"])
        diff = "".join(
            unified_diff(
                before.splitlines(keepends=True),
                after.splitlines(keepends=True),
                fromfile=call.arguments["path"],
                tofile=call.arguments["path"],
            )
        )
        target.write_text(after, encoding="utf-8")
        return ToolResult(
            success=True,
            summary=f"Updated {call.arguments['path']}",
            raw_payload={"diff": diff},
        )
```

`src/mycli/services/safety_policy.py`

```python
from __future__ import annotations

from mycli.domain.runtime import RiskLevel
from mycli.domain.tools import ToolCall


class SafetyPolicy:
    def classify(self, call: ToolCall) -> RiskLevel:
        if call.name in {"list_directory", "read_file", "search_text"}:
            return RiskLevel.LOW
        if call.name == "edit_file":
            return RiskLevel.MEDIUM
        return RiskLevel.HIGH
```

`src/mycli/agents/react_loop.py`

```python
from __future__ import annotations

from mycli.domain.runtime import ExecutionContext, PendingApproval, RiskLevel, TurnResponse
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt


class ReactAgent:
    def __init__(self, model_client, tool_registry, safety_policy) -> None:
        self._model_client = model_client
        self._tool_registry = tool_registry
        self._safety_policy = safety_policy

    def run(self, user_message: str, context: ExecutionContext) -> TurnResponse:
        progress_updates: list[str] = []
        last_tool_result = None

        for _step in range(context.config.max_steps):
            prompt = "\n\n".join(
                [
                    build_system_prompt(),
                    build_react_prompt(user_message=user_message, context=context),
                    f"Last tool result: {last_tool_result.summary if last_tool_result else 'none'}",
                ]
            )
            decision = self._model_client.decide(prompt)
            if decision.progress_message:
                progress_updates.append(decision.progress_message)
            if decision.tool_call is not None:
                risk = self._safety_policy.classify(decision.tool_call)
                if risk is RiskLevel.MEDIUM and context.config.auto_approve_medium is False:
                    return TurnResponse(
                        assistant_message="Approval required before editing the file.",
                        progress_updates=tuple(progress_updates),
                        pending_approval=PendingApproval(
                            tool_call=decision.tool_call,
                            risk_level=risk,
                            reason=decision.tool_call.reason,
                            preview="Medium-risk edit requested.",
                        ),
                    )
                if risk is RiskLevel.HIGH:
                    return TurnResponse(
                        assistant_message="Approval required before executing this action.",
                        progress_updates=tuple(progress_updates),
                        pending_approval=PendingApproval(
                            tool_call=decision.tool_call,
                            risk_level=risk,
                            reason=decision.tool_call.reason,
                            preview="High-risk action requested.",
                        ),
                    )
                last_tool_result = self._tool_registry.run(decision.tool_call)
                continue
            if decision.done and decision.assistant_message:
                return TurnResponse(
                    assistant_message=decision.assistant_message,
                    progress_updates=tuple(progress_updates),
                )

        return TurnResponse(
            assistant_message="I hit the step limit before reaching a confident answer.",
            progress_updates=tuple(progress_updates),
        )
```

`src/mycli/application/turn_service.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.agents.react_loop import ReactAgent
from mycli.domain.conversation import Message
from mycli.domain.runtime import AgentConfig, ExecutionContext, TurnResponse
from mycli.services.memory_service import MemoryService
from mycli.services.safety_policy import SafetyPolicy
from mycli.services.session_service import SessionService


class TurnService:
    def __init__(self, model_client, tool_registry, config: AgentConfig, home_dir: Path) -> None:
        self._agent = ReactAgent(
            model_client=model_client,
            tool_registry=tool_registry,
            safety_policy=SafetyPolicy(),
        )
        self._config = config
        self._memory_service = MemoryService(home_dir=home_dir, workspace_root=config.workspace_root)
        self._session_service = SessionService(home_dir=home_dir)

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        conversation = self._session_service.load_conversation(self._config.session_id)
        conversation.append(Message(role="user", content=user_message))
        context = ExecutionContext(config=self._config)
        response = self._agent.run(user_message=user_message, context=context)
        conversation.append(Message(role="assistant", content=response.assistant_message))
        self._session_service.save_conversation(conversation)
        return response
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/tools/test_edit_file_tool.py tests/integration/test_turn_service.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/tools/edit_file.py src/mycli/services/safety_policy.py src/mycli/agents/react_loop.py src/mycli/application/turn_service.py tests/unit/tools/test_edit_file_tool.py tests/integration/test_turn_service.py
git commit -m "feat: add file editing and approval handling"
```

## 任务 9：添加 shell 执行并补齐受 safety gate 约束的本地动作面

**文件：**
- 创建：`src/mycli/infrastructure/shell_adapter.py`
- 创建：`src/mycli/tools/run_shell.py`
- 修改：`src/mycli/services/safety_policy.py`
- 测试：`tests/unit/tools/test_run_shell.py`

- [ ] **步骤 1：编写失败的 shell tool 测试**

```python
from pathlib import Path

from mycli.domain.runtime import RiskLevel
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy
from mycli.tools.run_shell import RunShellTool


def test_shell_tool_executes_structured_args(tmp_path: Path) -> None:
    tool = RunShellTool(workspace_root=tmp_path)
    result = tool.run(
        ToolCall(
            name="run_shell",
            arguments={"args": ["python3", "-c", "print('ok')"]},
            reason="check shell wiring",
        )
    )
    assert result.success is True
    assert result.raw_payload["stdout"].strip() == "ok"


def test_safety_policy_marks_shell_high_risk() -> None:
    risk = SafetyPolicy().classify(
        ToolCall(name="run_shell", arguments={"args": ["python3", "-V"]}, reason="inspect")
    )
    assert risk is RiskLevel.HIGH
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/tools/test_run_shell.py -v`  
预期：FAIL，并出现缺少 shell adapter 或 shell tool 的错误

- [ ] **步骤 3：实现 shell adapter 与 shell tool**

`src/mycli/infrastructure/shell_adapter.py`

```python
from __future__ import annotations

import subprocess
from pathlib import Path


def run_command(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )
```

`src/mycli/tools/run_shell.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult
from mycli.infrastructure.shell_adapter import run_command


class RunShellTool:
    name = "run_shell"

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def run(self, call: ToolCall) -> ToolResult:
        args = list(call.arguments["args"])
        completed = run_command(args=args, cwd=self._workspace_root)
        return ToolResult(
            success=completed.returncode == 0,
            summary=f"Command exited with {completed.returncode}",
            raw_payload={"stdout": completed.stdout, "stderr": completed.stderr},
            error=None if completed.returncode == 0 else completed.stderr,
        )
```

`src/mycli/services/safety_policy.py`

```python
from __future__ import annotations

from mycli.domain.runtime import RiskLevel
from mycli.domain.tools import ToolCall


class SafetyPolicy:
    def classify(self, call: ToolCall) -> RiskLevel:
        if call.name in {"list_directory", "read_file", "search_text"}:
            return RiskLevel.LOW
        if call.name == "edit_file":
            return RiskLevel.MEDIUM
        if call.name == "run_shell":
            return RiskLevel.HIGH
        return RiskLevel.HIGH
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/tools/test_run_shell.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/infrastructure/shell_adapter.py src/mycli/tools/run_shell.py src/mycli/services/safety_policy.py tests/unit/tools/test_run_shell.py
git commit -m "feat: add structured shell tool and high-risk gating"
```

## 任务 10：将 memory、skills 与 tools 接入 ReAct 上下文并完成垂直切片

**文件：**
- 修改：`src/mycli/application/turn_service.py`
- 修改：`src/mycli/agents/react_loop.py`
- 修改：`src/mycli/cli/main.py`
- 测试：`tests/integration/test_turn_service.py`
- 测试：`tests/integration/test_cli_repl.py`

- [ ] **步骤 1：编写针对 memory 和 skill 感知 turn 的失败集成测试**

`tests/integration/test_turn_service.py`

```python
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.domain.runtime import AgentConfig, ModelDecision
from mycli.domain.tools import ToolCall, ToolResult


class ApprovalModel:
    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return ModelDecision(
            progress_message="Preparing a file update",
            tool_call=ToolCall(
                name="edit_file",
                arguments={"path": "README.md", "new_content": "updated\n"},
                reason="refresh README",
            ),
        )


class SkillAwareModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self._decisions = [
            ModelDecision(
                progress_message="Inspecting the repository with repository-analysis",
                tool_call=ToolCall(name="list_directory", arguments={"path": "."}, reason="inspect root"),
            ),
            ModelDecision(assistant_message="Start with src/mycli/cli/main.py and src/mycli/application/turn_service.py", done=True),
        ]

    def decide(self, prompt: str) -> ModelDecision:
        self.prompts.append(prompt)
        return self._decisions.pop(0)


class FakeToolRegistry:
    def run(self, _call: ToolCall) -> ToolResult:
        return ToolResult(success=True, summary="src, tests", raw_payload={"entries": ["src", "tests"]})


class UnusedToolRegistry:
    def run(self, _call):
        raise AssertionError("edit_file should not execute before approval")


def test_turn_service_returns_pending_approval_for_medium_risk_edit(tmp_path: Path) -> None:
    service = TurnService(
        model_client=ApprovalModel(),
        tool_registry=UnusedToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="approval", auto_approve_medium=False),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("Update the README")

    assert response.pending_approval is not None
    assert response.pending_approval.tool_call.name == "edit_file"


def test_turn_service_injects_memory_and_skill_context(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    (home_dir / ".mycli").mkdir()
    (workspace / ".mycli").mkdir()
    (home_dir / ".mycli" / "preferences.json").write_text(
        '{"tone": "concise"}',
        encoding="utf-8",
    )
    (workspace / ".mycli" / "project_memory.json").write_text(
        '[{"kind": "project_note", "key": "entrypoint", "value": "src/mycli/cli/main.py", "tags": []}]',
        encoding="utf-8",
    )

    model = SkillAwareModel()
    service = TurnService(
        model_client=model,
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=workspace),
        home_dir=home_dir,
    )

    response = service.handle_user_turn("Help me understand this repository")

    assert "src/mycli/cli/main.py" in response.assistant_message
    assert "repository-analysis" in model.prompts[0]
    assert "src/mycli/cli/main.py" in model.prompts[0]
    assert "concise" in model.prompts[0]
```

`tests/integration/test_cli_repl.py`

```python
from mycli.cli.main import handle_slash_command


def test_help_lists_approval_and_memory_controls() -> None:
    output = handle_slash_command("/help")
    assert "/memory" in output
    assert "/confirm" in output
```

- [ ] **步骤 2：运行集成测试并确认失败**

运行：`uv run pytest tests/integration/test_turn_service.py tests/integration/test_cli_repl.py -v`  
预期：FAIL，因为 turn 上下文还没有加载 memory 或 skills

- [ ] **步骤 3：通过加载 memory、匹配 skills 和展示简洁进度来完成垂直切片**

`src/mycli/application/turn_service.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.agents.react_loop import ReactAgent
from mycli.domain.conversation import Message
from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.runtime import AgentConfig, ExecutionContext, TurnResponse
from mycli.services.memory_service import MemoryService
from mycli.services.safety_policy import SafetyPolicy
from mycli.services.session_service import SessionService
from mycli.services.skill_registry import SkillRegistry


class TurnService:
    def __init__(self, model_client, tool_registry, config: AgentConfig, home_dir: Path) -> None:
        self._agent = ReactAgent(
            model_client=model_client,
            tool_registry=tool_registry,
            safety_policy=SafetyPolicy(),
        )
        self._config = config
        self._memory_service = MemoryService(home_dir=home_dir, workspace_root=config.workspace_root)
        self._session_service = SessionService(home_dir=home_dir)
        self._skill_registry = SkillRegistry(
            builtin_root=Path(__file__).resolve().parents[1] / "prompts" / "skills",
            user_root=home_dir / ".mycli" / "skills",
        )

    def _select_skill(self, user_message: str):
        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            skill = self._skill_registry.get(name)
            if skill and any(hint in lowered for hint in skill.trigger_hints):
                return skill
        return None

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        conversation = self._session_service.load_conversation(self._config.session_id)
        conversation.append(Message(role="user", content=user_message))

        preference_records = tuple(
            MemoryRecord(kind=MemoryKind.PREFERENCE, key=key, value=value)
            for key, value in self._memory_service.load_preferences().items()
        )
        project_records = tuple(
            self._memory_service.search_project_notes("entry")
        ) if "repo" in user_message.lower() else ()
        session_summary_records = tuple(
            MemoryRecord(kind=MemoryKind.SESSION_SUMMARY, key="recent", value=value)
            for value in self._memory_service.load_session_summaries(self._config.session_id)[-2:]
        )
        context = ExecutionContext(
            config=self._config,
            memory_records=preference_records + project_records + session_summary_records,
            active_skill=self._select_skill(user_message),
        )

        response = self._agent.run(user_message=user_message, context=context)
        conversation.append(Message(role="assistant", content=response.assistant_message))
        self._session_service.save_conversation(conversation)
        self._memory_service.append_session_summary(self._config.session_id, response.assistant_message)
        return response
```

`src/mycli/agents/react_loop.py`

```python
from __future__ import annotations

from mycli.domain.runtime import ExecutionContext, PendingApproval, RiskLevel, TurnResponse
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt


class ReactAgent:
    def __init__(self, model_client, tool_registry, safety_policy) -> None:
        self._model_client = model_client
        self._tool_registry = tool_registry
        self._safety_policy = safety_policy

    def run(self, user_message: str, context: ExecutionContext) -> TurnResponse:
        progress_updates: list[str] = []
        last_tool_result = None

        for _step in range(context.config.max_steps):
            prompt = "\n\n".join(
                [
                    build_system_prompt(),
                    build_react_prompt(user_message=user_message, context=context),
                    f"Last tool result: {last_tool_result.summary if last_tool_result else 'none'}",
                ]
            )
            decision = self._model_client.decide(prompt)
            if decision.progress_message:
                progress_updates.append(decision.progress_message)
            if decision.tool_call is not None:
                risk = self._safety_policy.classify(decision.tool_call)
                if risk is RiskLevel.HIGH or (
                    risk is RiskLevel.MEDIUM and context.config.auto_approve_medium is False
                ):
                    return TurnResponse(
                        assistant_message="Approval required before continuing.",
                        progress_updates=tuple(progress_updates),
                        pending_approval=PendingApproval(
                            tool_call=decision.tool_call,
                            risk_level=risk,
                            reason=decision.tool_call.reason,
                            preview=f"Pending {decision.tool_call.name}",
                        ),
                    )
                last_tool_result = self._tool_registry.run(decision.tool_call)
                continue
            if decision.done and decision.assistant_message:
                return TurnResponse(
                    assistant_message=decision.assistant_message,
                    progress_updates=tuple(progress_updates),
                )

        return TurnResponse(
            assistant_message="I hit the step limit before reaching a confident answer.",
            progress_updates=tuple(progress_updates),
        )
```

`src/mycli/cli/main.py`

```python
from __future__ import annotations

import argparse
import os
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.infrastructure.openai_client import OpenAIChatClient
from mycli.services.config_service import resolve_config
from mycli.tools.contracts import ToolRegistry
from mycli.tools.edit_file import EditFileTool
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.read_file import ReadFileTool
from mycli.tools.run_shell import RunShellTool
from mycli.tools.search_text import SearchTextTool


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycli")
    parser.add_argument("--session", default="default", help="Session identifier")
    parser.add_argument("--model", default=None, help="Model override")
    return parser


def handle_slash_command(command: str, session_id: str = "default") -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skill",
                "/skills",
                "/memory",
                "/plan",
                "/tools",
                "/session",
                "/confirm",
                "/quit",
            ]
        )
    if command == "/session":
        return f"Session: {session_id}"
    if command == "/quit":
        return "quit"
    return f"Unknown command: {command}"


def build_turn_service(cli_args: dict[str, object]) -> TurnService:
    cwd = Path.cwd()
    home = Path.home()
    config = resolve_config(cli_args=cli_args, env=os.environ, cwd=cwd, home=home)
    if not config.api_key:
        raise RuntimeError("MYCLI_API_KEY is required")

    model_client = OpenAIChatClient(
        api_key=config.api_key,
        base_url=config.api_base_url,
        model=config.model,
    )
    tool_registry = ToolRegistry(
        [
            ListDirectoryTool(cwd),
            ReadFileTool(cwd),
            SearchTextTool(cwd),
            EditFileTool(cwd),
            RunShellTool(cwd),
        ]
    )
    return TurnService(model_client=model_client, tool_registry=tool_registry, config=config, home_dir=home)


def run_repl(turn_handler, input_func=input, output_func=print, session_id: str = "default") -> None:
    while True:
        raw = input_func("> ").strip()
        if not raw:
            continue
        if raw.startswith("/"):
            handled = handle_slash_command(raw, session_id=session_id)
            if handled == "quit":
                output_func("Bye.")
                return
            output_func(handled)
            continue
        rendered = turn_handler(raw)
        if isinstance(rendered, str):
            output_func(rendered)
            continue
        for line in rendered:
            output_func(line)


def main() -> int:
    args = vars(build_parser().parse_args())
    service = build_turn_service(args)

    def handle_user_message(raw: str) -> list[str]:
        response = service.handle_user_turn(raw)
        rendered: list[str] = [f"[progress] {update}" for update in response.progress_updates]
        if response.pending_approval is not None:
            rendered.append(f"[approval] {response.pending_approval.reason}")
        rendered.append(response.assistant_message)
        return rendered

    run_repl(handle_user_message, session_id=service._config.session_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **步骤 4：运行完整测试套件**

运行：`uv run pytest -v`  
预期：PASS

运行：`uv run ruff check .`  
预期：PASS

运行：`uv run mypy src`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/application/turn_service.py src/mycli/agents/react_loop.py src/mycli/cli/main.py tests/integration/test_turn_service.py tests/integration/test_cli_repl.py
git commit -m "feat: finish react agent vertical slice"
```

## 任务 11：持久化待审批动作，并让 `/confirm` 恢复执行

**文件：**
- 修改：`src/mycli/services/session_service.py`
- 修改：`src/mycli/application/turn_service.py`
- 修改：`src/mycli/cli/main.py`
- 测试：`tests/unit/services/test_session_service.py`
- 测试：`tests/integration/test_cli_repl.py`

- [ ] **步骤 1：编写失败的待审批测试**

`tests/unit/services/test_session_service.py`

```python
from pathlib import Path

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import PendingApproval, RiskLevel
from mycli.domain.tools import ToolCall
from mycli.services.session_service import SessionService


def test_session_service_persists_conversation(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="hello"))

    service.save_conversation(conversation)
    loaded = service.load_conversation("demo")

    assert loaded.session_id == "demo"
    assert loaded.messages[0].content == "hello"


def test_session_service_round_trips_pending_approval(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    approval = PendingApproval(
        tool_call=ToolCall(
            name="edit_file",
            arguments={"path": "README.md", "new_content": "updated\n"},
            reason="refresh README",
        ),
        risk_level=RiskLevel.MEDIUM,
        reason="refresh README",
        preview="README diff preview",
    )

    service.save_pending_approval("demo", approval)
    loaded = service.load_pending_approval("demo")

    assert loaded is not None
    assert loaded.tool_call.name == "edit_file"
    service.clear_pending_approval("demo")
    assert service.load_pending_approval("demo") is None
```

`tests/integration/test_cli_repl.py`

```python
from mycli.cli.main import handle_slash_command, run_repl


def test_handle_slash_command_lists_known_commands() -> None:
    output = handle_slash_command("/help")
    assert "/memory" in output
    assert "/skills" in output
    assert "/quit" in output


def test_run_repl_routes_confirm_command() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/confirm", "/quit"])

    run_repl(
        turn_handler=lambda _message: "unused",
        confirm_handler=lambda: ["[approval] approved", "Applied pending action"],
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
        session_id="demo",
    )

    assert "[approval] approved" in outputs
    assert "Applied pending action" in outputs
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`uv run pytest tests/unit/services/test_session_service.py tests/integration/test_cli_repl.py -v`  
预期：FAIL，因为待审批动作还不能被持久化或恢复执行

- [ ] **步骤 3：实现待审批持久化与 confirm 流程**

`src/mycli/services/session_service.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import PendingApproval, RiskLevel
from mycli.domain.tools import ToolCall
from mycli.infrastructure.filesystem import read_json, write_json


class SessionService:
    def __init__(self, home_dir: Path) -> None:
        self._sessions_root = home_dir / ".mycli" / "sessions"

    def save_conversation(self, conversation: Conversation) -> None:
        payload = {
            "session_id": conversation.session_id,
            "messages": [
                {"role": message.role, "content": message.content}
                for message in conversation.messages
            ],
        }
        write_json(self._sessions_root / f"{conversation.session_id}.json", payload)

    def load_conversation(self, session_id: str) -> Conversation:
        payload = read_json(self._sessions_root / f"{session_id}.json", None)
        conversation = Conversation(session_id=session_id)
        if payload is None:
            return conversation
        for item in payload["messages"]:
            conversation.append(Message(role=item["role"], content=item["content"]))
        return conversation

    def save_pending_approval(self, session_id: str, approval: PendingApproval) -> None:
        payload = {
            "tool_call": {
                "name": approval.tool_call.name,
                "arguments": approval.tool_call.arguments,
                "reason": approval.tool_call.reason,
            },
            "risk_level": approval.risk_level.value,
            "reason": approval.reason,
            "preview": approval.preview,
        }
        write_json(self._sessions_root / f"{session_id}-approval.json", payload)

    def load_pending_approval(self, session_id: str) -> PendingApproval | None:
        payload = read_json(self._sessions_root / f"{session_id}-approval.json", None)
        if payload is None:
            return None
        return PendingApproval(
            tool_call=ToolCall(
                name=payload["tool_call"]["name"],
                arguments=payload["tool_call"]["arguments"],
                reason=payload["tool_call"]["reason"],
            ),
            risk_level=RiskLevel(payload["risk_level"]),
            reason=payload["reason"],
            preview=payload["preview"],
        )

    def clear_pending_approval(self, session_id: str) -> None:
        path = self._sessions_root / f"{session_id}-approval.json"
        if path.exists():
            path.unlink()
```

`src/mycli/application/turn_service.py`

```python
from __future__ import annotations

from pathlib import Path

from mycli.agents.react_loop import ReactAgent
from mycli.domain.conversation import Message
from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.runtime import AgentConfig, ExecutionContext, TurnResponse
from mycli.services.memory_service import MemoryService
from mycli.services.safety_policy import SafetyPolicy
from mycli.services.session_service import SessionService
from mycli.services.skill_registry import SkillRegistry


class TurnService:
    def __init__(self, model_client, tool_registry, config: AgentConfig, home_dir: Path) -> None:
        self._tool_registry = tool_registry
        self._agent = ReactAgent(
            model_client=model_client,
            tool_registry=tool_registry,
            safety_policy=SafetyPolicy(),
        )
        self._config = config
        self._memory_service = MemoryService(home_dir=home_dir, workspace_root=config.workspace_root)
        self._session_service = SessionService(home_dir=home_dir)
        self._skill_registry = SkillRegistry(
            builtin_root=Path(__file__).resolve().parents[1] / "prompts" / "skills",
            user_root=home_dir / ".mycli" / "skills",
        )

    def _select_skill(self, user_message: str):
        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            skill = self._skill_registry.get(name)
            if skill and any(hint in lowered for hint in skill.trigger_hints):
                return skill
        return None

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        conversation = self._session_service.load_conversation(self._config.session_id)
        conversation.append(Message(role="user", content=user_message))

        preference_records = tuple(
            MemoryRecord(kind=MemoryKind.PREFERENCE, key=key, value=value)
            for key, value in self._memory_service.load_preferences().items()
        )
        project_records = tuple(
            self._memory_service.search_project_notes("entry")
        ) if "repo" in user_message.lower() else ()
        session_summary_records = tuple(
            MemoryRecord(kind=MemoryKind.SESSION_SUMMARY, key="recent", value=value)
            for value in self._memory_service.load_session_summaries(self._config.session_id)[-2:]
        )
        context = ExecutionContext(
            config=self._config,
            memory_records=preference_records + project_records + session_summary_records,
            active_skill=self._select_skill(user_message),
        )

        response = self._agent.run(user_message=user_message, context=context)
        conversation.append(Message(role="assistant", content=response.assistant_message))
        self._session_service.save_conversation(conversation)
        if response.pending_approval is not None:
            self._session_service.save_pending_approval(self._config.session_id, response.pending_approval)
        else:
            self._session_service.clear_pending_approval(self._config.session_id)
        self._memory_service.append_session_summary(self._config.session_id, response.assistant_message)
        return response

    def confirm_pending_action(self) -> TurnResponse:
        approval = self._session_service.load_pending_approval(self._config.session_id)
        if approval is None:
            return TurnResponse(assistant_message="There is no pending action to confirm.")

        tool_result = self._tool_registry.run(approval.tool_call)
        self._session_service.clear_pending_approval(self._config.session_id)
        message = f"Approved {approval.tool_call.name}: {tool_result.summary}"
        self._memory_service.append_session_summary(self._config.session_id, message)
        return TurnResponse(assistant_message=message, progress_updates=("[approval] approved",))
```

`src/mycli/cli/main.py`

```python
from __future__ import annotations

import argparse
import os
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.infrastructure.openai_client import OpenAIChatClient
from mycli.services.config_service import resolve_config
from mycli.tools.contracts import ToolRegistry
from mycli.tools.edit_file import EditFileTool
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.read_file import ReadFileTool
from mycli.tools.run_shell import RunShellTool
from mycli.tools.search_text import SearchTextTool


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycli")
    parser.add_argument("--session", default="default", help="Session identifier")
    parser.add_argument("--model", default=None, help="Model override")
    return parser


def handle_slash_command(command: str, session_id: str = "default") -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skill",
                "/skills",
                "/memory",
                "/plan",
                "/tools",
                "/session",
                "/confirm",
                "/quit",
            ]
        )
    if command == "/session":
        return f"Session: {session_id}"
    if command == "/quit":
        return "quit"
    return f"Unknown command: {command}"


def build_turn_service(cli_args: dict[str, object]) -> TurnService:
    cwd = Path.cwd()
    home = Path.home()
    config = resolve_config(cli_args=cli_args, env=os.environ, cwd=cwd, home=home)
    if not config.api_key:
        raise RuntimeError("MYCLI_API_KEY is required")

    model_client = OpenAIChatClient(
        api_key=config.api_key,
        base_url=config.api_base_url,
        model=config.model,
    )
    tool_registry = ToolRegistry(
        [
            ListDirectoryTool(cwd),
            ReadFileTool(cwd),
            SearchTextTool(cwd),
            EditFileTool(cwd),
            RunShellTool(cwd),
        ]
    )
    return TurnService(model_client=model_client, tool_registry=tool_registry, config=config, home_dir=home)


def run_repl(
    turn_handler,
    input_func=input,
    output_func=print,
    session_id: str = "default",
    confirm_handler=None,
) -> None:
    while True:
        raw = input_func("> ").strip()
        if not raw:
            continue
        if raw == "/confirm" and confirm_handler is not None:
            for line in confirm_handler():
                output_func(line)
            continue
        if raw.startswith("/"):
            handled = handle_slash_command(raw, session_id=session_id)
            if handled == "quit":
                output_func("Bye.")
                return
            output_func(handled)
            continue
        rendered = turn_handler(raw)
        if isinstance(rendered, str):
            output_func(rendered)
            continue
        for line in rendered:
            output_func(line)


def main() -> int:
    args = vars(build_parser().parse_args())
    service = build_turn_service(args)

    def handle_user_message(raw: str) -> list[str]:
        response = service.handle_user_turn(raw)
        rendered: list[str] = [f"[progress] {update}" for update in response.progress_updates]
        if response.pending_approval is not None:
            rendered.append(f"[approval] {response.pending_approval.reason}")
        rendered.append(response.assistant_message)
        return rendered

    def confirm_pending_action() -> list[str]:
        response = service.confirm_pending_action()
        return [*response.progress_updates, response.assistant_message]

    run_repl(
        handle_user_message,
        session_id=service._config.session_id,
        confirm_handler=confirm_pending_action,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`uv run pytest tests/unit/services/test_session_service.py tests/integration/test_cli_repl.py -v`  
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add src/mycli/services/session_service.py src/mycli/application/turn_service.py src/mycli/cli/main.py tests/unit/services/test_session_service.py tests/integration/test_cli_repl.py
git commit -m "feat: persist approvals and resume actions from cli"
```
