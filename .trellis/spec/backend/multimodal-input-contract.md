# Multimodal Input Contract

Resolve the provider and captured route using the original resolved configuration
object before deriving effective image capabilities. The app associates route
snapshots with configuration object identity; an image-capability copy is only
for turn execution, tool exposure, and preflight decisions.

## Effective Image Capability And Errors

Freeze effective support from configuration and the resolved provider model.
Known text-only pi-ai catalog metadata bounds an optimistic config override.
Unknown provider capability metadata retains the configured setting. Image
detail (`high` or `original`) never grants image-input support.

Hide `view_image` when unsupported and reject stale calls before path access
with `capability.image_input_unsupported`. Return one tool-local failure and
continue the agent loop. User, historical and dynamic tool images receive the
same precise preflight reason before provider IO. Preserve accepted images and
completed effects; a later explicit compatible-model selection may continue
without replaying those effects. Recovery is resolved against current state.

## Scenario: Local Image Attachments Reach Provider Requests

### 1. Scope / Trigger

- Trigger: changing TUI attachments, `local_images` gateway input, queue commit, local file loading,
  canonical conversation persistence, provider profiles, or Chat/Responses/Anthropic projection.
- Data flow:
  `TUI paths -> gateway -> bounded tools loader -> canonical image -> SQLite -> provider adapter`.

### 2. Signatures

- Loader: `loadLocalImages(paths, {cwd, homeDir}) -> CanonicalImage[]`.
- Canonical shape: `{mediaType: image/jpeg|png|gif|webp, data: base64, detail?: high|original}`.
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
- TUI editor history stores `{text, localImages}`. Undo snapshots capture editor text/cursor,
  attachment metadata, and paste payloads together through `captureLocalImages` and
  `restoreLocalImages`. Restore metadata before firing the editor change callback.
- `Editor.setText(text, localImages?)` replaces bound metadata after recording the old undo state.
  Completed submissions and session transitions clear obsolete undo entries. History deduplication
  compares attachment identity as well as text; equal labels may name different submitted files.
- Image insertion allocates a label absent from the draft and attachment registry. Deletion prunes
  the removed path and relabels remaining bindings atomically through `replaceImagePlaceholders`,
  preserving cursor position and the original undo unit. Unbound literal labels are not attachments
  and reserve their label so an inserted/renumbered attachment cannot acquire them.

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
- Editor/runtime regressions assert exact image paths after history recall, undo, deletion and
  reinsertion, deleting either survivor, literal labels, and A -> B -> A draft restoration.

## Scenario: Tool Images Reach The Model And Survive Replay

- `ToolAdapterResult.images`, `ToolExecutionResult.images`, and `CanonicalToolResult.images`
  carry optional canonical image arrays independently of the bounded text output.
- `view_image({path, detail?})` resolves paths through `resolveReadableWorkspaceFile` with the active
  readable/writable roots and unrestricted-filesystem flag, then uses `loadPromptImage`.
  Relative paths and current-user home expansion are supported. Decoding determines the real format;
  PNG/JPEG/GIF/WebP input need not have the matching extension. Corrupt input and SVG are rejected.
  The decoder reads through one bounded file handle, checks for concurrent file changes, limits input
  and processed files to 10 MB and decoded pixels to 64 million. Errors do not disclose file paths.
- Load the native image decoder on `view_image` demand. Importing the tools registry and ordinary
  CLI startup must work when optional decoder binaries are missing; image calls return a bounded
  tool failure. Both tools and the published app declare the decoder dependency.
- Default/high detail fits within 2048 x 2048 without enlarging or changing aspect ratio. Original
  preserves dimensions. Unresized PNG/JPEG/WebP bytes are retained; GIF becomes its first frame in PNG.
  Re-encoding preserves EXIF and color profile metadata; JPEG uses quality 85, WebP uses lossless
  encoding. There are no crop, SVG rendering, or OCR parameters.
- The frozen turn's selected model controls original-detail support through explicit capability
  markers in the existing model catalog. Unknown models default to high. Provider schemas omit
  `detail` when original is unsupported; dispatch also downgrades unsupported original requests.
- Canonical `detail` survives tool routing, Worker RPC, model-input snapshots, blobs and transcript
  replay. Old images without this field remain valid. The pi-ai payload hook applies image detail
  without changing message roles or other SDK-owned fields; identical images at different detail
  levels are matched by occurrence. Unsupported original hints in replay fall back to high.
- `normalizeCanonicalImages` validates PNG/JPEG/GIF/WebP MIME types, non-empty base64, at most
  16 images, and at most 20,000,000 base64 characters per result. ToolRouter, canonical storage,
  Worker provider RPC, model-input validation, and provider projection enforce this contract.
- MCP `image` blocks use `mimeType` (with legacy `mediaType` accepted); embedded image resources
  use `resource.mimeType` and `resource.blob`. Invalid or oversized image arrays return a failed
  tool result while retaining bounded text. Binary data never becomes ordinary display metadata.
- Tool images are retained in transcript events, content blobs, completed effect attempts, and
  model-input snapshots. Approved continuations, restart recovery, and history forks preserve
  them. Provider projection never reopens a tool's original local path.
- Responses carries image blocks in function-call output, Chat projects images after the tool
  result batch, and Anthropic uses image source blocks in tool results through pi-ai. A selected
  model without image support fails before provider IO with `unsupported_capability`.
- Gateway/TUI payloads continue to use summaries and allowlisted metadata. They do not include
  canonical image data or base64 strings.
- Regression coverage includes real SDK payloads for all three protocols, bounded/invalid image
  results, symlink confinement and grants, Worker RPC, completed-attempt replay, content-blob
  reopen, missing decoder isolation, and an approved MCP image turn followed by restart after
  deleting the local image.
