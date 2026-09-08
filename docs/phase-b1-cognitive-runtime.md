# Phase B1 — Cognitive runtime

Phase B1 moves Cuppet's context and long-running cognitive state off the OpenCode plugin/controller boundary and onto the independent project-aware runtime introduced in Phases A and B. PE3 task routing is intentionally deferred to B2.

## Source baseline

Behavior is ported from `Officially-aditya/Cuppet-code@840ed751b61c04afc881a393b7836d4d2c932f61`, especially:

- `packages/opencode-plugin/src/context.ts`
- `packages/opencode-plugin/src/lossless-plan.ts`
- `packages/opencode-plugin/src/rpc.ts`
- `packages/cli/src/tst/client.ts`
- `packages/cli/src/background/candidate-ledger.ts`
- `packages/cli/src/background/worker.ts`

OpenCode remains absent from the production runtime.

## Model request authority

SQLite remains authoritative for visible user/assistant history. Cuppet context is compiled only after the current user message is durable. The compiler receives a detached copy of the transcript, may add an ephemeral system context block, and passes that detached projection to the provider. Synthetic context is never persisted back into SQLite and is never re-ingested as user evidence.

### Ordinary foreground

- budget: `min(2048, max(512, floor(usableTokens × .04)))`
- STM / graph / verified LTM shares: 45 / 35 / 20
- retrieved content is labeled untrusted and ephemeral
- context is memoized by session + current user-message epoch

### Plan mode

- budget: `min(16384, floor(usableTokens × .12))`
- workspace projection / graph / STM / LTM shares: 70 / 15 / 10 / 5
- projection completeness is surfaced separately; incomplete projection never pretends to be complete
- long implementation prompts are also captured by the lossless plan store

### History trimming

History trimming is fail-closed. It can happen only when:

1. there are more than two user turns;
2. estimated history exceeds half of usable context;
3. TST returned a non-empty context block;
4. TST reports `observation_complete=true`;
5. retained STM is non-empty.

Otherwise the complete durable history is sent. Trimming only changes the provider request; SQLite is untouched.

### STM experiments

`CUPPET_STM_EVENT_CONTEXT=1` uses structured STM-event context and keeps only the active user turn after TST confirms safe replacement. `CUPPET_STM_ONLY_COMPACTION=1` switches foreground context to STM-only mode. STM compaction is represented as a preflight directive: if refresh fails or TST is unavailable, the directive explicitly aborts and requires preservation of the full durable transcript.

## Lossless plan authority

The lossless plan store preserves the exact original user source text, creates stable `P01`, `P02`, … phases, persists atomically in a private runtime directory, and exposes overview/phase/search retrieval through the runtime control surface. The stored plan is canonical requirement truth; chat/UI projections are not allowed to replace it.

## TST bridge

The runtime lazily connects to the authenticated `cuppet.tst.v3` length-prefixed JSON-RPC protocol when `CUPPET_TST_SOCKET` and `CUPPET_TST_TOKEN` are present. Desktop startup does not depend on TST. When unavailable, Cuppet degrades to full-transcript provider requests and background enrichment remains idle.

The B1 bridge exposes context preparation, STM refresh, turn completion, memory query/observation, and evidence recording without giving the renderer socket/token access.

## Background enrichment

Foreground completion records a bounded user/assistant signal for the project-local background worker. The worker:

- waits for foreground idle (default 60 seconds);
- enforces a per-session cooldown (default 15 minutes);
- uses the optional background model, falling back to the primary model;
- produces at most four JSON candidates;
- rejects secret-bearing candidates;
- uses a deterministic bounded candidate ledger for support/contradiction/admission;
- always writes model output to TST with provenance `model_candidate`;
- records user-preference evidence separately when deterministic user cues support it.

The secondary model never decides promotion. If TST is not configured, no background model call is made.

## Orchestrator and model roles

Cognitive state is persisted outside the renderer. Roles are explicit:

- foreground coding: primary model
- planning: primary model
- background canonicalization: secondary model
- orchestrator master: primary model
- delegated worker: secondary model

When Orchestrator is enabled, automatic Cuppet context and lossless-plan injection are both disabled. The durable transcript is sent unchanged; explicit retrieval/delegation surfaces can be built on this control contract without a hidden automatic context path.

## Desktop controls

The top bar exposes:

- Build / Plan per-chat mode
- Orchestrator on/off
- Background enrichment pause/resume
- TST configured/connected state

Provider settings add an optional background model ID. API key handling remains in Electron main via `safeStorage`.

## Acceptance gate

`npm run phaseb1:verify` validates source structure and runs B1 tests for:

- detached context and same-turn cache stability;
- fail-closed history trimming;
- plan-mode budget/projection behavior;
- true Orchestrator bypass;
- STM-compaction abort behavior;
- exact lossless-plan persistence/retrieval;
- deterministic candidate admission and secret rejection;
- background `model_candidate` authority;
- runtime provider/SQLite separation;
- persisted cognitive controls.

CI must also keep Phase 0, Phase A, and Phase B gates green.
