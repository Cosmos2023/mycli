# Codex Image And Resource Tool Alignment

Reference: the local source snapshot at `/Users/cosmos/Downloads/codex-main`, inspected on
2026-09-09. This comparison describes that snapshot, not every installed Codex build.

## Implemented

| Surface | Codex reference | mycli behavior |
| --- | --- | --- |
| `view_image` arguments | `core/src/tools/handlers/view_image_spec.rs` | Required `path`; optional `detail` only for models with known original-detail support |
| Image processing | `utils/image/src/lib.rs` | Decode actual PNG/JPEG/GIF/WebP content; default proportional 2048-pixel bound; original dimensions on supported models |
| Encoding | `utils/image/src/lib.rs` | Retain small PNG/JPEG/WebP source bytes; JPEG quality 85; lossless WebP; GIF first frame becomes PNG; preserve EXIF and RGB ICC metadata |
| Image results | `core/src/tools/handlers/view_image.rs` | Canonical image blocks carry detail through Worker, storage and provider projection |
| Resource discovery | `core/src/tools/handlers/mcp_resource_spec.rs` | Optional `server`/`cursor`; native `nextCursor`; cursor requires a server |
| Resource templates | `core/src/tools/handlers/mcp_resource/list_mcp_resource_templates.rs` | Added `list_mcp_resource_templates`; exact `uriTemplate`; real SDK discovery and reading of instantiated URIs |
| Resource reads | `core/src/tools/handlers/mcp_resource/read_mcp_resource.rs` | `server`/`uri` input and structured `contents`; supported images returned as image blocks |

`models-manager/models.json` explicitly marks gpt-5.3-codex, gpt-5.4, gpt-5.4-mini and gpt-5.5
as supporting original image detail. Their existing mycli catalog entries carry that capability;
dated variants inherit it. Other models conservatively keep high detail until capability metadata
is available. This admission does not filter the pi-ai model catalog or change provider selection.

Pi-ai 0.84.4 lacks an image-detail field. A narrow payload hook applies canonical detail to SDK
image blocks, leaving untagged images and other wire fields unchanged. Replay on an unsupported
model downgrades original hints to high. The hook should disappear when the SDK supports detail.

## Deliberate Boundaries

- The mycli filesystem grant model and 10 MB image limit remain in force. Decoding is additionally
  bounded to 64 million pixels. This does not reproduce Codex's much larger defensive input cap.
- The image decoder is loaded on demand. Missing optional native binaries produce a bounded image
  tool failure without preventing ordinary CLI startup. Both tools and the published app declare
  the decoder dependency.
- mycli has one active local execution environment, so no `environment_id` parameter is exposed.
- mycli preserves valid JSON within 8,000 characters and marks truncation. Oversized resource
  identifiers/cursors fail without alteration. An unscoped truncated listing can be narrowed by server.
- Old `offset` calls retain their dispatch path. Fresh schemas and prompt version v15 use native
  cursor semantics. Existing sessions keep their original frozen system instructions.
- Cropping, SVG rasterization, OCR, browser automation, PDF tools and LSP tools are not features of
  the referenced `view_image` or MCP resource handlers and are not added by this alignment.

## Other Codex Tools

The core planner is `core/src/tools/spec_plan.rs`. Existing mycli Shell/WriteStdin, file mutation,
plan, clarification, permission, tool-discovery and agent-coordination tools already cover those
capability groups. Their existing names are retained; this change does not claim complete wire
compatibility for `apply_patch` or `request_user_input`.

Codex's token-budget context-window tools, clock/sleep tools, plugin installation and agent-job
tools have separate feature or environment gates. They require their corresponding runtime
capabilities and are not treated as missing unconditional local tools in this change.

## Verification

Regression coverage exercises corrupt and mislabeled images, proportional resizing, original
dimensions, symlink confinement, native resource cursors, template aggregation, legacy dispatch,
real SDK Responses/Chat image detail, Worker parsing, content-blob round trips, and a complete
MCP/image turn followed by restart after deleting the original local image.

The focused image/resource regression run passes all 70 tests, including a subprocess with an
unavailable image decoder. Build, lint, type-check, contract/config drift and release metadata
checks pass. Full unit and contract suites also pass. The full suite remains ungreen because of
the existing M6 output-token and M7 extension/agent assertions. Packed application smoke completes
its installed execution journeys but fails its final provider-free pi-ai module-loading assertion:
the existing credential-readiness path loads the provider catalog during startup.

A separate clean installation with optional native dependencies successfully executes the packed
`view_image` tool: a 3000 x 1500 PNG becomes 2048 x 1024 at high detail and stays 3000 x 1500 at
original detail. The installed package also exposes the resource-template schema.
