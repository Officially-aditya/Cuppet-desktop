# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Phase C2 — independent remote control, relay, setup, and token boundary: implemented candidate.**

Cuppet now owns the remote-control host boundary directly on top of the independent runtime. Devices can attach to projects/sessions, submit work, stop runs, switch Build/Plan mode, select host-configured models, and answer C1 permission requests without depending on the old OpenCode controller.

The relay remains transport-only: it performs zero coding inference, persists no transcript, and never receives provider API keys. Device identity/scopes are enforced by the host through local pairing credentials or locally verified short-lived managed Ed25519 tokens.

Phases A, B, B1, B2, and C1 remain intact: SQLite conversations, project import/binding, detached context compilation, lossless plans, TST/STM, evidence-gated background memory, PE3 task routing, runtime-owned coding tools, and the independent permission boundary remain authoritative.

The production source still has **no OpenCode dependency**.

### Run it

```bash
npm install
npm start
```

Open **Provider settings** and configure an OpenAI-compatible base URL, primary model ID, and API key. An optional background model can be configured separately. Provider keys remain encrypted through Electron `safeStorage` and are never exposed to the renderer.

## Remote control

The desktop **Remote** surface can start/stop the local host, use a manual relay or the managed Cuppet account-link flow, create trusted/viewer pairing invitations, list paired devices, and revoke them.

The same implementation is available headlessly:

```bash
cuppet remote-control
cuppet relay
cuppet remote-enroll --token <session-token>
```

Headless provider configuration stays local (`CUPPET_API_KEY`, `CUPPET_MODEL`, `CUPPET_BASE_URL`). A remote device cannot provide or retrieve host provider credentials.

Remote protocol v1 preserves:

- 512 KiB frame cap;
- monotonic host event sequence numbers;
- reconnect snapshots + host-process `connectionId`;
- replay-safe command IDs;
- per-command scopes;
- single-use short-lived pairing invites;
- viewer read-only scope;
- host/device-bound Ed25519 managed tokens;
- host replacement invalidating previously authenticated device authority.

The self-host relay is a trusted transport, not an end-to-end-encrypted boundary. Use TLS before exposing it outside localhost.

Two old command surfaces intentionally fail instead of inventing authority: `session.undo` waits for an independent mutation journal, and interactive question reply/reject waits for an independent runtime question broker.

## Runtime-owned coding tools

Project-bound chats expose a deliberately small tool surface:

- `tst_explore` — TST workspace/tree/search/trace discovery;
- `tst_read` — exact bounded filesystem reads;
- `workspace_edit` — precise text replacement;
- `workspace_write` — bounded UTF-8 file creation/replacement;
- `bash` — project-scoped shell execution;
- `cuppet_plan` — lossless implementation-plan retrieval;
- `cuppet_memory_search` — Cuppet memory retrieval.

General chats do not receive filesystem or shell tools.

### Structural exploration first

`tst_explore` consolidates the old graph navigation surface into four modes:

```text
workspace → bounded project overview
tree      → bounded project-relative file tree
search    → structural symbol/path localization
trace     → bounded caller/callee/dependency trace
```

TST owns structural discovery; it does **not** become source-content authority. After navigation, `tst_read` resolves and reads the current filesystem file.

Identical exploration calls are cached per session. Repeating the same query returns a compact reference rather than paying for duplicate graph output.

### Provider tool loop

The OpenAI-compatible provider adapter reconstructs streamed `tool_calls`, including fragmented names and JSON arguments.

```text
SQLite durable transcript
        │ detached model projection
        ▼
ContextCompiler + PE3 ephemeral context
        ▼
Provider inference
   │                 │
   │ text            │ tool call
   ▼                 ▼
visible stream   ToolRuntime
                     │
                     ▼
              PermissionBroker
                │ allow/deny
                ▼
               execute
                │
                ├── bounded tool result → provider loop
                ├── durable audit → SQLite tool_executions
                └── observed/mutated paths → PE3
```

Provider-only tool-call/tool-result messages are ephemeral. They are not appended to the visible SQLite `messages` transcript.

## Permission boundary

