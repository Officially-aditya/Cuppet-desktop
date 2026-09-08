# Phase C1 — TST workspace tools and independent permission execution

Phase C1 moves the coding-agent tool boundary out of the OpenCode-derived runtime and into Cuppet Desktop's independent runtime.

The goal is not to clone every OpenCode tool. The goal is to preserve Cuppet's behavioral contract while establishing a small runtime-owned tool surface whose authorities are explicit and testable.

## Authority model

C1 follows one-authority-per-fact:

| Concern | Authority |
| --- | --- |
| Current file contents and workspace state | Filesystem |
| Structural workspace navigation | TST graph |
| Whether a protected model operation may execute | `PermissionBroker` |
| Durable tool-call execution audit | SQLite `tool_executions` |
| Visible conversation | SQLite `messages` |
| Task-local observed/stale paths | PE3 |
| Permission presentation | Renderer only |

Tool output is never promoted into the durable visible transcript. It is model-facing execution context for the current generation and a separate audit record in SQLite.

## Model-facing tools

### `tst_explore`

A consolidated TST structural-navigation surface replacing the old separate workspace/tree/search/trace tools.

Modes:

- `workspace` — bounded project overview
- `tree` — bounded file listing below an optional prefix
- `search` — TST graph localization for a symbol/path/query
- `trace` — bounded caller/callee/dependency trace summary

Identical exploration calls are cached per session. Repeating the same request returns a compact reference instead of duplicating graph output.

### `tst_read`

Reads exact UTF-8 file contents from the filesystem after structural discovery. TST can select what looks relevant; the filesystem remains content authority.

Reads are line-addressable and bounded. Project containment and realpath checks reject path/symlink escape attempts.

### `workspace_edit`

Performs a precise old-text/new-text replacement in one project file. Ambiguous matches fail unless `replace_all=true` is explicitly requested.

### `workspace_write`

Creates or replaces one UTF-8 project file, with a bounded file-size limit and project-containment validation.

### `bash`

Runs a command with `cwd` fixed to the project. Arbitrary commands require permission. A deliberately tiny metadata-only command family can execute automatically.

### `cuppet_plan` and `cuppet_memory_search`

C1 keeps the existing runtime-owned lossless-plan and memory retrieval surfaces available to the model. Their returned data is treated as context, not instructions.

## Permission policy

### Ordinary reads

Ordinary workspace reads remain automatic by default so C1 does not make routine coding unusably permission-heavy.

Sensitive reads still require approval. `.env.example` remains explicitly readable because it is normally documentation/template data rather than a secret store.

### Protected files

Cuppet-owned or credential-bearing files such as the runtime credential store are denied rather than merely prompted.

### Edits and writes

Edits/writes require an explicit approval unless the user enabled guarded auto for that session and the exact resource passes the runtime safety checks.

Guarded auto is intentionally narrower than a general "YOLO" mode:

- only project-contained read/edit/write resources qualify
- sensitive paths do not qualify
- symlink escapes do not qualify
- shell commands never become guarded-auto eligible
- the setting is session-scoped

### Safe bash

The automatic shell family is copied from the pinned Cuppet-code behavior and remains metadata-only:

- `pwd`
- `ls` with a bounded flag set and no path operand
- read-only `git status`, `git log --oneline`, `git branch`, `git ls-files`, and selected `git rev-parse`
- common toolchain `--version` commands

Shell metacharacters, expansion, redirection, chaining, path operands, arbitrary Git commands, tests, builds, installs, and mutation commands are not safe-bash.

### Exact "always"

"Always" is not a wildcard permission rule. It records the exact action + exact resource fingerprint for the current session. A different command/path produces a new permission decision.

### Plan mode

Plan mode is read-only. File mutations and arbitrary shell commands are denied at the runtime permission boundary, independent of what the model asks for.

### Noninteractive mode

A headless/noninteractive runtime cannot silently invent consent. Any operation that would require a permission prompt fails closed.

## Provider tool loop

C1 extends the OpenAI-compatible provider adapter to support streamed `tool_calls` while preserving ordinary text streaming.

A generation now follows this loop:

```text
compiled model-facing context
        │
        ▼
provider inference
        │
        ├─ text ────────────────► visible assistant stream
        │
        └─ tool call
              │
              ▼
        ToolRuntime preflight
              │
              ▼
        PermissionBroker
          │ allow / deny
          ▼
        execute runtime tool
              │
              ├─ durable tool audit → SQLite tool_executions
              ├─ observed/mutated paths → PE3
              └─ bounded untrusted result → provider loop
```

The tool call and tool result are not appended as ordinary chat messages. OpenAI-compatible tool-call structures exist only in the ephemeral provider conversation used during the active generation.

## Durable tool audit

`tool_executions` records:

- session ID
- provider tool-call ID
- tool name
- argument JSON
- bounded output
- terminal status (`complete`, `error`, `rejected`)
- permission source (`safe-bash`, `workspace-read`, `session-auto`, `user-once`, `session-exact`, etc.)
- timestamps

Rows left `running` by a process crash/restart are converted to interrupted errors on database startup.

## PE3 integration

Successful structural exploration and file reads reinforce task-local observed paths.

Successful edits/writes, and shell commands that leave Git-visible workspace changes, notify PE3 as workspace mutations. That invalidates stale file privilege in dormant task contexts rather than allowing old assumptions to survive edits made by another task.

Rejected or failed tools do not update PE3 path privilege.

## Desktop permission surface

The renderer receives only bounded permission request metadata and can send only an approval decision:

- Allow once
- Always this exact request
- Reject
- Enable guarded auto when the runtime marks the resource eligible

The renderer never receives a raw filesystem/shell execution API. Main/preload only bridge permission decisions to the runtime.

## Hard limits

C1 intentionally bounds model-driven work:

- 64 tool calls per generation
- 128 KiB tool output
- 1 MiB file read/write/edit ceiling
- 16 resources per permission request
- 120 second maximum shell timeout
- bounded per-session duplicate graph-call cache

These limits are runtime-enforced, not prompt suggestions.

## Compatibility constraints

C1 must retain every prior migration invariant:

- no OpenCode production dependency
- SQLite conversation persistence and Stop behavior from Phase A
- immutable project binding/import behavior from Phase B
- detached context/TST/plan/background-memory behavior from B1
- PE3 transactional task routing and staleness semantics from B2

The dedicated C1 verifier runs focused permission/provider/tool/full-runtime tests in addition to all inherited phase gates in CI.
