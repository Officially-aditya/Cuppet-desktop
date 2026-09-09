# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Original C1 correction — structural editing contract: implemented candidate (`0.8.0-alpha.1`).**

Cuppet now closes the original C1 structural-editing gap without rebuilding an OpenCode-shaped controller:

- revision-bound TST edit targets tied to current filesystem hashes and exact source bytes;
- write-free multi-file `tst_edit_batch` prepare with staged Tree-sitter validation before publication;
- one runtime-owned `ProjectWriter` across structural batches, generic mutations, mutating shell work, and Undo;
- final-hash graph refresh receipts that fail closed when a changed path is omitted or stale;
- `tst_validate` evidence bound to stable post-edit hashes, with verifier provenance and command-success evidence;
- one conflict-safe `MutationJournal` checkpoint for an applied multi-file batch.

Phases A through E remain intact: SQLite conversation/project state, detached context compilation, lossless plans, TST/STM, evidence-gated background memory, PE3 task routing, runtime-owned permissions, host-authoritative Remote, provider/model/effort policy, and shared session/control behavior.

The production source has **no OpenCode dependency**. The next migration increment is the remaining **original C** scope.

## Run it

```bash
npm install
npm start
```

Open **Provider settings** and configure the local provider ID/base URL, primary model, optional secondary/background model, supported effort selection, and API key. Provider credentials remain encrypted through Electron `safeStorage` and never enter renderer authority.

## Session and control parity

The independent CLI supports durable continuation and inspection:

```bash
cuppet prompt "Continue this task" --session <session-id>
cuppet prompt "Continue the latest task" --continue
cuppet prompt "Try another approach" --session <session-id> --fork
cuppet sessions
cuppet status
cuppet doctor
cuppet undo --session <session-id>
```

A session fork transactionally copies the durable visible transcript and project binding into a new SQLite session. Historical `tool_executions` are deliberately **not** cloned because they are audit records belonging to the source session. If a lossless canonical plan exists, it is copied separately and its source-message IDs are remapped to the forked transcript.

Forking a currently streaming session fails closed.

### Interactive questions

`QuestionBroker` is the only authority for model-requested user questions.

```text
model question tool
      │
      ▼
QuestionBroker
  ├── question.requested
  │      ├── Desktop
  │      └── authorized Remote device
  ├── reply  → bounded answers resume the tool loop
  └── reject → explicit tool failure
```

Question requests are bounded to eight questions, twelve options per question, twelve answer values per question, and 512 characters per answer value. Desktop and Remote recover pending requests through `question.list`, so a renderer reload or reconnect does not lose a blocked question.

Headless/noninteractive runs fail closed instead of waiting indefinitely for unavailable user interaction.

### Conflict-safe undo

Undo is runtime-owned by `MutationJournal`. It does **not** use `git reset`, `git checkout`, `git restore`, `git clean`, or transcript deletion.

For deterministic `workspace_edit` and `workspace_write` calls, Cuppet records:

- the exact raw pre-mutation bytes, persisted as base64;
- the SHA-256 post-mutation hash;
- the original canonical project workspace;
- the durable SQLite `tool_executions` ID that performed the mutation.

Journal state is private runtime data, persisted atomically in a `0700` directory with `0600` files. The journal keeps at most 256 entries per session and snapshots files up to 1 MiB.

Undo succeeds only when the session is idle, the original workspace is still attached, and the current file still matches Cuppet's recorded postimage. It then restores the exact recorded bytes—or removes a file Cuppet created—and verifies the restored hash before marking the entry undone.

If a user, editor, hook, formatter, or another process changes the file afterward, Cuppet refuses to overwrite that work. Rebinding/relocating the session to a different checkout also fails closed.

A successful shell command that leaves Git-visible workspace mutations creates an **opaque undo barrier**. Cuppet will not guess how to reverse arbitrary shell behavior or cross that barrier with destructive Git commands.

## Remote control

The desktop **Remote** surface can start/stop the local host, use a manual relay or managed Cuppet account-link flow, create trusted/viewer pairing invitations, list paired devices, and revoke them.

Headless equivalents:

```bash
cuppet remote-control
cuppet relay
cuppet remote-enroll --token <session-token>
```

Remote protocol v1 preserves:

- 512 KiB frame cap;
- monotonic host event sequence numbers;
- reconnect snapshots + host-process `connectionId`;
- replay-safe command IDs;
- per-command scopes;
- single-use short-lived pairing invites;
- viewer read-only scope;
- host/device-bound Ed25519 managed tokens;
- host replacement invalidating prior device authority.

Phase E adds shared control routing without moving authority to the relay:

- `question.list` → `session.read`;
- `question.reply` / `question.reject` → `question.write`;
- `session.undo` → `session.write`;
- `status` / `doctor` → `session.read`.

Remote devices cannot provide or retrieve host provider credentials/endpoints. Provider/model/effort selection remains constrained to host-advertised policy, and the host performs final request lowering locally.

