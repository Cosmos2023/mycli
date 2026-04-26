---
name = "repository-analysis"
description = "Guide the agent to proactively inspect repository structure and summarize findings"
trigger_hints = ["repository", "repo", "project", "entrypoint"]
---
Inspect the repository before answering.
Prefer factual summaries grounded in files and directories.
Call tools when information is missing.
Explain likely entrypoints, responsibilities, and next reading steps.
