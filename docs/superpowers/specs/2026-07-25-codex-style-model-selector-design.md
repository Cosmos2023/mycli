# Codex-Style Model Selector Design

## Goal

Make `/model` a reliable model-selection workflow rather than a single crowded filter panel. The selector must switch the provider configuration atomically, expose only usable configured providers, and match Codex's two-stage model/effort interaction.

## User Experience

- Bare `/model` replaces the editor with a model selection view.
- The first stage shows one unified, searchable list of models from configured providers.
- The current model is first. Remaining models sort by provider and model id.
- Rows show model id, provider, current/default markers, and a short description when width permits.
- Enter applies models with zero or one supported reasoning effort immediately.
- Models with multiple supported efforts open a second selection view containing only supported efforts.
- Escape from the effort view returns to the model view with its query and selection preserved. Escape from the model view closes it.
- Narrow layouts remove descriptions first and then compact provider labels. Rendered rows must remain strictly below terminal width.
- Direct `/model <name> --thinking-effort <level>` remains supported.

## Model Catalog

Introduce a backend-owned model catalog. A catalog entry contains:

- provider and protocol
- model id and display name
- short description
- supported reasoning efforts and default effort
- default-model marker
- provider base URL resolution metadata

The catalog includes curated entries for built-in providers and always injects the current configured model, including custom compatible models. Entries are filtered to providers with usable credentials or the active configured endpoint. The TUI receives catalog data from the Gateway and does not invent model capabilities.

The current `all/scoped` toggle is removed. It has no complete backend catalog source and is replaced by the configured-provider filter.

## Selection Flow

The TUI submits a structured selection containing provider, protocol, model id, base URL selection, and reasoning effort. The backend validates the complete target before changing runtime state.

On success, the backend:

1. persists the model selection to `~/.mycli/config.toml`;
2. updates and rebinds the current session runtime;
3. emits refreshed status and model catalog state;
4. closes the selector without adding a slash-command card to the main transcript.

On failure, no partial configuration is retained. The selector stays open and shows a concise inline error. Existing session state and user config remain unchanged.

## Compatibility

- Existing command-line model arguments continue to work.
- Existing single-provider configurations remain valid.
- The active custom model is selectable even when it is absent from the curated catalog.
- Models without reasoning support skip the effort stage.
- A model with one fixed effort applies that effort directly.

## Testing

- Catalog tests cover configured-provider filtering, current custom-model injection, ordering, and model-specific reasoning capabilities.
- Gateway tests cover catalog projection and atomic provider/model/effort mutation.
- Config tests cover persistence and rollback on validation or write failure.
- TUI component tests cover fuzzy search, current/default labels, two-stage navigation, escape restoration, direct selection, empty states, and narrow-width safety.
- Shell integration tests cover `/model`, selection success, backend failure, and refreshed footer state.
