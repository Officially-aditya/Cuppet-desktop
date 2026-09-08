# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Phase B2 — PE3 task-local routing: implemented.**

Cuppet now owns task-context isolation directly inside the independent desktop runtime. Project prompts are routed before inference to the correct durable task session using deterministic affinity first, optional TST graph localization second, and a lazy local semantic fallback only for the ambiguous band.

The production runtime still has **no OpenCode dependency**. Phases A, B, and B1 remain intact: SQLite conversations, project binding/import, detached context compilation, lossless plans, TST/STM, evidence-gated background memory, and cognitive controls continue to be runtime-owned.

### Run it

```bash
npm install
npm start
```

Open **Provider settings** and configure an OpenAI-compatible base URL, primary model ID, and API key. An optional background model ID can be configured separately. Provider keys remain encrypted through Electron `safeStorage` and are never exposed to the renderer.

## PE3 task-local routing

A project can now maintain several long-running coding tasks without mixing their provider context:

```text
incoming project prompt
        │
        ▼
deterministic task affinity
  ├─ continuation / active structural match → continue
  ├─ dormant structural match → reactivate
  └─ ambiguous
        │
        ▼
optional TST graph localization
        │ still ambiguous
        ▼
local sentence embedding
        │
        ├─ decisive dormant winner → reactivate
        ├─ strong active match → continue
        ├─ clear novelty → create sibling task session
        └─ low confidence / failure → continue active task
```

The expensive failure mode is a false split, so PE3 is intentionally conservative: uncertain routing preserves the active task rather than inventing another context.

### Durable task contexts

Task-local contexts are ordinary **SQLite sessions** under the same project. PE3 does not maintain a second transcript store.

For a cross-task route:

1. PE3 prepares the route before the new user message is durable.
2. The target session must accept the handoff.
3. One SQLite transaction creates the sibling session when needed, records a bounded source routing marker, writes the user turn exactly once to the target, and creates the target streaming assistant message.
4. Only after the database transaction succeeds is router state committed.

If acceptance or the database transaction fails, the route is aborted and the source request is preserved. Half-routed turns are not allowed to survive.

When a prompt is routed to a sibling task, the desktop follows the returned target session automatically so streaming, Stop, Build/Plan state and visible history stay aligned with the actual execution target.

### Weighted task fingerprints

Task identity is based on concrete work rather than every word a task has mentioned. Evidence is weighted approximately in this order:

1. touched/modified paths;
2. observed active/read paths and recent tool symbols;
3. TST-localized paths and symbols;
4. prompt-mentioned paths and symbols;
5. lexical terms.

Weak prompt/localization evidence decays across turns. Dormant tasks are checked before semantic novelty creates a new task.

### Local semantic escalation

PE3 uses `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2` by default. The embedding runtime is lazy: normal deterministic turns do not load it, and routing inference is local rather than an extra remote LLM/classifier request.

Environment controls:

- `CUPPET_PE3=0` — disable automatic PE3 routing;
- `CUPPET_PE3_EMBED_MODEL` — override the embedding model;
- `CUPPET_PE3_MODEL_CACHE` — override model cache location;
- `CUPPET_PE3_MODEL_DIR` — use pre-staged model assets;
- `CUPPET_PE3_ALLOW_MODEL_DOWNLOAD=0` — strict offline mode; unavailable semantic routing safely keeps the active task.

Semantic vectors are process-local caches and are deliberately not persisted.

### Persistence and workspace staleness

Each project may persist up to 32 bounded task identities in `pe3-task-agents.json`. The registry contains routing metadata, fingerprints, stale paths, epochs, timestamps and bounded file signatures only. It does **not** contain transcripts, assistant/tool output, provider prompts, credentials or embedding vectors.

On restart, persisted privileged paths are checked against current filesystem metadata. Changed or missing paths lose their active/touched privilege, are removed from the path fingerprint, and are marked stale. Reactivating that task adds a bounded ephemeral refresh instruction so prior file assumptions cannot override current workspace truth.

A missing or corrupt registry fails closed to fresh routing state and never blocks desktop startup.

### Attachments

The B2 routing envelope accepts at most 16 bounded attachment metadata records with validated MIME metadata. At this phase PE3 routes **metadata only**; it never invents unread attachment contents. Routed attachment/refresh information is ephemeral provider context and is not added to the visible SQLite transcript.

## Cognitive runtime

The B1 model-request path remains:

