# Provider Architecture V2

Status: implementation branch foundation.

This design is Cuppet-native. External projects may inform the architectural questions we ask, but this implementation does not copy their source, contracts, component APIs, event names, or code structure.

## Why this exists

Cuppet currently supports several provider transports with provider-specific model discovery, configuration, event handling, process lifecycle, and renderer bridging. That has made unrelated operations capable of affecting each other: settings writes can influence model state, protocol additions require renderer work, and local CLI behavior can leak into product-level logic.

Provider Architecture V2 creates one ownership boundary around coding/model backends while keeping Cuppet's journal, TST, permissions, browserControl, remote control, and personal-agent orchestration above it.

## Core concepts

### Backend

A provider family such as Codex, OpenCode, or Antigravity. A backend declares static identity and constructs a runtime for a configured connection. It does not own user state.

### Connection

A user's configured backend. Authentication, executable configuration, and user preferences live in separate nested namespaces so changing credentials cannot implicitly rewrite model/runtime preferences.

### Runtime

A live execution environment with a small Cuppet contract: start, advertise capabilities, run a turn, cancel, and close. Protocol details stay behind this boundary.

### Capabilities

A provider-authoritative snapshot of models, runtime settings, attachment support, session features, and host-tool support. Runtime settings are generic select/boolean values. Cuppet may give known categories such as model or reasoning first-class UI without hardcoding provider values.

### Activity

A Cuppet-owned vocabulary for visible runtime work: text, reasoning, tools, plans, permissions, usage, status, warnings, and errors. Renderer, journal, remote clients, and future mobile surfaces consume Activity rather than ACP/Codex/native protocol names.

### Conversation bridge

A later migration slice will own the mapping between a Cuppet session and a provider session/resume state. Provider session ownership must not live in React or global settings.

## Authority rules

1. Provider-advertised IDs are preserved exactly.
2. Cuppet never uses the first advertised model as an inferred default.
3. An explicit user model is changed only by an explicit model operation, provider invalidation, or reset.
4. Credential/executable changes do not rewrite model or effort preferences.
5. Provider-specific events do not cross the Runtime -> Activity boundary.
6. Health checks, setup, authentication, installation, and runtime execution are separate operations.
7. Cuppet remains the permission authority for host mutations.

## Migration path

1. Add contracts, registry, Connection model, Activity model, and a compatibility runtime around current providers. No product behavior changes.
2. Build a Cuppet-owned ACP transport/runtime and move OpenCode first.
3. Replace ACP model/reasoning special cases with generic provider capabilities and model-dependent setting refresh.
4. Move chat/journal rendering to Activity only.
5. Add persistent provider sessions, native cancellation, and an inactivity watchdog.
6. Separate probe/install/auth/update/runtime operations and installation ownership.
7. Move other ACP providers, then Antigravity where the native ACP route is distributable/available.
8. Normalize Codex app-server activity into the same Cuppet Activity contract.
9. Remove compatibility paths only after parity tests pass.

## CI policy for this branch

Do not trigger broad CI for every architectural commit. Pure additive/docs/contract commits should be validated with focused Node tests. Run renderer verification when renderer-facing contracts change. Run the full CI matrix only at meaningful integration boundaries (for example, OpenCode migration, provider-factory cutover, or before PR readiness/release staging).
