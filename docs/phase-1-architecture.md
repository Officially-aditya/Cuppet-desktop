# Phase 1 — Independent Desktop Conversation Runtime

Phase 1 is the first executable slice of the Cuppet desktop migration. Its purpose is to prove that Cuppet can own its desktop shell, conversation persistence, provider streaming, and cancellation without running OpenCode.

## Source baselines

| Source | Pinned revision | What Phase 1 reuses |
| --- | --- | --- |
| `Officially-aditya/Cuppet-code` | `840ed751b61c04afc881a393b7836d4d2c932f61` | Behavioral contract and authority rules only. No OpenCode binary, package, plugin, or server is imported. |
| `Officially-aditya/Agent-Execute` | `03429e7729bb82bec17a47c1a8c7094228c90ebe` | Streaming pattern: assemble incremental model deltas and persist a canonical final assistant message. |
| `Officially-aditya/browserControl` | `7079b761ccd3814e6eeeccf4f6dd4f97fd3598a8` | Runtime-boundary pattern: orchestration/execution is owned by a non-UI runtime with explicit state and policy boundaries. |

The exact pins and dispositions are also stored in `migration/phase-1-sources.json`.

## Process model

```text
Electron renderer
    │ narrow contextBridge API
    ▼
Electron main process
    │ newline JSON request/event protocol
    ▼
Independent Node runtime process
    ├── SQLite conversation store
    ├── provider adapter
    └── AbortController per live generation
```

### Renderer

The renderer has no Node integration and cannot access provider credentials or the filesystem. It renders sessions/messages and emits explicit user intents through the preload bridge.

### Electron main

The main process owns OS integration and provider-secret persistence. API keys are encrypted through Electron `safeStorage`; if OS encryption is unavailable, Cuppet refuses to persist a plaintext key.

### Runtime

The runtime can be launched directly by Node and has no Electron or OpenCode dependency. It is authoritative for:

- session/message persistence;
- message ordering and statuses;
- provider request lifecycle;
- partial streamed output;
- Stop/cancellation state.

SQLite uses WAL mode. A message left in `streaming` after an unclean shutdown is converted to `interrupted` on the next runtime start instead of appearing perpetually active.

## Provider slice

Phase 1 intentionally implements one real provider contract: an OpenAI-compatible `/chat/completions` endpoint. The user configures base URL, model, and API key in desktop settings. Streaming is consumed as SSE; compatible gateways that return a single JSON completion despite `stream: true` are also accepted.

The provider adapter is intentionally tool-free in Phase 1. Tool execution, workspace access, Cuppet context compilation, PE3, TST, and browser execution are later gates and must not be smuggled into this first slice.

## Stop semantics

`session.stop` aborts the runtime-owned `AbortController`. Any text already received remains durable and the assistant message becomes `stopped`. A provider failure becomes `error`. A process crash/restart turns an unfinished stream into `interrupted`.

These are distinct states because cancellation is user intent, provider failure is an execution error, and interruption is recovery from process loss.

## Acceptance gate

`npm run phase1:verify` verifies:

1. required desktop/runtime files exist;
2. production source has no OpenCode reference/dependency;
3. the runtime is directly executable outside Electron;
4. SQLite conversations survive restart;
5. SSE deltas are assembled in order;
6. Stop aborts generation and persists partial output.

The Electron dependency is pinned to `44.2.0`; Phase 1 does not depend on prerelease Electron features.
