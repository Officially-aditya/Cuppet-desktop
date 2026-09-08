# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Phase B1 — cognitive runtime: implemented.**

Cuppet now runs its context compiler, lossless implementation-plan authority, TST/STM bridge, evidence-gated background enrichment, model-role controls, and Orchestrator behavior directly inside the independent project-aware runtime introduced in Phases A and B.

The production runtime still has **no OpenCode dependency**. PE3 task routing remains intentionally deferred to B2.

### Run it

```bash
npm install
npm start
```

Open **Provider settings** and configure an OpenAI-compatible base URL, primary model ID, and API key. An optional background model ID can be configured separately. Provider keys remain encrypted through Electron `safeStorage` and are never exposed to the renderer.

### Cognitive runtime

The model request path is now:

```text
SQLite durable transcript
        │ detached copy
        ▼
Cuppet ContextCompiler
        ├── TST session continuity (STM)
        ├── workspace graph context
        ├── verified project memory (LTM)
        └── lossless plan projection
        │ ephemeral provider request only
        ▼
Provider streaming
        │
        ▼
SQLite durable assistant result
```

Synthetic retrieval/context is **never written back into SQLite**. SQLite remains conversation truth; the provider receives only an ephemeral projection.

#### Foreground context

- maximum synthetic context: 2,048 tokens;
- target budget: 4% of usable provider context, with a 512-token floor;
- STM / graph / verified LTM allocation: 45 / 35 / 20;
- retrieved material is explicitly marked untrusted and ephemeral;
- generated context is memoized by session + current user-message epoch for cache-stable repeated model steps.

History trimming is fail-closed. Cuppet keeps the complete durable history unless TST reports complete observation coverage and non-empty retained STM.

#### Plan mode

Each chat can switch between **Build** and **Plan**. Plan mode uses up to 12% of usable provider context, capped at 16K tokens, with workspace projection / graph / STM / LTM allocation of 70 / 15 / 10 / 5.

Long implementation prompts are captured by the **LosslessPlanStore**. Exact user source text remains canonical requirement truth and is recoverable by stable `P01`, `P02`, … phases after restart.

#### TST / STM

When `CUPPET_TST_SOCKET` and `CUPPET_TST_TOKEN` are present, the runtime lazily connects to the authenticated `cuppet.tst.v3` length-prefixed JSON-RPC protocol. TST is not required for desktop startup.

If TST is unavailable:

- foreground falls back to the full durable transcript;
- unsafe history replacement is not performed;
- STM-only compaction aborts and preserves the durable transcript;
- background enrichment does not spend secondary-model tokens.

#### Background enrichment

Completed foreground turns create bounded candidate signals for a project-local background worker. The worker defaults to a 60-second idle delay and a 15-minute per-session cooldown, produces at most four candidates, and rejects secret-bearing candidate content.

The secondary model is only a **canonicalizer**. Its output is stored with `model_candidate` provenance and does not itself count as verification or promotion evidence. Model-requested project scope is not authoritative; deterministic reinforcement/evidence policy controls admission.

#### Orchestrator

**Orchestrator** is a persisted global runtime control. When enabled, Cuppet disables all automatic synthetic context and automatic lossless-plan injection. The primary/master model receives the durable transcript unchanged and must use explicit retrieval/delegation surfaces.

### Visible controls

The desktop top bar exposes:

- Build / Plan mode for the active chat;
- Orchestrator on/off;
- Background enrichment pause/resume;
- TST configured/connected state.

These controls only project/mutate runtime-owned cognitive state; the renderer is not an authority for plans, memory, or transcript truth.

### Projects

Phase B project behavior remains intact:

- **Local folder** — register any local folder; Git root/origin are detected when available.
- **GitHub URL** — clone normal HTTPS or SSH `github.com` repository URLs with existing Git/SSH credentials.
- **GitHub repositories** — browse repositories using an already-authenticated `gh` CLI session and clone the selected repository.

Chats remain permanently bound to their selected project, active runs cannot be retargeted by project switching, removing a project registration does not delete its checkout, and missing folders can be relocated without losing history.

### Phase gates

```bash
npm run phase0:verify
npm run phase1:verify
npm run phaseb:verify
npm run phaseb1:verify
```

B1 verifies detached context compilation, cache-stable user-turn epochs, fail-closed trimming, Plan budgets, true Orchestrator bypass, STM-compaction abort behavior, exact lossless-plan persistence, deterministic candidate admission, background `model_candidate` authority, provider/SQLite separation, and persisted cognitive controls.

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
    ├── CognitiveStateStore
    ├── ContextCompiler
    │    ├── LosslessPlanStore
    │    └── TST / STM bridge
    ├── evidence-gated background enricher
    ├── provider streaming
    └── generation cancellation
```

Authority stays explicit:

- filesystem → checkout/code truth;
- SQLite project rows → project registration identity;
- SQLite sessions/messages → conversation truth;
- LosslessPlanStore → canonical implementation requirements;
- TST LTM → verified reusable memory;
- CandidateLedger + TST evidence rules → candidate admission/promotion boundary;
- CognitiveStateStore → mode/orchestrator/background controls;
- runtime run record → immutable project binding for active execution;
- Electron main → provider-secret persistence;
- renderer → projection only.

## Migration docs

- Phase 0 audit: [`docs/phase-0-behavior-inventory.md`](docs/phase-0-behavior-inventory.md)
- Phase 0 baseline: [`migration/cuppet-source-baseline.json`](migration/cuppet-source-baseline.json)
- Phase A architecture: [`docs/phase-1-architecture.md`](docs/phase-1-architecture.md)
- Phase A source pins: [`migration/phase-1-sources.json`](migration/phase-1-sources.json)
- Phase B projects: [`docs/phase-b-projects.md`](docs/phase-b-projects.md)
- Phase B contract: [`migration/phase-b-contract.json`](migration/phase-b-contract.json)
- Phase B1 cognitive runtime: [`docs/phase-b1-cognitive-runtime.md`](docs/phase-b1-cognitive-runtime.md)
- Phase B1 contract: [`migration/phase-b1-contract.json`](migration/phase-b1-contract.json)

## Migration rule

A later phase may replace an old OpenCode mechanism, but it may not silently replace Cuppet policy. Context compilation, lossless plans, PE3, evidence-gated memory, model roles, permissions, session controls, and remote compatibility remain explicit migration obligations.

**Next gate: B2** — move PE3 task-local routing, persisted task fingerprints/staleness, local routing escalation, attachment routing, and transactional cross-session handoff onto the independent runtime.
