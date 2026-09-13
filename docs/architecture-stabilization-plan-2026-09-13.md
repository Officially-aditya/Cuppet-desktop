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
- `runtime_events` exists for durable run/queue lifecycle.
- Assistant message + run phase transitions share one SQLite transaction through projection triggers.
- Durable run phases include `starting`, `running`, `waiting`, `settling`, and terminal states.
- Permission/question waits are reference-counted by request ID so overlapping waits cannot resume a run early.
- Transcript event ownership has moved out of `ChatPane` into a renderer client-runtime store.
- TST `turn.completed` now fires at the true terminal run boundary instead of on the next prompt.
- Remote credential revocation reauthorizes live commands and immediately ejects revoked devices.
- Lossless-plan read/modify/write mutations are serialized per session.

## Remaining milestones

# Milestone 1 — Durable Runtime Core

Priority: P0

This is the next implementation milestone.

### 1.1 Crash-safe mutation intents

Problem: multi-file TST batches currently snapshot preimages in memory and only become durable after all files have been published. A runtime/process crash between file publications can leave a partially applied workspace with no durable recovery record.

Target:

- persist a pending batch mutation intent before the first workspace write;
- record per-file preimage plus expected post-write hash;
- atomically publish files as today;
- on successful journal commit, mark/remove the pending intent only after durable history exists;
- on restart:
  - if a file still matches its preimage, leave it;
  - if it matches the expected postimage, restore the preimage;
  - if it matches neither, do not overwrite it and report a recovery conflict;
- never silently destroy a user/external edit during recovery.

Acceptance:

- simulated crash after N of M file publications restores all safely recoverable files after journal restart;
- successful committed batches are never rolled back by stale pending-intent cleanup;
- unknown external hashes produce a conflict, not an overwrite.

### 1.2 Canonical runtime event coverage

Current `runtime_events` primarily covers run/queue lifecycle. Expand durable event coverage incrementally for the state that must be replayable/debuggable:

- turn lifecycle;
- human-interaction waits;
- tool execution lifecycle;
- mutation lifecycle;
- terminal recovery transitions.

Do not duplicate secrets or queued prompt bodies into diagnostic/runtime events unless the event is intentionally the canonical content authority.

### 1.3 Explicit Turn authority

Converge the durable lifecycle to one canonical model:

```text
queued
  -> preparing
  -> provider_starting
  -> streaming
       -> waiting (permission/question)
       -> tool_running
       -> waiting_for_provider
  -> settling
  -> complete

terminal:
  stopped
  interrupted
  error
```

Requirements:

- message status is a transcript projection, not the sole run authority;
- provider protocol completion and Cuppet turn completion remain separate;
- terminal state is immutable;
- restart recovery is deterministic and journaled;
- side effects are never replayed merely to reconstruct state.

### 1.4 Command receipts / idempotency

Add durable receipts for externally issued runtime mutations where duplicate dispatch would be dangerous.

Initial targets:

- `session.send`;
- queued-turn dispatch;
- mutation/apply commands;
- remote mutation commands.

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

1. Crash-safe pending mutation intents and restart recovery.
2. Extend runtime event coverage around mutations/tools/recovery.
3. Add command receipts/idempotency for dangerous mutations.
4. Finish canonical Turn lifecycle transitions and publication ordering.
5. Extract remaining renderer server-state ownership.
6. Remove legacy provider event compatibility.
7. Remote/PE3 projection parity and graph/history durability.
8. Signing/notarization and final production supervisor hardening.

## Release rule

Do **not** cut the next alpha merely because an intermediate slice is green. A release candidate should require:

- full CI green on the exact release head;
- Provider V2 selected gate green;
- real macOS LaunchServices provider-path acceptance green;
- packaged-runtime smoke green;
- no known P0 crash-consistency or duplicate-side-effect issue;
- explicit record of any remaining P1/P2 gaps.
