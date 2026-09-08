# Phase E — Session/control parity

Phase E closes the remaining shared session/control gaps after Phase D without reintroducing an OpenCode-shaped controller. SQLite, the filesystem, the lossless plan store, runtime brokers, and host-local provider policy remain the authorities.

## Scope

Phase E owns four related surfaces:

1. durable headless session continuation/fork controls;
2. runtime status/doctor aggregation;
3. interactive question brokerage across Desktop and Remote;
4. conflict-safe undo for Cuppet-owned file mutations.

The implementation is versioned as `0.8.0-alpha.1`.

## Session continuation and fork

The independent CLI supports explicit session continuation, latest-session continuation, and forked continuation.

```text
cuppet prompt <text> --session <id>
cuppet prompt <text> --continue
cuppet prompt <text> --session <id> --fork
cuppet sessions
```

A fork is not an empty session with a copied title. SQLite transactionally copies the durable visible transcript and project binding to a new session. Historical `tool_executions` are deliberately not cloned because they are an audit of actions performed by the source session, not conversational state owned by the fork.

If the source has a lossless canonical implementation plan, the plan is cloned separately and source-message references are remapped to the forked transcript IDs. A source session with a currently streaming response cannot be forked.

## Status and doctor

`cuppet status` and `cuppet doctor` aggregate the existing independent runtime authorities. The same diagnostics are available to Remote as read-scoped commands.

Provider credentials and endpoint details remain host-local and are not part of the public diagnostic projection.

## Question authority

`QuestionBroker` is the single authority for model-requested user questions.

The model receives a bounded `question` tool. One request can contain at most eight questions, each question can advertise at most twelve options, and each answer group is bounded before it reaches the runtime.

Interactive flow:

```text
model question tool
      │
      ▼
QuestionBroker
      ├── question.requested event
      │       ├── Electron Desktop dialog
      │       └── authorized Remote device
      │
      ├── reply → bounded answers return to tool loop
      └── reject → tool fails explicitly
```

Desktop and Remote recover pending questions by calling `question.list`, so a renderer reload or Remote reconnect does not silently lose a blocked request.

Remote scopes remain split:

- `question.list` → `session.read`;
- `question.reply` / `question.reject` → `question.write`.

A noninteractive/headless generation cannot wait indefinitely for an unavailable user. Question requests fail closed with an interaction-required error.

## Undo authority

Undo is implemented by `MutationJournal`; it is not implemented with `git reset`, `git checkout`, `git clean`, or transcript deletion.

For deterministic `workspace_edit` and `workspace_write` calls, Cuppet records the exact raw pre-mutation bytes before execution and the SHA-256 post-mutation hash after successful execution. Raw preimages are persisted as base64 inside private runtime journal state so arbitrary byte sequences survive round trips without UTF-8 normalization. Each reversible journal entry is also bound to the original canonical project workspace and to the durable SQLite `tool_executions` row that performed the mutation. Journal files are written atomically with a `0700` directory and `0600` files.

On undo:

1. the session must be idle and project-bound;
2. the currently attached canonical workspace must be the same workspace that produced the journal entry;
3. the latest applied journal entry must be a reversible file entry;
4. the current file state must match the recorded Cuppet postimage hash;
5. only then does Cuppet restore the exact recorded raw preimage or remove a file that Cuppet originally created;
6. the restored result is hashed again before the journal entry is marked undone.

This deliberately gives user/external filesystem activity precedence. If a user, editor, hook, formatter, or another process changes the file after Cuppet's mutation, Undo reports a conflict and does not overwrite it. Relocating or rebinding a project also fails closed for an older journal entry rather than applying that entry to a different checkout that happens to contain a matching relative path.

### Shell mutations are barriers

A shell command can mutate an arbitrary number of files through behavior that cannot be reconstructed from the command string or a Git status list. When a successful shell tool leaves Git-visible changes, Phase E records an opaque mutation barrier.

Undo refuses to cross that barrier rather than guessing at a reverse operation. This is safer than using repository-wide Git restoration that could destroy unrelated work.

## Surfaces

### Desktop

- pending questions appear in an isolated dialog controller;
- answers/rejections cross the bounded Electron main-process IPC boundary;
- the Undo control invokes only the session-scoped runtime undo method;
- provider credentials remain outside renderer authority.

### Remote

- pending questions are restored on reconnect;
- trusted devices can answer/reject according to `question.write` scope;
- viewers remain read-only;
- `session.undo` remains a `session.write` operation and delegates to the host runtime;
- relay remains transport/presence only.

### Headless

- `prompt --session`, `--continue`, and `--fork` provide durable continuation semantics;
- `sessions` lists durable sessions;
- `status` and `doctor` inspect the runtime;
- `undo [--session <id>]` invokes the same mutation journal as Desktop/Remote;
- interactive questions fail closed rather than hanging.

## Authority map

- filesystem → source/workspace truth;
- SQLite sessions/messages → visible conversation truth;
- SQLite `tool_executions` → historical tool audit;
- LosslessPlanStore → canonical requirements;
- QuestionBroker → pending interactive question state;
- MutationJournal → reversible Cuppet-owned file mutation state;
- PermissionBroker → protected-operation approval;
- PE3 → task routing metadata;
- TST → structural navigation and verified memory;
- Remote → transport and scoped device state only.

## Acceptance invariants

Phase E is accepted only when all prior phase gates still pass and the E gate proves at least:

- transcript/project state forks without cloning tool audit;
- lossless plan source IDs are remapped into the fork;
- question reply/reject resumes or terminates the waiting tool;
- noninteractive questions fail closed;
- arbitrary raw file bytes can be restored exactly after runtime restart;
- reversible entries are tied to the original canonical project workspace;
- journal entries reference the durable SQLite tool execution rather than only the provider call ID;
- a Cuppet-created file is removed on undo;
- an external edit after a Cuppet mutation blocks undo without data loss;
- an opaque shell mutation blocks undo;
- Remote delegates question/undo authority to the host runtime;
- Remote scope boundaries remain unchanged;
- Desktop exposes only bounded IPC methods;
- no production OpenCode dependency is reintroduced;
- no destructive Git restoration command becomes the undo implementation.
