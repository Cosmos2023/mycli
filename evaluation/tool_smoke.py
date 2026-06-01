from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Any

from mycli.tools.bash import BashTool
from mycli.tools.file_snapshot import FileSnapshotStore
from mycli.tools.git_tools import GitStatusTool
from mycli.tools.grep import GrepTool
from mycli.tools.patch import PatchTool
from mycli.tools.read import ReadTool
from mycli.tools.write import WriteTool


REPO_ROOT = Path(__file__).resolve().parents[1]
SCENARIO_ROOT = REPO_ROOT / "evaluation" / "scenarios"
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"


def main() -> int:
    report = {
        "run_id": f"tool-smoke-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": datetime.now(tz=UTC).isoformat(),
        "scenarios": [
            _data_summary_smoke(),
            _doc_lookup_smoke(),
            _code_modification_smoke(),
        ],
    }
    report["success"] = all(item["success"] for item in report["scenarios"])
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = RUNS_ROOT / f"{report['run_id']}.json"
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(output_path)
    return 0 if report["success"] else 1


def _data_summary_smoke() -> dict[str, Any]:
    root = SCENARIO_ROOT / "03-weekly-data-summary" / "fixtures"
    read = ReadTool(root)
    tool_calls: list[dict[str, Any]] = []
    files = ("weekly_sales.csv", "team_hours.csv", "support_tickets.csv")
    totals: dict[str, object] = {}
    for file_path in files:
        result = read.execute({"file_path": file_path})
        tool_calls.append(_call_result("Read", result.success, result.summary, result.raw_payload))
        totals[file_path] = result.raw_payload.get("numeric_summary")
    duplicate = read.execute({"file_path": "weekly_sales.csv"})
    tool_calls.append(_call_result("Read", duplicate.success, duplicate.summary, duplicate.raw_payload))
    success = (
        all(call["success"] for call in tool_calls)
        and "unchanged duplicate" in duplicate.summary
        and "weekly_revenue" in str(totals["weekly_sales.csv"])
    )
    return {
        "scenario": "03-weekly-data-summary",
        "task_type": "data_summary",
        "success": success,
        "tool_call_count": len(tool_calls),
        "tool_calls": tool_calls,
        "checks": {
            "csv_numeric_summary": "weekly_revenue" in str(totals["weekly_sales.csv"]),
            "duplicate_read_hint": "unchanged duplicate" in duplicate.summary,
        },
    }


def _doc_lookup_smoke() -> dict[str, Any]:
    root = SCENARIO_ROOT / "02-policy-and-doc-lookup" / "fixtures"
    grep = GrepTool(root)
    tool_calls: list[dict[str, Any]] = []
    train = grep.execute(
        {
            "pattern": "高铁二等座",
            "path": ".",
            "output_mode": "content",
            "include": "*.md",
        }
    )
    hotel = grep.execute(
        {
            "pattern": "650",
            "path": ".",
            "output_mode": "content",
            "include": "*.md",
        }
    )
    missing = grep.execute(
        {
            "pattern": "餐补具体金额",
            "path": ".",
            "output_mode": "content",
            "include": "*.md",
        }
    )
    for result in (train, hotel, missing):
        tool_calls.append(_call_result("Grep", result.success, result.summary, result.raw_payload))
    success = (
        train.success
        and hotel.success
        and missing.success
        and train.raw_payload.get("match_count", 0) >= 1
        and hotel.raw_payload.get("match_count", 0) >= 1
        and missing.raw_payload.get("match_count", 0) == 0
    )
    return {
        "scenario": "02-policy-and-doc-lookup",
        "task_type": "doc_lookup",
        "success": success,
        "tool_call_count": len(tool_calls),
        "tool_calls": tool_calls,
        "checks": {
            "found_train_policy": train.raw_payload.get("match_count", 0) >= 1,
            "found_hotel_limit": hotel.raw_payload.get("match_count", 0) >= 1,
            "missing_topic_stays_missing": missing.raw_payload.get("match_count", 0) == 0,
        },
    }