```text
SQLite durable task transcript
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

### Foreground context

- maximum synthetic context: 2,048 tokens;
- target budget: 4% of usable provider context, with a 512-token floor;
- STM / graph / verified LTM allocation: 45 / 35 / 20;
- generated context is memoized by session + current user-message epoch for cache-stable repeated model steps;
- history trimming remains fail-closed unless TST reports complete observation coverage and retained STM.

### Plan mode and lossless requirements

Each chat can switch between **Build** and **Plan**. Plan mode uses up to 12% of usable provider context, capped at 16K tokens, with workspace projection / graph / STM / LTM allocation of 70 / 15 / 10 / 5.

The **LosslessPlanStore** preserves exact source requirements independently from chat/todo projections and makes stable `P01`, `P02`, … phases recoverable after restart.

### TST / STM and background memory

When `CUPPET_TST_SOCKET` and `CUPPET_TST_TOKEN` are present, the runtime lazily connects to authenticated `cuppet.tst.v3`. TST remains optional for desktop startup.

If TST is unavailable, foreground preserves full durable history, unsafe replacement/STM compaction fails closed, and background enrichment does not spend secondary-model tokens.

The secondary/background model is only a canonicalizer. Its output uses `model_candidate` provenance and never gains promotion authority merely because a model selected it.

### Orchestrator

**Orchestrator** remains a persisted global runtime control. When enabled, all automatic synthetic context and automatic lossless-plan injection are disabled so the master model must use explicit retrieval/delegation surfaces.

## Projects

Phase B behavior remains intact:

- **Local folder** — register any local folder; Git root/origin are detected when available.
- **GitHub URL** — clone normal HTTPS or SSH `github.com` repository URLs with existing Git/SSH credentials.
- **GitHub repositories** — browse repositories using an already-authenticated `gh` CLI session and clone the selected repository.

Chats remain permanently bound to their project. Switching projects cannot retarget an active run, removing a project registration does not delete its checkout, and missing folders can be relocated without losing history.

## Phase gates

```bash
npm run phase0:verify
npm run phase1:verify
npm run phaseb:verify
npm run phaseb1:verify
npm run phaseb2:verify
```

B2 verifies deterministic task switching/reactivation, conservative local semantic fallback, bounded routing metadata persistence, offline staleness invalidation, attachment bounds, transactional rollback, stale-task refresh behavior, and full-runtime SQLite target-session ownership.

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
    ├── SQLite projects + task conversations
    ├── Git / GitHub project service
    ├── PE3 project router
    │    ├── weighted task fingerprints
    │    ├── TST graph localization
    │    ├── lazy local embedding fallback
    │    ├── project-local routing registry
    │    └── transactional task handoff
    ├── CognitiveStateStore
    ├── ContextCompiler
    │    ├── LosslessPlanStore
    │    └── TST / STM bridge
    ├── evidence-gated background enricher
    ├── provider streaming
    └── generation cancellation
```

Authority stays explicit:

- filesystem → checkout/code truth and current-file staleness truth;
- SQLite project rows → project registration identity;
- SQLite sessions/messages → task/conversation truth;
- PE3 registry → bounded task-routing metadata only;
- PE3 semantic vectors → in-memory cache only;
- LosslessPlanStore → canonical implementation requirements;
- TST LTM → verified reusable memory;
- CandidateLedger + TST evidence rules → candidate admission/promotion boundary;
- CognitiveStateStore → mode/orchestrator/background controls;
- runtime run record → immutable project binding for active execution;
- Electron main → provider-secret persistence;
- renderer → projection/navigation only.

## Migration docs

- Phase 0 audit: [`docs/phase-0-behavior-inventory.md`](docs/phase-0-behavior-inventory.md)
- Phase 0 baseline: [`migration/cuppet-source-baseline.json`](migration/cuppet-source-baseline.json)
- Phase A architecture: [`docs/phase-1-architecture.md`](docs/phase-1-architecture.md)
- Phase A source pins: [`migration/phase-1-sources.json`](migration/phase-1-sources.json)
- Phase B projects: [`docs/phase-b-projects.md`](docs/phase-b-projects.md)
- Phase B contract: [`migration/phase-b-contract.json`](migration/phase-b-contract.json)
- Phase B1 cognitive runtime: [`docs/phase-b1-cognitive-runtime.md`](docs/phase-b1-cognitive-runtime.md)
- Phase B1 contract: [`migration/phase-b1-contract.json`](migration/phase-b1-contract.json)
- Phase B2 PE3 routing: [`docs/phase-b2-pe3-routing.md`](docs/phase-b2-pe3-routing.md)
- Phase B2 contract: [`migration/phase-b2-contract.json`](migration/phase-b2-contract.json)

## Migration rule

A later phase may replace an old OpenCode mechanism, but it may not silently replace Cuppet policy. Context compilation, lossless plans, PE3, evidence-gated memory, model roles, permissions, session controls, and remote compatibility remain explicit migration obligations.

**Next gate: C1** — move Cuppet's TST-backed workspace exploration/read tools and the independent tool/permission execution surface onto the desktop runtime, preserving permission boundaries before browser execution and remote-control migration.
