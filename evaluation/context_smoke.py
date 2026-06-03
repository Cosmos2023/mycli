from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.runtime import AgentConfig, ExecutionContext, PlanState
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.memory.service import MemoryService
from mycli.services.context import ContextFileLoader, TurnContextAssembler
from mycli.services.diagnostics.doctor import DoctorService
from mycli.services.tracing import TraceService
from mycli.domain.runtime.tracing import RuntimeTraceEvent


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
        report = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda command: f"/usr/bin/{command}",
            import_checker=lambda module: module == "mycli.cli.tui",
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
        }
        ok = (
            payload["selected_source"] == ".mycli"
            and payload["workspace_fenced"] is True
            and payload["memory_fenced"] is True
            and payload["workspace_cache_class"] == "static"
            and payload["memory_cache_class"] == "dynamic"
            and payload["doctor_context_status"] == "ok"
            and "context_trace_rows=1" in context_check.message
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
