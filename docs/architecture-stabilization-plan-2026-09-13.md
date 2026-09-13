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

### Runtime/client ownership — complete for current desktop-renderer scope

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
- Undo persists a durable `undo-intent` before restoring workspace bytes.
- Restart recovery can finish a partially-completed multi-file undo, remove a partially undone created file, and preserve unknown external edits as explicit recovery conflicts.
- Undo and TST publication share project-level writer serialization so separate sessions cannot mutate the same workspace concurrently through those paths.
- Crash-recovery regressions cover partial multi-file publication, created-file recovery, committed batches, unknown external edits, partial undo, created-file undo, and conflicted undo recovery.

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

### Command receipts / idempotency — complete for current P0 scope

- Durable receipts protect externally retryable `session.create`, `session.steer`, and `session.undo` mutations in addition to `session.send`.
- Remote envelopes provide stable command identity across adapter recreation and slash-command dispatch.
- Retry of the same command ID replays the accepted result or stops at the receipt boundary instead of duplicating a mutation.
- Reuse of a command ID for a different payload is rejected as a conflict.
- A crash after a side effect but before receipt completion recovers conservatively as `unknown`; the runtime never redispatches the mutation merely to discover whether it happened.
- Retry-sensitive remote mutation commands fail closed when no stable envelope command ID is available.
- Runtime regressions cover duplicate create/steer/undo delivery, command-ID conflict, restart-to-unknown, stable remote IDs, and adapter recreation.

### Transaction boundary cleanup — complete for current P0 scope

- DB-only session creation and its accepted command receipt commit atomically in the shared SQLite transaction; a receipt write failure rolls back the session insert.
- Transcript/run projection/event transitions already use shared `TurnStore` transactions where they belong to the same SQLite authority.
- Filesystem/provider side effects are not incorrectly pulled into SQLite; they use durable processing/intent state before the external effect and recover to a known result, `unknown`, or explicit conflict.
- Workspace undo now has a durable pre-side-effect intent and hash-safe restart completion.
- Mutation publication remains after durable persistence; failed durability does not publish the mutation as committed.
- Milestones 1.4 and 1.5 were validated on exact head `04bb70403800d682a0e768a4f3b26342a1c11d25` with Provider V2 Selected, all phase gates, real macOS LaunchServices/Finder PATH acceptance, and packaged-runtime smoke green.

### Client runtime view/state separation — complete for current desktop scope

- `client-session-state.ts` owns the shared session collection and detailed active-session projection; summary-list refreshes preserve already-fetched messages, activities, and tool history.
- `App` owns only the selected `activeSessionId` for navigation and derives the active server projection from the shared session store.
- Message deltas and message/run/tool detail refreshes are reduced in the session store rather than in `App`.
- `client-transcript.ts` owns durable/live transcript merge and canonical Activity reduction; `ChatPane` renders the projection instead of interpreting runtime events.
- `client-run-state.ts` owns the renderer run-state projection; queue ordering and dispatch remain runtime-owned and durable.
- `client-provider-state.ts` owns provider settings synchronization; both `App` and `ModelPicker` consume the shared snapshot instead of keeping independent canonical settings copies.
- `ModelPicker` keeps only model-catalog/capability and menu interaction state local; provider settings reads are routed through the shared provider projection.
- `client-remote-state.ts` owns user-visible Remote connection/status projection and reconciles runtime lifecycle events; pairing QR/invite/note/busy state remains intentionally view-local.
- Local runtime child-process/socket connection and recovery remain owned by main-process `RuntimeClient`; the renderer does not maintain a competing local-runtime process authority.
- Renderer ownership regressions forbid session/run/provider/remote workflow state from drifting back into view components while allowing intentionally ephemeral composer, modal, form, and navigation state.
- Milestone 2.1 was validated on exact head `a1e9958e45ebe3e672b02632874319bad0ef0ce1` with Provider V2 Selected, all phase gates, real macOS LaunchServices/Finder PATH acceptance, and packaged-runtime smoke green.

### Provider compatibility event removal — complete for current provider/runtime scope

- Managed ACP and stateless ACP emit canonical `Activity` directly through `onActivity`; neither path downgrades canonical activity into provider-specific legacy events.
- `ProviderRuntimeManager` no longer contains the canonical-to-legacy fallback or legacy activity state machine.
- `JournaledToolRuntime` no longer accepts `onProviderEvent` ingress and persists/publishes only canonical provider Activity plus genuine execution lifecycle events.
- `activityFromLegacyProviderEvent`, `legacyProviderRuntime`, and `runtime-manager-legacy.mjs` have been removed from production/exported provider surfaces.
- Provider reasoning/tool telemetry remains distinct from real Cuppet execution lifecycle; genuine execution `tool.started` / `tool.finished` events remain available for durable runtime and remote semantics.
- Provider/renderer regressions prohibit reintroducing legacy provider event conversion while preserving canonical Activity ordering and execution lifecycle behavior.
- Milestone 2.2 was validated on exact head `2c354dc623289bb10248f9846c196f91270d0f3e` with Provider V2 Selected, all phase gates, real macOS LaunchServices/Finder PATH acceptance, released OpenCode ACP smoke, and packaged-runtime smoke green.

### Remote/mobile projection parity — complete for current scope

- `session.snapshot` reuses the durable `session.get` projection so remote clients receive the same messages, canonical Activities, and tool-execution history as desktop clients.
- The remote snapshot includes the canonical durable run row from `session.run.latest`, including detailed phase/status rather than inferring run state from transient events.
- Runtime message/activity/tool/run/session events invalidate the remote session projection instead of creating a parallel `assistant.text.delta` / raw-tool interpretation in the browser client.
- The remote browser rehydrates the durable snapshot after invalidation; its Stop availability is derived from durable run status (`starting / running / waiting / settling`).
- Host provider-configuration changes invalidate the connected remote provider projection; per-device provider/model/effort choices are reconciled through `resolveAdvertisedSelection`, preserving valid selections and dropping stale ones.
- Provider synchronization remains lazy for unused Remote: config updates do not create remote identity/state unless a bridge already exists.
- Remote parity regressions forbid live transcript reducers from returning and cover transcript/tool/run hydration, provider invalidation, and stale-effort reconciliation.
- Milestone 2.3 was validated on exact head `c489d97d4eb64b940b00d9e2afda2738bcf2c510` with Provider V2 Selected, all phase gates, real macOS LaunchServices/Finder PATH acceptance, released OpenCode ACP smoke, and packaged-runtime smoke green.

## Remaining milestones

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

1. Finish provider supervisor production policy.
2. Finish graph/history and PE3 restart durability.
3. Complete signing/notarization and production updater hardening.

## Release rule

Do **not** cut the next alpha merely because an intermediate slice is green. A release candidate should require:

- full CI green on the exact release head;
- Provider V2 selected gate green;
- real macOS LaunchServices provider-path acceptance green;
- packaged-runtime smoke green;
- no known P0 crash-consistency or duplicate-side-effect issue;
- explicit record of any remaining P1/P2 gaps.