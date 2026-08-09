# Multimodal Input Contract

## Scenario: Local Image Attachments Reach Provider Requests

### 1. Scope / Trigger

- Trigger: changing TUI attachments, `local_images` gateway input, queue commit, local file loading,
  canonical conversation persistence, provider profiles, or Chat/Responses/Anthropic projection.
- Data flow:
  `TUI paths -> gateway -> bounded tools loader -> canonical image -> SQLite -> provider adapter`.

### 2. Signatures

- Loader: `loadLocalImages(paths, {cwd, homeDir}) -> CanonicalImage[]`.
- Canonical shape: `{mediaType: image/jpeg|png|gif|webp, data: base64}`.
- Initial persistence: `ReserveTurnInput.imagePaths` plus `ReserveTurnInput.images`.
- Queue persistence: `CommitQueuedInputsInput.imagesByQueueId`.
- Capability: `NodeRuntimeConfig.supportsImages` resolved from provider profile with optional
  `[model].supports_images` / `MYCLI_SUPPORTS_IMAGES` override.

### 3. Contracts

- Local paths exist only at the user-input and local-IO boundaries. Provider adapters consume
  canonical image data and never read files.
- The loader accepts at most 16 PNG/JPEG/GIF/WebP files, at most 10 MB each and 15 MB total. It
  expands the current user's `~/`, resolves relative paths against the active workspace, rejects
  empty/unreadable/non-file/unsupported input, and never includes a path in an error message.
- Initial submission loads images before atomic turn reservation. Steering loads images immediately
  before atomic queue history commit. Follow-up input loads through the next turn reservation.
- SQLite stores canonical image blocks with the user conversation item and keeps paths only as
  display metadata. Reload and agent history fork preserve canonical image data without depending
  on the original file.
- OpenAI Chat emits `text` plus `image_url` data-URL blocks. Responses emits `input_text` plus
  `input_image` data-URL blocks. Anthropic emits base64 image source blocks.
- OpenAI, Codex, Qwen, Anthropic, and compatible profiles enable images by default. DeepSeek does
  not. A disabled profile fails before provider IO with `unsupported_capability`.
- Provider and storage boundaries revalidate media type, base64 shape, count, and bounded size.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Invalid initial file/path/type/size | Reject `turn.submit` with bounded `invalid_params` |
| Steering file disappears before commit | Fail the turn as `unsupported_capability`; retain steer |
| Provider profile disables images | Persist accepted user input, skip provider IO, fail capability |
| Persisted image block is malformed | Fail closed with bounded `persistence_error` |
| Image is valid | Persist once and project the protocol-specific image shape |

### 5. Tests Required

- Loader unit tests cover supported input, home expansion, missing/type/size failures, and redaction.
- Storage tests close/reopen SQLite and assert initial and queued canonical image round trips.
- Runtime tests cover capable and disabled provider paths plus unavailable steering images.
- Chat and Responses adapter tests assert exact data-URL shapes; Anthropic keeps its base64 test.
- Backend integration starts the real Node composition, submits `local_images`, captures local HTTP
  provider input, and reopens SQLite to verify durable canonical image data.
