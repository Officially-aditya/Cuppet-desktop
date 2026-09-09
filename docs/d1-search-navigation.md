# D1 — Local Search & Navigation

D1 completes the first product-facing milestone after the original C execution loop. It keeps local conversations local and gives the desktop shell a real retrieval/navigation layer without introducing a second conversation authority.

## Search authority

SQLite remains the durable conversation authority. A local FTS5 projection indexes:

- chat titles;
- visible user messages;
- assistant messages only after they reach a terminal state.

Provider-only tool messages and synthetic context are not indexed. Archived chats are excluded from ordinary search and navigation by default, but Search can explicitly include them for recovery.

Search queries are normalized into bounded prefix terms before entering FTS `MATCH`; renderer text never becomes raw FTS syntax.

## Chat lifecycle

Desktop exposes runtime-host operations for:

- rename;
- archive;
- restore;
- permanent delete.

Archive and delete fail closed while a session is generating or has queued messages. Archive is reversible through Search. Delete removes the SQLite transcript and its FTS projection; it does not delete project files.

Project display names can also be renamed locally without changing checkout paths or Git identity.

## Navigation behavior

The visible Search surface supports `Cmd/Ctrl+K`, keyboard result navigation, exact result-to-message scrolling, and archived recovery.

Desktop-local presentation state remembers the last opened conversation and a scroll offset per conversation. That state is presentation-only: session/message truth remains in SQLite.

While an assistant is streaming, Cuppet follows the bottom only while the user remains near the bottom. If the user scrolls upward, incoming deltas no longer pull the viewport away from what they are reading.

## Integration note

D1 explicitly loads `execution-ui.mjs` from the desktop shell, making the previously implemented streaming Markdown, activity, queue/steer, diff, and validation presentation part of the actual renderer boot path.

## Gate

Run:

```bash
npm run d1:verify
```

The gate checks the machine contract, syntax, real FTS/lifecycle behavior, visible Search wiring, navigation persistence, and the Electron/runtime boundary.
