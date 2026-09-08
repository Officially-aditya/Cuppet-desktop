# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Phase B — projects and GitHub import: implemented.**

Cuppet now owns explicit local project registrations on top of the independent Phase A runtime. Projects are durable SQLite records pointing at canonical local checkout paths; conversations are bound to project IDs, while the filesystem remains the source of truth for the checkout itself.

The production runtime still has **no OpenCode dependency**.

### Run it

```bash
npm install
npm start
```

Open **Provider settings** and configure an OpenAI-compatible base URL, model ID, and API key. Provider keys remain encrypted through Electron `safeStorage` and are never exposed to the renderer.

### Projects

Use **Add project** for one of three flows:

- **Local folder** — register any local folder; Git root/origin are detected when available.
- **GitHub URL** — clone a normal HTTPS or SSH `github.com` repository URL with existing Git/SSH credentials.
- **GitHub repositories** — browse repositories using an already-authenticated `gh` CLI session, then clone the selected repository.

The authenticated picker is isolated behind the project runtime boundary so Sydney's existing GitHub connection can replace the `gh` adapter later without changing project/chat storage semantics. Cuppet does not create a second OAuth app in Phase B.

Removing a project registration does **not** delete the checkout. Missing folders remain registered and can be relocated without losing chat history.

### Phase gates

```bash
npm run phase0:verify
npm run phase1:verify
npm run phaseb:verify
```

Phase B verifies database migration, project/chat isolation, canonical Git roots, URL and credential safety, clone failure cleanup, authenticated repository discovery, first-message chat persistence, and run→project binding across project switches.

## Architecture

```text
Electron renderer
    │ narrow contextBridge API
    ▼
Electron main process
    ├── native folder picker
    └── OS-encrypted provider settings
    │ newline-delimited JSON
    ▼
Independent Node runtime
    ├── SQLite projects + conversations
    ├── Git / GitHub project service
    ├── provider streaming
    └── generation cancellation
```

Authority stays explicit:

- filesystem → checkout/code truth;
- SQLite project rows → project registration identity;
- SQLite sessions/messages → conversation truth;
- runtime run record → immutable project binding for active execution;
- Electron main → provider-secret persistence.

## Migration docs

- Phase 0 audit: [`docs/phase-0-behavior-inventory.md`](docs/phase-0-behavior-inventory.md)
- Phase 0 baseline: [`migration/cuppet-source-baseline.json`](migration/cuppet-source-baseline.json)
- Phase 1 architecture: [`docs/phase-1-architecture.md`](docs/phase-1-architecture.md)
- Phase 1 source pins: [`migration/phase-1-sources.json`](migration/phase-1-sources.json)
- Phase B projects: [`docs/phase-b-projects.md`](docs/phase-b-projects.md)
- Phase B contract: [`migration/phase-b-contract.json`](migration/phase-b-contract.json)

## Migration rule

A later phase may replace an old OpenCode mechanism, but it may not silently replace Cuppet policy. Context compilation, lossless plans, PE3, evidence-gated memory, model roles, permissions, session controls, and remote compatibility remain explicit migration obligations.

**Next gate: B1** — move Cuppet's context compiler, lossless plans, TST/STM contracts, background enrichment, and orchestrator roles onto the independent project-aware runtime. PE3 task routing remains B2.
