# D3 — Native Provider Execution

D3 makes Cuppet's provider abstraction real without splitting the agent loop. The runtime, TST tools, permissions, mutation journal, Queue/Steer, Remote, and background enrichment keep one internal adapter contract:

```text
stream(messages, { signal, onDelta, tools })
  -> { text, toolCalls, usage }
```

Each native adapter translates that contract at the HTTP boundary and normalizes provider output back into the same `toolCalls: [{ id, name, arguments }]` shape consumed by `ToolRuntime`.

## Reviewed native routes

| Resolved provider ID | Native transport |
| --- | --- |
| `openai` | OpenAI Responses API (`/responses`) |
| `anthropic` | Anthropic Messages API (`/messages`) |
| `google` | Gemini Interactions API (`/interactions`) |
| `google-vertex` | Vertex Gemini `streamGenerateContent` |

All other provider IDs continue through the existing OpenAI-compatible Chat Completions adapter. This is deliberate: provider labels that need different authentication or wire formats are not guessed into a native implementation.

In particular, D3 does **not** claim a dedicated native transport for Azure OpenAI or Anthropic-on-Vertex. Those remain on the configured compatibility path until their host authentication/configuration is implemented explicitly.

## OpenAI

The native OpenAI path uses the Responses API, translates internal function definitions to Responses function tools, reconstructs streamed function-call argument deltas, and forces `store: false` for Cuppet requests. Bearer authentication remains host-local and sanitized request metadata cannot replace the runtime-owned model, conversation input, or authorization header.

## Anthropic

The Anthropic path moves internal system/developer text to the Messages `system` field, translates assistant tool calls to `tool_use`, translates runtime tool results to `tool_result`, and reconstructs `input_json_delta` streams. The adapter sets the reviewed `anthropic-version` header and owns the `x-api-key` credential header.

## Gemini API

The Google path uses the Interactions API. Within one Cuppet agent run, the adapter keeps the returned interaction ID and sends tool results using `previous_interaction_id` plus the exact function `call_id`. Tools and system/generation configuration are re-specified on continuation turns because they are interaction-scoped.

Gemini Interactions are stateful at the provider during that run when `previous_interaction_id` is used. Cuppet does not represent this as local-only retention. The local desktop still keeps the user's credential and runtime conversation authority; provider retention follows the selected provider's API behavior and account terms.

## Vertex Gemini

The Vertex path targets the express-compatible global `aiplatform.googleapis.com/v1/{model}:streamGenerateContent` shape when the normal OpenAI default endpoint would otherwise leak through configuration. Bare Gemini IDs are lowered to `publishers/google/models/{id}`; an explicitly supplied full model resource remains usable.

The API key is moved into `x-goog-api-key`, never left in the request URL. Native model response parts are retained only in the in-memory adapter history for the current run so function-call IDs and provider-required opaque parts can be returned with the next tool result.

## Provider selection authority

Routing is based on the provider ID attached to the **resolved primary or secondary model**, not on a renderer label. `createChatProvider` is the default `RuntimeService` factory and the same function is passed to `BackgroundEnricher`, so foreground and secondary/background roles use identical transport-selection rules.

Unknown or future providers remain supported through the existing OpenAI-compatible fallback instead of being rejected merely because D3 does not know their brand.

## Safety boundaries preserved

D3 does not move provider credentials into the renderer or transcript. Abort signals are forwarded through every native HTTP request, so existing Stop/Steer cancellation remains the authority. Tool execution still passes through the existing permission, audit, mutation-journal, TST, and validation layers; providers only propose normalized tool calls.

Reasoning/thinking payloads are not projected into visible chat by these adapters. Only normal assistant text, normalized tool calls, and usage metadata enter the existing runtime contract.

## Gate

Run:

```bash
npm run d3:verify
```

The D3 gate checks routing authority, reviewed native endpoints, fallback preservation, credential placement, syntax, mocked streaming/tool continuations, existing OpenAI-compatible behavior, provider policy, and background-provider reuse.