Permissions are runtime policy, not model policy and not renderer/remote policy.

### Reads

Ordinary project reads remain automatic. Sensitive files such as `.env`, credential-like files, private keys, and certificates require approval. `.env.example` remains readable as template/documentation data.

Cuppet-owned credential/runtime files are denied rather than merely prompted.

### Edits and writes

Edits/writes require approval unless **guarded auto** is enabled for that session and the exact path passes containment and sensitivity checks.

Guarded auto is intentionally narrow:

- session-scoped;
- project-contained files only;
- no sensitive paths;
- no symlink escapes;
- no shell-command auto approval.

### Safe bash

Only the pinned metadata-only command family can run automatically:

- `pwd`;
- `ls` with a small flag allowlist and no path operand;
- bounded read-only `git status`, `git log --oneline`, `git branch`, `git ls-files`, and selected `git rev-parse`;
- common toolchain version commands.

Arbitrary commands, shell chaining/redirection/expansion, installs, builds, tests, mutation commands, and path-bearing discovery commands require permission.

### Visible permission choices

When a model requests protected work, the desktop or an authorized remote device can choose:

- **Allow once**;
- **Always this exact request**;
- **Reject**;
- **Enable guarded auto** only from the local desktop when the runtime marks the workspace resource eligible.

“Always” is an exact action + exact resource fingerprint for the current session. It is not a wildcard rule.

Plan mode remains read-only at the runtime boundary. Noninteractive/headless execution fails closed when an operation would require consent.

## Durable tool audit

SQLite `tool_executions` is the authority for model-requested tool execution history. It stores tool name, call ID, argument JSON, bounded output, status, permission source, and timestamps separately from visible chat messages.

A stale `running` row after process restart is converted to an interrupted error rather than being treated as a successful tool.

Runtime limits include:

- 64 tool calls per generation;
- 128 KiB tool output;
- 1 MiB file read/edit/write ceiling;
- 16 resources per permission request;
- 120-second maximum shell timeout.

## PE3 task-local routing

B2 remains the task-context scheduler for project chats:

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

Tool execution feeds PE3 directly:

- successful exploration/read → observed paths;
- successful edit/write → workspace mutation;
- shell commands that leave Git-visible changes → workspace mutation;
- rejected/failed tools → no path-privilege update.

Cross-task routing remains transactional: prepare → target accept → SQLite transaction → router commit. Task contexts are ordinary SQLite sessions; PE3 stores only bounded routing metadata.

## Cognitive runtime

B1's detached context architecture remains unchanged:

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
Provider + runtime tool loop
        │
        ▼
SQLite durable assistant result
```

Synthetic retrieval/context is never written back into the visible conversation.

### Foreground context

- maximum synthetic context: 2,048 tokens;
- target budget: 4% of usable provider context, with a 512-token floor;
- STM / graph / verified LTM allocation: 45 / 35 / 20;
- context memoized by session + current user-message epoch for cache stability;
- history trimming remains fail-closed without complete TST coverage.

### Plan mode and lossless requirements

Build/Plan mode remains session-persisted. Plan mode can use up to 12% of usable context, capped at 16K tokens, with workspace projection / graph / STM / LTM allocation of 70 / 15 / 10 / 5.

`LosslessPlanStore` preserves canonical source requirements independently from todo/chat projection and exposes stable `P01`, `P02`, … phases.

### TST / STM and memory

When `CUPPET_TST_SOCKET` and `CUPPET_TST_TOKEN` are configured, the runtime lazily connects to authenticated `cuppet.tst.v3`. TST remains optional for desktop startup.

If TST is unavailable, unsafe history replacement/STM compaction fails closed and structural `tst_explore` reports that the graph is unavailable rather than inventing topology.

The secondary/background model remains a canonicalizer only. `model_candidate` output does not gain durable promotion authority merely because a model selected it.

## Projects

Phase B remains intact:

- **Local folder** — register an existing folder; detect Git root/origin when available.
- **GitHub URL** — clone normal HTTPS/SSH `github.com` repositories with existing credentials.
- **GitHub repositories** — browse using an already-authenticated `gh` CLI session and clone the selected repository.

Chats remain permanently bound to their project. Switching projects cannot retarget an active run, removing a registration does not delete the checkout, and missing folders can be relocated without losing history.

## Phase gates

```bash
npm run phase0:verify
npm run phase1:verify
npm run phaseb:verify
npm run phaseb1:verify
npm run phaseb2:verify
npm run phasec1:verify
npm run phasec2:verify
```

C2 verifies protocol/pairing/token/setup boundaries, authenticated scope-checked/replay-safe command routing, real relay/host/device integration, runtime-backed remote actions, lifecycle cleanliness, desktop/headless surfaces, and the rule that provider secrets never become remote state.

## Architecture

```text
Electron renderer
    ├── conversations/projects
    ├── permission decision UI
    └── Remote lifecycle UI
          │ narrow contextBridge
          ▼
