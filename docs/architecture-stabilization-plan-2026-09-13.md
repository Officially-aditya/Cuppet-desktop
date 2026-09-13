# Cuppet Desktop Architecture Stabilization Plan

Updated: 2026-09-13
Branch: `feat/provider-architecture-v2`

## Goal

Finish the ownership migration identified by the T3 Code / OpenCode Desktop / Cuppet Desktop architecture review before adding more provider-specific behavior or cutting another alpha.

The target is not to copy T3 or OpenCode wholesale. Cuppet keeps its multi-provider ACP/Codex/API architecture, Cuppet-owned execution tools, TST, PE3, remote control, and provider-independent conversations. The invariants we are adopting are:

1. one runtime authority for provider/runtime state;
2. durable state changes happen before publication;
3. one explicit turn/run lifecycle;
4. client views consume projections rather than owning workflow state;
5. side effects have a single owner and crash-recovery contract.

## Completed stabilization work

### Provider Control Plane — complete for current scope

- Provider install/detect/auth/model discovery moved behind runtime RPC.
- Electron main is a thin native/secret/proxy boundary rather than a provider lifecycle authority.
- Runtime health is separate from authentication state.
- Capability lifecycle is explicit: `unknown / loading / ready / stale / failed / blocked`.
- Local provider installation identity is bound to the resolved executable rather than a historical install flag.
- OpenCode compatibility policy is centralized at `>= 1.18.30` and enforced for status, capability discovery, and managed ACP execution.
- External incompatible installs are never auto-mutated.
- Cuppet-managed incompatible installs can be repaired only through an explicit connect/update action.
- Secure storage is lazy for local CLI / OAuth providers.

### Provider process safety — substantially complete

- Managed ACP runtime supervision has explicit health and generation/restart state.
- Dead idle ACP processes can be rebuilt before the next turn.
- A turn that may already have caused side effects is never automatically replayed.
- Provider failures are structured rather than being inferred only from strings.
- Real macOS LaunchServices/Finder PATH recovery is covered end-to-end in CI.

### Runtime/client ownership — partially complete

- Runtime-owned durable queue replaces renderer-owned dispatch queues.
- Runs and queue state share `conversations.sqlite3` with messages and tool history.
- Assistant message + run phase transitions share one SQLite transaction through projection triggers.
- `RunStateProjection` is the sole semantic active-run authority; the live AbortController map is process metadata only.
- Runtime health reports durable `activeRuns` separately from process-local `liveExecutions`.
- Permission/question waits are reference-counted by request ID so overlapping waits cannot resume a run early.
- Transcript event ownership has moved out of `ChatPane` into a renderer client-runtime store.
- TST `turn.completed` now fires at the true terminal run boundary instead of on the next prompt.
- Remote credential revocation reauthorizes live commands and immediately ejects revoked devices.
- Lossless-plan read/modify/write mutations are serialized per session.

### Durable mutation recovery — complete for current scope

- Multi-file TST batches persist a pending mutation intent before the first workspace write.
- Pending intents contain per-file preimages plus expected post-write identity.
- Successful mutation history becomes durable before the pending intent is removed.
- Restart recovery is hash-safe:
  - files still matching their preimage are left unchanged;
  - files matching the expected Cuppet postimage are restored to the durable preimage;
  - files matching neither are preserved and reported as recovery conflicts.
- Partially-created files are removed only when the durable preimage proves they did not exist.
- Committed batches are never rolled back by stale pending-intent cleanup.
- Crash-recovery regressions cover partial multi-file publication, created-file recovery, committed batches, and unknown external edits.

### Canonical runtime event coverage — complete for current P0 scope

- `runtime_events` is the canonical ordered per-session event log for run/queue lifecycle and restart recovery.
- Permission/question waits durably record `run.waiting`, `run.wait.resolved`, and `run.resumed` in the same transaction as their run/wait projection changes.
- Tool lifecycle records metadata-only `tool.started` / `tool.finished` events associated with the durable run.
- TST batch lifecycle records metadata-only `edit.batch.prepared` / `edit.batch.applied` events.
- Mutation recovery/conflict/undo events can be durably attached to a session even when no run is active.
- Run and queue restart recovery transitions are durably journaled and are never reconstructed by replaying side effects.
- Durable event projection deliberately excludes prompt bodies, tool arguments, tool output, full diffs, API keys, and arbitrary provider payloads; bounded diagnostics redact bearer credentials.
- Whitelisted mutation events are persisted before renderer/remote publication; persistence failure is surfaced as a durability diagnostic rather than publishing the mutation event as if durable.

### Explicit Turn authority — complete for current scope

