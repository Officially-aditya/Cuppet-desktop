# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Phase D — independent provider, model-role, and reasoning/effort parity: implemented candidate.**

Cuppet now owns provider/model policy independently of the old OpenCode controller. The local host keeps provider credentials and endpoint authority, while a sanitized provider catalog carries coding-capable model metadata, independent primary/secondary role selections, and supported reasoning/effort variants across desktop, headless, and Remote surfaces.

Reasoning/effort is lowered into provider request metadata rather than prompt text. Live provider variants win over the legacy compatibility bridge, bridge data is recursively sanitized before persistence/projection, and Remote devices may select only host-advertised provider/model/effort combinations.

Phases A, B, B1, B2, C1, and C2 remain intact: SQLite conversations, project import/binding, detached context compilation, lossless plans, TST/STM, evidence-gated background memory, PE3 task routing, runtime-owned coding tools, permissions, and host-authoritative remote control remain authoritative.

The production source still has **no OpenCode dependency**.

### Run it

```bash
npm install
npm start
```

Open **Provider settings** and configure the local provider ID/base URL, primary model, optional secondary/background model, supported effort selections, and API key. Provider keys remain encrypted through Electron `safeStorage` and are never exposed to the renderer.

## Provider, model-role, and effort policy

Phase D separates local secret/transport configuration from reusable non-secret model policy:

- provider API key and endpoint authority stay on the local host;
- primary and secondary roles are independently persisted and resolved;
- model catalogs require coding-agent capability: text input/output, streaming, and tool calling;
- OpenAI/Azure and Vertex/Vertex-Anthropic aliases remain grouped without crossing vendors;
- unknown/future provider IDs can participate when they advertise the required capability contract;
- live variants and the compatibility variant bridge are sanitized before projection;
- effort/reasoning metadata is applied once at provider-request lowering, while auth, selected model, prompts, and runtime tools remain authoritative;
- the background memory canonicalizer uses the independent secondary role and secondary effort;
- desktop, headless, and Remote expose the same non-secret provider/model/variant policy.

The independent CLI can inspect the sanitized host policy:

```bash
cuppet models --provider-id openai-compatible --model <model-id> --effort <variant>
```

Headless provider configuration stays local through `CUPPET_PROVIDER_ID`, `CUPPET_API_KEY`, `CUPPET_MODEL`, `CUPPET_BACKGROUND_MODEL`, `CUPPET_EFFORT`, `CUPPET_BACKGROUND_EFFORT`, and `CUPPET_BASE_URL`. Optional non-secret discovery metadata can be provided through `CUPPET_MODEL_CATALOG_JSON` and `CUPPET_VARIANT_BRIDGE_JSON`.

## Remote control

The desktop **Remote** surface can start/stop the local host, use a manual relay or the managed Cuppet account-link flow, create trusted/viewer pairing invitations, list paired devices, and revoke them.

The same implementation is available headlessly:

```bash
cuppet remote-control
cuppet relay
cuppet remote-enroll --token <session-token>
```

A remote device cannot provide or retrieve host provider credentials/endpoints. It can select only a model/effort combination already advertised by the host policy; the host performs the final request lowering locally.

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

Two old command surfaces intentionally still fail instead of inventing authority: `session.undo` waits for an independent mutation journal, and interactive question reply/reject waits for an independent runtime question broker. Those are now explicit post-D migration obligations.

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
npm run phased:verify
```

D verifies provider grouping/capability discovery, independent primary/secondary role resolution, effort/variant sanitization and request lowering, background secondary-role execution, desktop/headless/Remote projection parity, host-only secret/endpoint authority, and Remote selection restricted to host-advertised model/effort choices.

## Architecture

```text
Electron renderer
    ├── conversations/projects
    ├── provider/model/effort controls
    ├── permission decision UI
    └── Remote lifecycle UI
          │ narrow contextBridge
          ▼
Electron main
    ├── native folder picker
    ├── OS-encrypted provider credentials/endpoints
    └── sanitized provider/model policy projection
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
    ├── ProviderPolicy
    │    ├── primary/secondary role selection
    │    ├── sanitized model/variant catalog
    │    └── one-step request lowering
    ├── OpenAI-compatible execution adapter
    ├── RemoteManager / RemoteBridge
    │    ├── host identity + device scopes
    │    ├── local/JWT authentication
    │    └── host-advertised model/effort selection
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
- Electron main/headless host → provider-secret/endpoint authority;
- ProviderPolicy → non-secret provider/model/role/effort policy and request lowering;
- remote device state → ephemeral advertised model/effort selection only;
- relay → transport/presence only;
- renderer → presentation/navigation/approval/policy projection only.

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
- Phase D provider/model/effort: [`docs/phase-d-provider-model-effort.md`](docs/phase-d-provider-model-effort.md)
- Phase D contract: [`migration/phase-d-contract.json`](migration/phase-d-contract.json)

## Migration rule

A later phase may replace an old OpenCode mechanism, but it may not silently replace Cuppet policy. Context compilation, plans, PE3, evidence-gated memory, permissions, model roles, session controls, and remote compatibility remain explicit migration obligations.

**Next gate after D: E** — complete the remaining shared session/control compatibility that still intentionally fails closed: independent undo/mutation ownership, interactive question brokerage, and the remaining headless session-resume/fork/status/doctor command semantics. Phase E must reuse the existing SQLite/runtime authorities rather than rebuilding an OpenCode-shaped controller.
