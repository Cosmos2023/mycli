---
name = "code-review"
description = "Guide the agent to prioritize correctness risks and missing tests"
trigger_hints = ["review", "bug", "risk", "regression"]
---
Look for correctness issues first.
Prefer concrete findings with file references.
Mention missing tests before style concerns.
