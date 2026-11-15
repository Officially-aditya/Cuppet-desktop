# MCP servers

Settings → **MCP** lets a user connect local [Model Context Protocol](https://modelcontextprotocol.io) servers. Their tools join the ones Cuppet already offers the model, going through the same tool loop and permission broker.

## Scope

- **Transport:** local command servers over stdio only. Remote (HTTP/SSE) servers, OAuth, and the client-side MCP features (sampling, roots, elicitation) are not implemented. A server that sends such a request receives a JSON-RPC "method not found" error, so it never blocks waiting for Cuppet. Pasted JSON entries that use `url` or `type: http|sse` are reported as skipped.
- **Capabilities used:** `tools/list` (paginated), `tools/call`, `notifications/tools/list_changed`, and cancellation. Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are accepted.
- **Providers:** MCP tools are part of the ordinary tool list, so they reach native API providers and, through the `cuppet-runtime` bridge, ACP/CLI providers and delegated subagents alike.

## Where things live

| Piece | File | Process |
| --- | --- | --- |
| Validation and normalisation, shared by every layer | `src/shared/mcp-config.mjs` | any |
| Persisted configuration, encrypted environment values | `src/main/mcp-settings.mjs` | Electron main |
| Stdio client for one server | `src/runtime/mcp-client.mjs` | runtime |
| Registry, lifecycle, tool naming | `src/runtime/mcp-manager.mjs` | runtime |
| Settings panel | `src/renderer/react/McpPanel.tsx`, `mcp-form.ts` | renderer |

The configuration is saved to `mcp-servers.json` in the Electron user-data directory (mode `0600`). After every change, and again if the runtime process is restarted, the main process pushes the decrypted configuration to the runtime with `integration.mcp.sync`. The runtime keeps it in memory only. `integration.mcp.*` methods are internal and are not part of the remote command allowlist, so a paired device cannot add or change servers. `integration.mcp.updated` runtime events are not forwarded to remote devices either.

## Secrets

Environment values are treated like provider API keys. They are encrypted with Electron `safeStorage`, never returned to the renderer (it receives variable *names* only; editing sends `null` to mean "keep the stored value"), and never written in plaintext. If the OS credential store is unavailable, or on Linux reports the `basic_text` backend, saving environment values is refused. If saved values can no longer be decrypted, the server is marked as an error instead of being started without them. Server stderr shown in Settings has the configured values and credential-shaped text removed.

## What a server inherits

The child process receives the recovered login `PATH` (so `npx`, `uvx` and version-managed tools are found even when the app was launched from Finder), the same non-credential allowlist used for sandboxed commands, a short list of connectivity settings (CA bundles, proxy variables, npm config pointers, XDG directories), and whatever the user configured. Provider keys and tokens in Cuppet's own environment are not inherited. The working directory is the user's home directory.

This is hygiene, not isolation. A server runs unsandboxed with the user's permissions and can read files such as `~/.npmrc` by itself; what the filtering prevents is Cuppet's own secrets reaching a server by accident. Proxy URLs can contain credentials and are passed on deliberately, because launchers cannot download a server behind a proxy without them.

## Lifecycle

- Enabled servers start in the background when the configuration is applied. `initialize` is bounded only by a 60 second startup timeout, since `npx -y` may still be downloading the package; later requests time out after 30 seconds and tool calls after 120.
- At the start of a turn, servers that are still starting are given up to 10 seconds, and servers that crashed are retried at most once every 15 seconds. The wait ends immediately if the turn is stopped.
- Shutdown closes stdin first (the protocol's signal), then sends `SIGTERM` and `SIGKILL` to the server's process group, so a wrapper such as `npx` cannot leave the real server running.
- Reconfiguring restarts only servers whose command, arguments, environment or enabled flag changed. A rename alone does not restart.

## Tool names, limits and model context

Tools are named `mcp__<server-id>__<tool>`: characters outside `[A-Za-z0-9_-]` become `_`, names are limited to 64 characters (longer or colliding names keep a prefix plus an 8-character digest), and they are stable across restarts. The server id is derived from its name when first saved and does not change on rename. At most 16 servers, 64 tools per server and 96 MCP tools in total are offered; overflow is reported on the server's status line. Every tool result is capped, and the system context sent with each turn tells the model that MCP output is untrusted third-party data.

## Permissions

An MCP tool call always goes through the permission broker, and the prompt shows the server, the tool and the complete arguments.

Plan mode is checked first and is independent of the permission level: it blocks `mcp-tool` outright, whatever the level, and does not affect `mcp-read`. What remains depends on the level:

| Server declares | Action | Default and Auto | Full access |
| --- | --- | --- | --- |
| `readOnlyHint: true` | `mcp-read` | asks | allowed |
| anything else | `mcp-tool` | asks (blocked in plan mode) | allowed (blocked in plan mode) |

"Always" approves one exact request (server, tool, arguments) for the session, never a whole tool. Arguments too large to show in full (over 8,000 characters) are refused rather than approved unseen. `readOnlyHint` is only a hint from the server, so it relaxes plan mode but is never what lets a call skip its prompt. Full access allows MCP calls without a prompt, matching how it already treats browser control; change `PLAN_MUTATING_ACTIONS` and `immediateDecision` in `src/runtime/permissions.mjs` if that should be stricter.

MCP calls do not take part in the undo journal. A server that edits project files does so outside Cuppet's recorded edits.

## Tests

`test/mcp-settings.test.mjs` (validation, encrypted persistence, import), `test/mcp-manager.test.mjs` (protocol, environment, lifecycle, naming, shutdown) against `test/fixtures/fake-mcp-server.mjs`, `test/mcp-runtime.test.mjs` (permissions and plan mode end to end through `RuntimeService`), and `test/mcp-panel.test.mjs` (renderer logic).