The self-host relay is a trusted transport, **not** an end-to-end-encrypted boundary. Use TLS before exposing it outside localhost.

## Provider, model-role, and effort policy

Phase D remains the provider-policy authority:

- provider API key and endpoint authority stay on the local host;
- primary and secondary roles are independently persisted and resolved;
- model catalogs require text input/output, streaming, and tool-calling capability;
- OpenAI/Azure and Vertex/Vertex-Anthropic aliases remain grouped without crossing vendors;
- future provider IDs can participate when they advertise the required capability contract;
- live variants and compatibility bridge data are sanitized before projection;
- effort/reasoning is lowered into provider request metadata, not prompt text;
- the background canonicalizer uses the independent secondary model role;
- Desktop, headless, and Remote expose the same non-secret model/variant policy.

Inspect the sanitized host policy with:

```bash
cuppet models --provider-id openai-compatible --model <model-id> --effort <variant>
```

Headless provider configuration stays local through `CUPPET_PROVIDER_ID`, `CUPPET_API_KEY`, `CUPPET_MODEL`, `CUPPET_BACKGROUND_MODEL`, `CUPPET_EFFORT`, `CUPPET_BACKGROUND_EFFORT`, and `CUPPET_BASE_URL`. Optional non-secret discovery metadata can be provided through `CUPPET_MODEL_CATALOG_JSON` and `CUPPET_VARIANT_BRIDGE_JSON`.

## Runtime-owned coding tools

Project-bound chats expose a deliberately small tool surface:

- `tst_explore` — TST workspace/tree/search/trace discovery plus revision-bound edit targets;
- `tst_read` — exact bounded filesystem reads and checked revision-target reads;
- `tst_edit_batch` — write-free structural prepare followed by checked multi-file apply;
- `tst_validate` — explicit approved repository checks bound to stable post-edit hashes;
- `workspace_edit` — precise text replacement fallback for unsupported/unstructured cases;
- `workspace_write` — bounded file creation/replacement fallback;
- `bash` — project-scoped shell execution;
- `question` — bounded interactive user input through `QuestionBroker`;
- `cuppet_plan` — lossless implementation-plan retrieval;
- `cuppet_memory_search` — Cuppet memory retrieval.

General chats do not receive filesystem or shell tools.

### Structural edit path

For supported code edits, the preferred path is:

```text
tst_explore
→ revision-bound target
→ tst_read
→ tst_edit_batch prepare (zero writes)
→ exact permission for the prepared batch + diff digest
→ tst_edit_batch apply
→ current-hash TST graph refresh receipt
→ tst_validate
```

Prepare never changes project files. Apply revalidates base hashes, publishes one checked batch under the shared project writer, records one multi-file Undo boundary, and owns the graph refresh barrier. If TST cannot acknowledge every changed path at its final filesystem hash, later structural work remains blocked until freshness is recovered.

Successful validation becomes reusable behavioral evidence only when approved checks pass against unchanged post-edit hashes. The observation uses verifier provenance and records both command-success and content-hash evidence. Model claims and prepared-but-unapplied edits do not become verified memory.

### Structural exploration first

`tst_explore` consolidates structural navigation:

```text
workspace → bounded project overview
tree      → bounded project-relative file tree
search    → structural symbol/path localization
trace     → bounded caller/callee/dependency trace
```

TST owns structural discovery, not source-content truth. `tst_read` resolves and reads the current filesystem after navigation. Identical exploration calls are cached per session so duplicate graph output is not repeatedly sent to the model.

### Provider tool loop

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
visible stream   JournaledToolRuntime
                     │
                     ├── QuestionBroker
                     ├── PermissionBroker
                     └── ToolRuntime
                            │
                            ├── bounded result → provider loop
                            ├── durable audit → SQLite tool_executions
                            ├── reversible mutation → MutationJournal
                            └── observed/mutated paths → PE3