Electron main
    ├── native folder picker
    ├── OS-encrypted provider settings
    └── local provider configuration forwarding
          │ NDJSON runtime protocol
          ▼
Independent Node runtime
    ├── SQLite
    │    ├── projects
    │    ├── task sessions/messages
    │    └── tool_executions
    ├── ProjectManager
    ├── PE3 project router
    ├── CognitiveStateStore
    ├── ContextCompiler / LosslessPlanStore
    ├── TST / STM bridge
    ├── PermissionBroker
    ├── ToolRuntime
    │    ├── tst_explore / tst_read
    │    ├── workspace_edit / workspace_write
    │    └── bash
    ├── evidence-gated background enricher
    ├── OpenAI-compatible provider adapter
    ├── RemoteManager / RemoteBridge
    │    ├── host identity + device scopes
    │    ├── local/JWT authentication
    │    └── runtime-backed command adapter
    └── generation/tool cancellation
          │ outbound WebSocket only
          ▼
Cuppet relay
    ├── transport/presence
    ├── bounded in-memory replay
    └── optional browser Remote client
```

Authority stays explicit:

- filesystem → source/workspace truth;
- TST graph → structural navigation;
- SQLite project rows → project registration identity;
- SQLite sessions/messages → visible task/conversation truth;
- SQLite tool executions → durable tool audit;
- PermissionBroker → protected-operation approval authority;
- PE3 registry → bounded task-routing metadata only;
- LosslessPlanStore → canonical implementation requirements;
- TST LTM → verified reusable memory;
- CognitiveStateStore → mode/orchestrator/background controls;
- Electron main/headless host → provider-secret authority;
- remote device state → ephemeral selection/projection only;
- relay → transport/presence only;
- renderer → presentation/navigation/approval projection only.

## Migration docs

- Phase 0 audit: [`docs/phase-0-behavior-inventory.md`](docs/phase-0-behavior-inventory.md)
- Phase A architecture: [`docs/phase-1-architecture.md`](docs/phase-1-architecture.md)
- Phase B projects: [`docs/phase-b-projects.md`](docs/phase-b-projects.md)
- Phase B1 cognitive runtime: [`docs/phase-b1-cognitive-runtime.md`](docs/phase-b1-cognitive-runtime.md)
- Phase B2 PE3 routing: [`docs/phase-b2-pe3-routing.md`](docs/phase-b2-pe3-routing.md)
- Phase C1 tools/permissions: [`docs/phase-c1-tools-permissions.md`](docs/phase-c1-tools-permissions.md)
- Phase C1 contract: [`migration/phase-c1-contract.json`](migration/phase-c1-contract.json)
- Phase C2 remote control: [`docs/phase-c2-remote-control.md`](docs/phase-c2-remote-control.md)
- Phase C2 contract: [`migration/phase-c2-contract.json`](migration/phase-c2-contract.json)

## Migration rule

A later phase may replace an old OpenCode mechanism, but it may not silently replace Cuppet policy. Context compilation, plans, PE3, evidence-gated memory, permissions, model roles, session controls, and remote compatibility remain explicit migration obligations.

**Next gate after C2: D** — complete provider/model/effort parity on the independent runtime: provider routing, model-role selection, reasoning/effort variants, and their desktop/headless/remote projections without moving provider-secret authority out of the local host.
