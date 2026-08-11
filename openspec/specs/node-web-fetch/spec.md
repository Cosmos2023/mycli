# node-web-fetch Specification

## Purpose
TBD - created by archiving change add-node-web-fetch-tool-search. Update Purpose after archive.
## Requirements
### Requirement: Public HTTP(S) retrieval
The Node runtime SHALL expose `web_fetch` with one required `url` string and SHALL retrieve only unauthenticated public `http:` or `https:` resources when the active execution policy enables network access.

#### Scenario: Fetch a public text resource
- **WHEN** the model calls `web_fetch` with a public HTTPS URL under a network-enabled policy
- **THEN** the tool returns a successful bounded result containing the final source URL and readable text

#### Scenario: Network policy is disabled
- **WHEN** the model calls `web_fetch` while the active execution policy has `network=disabled`
- **THEN** the tool fails with a bounded `network_disabled` result before DNS resolution or connection

#### Scenario: Unsupported or credentialed URL
- **WHEN** the URL uses a non-HTTP(S) scheme, has no hostname, or contains username/password credentials
- **THEN** the tool fails with `invalid_url` before network activity

### Requirement: SSRF and redirect protection
The fetch transport SHALL reject loopback, unspecified, private, link-local, carrier-grade NAT, multicast, reserved, documentation, benchmark, and metadata-network targets for IPv4 and IPv6; SHALL validate every DNS answer; SHALL pin the connection to a validated answer; and SHALL repeat validation for each redirect.

#### Scenario: Literal private address
- **WHEN** the URL hostname is a private or local IP literal
- **THEN** the tool fails with `unsafe_address` without opening a connection

#### Scenario: DNS includes a private answer
- **WHEN** hostname resolution returns one or more addresses and any answer is non-public
- **THEN** the tool fails closed with `unsafe_address`

#### Scenario: Redirect targets local network
- **WHEN** a public response redirects to a loopback, private, metadata, or otherwise non-public target
- **THEN** the redirect is not followed and the tool fails with `unsafe_redirect`

#### Scenario: DNS rebinding after validation
- **WHEN** the system resolver would return a different address during socket connection
- **THEN** the request uses the previously validated pinned address rather than performing an uncontrolled second lookup

### Requirement: Bounded and cancellable transfer
The tool SHALL enforce one abortable timeout, at most five redirects, a one MiB response-body limit, a bounded URL/header surface, and the shared tool-result output limit.

#### Scenario: Declared body is too large
- **WHEN** a response declares a content length above the byte ceiling
- **THEN** the tool fails with `response_too_large` before consuming the body

#### Scenario: Stream exceeds body limit
- **WHEN** the streamed bytes exceed the byte ceiling without an oversize declaration
- **THEN** the tool destroys the request and fails with `response_too_large`

#### Scenario: Timeout or turn interruption
- **WHEN** the overall deadline expires or the turn AbortSignal is aborted
- **THEN** in-flight DNS/request work is cancelled and the result is `fetch_timeout` or the runtime's interrupted outcome

#### Scenario: Redirect limit exceeded
- **WHEN** more than five redirects are required
- **THEN** the tool fails with `too_many_redirects`

### Requirement: Safe model-readable projection
The tool SHALL accept HTML, JSON, and textual content, SHALL reject unsupported binary media, and SHALL label all successful content as untrusted external data rather than instructions.

#### Scenario: HTML response
- **WHEN** a successful response is HTML
- **THEN** the parser omits non-content nodes, normalizes readable text, and returns it inside an external-content fence

#### Scenario: JSON response
- **WHEN** a successful response declares JSON and contains valid JSON
- **THEN** the tool returns bounded stable pretty-printed JSON inside the external-content fence

#### Scenario: Unsupported media type or encoding
- **WHEN** the response is binary or uses an unsupported content encoding
- **THEN** the tool fails with `unsupported_content_type` or `unsupported_content_encoding`

#### Scenario: Prompt injection in page text
- **WHEN** fetched content contains instructions addressed to the agent
- **THEN** the content remains inside the explicit untrusted external-content fence and is not projected as a developer or user instruction

### Requirement: Manifest and approval metadata
The built-in manifest SHALL classify `web_fetch` under the `web` toolset with low risk, `auto_allow` approval, parallel-call support, no filesystem/process effects, and `network=true`.

#### Scenario: Inspect built-in manifest
- **WHEN** a client reads the built-in or combined tool manifest
- **THEN** `web_fetch` has stable id `builtin:web_fetch`, the specified schema and effect metadata, and exactly one matching route

