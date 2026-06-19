from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.application.runtime.request import CacheShapeDiagnostics, RequestShapeBuilder
from mycli.domain.conversation import Message
from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.runtime import (
    AgentConfig,
    ExecutionContext,
    InstructionContract,
    InstructionFragment,
    PlanState,
)
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.llms.adapters.base import ModelToolDefinition, ModelToolParameter
from mycli.memory.service import MemoryService
from mycli.services.context import ContextFileLoader, TurnContextAssembler, TurnContextBudgeter
from mycli.services.diagnostics.doctor import DoctorService
from mycli.services.tracing import TraceService


def _cache_contract(
    *,
    current_user_request: str,
    runtime_reminder: str,
) -> InstructionContract:
    return InstructionContract(
        base_instructions="Stable system rules.",
        contextual_user_sections=(
            InstructionFragment(
                kind="workspace_instructions",
                title="Workspace",
                content="<workspace-context>Use pytest.</workspace-context>",
                source=".mycli.md",
                metadata={"cache_class": "static"},
            ),
            InstructionFragment(
                kind="runtime_reminders",
                title="Runtime reminders",
                content=runtime_reminder,
                metadata={"cache_class": "ephemeral"},
            ),
        ),
        conversation_messages=(
            Message(role="user", content="Earlier request"),
            Message(role="assistant", content="Earlier answer"),
        ),
        current_user_request=current_user_request,
    )


