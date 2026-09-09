# Phase B2 — PE3 task-local routing

Phase B2 moves Cuppet's PE3 context scheduler from the old OpenCode controller/patch boundary into the independent desktop runtime.

## Goal

A project may contain several long-running coding tasks. PE3 keeps each task in its own durable SQLite session and routes each new prompt to the best task context before the prompt is committed. The routing layer must preserve continuity without allowing stale task identity to override current workspace truth.

## Routing pipeline

```text
incoming project prompt
        │
        ▼
deterministic affinity
  ├─ continuation / active path or symbol match → continue
  ├─ dormant match → reactivate
  └─ ambiguous
        │
        ▼
TST graph localization (when available)
        │ still ambiguous
        ▼
local feature embedding
        │
        ├─ decisive dormant winner → reactivate
        ├─ strong active match → continue
        ├─ clear novelty → create sibling task session
        └─ low confidence / failure → continue active task
```

No remote LLM/classifier call is used for task routing. The final ambiguity breaker is Cuppet's built-in `cuppet/subword-hash-v1` feature embedding: a bounded 512-dimensional normalized vector built from word, word-order, and subword features using deterministic hashing. It performs no model download, network request, native-runtime loading, or disk cache write.

This stage is deliberately lower authority than deterministic task evidence and TST localization. It is not presented as a neural sentence-embedding replacement. Its job is to break obvious lexical/subword ambiguity cheaply and locally; low-confidence cases preserve the active task because a false split is more damaging than a temporary missed split.

## Authority boundary

- SQLite sessions/messages are the only task transcript authority.
- `sessions.project_id` remains the project-binding authority.
- PE3's project-local registry stores bounded routing metadata only.
- Current filesystem state is authoritative for file contents and existence.
- TST is optional localization evidence, not transcript authority.
- Feature vectors are process-local caches and are never persisted.
- The renderer only follows runtime route events; it never chooses the target task itself.

## Weighted task identity

Task fingerprints favor concrete working-set evidence over incidental language:

1. touched/modified paths;
2. observed active/read paths and tool symbols;
3. TST-localized paths/symbols;
4. prompt-mentioned paths/symbols;
5. lexical terms.

Weak prompt/localization signals decay as turns advance. Ambiguous routing falls back to the active task because a false split is more damaging than a temporary missed split.

## Local feature embedding

`LocalFeatureEmbeddingProvider` is dependency-free production code. It normalizes and bounds input, extracts at most 512 word-like tokens, adds weighted unigram/bigram/trigram and 3–4 character subword features, hashes them into a bounded power-of-two vector, then L2-normalizes the result.

The provider is deterministic for the same normalized input and exposes model ID `cuppet/subword-hash-v1`. Production PE3 uses it by default, while tests/future adapters may inject another embedding provider through the existing constructor boundary. The conservative `SemanticTaskRouter` thresholds and fail-closed behavior remain unchanged.

The previous `@huggingface/transformers`/ONNX default was removed from the production dependency graph during E1 packaging hardening after dependency audit surfaced high-severity transitive advisories with no upstream fix. PE3 therefore no longer needs `onnxruntime-node`, `sharp`, model downloads, or Transformers cache directories in packaged builds.

## Persistence and staleness

Each project may persist at most 32 task identities in `pe3-task-agents.json`. The file contains descriptors, bounded path/symbol/term fingerprints, stale paths, epochs, timestamps and file signatures. It never stores transcripts, tool output, provider prompts, credentials or embedding vectors.

On restore, file signatures are compared against the current checkout. Changed or missing privileged paths are removed from active/touched fingerprint privilege and marked stale. A reactivated task receives a bounded ephemeral refresh instruction naming those paths. The refresh hint is model-facing context only and is not written into the visible transcript.

Corrupt or unsupported registry data fails closed to a fresh router and never blocks desktop startup.

## Transactional handoff

PE3 routing occurs before the new user message is durable.

```text
prepare route
   ↓
accept target availability
   ↓
SQLite transaction
   ├─ create sibling task session when needed
   ├─ write bounded source routing marker for cross-session moves
   ├─ write user message once to the target
   └─ create target streaming assistant message
   ↓
commit router state
```

If acceptance or the SQLite transaction fails, the PE3 route is aborted and the source request is preserved. No half-created task turn is allowed to survive.

## Attachments

The B2 routing envelope supports up to 16 bounded attachment metadata records. MIME metadata is validated. Only metadata is routed at this phase; PE3 never invents or assumes attachment contents it has not read. Attachment metadata may contribute path affinity and is injected only as ephemeral provider context.

## Desktop behavior

When PE3 creates or reactivates another task session, the runtime returns the actual target session ID and emits `pe3.routed`. The renderer automatically follows that session so streamed output, Stop, mode controls and conversation history stay aligned with the execution target.

## Environment controls

- `CUPPET_PE3=0` — disable automatic PE3 routing.

The production feature embedding has no model/cache/download environment controls because it has no external model or network dependency. An alternate provider can still be injected through the runtime constructor boundary where needed for tests or a future intentionally reviewed adapter.

## Acceptance gate

`npm run phaseb2:verify` checks the production routing invariants and runs focused tests for deterministic switching/reactivation, conservative semantic fallback, the dependency-free local feature embedding, persisted staleness, transaction rollback, attachment bounds, dormant stale-task reactivation and full-runtime target-session ownership.

All earlier gates remain mandatory. B2 is accepted only when Phase 0, A, B, B1 and B2 are green together.
