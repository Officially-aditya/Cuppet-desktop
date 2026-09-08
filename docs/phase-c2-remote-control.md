# Phase C2 — Independent remote control, relay, setup, and token boundary

Phase C2 migrates Cuppet remote control off the OpenCode-derived controller and onto the independent desktop/runtime created in Phases A through C1.

The remote feature is a transport and control surface. It is **not** a second coding runtime and it is not allowed to become an alternate authority for conversations, workspace state, provider secrets, permissions, or task routing.

## Authority model

| Concern | Authority |
| --- | --- |
| Conversation and run state | independent runtime + SQLite |
| Workspace contents | filesystem |
| Tool execution and permission decisions | C1 `ToolRuntime` + `PermissionBroker` |
| Task-local routing and staleness | PE3 |
| Provider credentials | local desktop/headless host only |
| Remote device identity/scopes | host-side remote registry or locally verified managed token |
| Relay routing/presence | relay process only |
| Remote UI state | projection/cache only |

A remote command may select **where** an action should happen, but it never replaces the runtime authority that decides **what actually happens**.

## Privacy and trust boundary

C2 preserves the existing remote-control privacy model:

- provider API keys remain on the developer machine;
- the relay performs zero coding inference;
- the relay does not persist transcripts;
- the relay is a trusted transport, not an end-to-end-encrypted boundary;
- host/device traffic should use TLS when exposed beyond localhost;
- device commands are authenticated and scope-checked again by the host;
- unknown commands fail closed;
- remote lifecycle/configuration methods remain local-only and cannot be invoked by a remote device.

The Electron renderer never receives decrypted provider credentials. Main passes the local runtime provider configuration directly to the independent runtime process, and the remote manager advertises only non-secret provider/model metadata.

## Protocol v1

Remote frames remain JSON protocol version 1 with a 512 KiB maximum serialized frame size.

Host events use monotonic sequence numbers. `host.attach`, `client.accept`, `client.reject`, and pairing control frames use sequence `0` because they establish transport authority rather than advance the event stream.

A new host process gets a new `connectionId`. Devices reset their event cursor when that value changes. Duplicate/replayed event sequence numbers are ignored and sequence gaps trigger a snapshot refresh.

Command IDs are replay-safe per device. The host keeps a bounded dedupe set so a network retry cannot execute destructive or state-changing commands twice.

## Device scopes

C2 keeps the frozen scope families:

- `session.read`
- `session.write`
- `permission.write`
- `question.write`
- `model.write`

Trusted local pairing receives the normal control scopes. Viewer pairing receives only `session.read`.

The bridge validates the command type, derives its required scope from the runtime-owned protocol table, then checks the authenticated device before forwarding to the independent command adapter.

## Host identity and pairing

The host has a durable Ed25519 machine identity and relay secret below the runtime data directory. The identity survives process restarts.

Local pairing invitations are:

- random;
- short-lived (two minutes by default);
- single-use;
- stored with private filesystem permissions;
- redeemed atomically using rename as the claim barrier so two concurrent devices cannot win one invite.

Paired device secrets are stored as hashes. Device credential verification uses constant-time hash comparison. Devices may be revoked locally.

## Managed tokens and first-time setup

C2 also preserves the managed Cuppet account-link path.

Sydney/Cuppet backend may mint a short-lived Ed25519 JWT. The host verifies the signature locally and requires the token to be bound to:

- issuer `cuppet-backend`;
- audience `cuppet-relay`;
- this exact host ID;
- this exact device ID;
- a non-expired timestamp;
- mapped supported scopes.

The relay does not need the signing key.

The first-time managed setup flow keeps sensitive material out of the QR/deep-link payload. The setup URL contains the setup identity/code and API origin; the polling secret remains host-local. The relay secret is sent only during the authenticated claim step after the signed-in mobile user approves the machine.

Default managed API origin remains `https://connect.cuppet.in`.

## Outbound host transport

The host opens an outbound WebSocket to the relay and exposes no inbound control port.

The transport provides:

- reconnect with bounded exponential backoff/jitter;
- heartbeat traffic;
- bounded offline event buffering;
- explicit connected state;
- host-offline/unauthorized close handling.

When a host connection is replaced, the relay clears old replay state and disconnects devices authenticated against the previous host process. This prevents stale authority from surviving host replacement.

## Relay

The independent self-host relay preserves the old zero-inference room model:

- one room per host identity;
- optional fail-closed host auth file;
- host replacement invalidates old device authority;
- devices cannot receive host state before host authentication accepts them;
- unauthenticated devices may only attempt pairing or hello;
- failed pairing attempts are bounded per connection;
- authenticated device replies are routed only to the requesting device;
- event replay is bounded and in-memory only;
- incoming frames and connection rate are bounded;
- no transcript/provider-key persistence.

The relay may serve the bundled browser Remote client under `/app`.

## Independent command adapter

C2 does not port the legacy `ControlRouter`. The host bridge calls a new remote command adapter whose only authority is to call existing independent runtime methods.

Per-device ephemeral selection state may include:

- attached workspace/project;
- active session;
- selected local provider/model projection.

Those selections do not become durable conversation or workspace truth.

Important mappings include:

- session/workspace reads → existing project/session runtime methods;
- `session.submit` → `session.send` with host-local provider configuration;
- `session.abort` → `session.stop`;
- Build/Plan mode → `session.mode.get/set`;
- permission list/reply → C1 `PermissionBroker` methods;
- compaction → existing independent context compaction;
- model selection → host-advertised local model metadata only.

A remote client cannot provide a provider key, base URL, or alternate execution backend in a command.

## Reviewed compatibility gaps

Two legacy protocol commands remain recognized by the compatibility surface but intentionally fail instead of inventing semantics:

### Undo

The independent runtime does not yet have an authoritative mutation/undo journal equivalent to the old OpenCode boundary. `session.undo` therefore reports unsupported rather than pretending a rollback occurred.

### Interactive questions

The independent runtime does not yet own a question/prompt broker equivalent to the legacy controller. Question reply/reject calls therefore report unsupported until that authority exists.

These are reviewed migration gaps, not silent omissions.

## Desktop surface

The previously disabled Remote navigation surface is now local UI for:

- current remote status;
- manual relay startup;
- managed account-link startup;
- trusted/viewer pairing invites;
- paired device listing;
- device revocation;
- stop remote host.

The renderer can ask for lifecycle actions but cannot mint arbitrary scopes, access host identity secrets, or obtain the provider API key.

## Headless/CLI surface

The same implementation is exposed through:

- `cuppet remote-control`
- `cuppet relay`
- `cuppet remote-enroll`

Headless provider settings are supplied locally through flags/environment. Remote devices still cannot supply credentials.

## Browser Remote client

The self-host relay serves a small browser client using the same protocol. It supports the independent runtime projection for:

- host/workspace/session selection;
- transcript refresh;
- Build/Plan mode;
- locally configured model selection;
- submit/Stop;
- live assistant/tool events;
- permission replies.

The client is a projection only; reconnect snapshots restore current host/runtime state.

## C2 acceptance

C2 acceptance requires focused coverage for the four legacy remote test families:

1. protocol/identity/pairing/managed token/setup;
2. bridge scope/auth/replay/reconnect behavior;
3. real loopback relay + WebSocket host/device integration;
4. runtime-backed command routing and reviewed unsupported commands.

The gate also verifies that Electron/preload expose bounded local Remote lifecycle controls, the CLI exposes the three independent entrypoints, the relay serves the independent browser client, and production C2 code contains no OpenCode dependency.

All inherited migration gates must remain green before C2 may merge.