def _code_modification_smoke() -> dict[str, Any]:
    source = SCENARIO_ROOT / "04-small-scope-modification" / "fixtures" / "workspace"
    with tempfile.TemporaryDirectory(prefix="mycli-tool-smoke-") as tmp:
        workspace = Path(tmp) / "workspace"
        shutil.copytree(source, workspace)
        snapshot_store = FileSnapshotStore()
        read = ReadTool(workspace, snapshot_store=snapshot_store)
        write = WriteTool(workspace)
        patch = PatchTool(workspace, snapshot_store=snapshot_store)
        shell = BashTool(workspace)
        git_status = GitStatusTool(workspace)
        tool_calls: list[dict[str, Any]] = []

        template_files = (
            "src/report_tool_template/__init__.py",
            "src/report_tool_template/service.py",
            "src/report_tool_template/cli.py",
        )
        for template_file in template_files:
            result = read.execute({"file_path": template_file})
            tool_calls.append(_call_result("Read", result.success, result.summary, result.raw_payload))
            target_file = template_file.replace("report_tool_template", "report_tool")
            content = str(result.raw_payload.get("content", ""))
            content = _strip_line_numbers(content)
            write_result = write.execute({"file_path": target_file, "content": content})
            tool_calls.append(_call_result("Write", write_result.success, write_result.summary, write_result.raw_payload))

        service_read = read.execute({"file_path": "src/report_tool/service.py"})
        tool_calls.append(_call_result("Read", service_read.success, service_read.summary, service_read.raw_payload))
        patch_result = patch.execute(
            {
                "file_path": "src/report_tool/service.py",
                "old_string": 'config.get("output-dir", "dist")',
                "new_string": 'config.get("output_dir", "dist")',
            }
        )
        tool_calls.append(_call_result("Patch", patch_result.success, patch_result.summary, patch_result.raw_payload))
        verify = shell.execute({"command": f"{sys.executable} -m pytest -q", "timeout": 30})
        tool_calls.append(_call_result("Bash", verify.success, verify.summary, verify.raw_payload))
        git_before_init = git_status.execute({})
        tool_calls.append(_call_result("GitStatus", git_before_init.success, git_before_init.summary, git_before_init.raw_payload))
        success = (
            all(call["success"] for call in tool_calls if call["tool"] != "GitStatus")
            and git_before_init.raw_payload.get("error_kind") == "not_git_repository"
            and verify.raw_payload.get("exit_code") == 0
            and patch_result.raw_payload.get("status") == "patched"
        )
        return {
            "scenario": "04-small-scope-modification",
            "task_type": "code_modification",
            "success": success,
            "tool_call_count": len(tool_calls),
            "tool_calls": tool_calls,
            "checks": {
                "patch_succeeded": patch_result.raw_payload.get("status") == "patched",
                "pytest_passed": verify.raw_payload.get("exit_code") == 0,
                "failed_tool_diagnostic": git_before_init.raw_payload.get("error_kind") == "not_git_repository",
            },
        }


def _call_result(
    tool: str,
    success: bool,
    summary: str,
    payload: dict[str, object],
) -> dict[str, Any]:
    return {
        "tool": tool,
        "success": success,
        "summary": summary,
        "error_kind": payload.get("error_kind"),
        "truncated": payload.get("truncated"),
        "path": payload.get("path"),
        "match_count": payload.get("match_count"),
        "exit_code": payload.get("exit_code"),
    }


def _strip_line_numbers(content: str) -> str:
    lines: list[str] = []
    for line in content.splitlines():
        _prefix, separator, text = line.partition("\t")
        lines.append(text if separator else line)
    return "\n".join(lines) + ("\n" if content.endswith("\n") else "")


if __name__ == "__main__":
    raise SystemExit(main())
