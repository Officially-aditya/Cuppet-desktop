# Phase D — Provider, model-role, and effort parity

Phase D completes the provider/model-selection behavior assigned by the Phase 0 migration baseline to the independent Cuppet desktop/runtime.

The central rule is that **provider execution secrets and model policy are different authorities**. The local host owns credentials and endpoint configuration. A credential-free provider policy owns which coding-capable models exist, which model is primary/secondary, and which advertised effort variant is selected.

## Authority model

| State | Authority |
| --- | --- |
| API key | Electron `safeStorage` or headless host environment |
| Provider endpoint | local host configuration |
| Provider/model catalog | sanitized provider policy |
| Primary model | persisted provider settings |
| Secondary model | persisted provider settings |
| Effort/reasoning variants | sanitized live/bridged model metadata |
| Remote model choice | device-local pointer constrained to host catalog |
| Actual provider call | independent runtime provider adapter |

The compatibility `model` and `backgroundModel` fields remain only as projections of `primary.modelID` and `secondary.modelID`; they are not parallel authorities.

## Dynamic provider catalog

`src/runtime/provider-catalog.mjs` builds the catalog from current model/integration metadata instead of a closed provider registry.

Cuppet-specific grouping is limited to semantic aliases that need to preserve legacy behavior:

- OpenAI groups OpenAI and Azure OpenAI IDs;
- Vertex AI groups Google Vertex and Vertex-Anthropic IDs;
- Google Gemini and Vertex remain separate groups;
- unknown/future provider IDs are included automatically.

A model is eligible for coding-agent use only when it supports all of:

- text input;
- text output;
- streaming;
- tool calling.

An unavailable persisted model is never replaced with a guessed different model. A known alias such as legacy `vertex` may resolve to the exact matching model ID on a concrete live provider.

## Primary and secondary roles

`src/runtime/provider-policy.mjs` normalizes provider configuration into two independent persisted model references:

```text
primary   → foreground coding / conversation inference
secondary → background canonicalization / worker inference
```

The secondary role defaults to primary only when no separate secondary model is configured. `BackgroundEnricher` resolves the secondary role before constructing its provider adapter, so changing background model/effort no longer mutates the foreground selection.

## Effort / reasoning variants

`src/runtime/provider-variants.mjs` normalizes live variants and reconstructs missing variant metadata from the legacy-compatible bridge when necessary.

Rules:

1. live variant metadata wins;
2. bridged metadata fills only missing variants;
3. credential-shaped fields are recursively removed;
4. live variant headers are sanitized too;
5. an effort may be selected only if the model advertises it;
6. invalid effort fails with the available options rather than inventing a fallback;
7. effort is provider request metadata, never injected into user/system prompt text.

Provider-specific lowering preserves the expected request shape for OpenAI/Azure reasoning, Anthropic effort/task budget, Google/Vertex thinking configuration, Bedrock additional request fields, and compatible request bodies represented by the source metadata.

## Request lowering

The policy layer lowers an allowed role or explicit host-advertised selection into:

```text
provider ID
endpoint + host API key
transport model ID
context window
selected variant ID
sanitized request headers
sanitized request body
```

`OpenAICompatibleChatProvider` then applies that metadata while keeping runtime-owned fields authoritative:

- host `Authorization` always wins;
- selected model always wins;
- current messages always win;
- streaming remains enabled;
- runtime tool definitions/tool choice remain authoritative.

Variant metadata cannot override those fields or smuggle credential headers.

## Desktop

Provider settings now expose:

- provider ID;
- primary model;
- primary effort;
- secondary model;
- secondary effort;
- local endpoint;
- encrypted API key.

Effort selectors enable only when the stored model metadata advertises variants. The provider pill shows the active primary model and selected effort.

The renderer receives the sanitized provider/model projection and only an `apiKeyConfigured` boolean. It never receives the decrypted key.

## Headless

The independent CLI exposes the same sanitized provider policy through:

```bash
cuppet models
```

Headless role configuration supports:

```text
CUPPET_PROVIDER_ID
CUPPET_MODEL
CUPPET_BACKGROUND_MODEL
CUPPET_EFFORT
CUPPET_BACKGROUND_EFFORT
CUPPET_BASE_URL
CUPPET_API_KEY
```

Optional credential-free live metadata may be supplied through `CUPPET_MODEL_CATALOG_JSON` and `CUPPET_VARIANT_BRIDGE_JSON`.

`cuppet models` never emits the API key or endpoint.

## Remote

Remote provider/model state is a projection of host policy, not a second provider configuration surface.

An authorized remote device can:

- list host-advertised provider groups;
- select a provider group that has a configured coding model;
- list coding-capable host models;
- see each model's advertised variants;
- select an advertised model + effort.

A remote command cannot provide or override:

- API key;
- endpoint;
- arbitrary request headers;
- arbitrary request body;
- an unadvertised model;
- an unadvertised variant.

The device stores only its current allowed selection. When it submits work, the host lowers that selection against current host policy immediately before calling the runtime.

## Security boundary

Provider/model metadata is sanitized before it becomes reusable state. The sanitizer recursively removes credential-shaped keys including API/auth/access/refresh tokens, passwords, client secrets, authorization headers, credentials, and nested secret-bearing structures.

C2's stronger Remote rule remains unchanged: provider keys and provider endpoints never cross the relay boundary.

## Acceptance coverage

The Phase 0 baseline pins these legacy acceptance areas to A/D:

- `platforms.test.ts`;
- `provider-routing.test.ts`;
- `effort.test.ts`;
- `variant-bridge.test.ts`.

Phase D adds independent tests for:

- dynamic provider grouping and future provider IDs;
- coding capability filtering;
- exact alias/model migration;
- live/bridged variant precedence and sanitization;
- independent primary/secondary request lowering;
- background secondary-role execution;
- provider HTTP request metadata precedence;
- Remote host-advertised model/effort authority;
- desktop/headless/Remote projection seams.

The machine-readable contract is `migration/phase-d-contract.json`, and `npm run phased:verify` is the migration gate.
