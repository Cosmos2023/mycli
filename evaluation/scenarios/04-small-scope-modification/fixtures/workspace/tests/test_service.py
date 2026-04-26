from report_tool.service import build_output_path


def test_uses_custom_output_dir_when_provided() -> None:
    result = build_output_path({"output_dir": "reports"}, "daily.txt")
    assert result == "reports/daily.txt"

def test_uses_default_dist_when_no_output_dir_provided() -> None:
    result = build_output_path({}, "daily.txt")
    assert result == "dist/daily.txt"