```

Provider-only tool-call/tool-result messages remain ephemeral and are not appended to the visible SQLite message transcript.

## Permission boundary

Permissions are runtime policy, not model, renderer, or Remote policy.

Ordinary project reads remain automatic. Sensitive files such as `.env`, credential-like files, private keys, and certificates require approval; Cuppet-owned credential/runtime files are denied. Edits/writes require approval unless narrow session-scoped **guarded auto** is enabled and the exact path passes containment/sensitivity checks.

Only a pinned metadata-only shell command family can run automatically. Arbitrary commands, shell chaining/redirection/expansion, installs, builds, tests, mutations, and path-bearing discovery commands require permission.

Visible approval choices are:

- **Allow once**;
- **Always this exact request**;
- **Reject**;
- **Enable guarded auto** from the local Desktop only when eligible.

“Always” is an exact action + exact resource fingerprint for the current session, never a wildcard. Plan mode stays read-only and noninteractive execution fails closed when consent is required.

## Durable tool audit

SQLite `tool_executions` is the authority for model-requested execution history. It stores tool name, provider call ID, argument JSON, bounded output, terminal status, permission source, and timestamps separately from visible chat messages.

A stale `running` row after restart becomes an interrupted error rather than a false success.

Key runtime limits:

- 64 tool calls per generation;
- 128 KiB tool output;
- 1 MiB file read/edit/write and undo snapshot ceiling;
- 16 resources per permission request;
- 120-second maximum shell timeout.

## PE3 task-local routing

PE3 remains the project task-context scheduler:

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

Successful exploration/read feeds observed paths; successful edit/write and Git-visible shell changes feed workspace mutation. Rejected/failed tools do not gain path privilege. Cross-task routing remains transactional: prepare → target accept → SQLite transaction → router commit.

## Cognitive runtime

Synthetic retrieval remains detached from durable conversation truth:

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

Foreground synthetic context is capped at 2,048 tokens, targeting 4% of usable provider context with a 512-token floor. STM / graph / verified LTM allocation remains 45 / 35 / 20, with cache-stable memoization by session + user-message epoch. History trimming fails closed without complete TST coverage.

Build/Plan mode is session-persisted. Plan mode can use up to 12% of usable context, capped at 16K tokens, with workspace / graph / STM / LTM allocation of 70 / 15 / 10 / 5. `LosslessPlanStore` preserves canonical source requirements independently from todo/chat projection.

When `CUPPET_TST_SOCKET` and `CUPPET_TST_TOKEN` are configured, the runtime lazily connects to authenticated `cuppet.tst.v3`. TST is optional for startup; unsafe history replacement and STM compaction fail closed when it is unavailable. The secondary/background model remains a canonicalizer only and cannot promote its own `model_candidate` output into trusted memory.

## Projects

Project behavior remains unchanged:

- **Local folder** — register an existing folder and detect Git root/origin;
- **GitHub URL** — clone normal HTTPS/SSH `github.com` repositories with existing credentials;
- **GitHub repositories** — browse through an already-authenticated `gh` CLI session and clone the selected repository.

Chats stay permanently bound to their project. Switching projects cannot retarget an active run, removing a registration does not delete the checkout, and missing folders can be relocated without losing conversation history. Phase E additionally refuses to replay an old undo entry against a different canonical checkout.

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
npm run phasee:verify
```

Phase E verifies all earlier contracts plus durable continuation/fork semantics, lossless-plan remapping, status/doctor privacy, bounded question brokerage, Desktop/Remote scope routing, byte-exact restart-persistent undo, external-edit conflicts, original-workspace binding, opaque shell barriers, durable audit-ID linkage, UI syntax, and the absence of destructive Git restoration or a production OpenCode dependency.

## Architecture

```text
Electron renderer
    ├── conversations/projects
    ├── provider/model/effort controls
    ├── permission decisions
    ├── question responses
    ├── session Undo
    └── Remote lifecycle
          │ narrow contextBridge
          ▼
Electron main
    ├── native folder picker
    ├── OS-encrypted provider credentials/endpoints
    └── bounded runtime IPC methods
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
    ├── QuestionBroker
    ├── MutationJournal
    ├── JournaledToolRuntime / ToolRuntime
    ├── evidence-gated background enricher
    ├── ProviderPolicy
    ├── OpenAI-compatible execution adapter
    ├── RemoteManager / RemoteBridge
    └── generation/tool cancellation
          │ outbound WebSocket only
          ▼
Cuppet relay
    ├── transport/presence
    ├── bounded in-memory replay
    └── optional browser Remote client
```

## Authority map

Each fact/state class has one authority; everything else is a projection, index, cache, or transport:

- filesystem → source/workspace truth;
- TST graph → structural navigation;
- SQLite project rows → project registration identity;
- SQLite sessions/messages → visible task/conversation truth;
- SQLite `tool_executions` → durable tool audit;
- `PermissionBroker` → protected-operation approval;
- `QuestionBroker` → pending interactive question state;
- `MutationJournal` → reversible Cuppet-owned file mutation state;
- PE3 registry → bounded task-routing metadata only;
- `LosslessPlanStore` → canonical implementation requirements;
- TST LTM → verified reusable memory;
- `CognitiveStateStore` → mode/orchestrator/background controls;
- Electron main/headless host → provider secret/endpoint authority;
- `ProviderPolicy` → non-secret provider/model/role/effort policy and request lowering;
- Remote device state → scoped presentation/selection state only;
- relay → transport/presence only;
- renderer → presentation/navigation only.

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
- Phase E session/control parity: [`docs/phase-e-session-control.md`](docs/phase-e-session-control.md)
- Phase E contract: [`migration/phase-e-contract.json`](migration/phase-e-contract.json)

## Migration rule

A later phase may replace an old mechanism, but it may not silently replace Cuppet policy or create a second authority. Context compilation, plans, PE3, evidence-gated memory, permissions, provider policy, questions, undo, session controls, and Remote compatibility remain explicit contracts.

**Phase E completes the currently defined migration acceptance sequence through shared session/control parity.** Any later increment should start from the same authority-map rule rather than reopening controller duplication.