- `runs.phase` is the canonical detailed durable turn lifecycle; existing `runs.status` remains a compatibility projection for admission and older clients during migration.
- Canonical phases are `preparing`, `provider_starting`, `streaming`, `waiting_for_user`, `tool_running`, `waiting_for_provider`, `settling`, plus terminal `complete`, `stopped`, `interrupted`, and `error`.
- The assistant transcript row and `preparing` run projection are created in one SQLite transaction.
- Runtime ownership advances the run to `provider_starting`; first durable text/reasoning output advances it to `streaming`.
- Tool lifecycle projects `tool_running -> waiting_for_provider` without provider-specific interpretation above the execution boundary.
- Permission/question requests project `waiting_for_user`; provider telemetry cannot resume the run while any human wait remains; the final resolution advances to `waiting_for_provider`.
- Message terminalization projects `settling` before final run completion.
- Terminal run history is immutable; restart recovery deterministically terminalizes active runs as `interrupted` and records the previous detailed phase.
- Existing databases gain the phase column through deterministic compatibility backfill, and existing coarse status consumers remain valid.
- Lifecycle regressions cover normal streaming, tools, human waits, resume ordering, transactional rollback, terminalization, and legacy-schema restart migration.
- Milestone 1.3 was validated on exact head `852344ea236fb592cdb65e40d59d5d55c82a8309` with Provider V2 Selected, full phase gates, live OpenCode ACP, macOS LaunchServices, and packaged-runtime smoke all green.

## Remaining milestones

# Milestone 1 — Durable Runtime Core

Priority: P0

The next implementation milestone is command idempotency for dangerous externally issued mutations.

### 1.4 Command receipts / idempotency

Durable receipts already protect `session.send` and its queue admission path. Finish receipt/idempotency coverage for externally issued mutations where duplicate dispatch would be dangerous.

Remaining initial targets:

- mutation/apply commands;
- remote mutation commands;
- any queue/mutation transition that can still be retried outside an already-transactional receipt boundary.

A command ID must resolve to one of: accepted, committed, terminally failed, or unknown. Retrying the same command ID must not duplicate a turn or tool side effect.

### 1.5 Transaction boundary cleanup

Move toward:

```text
command
  -> validate/decide
  -> one SQLite transaction
       append runtime event(s)
       update projection(s)
       persist command receipt
  -> commit
  -> publish to renderer/remote
  -> run external reactors/side effects where applicable
```

This should be introduced incrementally around existing working paths; do not rewrite the entire RuntimeService in one patch.

## Milestone 2 — Client Runtime Cleanup

Priority: P1

### 2.1 Finish view/state separation

Renderer client runtime should own shared projections for:

- session state;
- transcript state;
- provider state;
- runtime/connection state;
- queue/run state.

`ChatPane` should primarily render and dispatch commands.

Composer draft/attachment state may remain view-local where it is intentionally ephemeral, but it must not own server workflow state.

### 2.2 Remove compatibility event paths

Desired boundary:

```text
ACP / Codex / HTTP / future provider
            -> ProviderAdapter
            -> canonical Cuppet Activity / ProviderFailure
            -> Runtime
            -> client projection
```

Remove legacy provider event compatibility once all consumers use canonical Activity/Failure types.

### 2.3 Remote parity

Remote/mobile clients should consume the same durable session/run/transcript/provider projections instead of maintaining a parallel interpretation of runtime events.

## Milestone 3 — Production Hardening

Priority: P1/P2

### 3.1 Complete provider supervisor policy

Add only the missing production behavior around the existing ACP supervisor:

- explicit startup/handshake health gates;
- bounded retry/backoff for safe pre-turn failures;
- sleep/wake/network recovery where applicable;
- one restart owner;
- diagnostic snapshots suitable for support bundles.

Never auto-replay a side-effecting turn.

### 3.2 Graph/history durability

- make graph-cache invalidation deterministic after workspace mutation;
- make stale graph state restart-safe;
- ensure history/materialized projections can be rebuilt from durable authority;
- remove independent caches that can silently disagree after restart.

### 3.3 PE3 and long-running routing consistency

- ensure routing never loses the source task's durable run/requirement identity;
- keep newly created sibling sessions as separate task identities unless explicitly forked;
- make restart behavior deterministic for accepted/committed handoffs.

### 3.4 Distribution security

- stable Apple Developer ID signing;
- notarization;
- stable Keychain identity/entitlements;
- production updater trust chain;
- retain real LaunchServices acceptance testing in CI.

### 3.5 OpenCode runtime ownership decision

Current policy is safe PATH-based compatibility enforcement. Bundling/pinning an OpenCode sidecar remains optional.

Decision gate:

- bundle only if user-owned auth/provider behavior can remain intact and the operational reliability gain outweighs maintenance cost;
- otherwise retain external CLI ownership with explicit supported-version policy and health checks.

## Implementation order from here

1. Finish command receipts/idempotency for dangerous mutation and remote mutation commands.
2. Tighten remaining command/event/projection transaction boundaries.
3. Extract remaining renderer server-state ownership.
4. Remove legacy provider event compatibility.
5. Remote/PE3 projection parity and graph/history durability.
6. Signing/notarization and final production supervisor hardening.

## Release rule

Do **not** cut the next alpha merely because an intermediate slice is green. A release candidate should require:

- full CI green on the exact release head;
- Provider V2 selected gate green;
- real macOS LaunchServices provider-path acceptance green;
- packaged-runtime smoke green;
- no known P0 crash-consistency or duplicate-side-effect issue;
- explicit record of any remaining P1/P2 gaps.
