# Phase D — Provider, model-role, and effort parity

Phase D begins after C2 merges. It will move the remaining provider/model-selection behavior from the legacy Cuppet-code controller into an independent, non-secret provider catalog and request-policy layer.

Planned invariants:

- provider credentials and endpoint configuration remain local to Electron `safeStorage` or headless environment/configuration;
- normalized provider/model metadata contains no credentials;
- live/unknown provider IDs can participate without adding bespoke runtime plumbing when they expose the required coding-agent capabilities;
- provider grouping preserves special aliases such as OpenAI/Azure and Vertex/Vertex-Anthropic without crossing vendors;
- coding-agent models must support text input/output, tool calling, and streaming;
- primary and secondary model roles are independent persisted selections;
- reasoning/effort is selected from model-supported live variants and becomes request metadata, not prompt text;
- variant metadata is sanitized before persistence/projection; credential fields such as API keys may never survive a variant bridge;
- desktop, headless, and remote surfaces project the same normalized non-secret catalog;
- remote devices may select only host-advertised provider/model/effort choices and never supply provider secrets or endpoints.

Legacy acceptance sources are pinned by Phase 0 and include `platforms.test.ts`, `provider-routing.test.ts`, `effort.test.ts`, and `variant-bridge.test.ts` from Cuppet-code `840ed751b61c04afc881a393b7836d4d2c932f61`.
