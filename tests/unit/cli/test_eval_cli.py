from __future__ import annotations

from pathlib import Path

from mycli.cli.main import build_parser, handle_evaluation_command
from mycli.domain.providers import ProviderId, ProtocolId
from mycli.evaluation.runner import EvaluationRunReport, EvaluationScenario


def test_build_parser_accepts_eval_arguments() -> None:
    parser = build_parser()
    args = parser.parse_args(["--eval-list"])
    assert args.eval_list is True

    args = parser.parse_args(["--eval-scenario", "01"])
    assert args.eval_scenario == "01"


def test_handle_evaluation_command_lists_scenarios(monkeypatch, tmp_path: Path) -> None:
    scenario = EvaluationScenario(
        id="01-boss-message-reply",
        title="场景 01：老板消息回复助手",
        scenario_dir=tmp_path,
        workspace_root=tmp_path,
        turn_paths=(),
        expected_payload={},
    )
    monkeypatch.setattr("mycli.cli.main.discover_scenarios", lambda _root: (scenario,))

    outputs: list[str] = []
    exit_code = handle_evaluation_command(
        {
            "eval_list": True,
            "eval_scenario": None,
            "eval_root": "evaluation/scenarios",
            "session": "default",
            "model": None,
        },
        cwd=tmp_path,
        home=tmp_path,
        env={},
        output_func=outputs.append,
    )

    assert exit_code == 0
    assert any("01-boss-message-reply [capability]" in line for line in outputs)


def test_handle_evaluation_command_runs_single_scenario(monkeypatch, tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("demo", encoding="utf-8")
    scenario = EvaluationScenario(
        id="01-boss-message-reply",
        title="场景 01：老板消息回复助手",
        scenario_dir=tmp_path,
        workspace_root=tmp_path,
        turn_paths=(),
        expected_payload={},
    )
    captured_args: dict[str, object] = {}

    monkeypatch.setattr("mycli.cli.main.load_scenario", lambda _root, _id: scenario)

    def fake_build_turn_service(cli_args, **kwargs):
        captured_args["session"] = cli_args["session"]
        captured_args["cwd"] = kwargs["cwd"]
        return object()

    monkeypatch.setattr("mycli.cli.main.build_turn_service", fake_build_turn_service)
    monkeypatch.setattr(
        "mycli.cli.main.run_evaluation_scenario",
        lambda _scenario, _service: EvaluationRunReport(
            scenario_id="01-boss-message-reply",
            scenario_title="场景 01：老板消息回复助手",
            workspace_root=tmp_path,
            turn_results=(),
            checks=(),
        ),
    )
    monkeypatch.setattr(
        "mycli.cli.main.write_evaluation_report",
        lambda **_kwargs: tmp_path / "evaluation" / "runs" / "report.json",
    )
    monkeypatch.setattr(
        "mycli.cli.main.render_evaluation_report",
        lambda report: [f"[eval] {report.scenario_id}"],
    )

    outputs: list[str] = []
    exit_code = handle_evaluation_command(
        {
            "eval_list": False,
            "eval_scenario": "01",
            "eval_root": "evaluation/scenarios",
            "session": "default",
            "model": None,
        },
        cwd=tmp_path,
        home=tmp_path,
        env={"MYCLI_API_KEY": "test-key"},
        output_func=outputs.append,
    )

    assert exit_code == 0
    assert outputs == [
        "[eval] 01-boss-message-reply",
        f"[eval] report: {tmp_path / 'evaluation' / 'runs' / 'report.json'}",
    ]
    assert str(captured_args["session"]).startswith("eval-01-boss-message-reply-")
    assert captured_args["cwd"] != scenario.workspace_root
    assert Path(captured_args["cwd"]).is_dir()
    assert (Path(captured_args["cwd"]) / "README.md").read_text(encoding="utf-8") == "demo"


def test_handle_evaluation_command_renders_friendly_error_when_service_build_fails(
    monkeypatch, tmp_path: Path
) -> None:
    scenario = EvaluationScenario(
        id="01-boss-message-reply",
        title="场景 01：老板消息回复助手",
        scenario_dir=tmp_path,
        workspace_root=tmp_path,
        turn_paths=(),
        expected_payload={},
    )
    monkeypatch.setattr("mycli.cli.main.load_scenario", lambda _root, _id: scenario)
    monkeypatch.setattr(
        "mycli.cli.main.build_turn_service",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("MYCLI_API_KEY is required")),
    )

    outputs: list[str] = []
    exit_code = handle_evaluation_command(
        {
            "eval_list": False,
            "eval_scenario": "01",
            "eval_root": "evaluation/scenarios",
            "session": "default",
            "model": None,
        },
        cwd=tmp_path,
        home=tmp_path,
        env={},
        output_func=outputs.append,
    )

    assert exit_code == 2
    assert outputs == ["[eval] error: MYCLI_API_KEY is required"]


