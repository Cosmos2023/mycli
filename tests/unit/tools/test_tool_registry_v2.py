from mycli.tools.base import ToolParameter, ToolSpec
from mycli.tools.registry import ToolRegistryV2


def test_tool_registry_validates_required_arguments_before_execution() -> None:
    spec = ToolSpec(
        name="read_file",
        description="Read a file from the workspace",
        parameters=(ToolParameter(name="path", type="string", required=True),),
    )
    registry = ToolRegistryV2(specs={"read_file": spec}, executors={})

    try:
        registry.validate("read_file", {})
    except ValueError as exc:
        assert "path" in str(exc)
    else:
        raise AssertionError("validate() should reject missing required arguments")
