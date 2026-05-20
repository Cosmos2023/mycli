from mycli.agents.sub_agent import SubAgentReportFragment
from mycli.domain.subagents import SubAgentResult


def test_legacy_sub_agent_module_exports_report_alias() -> None:
    assert SubAgentReportFragment is SubAgentResult