def main() -> int:
    timestamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")
    with tempfile.TemporaryDirectory(prefix="mycli-context-smoke-") as raw_root:
        root = Path(raw_root)
        workspace = root / "workspace"
        child = workspace / "src"
        home = root / "home"
        child.mkdir(parents=True)
        (home / ".mycli").mkdir(parents=True)
        (workspace / ".mycli.md").write_text(
            "Project rule: keep context smoke provider-free.",
            encoding="utf-8",
        )
        (workspace / ".mycli" / "config.toml").parent.mkdir(parents=True, exist_ok=True)
        (workspace / ".mycli" / "config.toml").write_text(
            "\n".join(
                (
                    'provider = "deepseek"',
                    'protocol = "chat_completions"',
                    'model = "deepseek-v4-flash"',
                    'api_key = "sk-smoke-secret"',
                )
            ),
            encoding="utf-8",
        )
        session_store = SQLiteSessionStore(home / ".mycli" / "sessions.db")
        memory = MemoryService(
            home_dir=home,
            workspace_root=workspace,
            session_store=session_store,
        )
        memory.append_session_summary("context-smoke", "Previously summarized work.")
        loaded = ContextFileLoader().load(workspace_root=workspace, cwd=child)
        context = ExecutionContext(
            config=AgentConfig(
                workspace_root=workspace,
                session_id="context-smoke",
            ),
            memory_records=(
                MemoryRecord(
                    kind=MemoryKind.SESSION_SUMMARY,
                    key="recent",
                    value="Previously summarized work.",
                ),
                MemoryRecord(
                    kind=MemoryKind.PROJECT_NOTE,
                    key="layout",
                    value="Context smoke uses temporary workspace.",
                ),
            ),
            context_file_content=loaded.content,
            context_file_diagnostics=loaded.diagnostics.to_dict(),
            plan_state=PlanState(),
        )
        turn_context = TurnContextAssembler().assemble(
            user_message="continue context smoke",
            context=context,
            workspace_instructions=loaded.content,
        )
        oversized_context = ExecutionContext(
            config=AgentConfig(
                workspace_root=workspace,
                session_id="context-smoke",
                max_prompt_tokens=120,
            ),
            memory_records=(
                MemoryRecord(
                    kind=MemoryKind.PROJECT_NOTE,
                    key="oversized",
                    value="memory detail " * 400,
                ),
            ),
            context_file_content="workspace detail " * 400,
            context_file_diagnostics=loaded.diagnostics.to_dict(),
            plan_state=PlanState(),
        )
        oversized_turn_context = TurnContextAssembler().assemble(
            user_message="keep this exact request",
            context=oversized_context,
            workspace_instructions=oversized_context.context_file_content,
        )
        trimmed_turn_context, budget_diagnostic = TurnContextBudgeter().apply(
            turn_context=oversized_turn_context,
            max_tokens=oversized_context.config.max_prompt_tokens,
        )
        trace = TraceService(home)
        trace.append(
            "context-smoke",
            RuntimeTraceEvent(
                kind="context_diagnostics",
                turn_id="turn_1",
                payload={
                    "estimated_context_tokens": 42,
                    "context_file": {
                        "blocked": loaded.diagnostics.blocked,
                        "truncated": loaded.diagnostics.truncated,
                    },
                },
            ),
        )
        trace.append(
            "context-smoke",
            RuntimeTraceEvent(
                kind="context_summary_persistence",
                turn_id="turn_1",
                payload={
                    "persisted_count": 1,
                    "duplicate_skipped_count": 0,
                },
            ),
        )
        trace.append(
            "context-smoke",
            RuntimeTraceEvent(
                kind="context_budget_diagnostic",
                turn_id="turn_1",
                payload=budget_diagnostic.to_dict(),
            ),
        )
        cache_builder = RequestShapeBuilder()
        request_config = AgentConfig(
            workspace_root=workspace,
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-v4-flash",
        )
        tool = ModelToolDefinition(
            name="read_file",
            description="Read a file",
            parameters=(ModelToolParameter(name="path", type="string"),),
        )
        first_shape = cache_builder.build(
            config=request_config,
            contract=_cache_contract(
                current_user_request="inspect cache policy",
                runtime_reminder="runtime reminder turn one",
            ),
            tools=(tool,),
        )
        second_shape = cache_builder.build(
            config=request_config,
            contract=_cache_contract(
                current_user_request="inspect cache policy with new intent",
                runtime_reminder="runtime reminder turn two",
            ),
            tools=(tool,),
        )
        cache_diagnostic = CacheShapeDiagnostics().build(
            current=second_shape,
            previous=first_shape,
        )
        trace.append(
            "context-smoke",
            RuntimeTraceEvent(
                kind="request_shape",
                turn_id="turn_2",
                payload=second_shape.summary(),
            ),
        )
        trace.append(
            "context-smoke",
            RuntimeTraceEvent(
                kind="cache_shape_diagnostic",
                turn_id="turn_2",
                payload=cache_diagnostic.to_dict(),
            ),
        )
        report = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda command: f"/usr/bin/{command}",
            import_checker=lambda _module: False,
        ).run()
        context_check = next(check for check in report.checks if check.name == "context")
        workspace_section = next(
            section
            for section in turn_context.sections
            if section.type.value == "workspace_instructions"
        )
        memory_section = next(
            section for section in turn_context.sections if section.type.value == "memory"
        )
        trimmed_user_request = next(
            section
            for section in trimmed_turn_context.sections
            if section.type.value == "user_request"
        )
        payload = {
            "scenario": "context-smoke",
            "timestamp": timestamp,
            "selected_source": loaded.diagnostics.selected_source,
            "workspace_fenced": "<workspace-context>" in workspace_section.content,
            "memory_fenced": "<memory-context>" in memory_section.content,
            "workspace_cache_class": workspace_section.cache_class.value,
            "memory_cache_class": memory_section.cache_class.value,
            "doctor_context_status": context_check.status.value,
            "doctor_context_message": context_check.message,
            "budget_trimmed_section_count": budget_diagnostic.trimmed_section_count,
            "budget_saved_tokens": budget_diagnostic.estimated_saved_tokens,
            "trimmed_user_request_preserved": (
                trimmed_user_request.content == "Current user request: keep this exact request"
            ),
            "cacheable_prefix_hash_stable": (
                first_shape.cacheable_prefix_hash() == second_shape.cacheable_prefix_hash()
            ),
            "volatile_hash_changed": first_shape.volatile_hash != second_shape.volatile_hash,
            "first_changed_cache_class": cache_diagnostic.first_changed_cache_class,
            "request_shape_trace_available": "request_shape_rows=1" in context_check.message,
            "cache_shape_trace_available": "cache_shape_rows=1" in context_check.message,
        }
        ok = (
            payload["selected_source"] == ".mycli"
            and payload["workspace_fenced"] is True
            and payload["memory_fenced"] is True
            and payload["workspace_cache_class"] == "static"
            and payload["memory_cache_class"] == "dynamic"
            and payload["doctor_context_status"] == "ok"
            and "context_trace_rows=1" in context_check.message
            and payload["budget_trimmed_section_count"] >= 1
            and payload["budget_saved_tokens"] > 0
            and payload["trimmed_user_request_preserved"] is True
            and "context_budget_rows=1" in context_check.message
            and payload["cacheable_prefix_hash_stable"] is True
            and payload["volatile_hash_changed"] is True
            and payload["first_changed_cache_class"] == "ephemeral"
            and payload["request_shape_trace_available"] is True
            and payload["cache_shape_trace_available"] is True
        )
        payload["ok"] = ok
        output_dir = Path(__file__).resolve().parent / "runs"
        output_dir.mkdir(parents=True, exist_ok=True)
        report_path = output_dir / f"context-smoke-{timestamp}.json"
        report_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        print(f"[context-smoke] report: {report_path}")
        print(f"[context-smoke] ok={str(ok).lower()}")
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