def test_handle_evaluation_command_reuses_root_config_for_eval_workspace(
    monkeypatch, tmp_path: Path
) -> None:
    workspace_root = tmp_path / "scenario" / "fixtures"
    workspace_root.mkdir(parents=True)
    (workspace_root / "meeting-notes.md").write_text("hello", encoding="utf-8")
    scenario = EvaluationScenario(
        id="02-policy-and-doc-lookup",
        title="场景 02：制度与资料查找",
        scenario_dir=tmp_path / "scenario",
        workspace_root=workspace_root,
        turn_paths=(),
        expected_payload={},
    )
    captured_env: dict[str, object] = {}

    monkeypatch.setattr("mycli.cli.main.load_scenario", lambda _root, _id: scenario)
    monkeypatch.setattr(
        "mycli.cli.main.resolve_config",
        lambda **_kwargs: type(
            "Cfg",
            (),
            {
                "api_key": "project-token",
                "provider": ProviderId.DEEPSEEK,
                "api_base_url": "https://example.invalid/v1",
                "model": "demo-model",
                "protocol": ProtocolId.CHAT_COMPLETIONS,
                "max_prompt_tokens": 5000,
                "compression_threshold_tokens": 3200,
                "recent_message_count": 6,
            },
        )(),
    )

    def fake_build_turn_service(cli_args, **kwargs):
        captured_env["env"] = kwargs["env"]
        captured_env["cwd"] = kwargs["cwd"]
        return object()

    monkeypatch.setattr("mycli.cli.main.build_turn_service", fake_build_turn_service)
    monkeypatch.setattr(
        "mycli.cli.main.run_evaluation_scenario",
        lambda _scenario, _service: EvaluationRunReport(
            scenario_id="02-policy-and-doc-lookup",
            scenario_title="场景 02：制度与资料查找",
            workspace_root=scenario.workspace_root,
            turn_results=(),
            checks=(),
        ),
    )
    monkeypatch.setattr(
        "mycli.cli.main.write_evaluation_report",
        lambda **_kwargs: tmp_path / "evaluation" / "runs" / "report.json",
    )
    monkeypatch.setattr("mycli.cli.main.render_evaluation_report", lambda _report: [])

    exit_code = handle_evaluation_command(
        {
            "eval_list": False,
            "eval_scenario": "02",
            "eval_root": "evaluation/scenarios",
            "session": "default",
            "model": None,
        },
        cwd=tmp_path,
        home=tmp_path,
        env={},
        output_func=lambda _line: None,
    )

    assert exit_code == 0
    assert captured_env["cwd"] != scenario.workspace_root
    assert Path(captured_env["cwd"]).is_dir()
    assert (Path(captured_env["cwd"]) / "meeting-notes.md").read_text(encoding="utf-8") == "hello"
    assert captured_env["env"]["MYCLI_API_KEY"] == "project-token"
    assert captured_env["env"]["MYCLI_PROVIDER"] == "deepseek"
    assert captured_env["env"]["MYCLI_BASE_URL"] == "https://example.invalid/v1"
    assert captured_env["env"]["MYCLI_MODEL"] == "demo-model"
    assert captured_env["env"]["MYCLI_PROTOCOL"] == "chat_completions"
