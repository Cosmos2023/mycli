# Hermes Session Storage Notes

## Observed Patterns

- `hermes_constants.py` centralizes home path resolution with `get_hermes_home()` and resolves some old-vs-new directories through `get_hermes_dir(new_subpath, old_name)`.
- Hermes keeps operational logs under a dedicated `logs/` directory.
- `hermes_state.py` treats the DB as the primary session store and only removes old flat files during explicit delete/prune operations.
- `tools/tool_result_storage.py` persists large tool outputs separately and replaces in-context content with a bounded preview plus a path reference.

## mycli Implication

For mycli, the safe first step is not a destructive migration. The implementation should introduce a central layout object, route new trace writes to a dedicated `traces/` directory, keep legacy trace reads, and sanitize trace payloads so local trace files do not duplicate full transcript/tool-result content.
