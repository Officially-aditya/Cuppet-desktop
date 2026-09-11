# Provider Conversation Bridge

Provider Architecture V2 separates provider **process lifetime** from provider **conversation lifetime**.

`ProviderRuntimeManager` may keep a provider process warm for latency, but that does not grant the provider authority over Cuppet conversation history. `ConversationBridge` owns that decision.

## Current strategy: replay-isolated

The initial production-safe strategy is intentionally conservative:

```text
Cuppet durable conversation
        │
        │ compiled full replay
        ▼
Conversation Bridge
        │
        ├─ turn 1 -> start provider runtime + new logical session
        ├─ turn 2 -> same warm process + fresh logical session
        ├─ turn 3 -> same warm process + fresh logical session
        └─ ...
```

For every turn the bridge declares:

```text
contextOwner: cuppet
delivery: full-replay
providerHistory: turn-isolated
```

This preserves one unambiguous source of truth: Cuppet's durable/context-compiled conversation.

A warm provider process is therefore only a transport/runtime optimization. It must not be interpreted as persistent provider conversation state.

## Why persistent logical sessions are not enabled yet

If Cuppet sends its compiled full history into a provider session that also retains prior turns, earlier context can be duplicated. That can change reasoning, tool selection, token use, and safety behavior in subtle ways.

Before provider continuation/resume is enabled, parity evidence must define:

- which side owns each historical message,
- whether a resumed provider receives full replay, a delta, or no replay,
- how Cuppet compaction/TST/context injection changes the provider-visible history,
- what happens when the user edits, forks, routes, or restores a conversation,
- what invalidates a provider continuation token/session,
- how model/effort/backend/project changes invalidate history,
- how failure/cancellation avoids resuming ambiguous provider-side state.

Until those rules are proven, fresh logical sessions are safer than implicit provider history.

## Lifecycle invariants

A bridge mapping is invalidated when:

- provider runtime authority/fingerprint changes,
- the managed provider turn fails,
- the runtime is forgotten during session cleanup,
- a warm runtime is idle-evicted,
- ProviderRuntimeManager shuts down.

Cancellation/failure does not preserve ambiguous provider-side history. A retry begins again from Cuppet's durable full replay.

Each successful turn stores only bridge metadata such as completed-turn count and replay fingerprint. It does **not** persist provider transcript state.

## Replay fingerprint

`fingerprintConversationMessages()` computes a deterministic SHA-256 digest of the role/content sequence delivered through the bridge.

The fingerprint is diagnostic evidence, not a substitute for the messages themselves. It allows tests and future resume work to prove which exact Cuppet replay a provider turn was based on without making the provider the history authority.

## Future continuation strategy

Provider-native persistence/resume should be added as a distinct Conversation Bridge strategy, not by changing ACP transport behavior directly.

A future strategy may look conceptually like:

```text
turn 1: full replay -> provider session P1
turn 2: proven-safe delta -> resume P1
turn 3: proven-safe delta -> resume P1
```

but it must fall back to replay-isolated whenever context ownership becomes uncertain.

No transport—ACP, Codex app-server, direct API, or future provider protocol—may independently decide to retain/replay conversation history outside this bridge contract.
