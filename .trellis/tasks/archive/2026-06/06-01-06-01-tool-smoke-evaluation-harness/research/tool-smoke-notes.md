# Tool Smoke Notes

## Current state

- Existing eval scenarios require a configured model provider.
- `evaluation/runs/` is ignored, so local smoke reports can be preserved without
  polluting version control.

## Target

Use the built-in local tools directly to validate the hardened tool surface:

- `Read` over CSV fixtures and duplicate-read hints
- `Grep` over policy/doc fixtures
- `Write` and `Patch` over a copied code fixture
- `Bash` for local verification
- `GitStatus` non-git failure as a stable diagnostic sample
