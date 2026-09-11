## Provider Transport Parity Record

The legacy Responses, Chat Completions, DeepSeek, and Anthropic adapter tests were green together
with the pi-ai payload and canonical-event fixtures before the legacy transports were removed.
The final pi-ai fixtures cover every configured route, instruction authority, tools, images,
reasoning effort, cache/storage/output controls, usage projection, replay family, error class,
cancellation path, and runtime retry lane.

Preserved wire behavior includes:

- Responses and ordinary compatible/Qwen Chat developer authority.
- DeepSeek stable developer instructions in the system prefix and dynamic developer context as a
  user-role suffix.
- Anthropic developer authority in the system prompt and the legacy thinking budgets.
- Explicit `store`, prompt-cache, cache-control, output-token, `max`, and `ultra` values.
- Chat tool schemas with `strict: false` and Responses native function-call IDs.
- Mycli-owned retry budgets with `maxRetries: 0` for every pi-ai invocation.

Intentional differences required by the new capability spec are:

- Empty successful, deferred, malformed, duplicate-terminal, and unsupported length outcomes now
  fail explicitly instead of being accepted as completion.
- Zero-valued optional cache-write, cache-read, and reasoning usage fields are omitted while the
  protocol-required input/output/total fields retain their previous accounting.
- New replay metadata uses the bounded `pi_ai_assistant` version-1 envelope; valid legacy Responses,
  Anthropic, and DeepSeek state remains readable and malformed or foreign metadata degrades to
  canonical content with a bounded diagnostic.

Live OpenAI Responses web search remains byte-compatible through the isolated hosted-search module.
All disabled-search Responses requests and all Chat/Anthropic requests use pi-ai.
