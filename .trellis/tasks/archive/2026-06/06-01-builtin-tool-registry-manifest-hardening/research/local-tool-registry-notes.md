# Local Tool Registry Notes

## Current mycli state

- Built-in tools are assembled by `src/mycli/tools/registry.py::default_tools`.
- `ToolSpec` currently carries name, description, parameters, and risk level.
- `SafetyPolicy` separately classifies built-in tools into low, medium, and
  high risk.
- Runtime tool execution already emits lifecycle and trace diagnostics, but the
  registry does not provide a stable manifest contract for external clients or
  doctor checks.
- Existing extension manifest exposes runtime/gateway capability discovery, but
  not the concrete local tool catalog.

## Hermes-inspired target semantics

Hermes-agent treats tools as a discoverable catalog with metadata beyond raw
provider schema: grouping, availability, display metadata, result behavior,
dynamic/contributed tools, and safety constraints. For this slice, mycli should
adopt only the local built-in subset:

- stable id per tool
- toolset grouping
- risk/approval metadata
- schema and effect profile
- availability status
- machine-readable manifest
- doctor validation

## Design choice

Do not introduce a new dynamic plugin architecture in this slice. Add manifest
metadata to the existing registry path so current runtime behavior is preserved
while clients gain a typed discovery surface.
