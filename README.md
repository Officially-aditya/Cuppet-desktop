# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Phase 1 / Increment A — independent desktop conversation runtime: implemented.**

Cuppet now boots as its own Electron application with a separate Node runtime process. Conversation truth lives in local SQLite, provider output streams into durable assistant messages, and Stop is owned by a runtime `AbortController` rather than UI state.

Phase 1 deliberately has **no OpenCode production dependency**.

### Run it

```bash
npm install
npm start
```

Open **Provider settings** in the app and configure:

- an OpenAI-compatible base URL (defaults to `https://api.openai.com/v1`);
- a model ID;
- an API key.

The API key is encrypted through Electron `safeStorage` before persistence. If OS credential encryption is unavailable, Cuppet refuses to store the key as plaintext.

### Phase gates

```bash
npm run phase0:verify
npm run phase1:verify
```

Phase 1 verifies standalone runtime boot, SQLite restart persistence, SSE streaming, Stop semantics, and absence of OpenCode references in production source.

## Architecture

```text
Electron renderer
    │ narrow contextBridge API
    ▼
Electron main process
    │ newline-delimited JSON
    ▼
Independent Node runtime
    ├── SQLite conversations
    ├── provider streaming
    └── generation cancellation
```

- Phase 0 audit: [`docs/phase-0-behavior-inventory.md`](docs/phase-0-behavior-inventory.md)
- Phase 0 baseline: [`migration/cuppet-source-baseline.json`](migration/cuppet-source-baseline.json)
- Phase 1 architecture: [`docs/phase-1-architecture.md`](docs/phase-1-architecture.md)
- Phase 1 source pins: [`migration/phase-1-sources.json`](migration/phase-1-sources.json)

## Migration rule

A later phase may replace an OpenCode mechanism, but it may not silently replace Cuppet policy. Context compilation, lossless plans, PE3, evidence-gated memory, model roles, permissions, session controls, and remote compatibility remain product behavior with explicit migration dispositions.

Phase 1 only claims the conversation/runtime foundation. Workspace tools, permission mediation, Cuppet context compilation, TST, PE3, browser control, remote control, and full provider catalog migration remain later gates.
