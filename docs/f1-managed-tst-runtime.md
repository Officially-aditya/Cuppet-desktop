# F1 — Managed native TST runtime

F1 replaces E1's temporary optional-external TST boundary with a desktop-owned native runtime while preserving the existing `cuppet.tst.v3` protocol.

## Artifact authority

Desktop consumes the standalone TST artifact produced by `Officially-aditya/Cuppet-code` at pinned revision `9f2a8ae63555b7534ee1ccfe211efce1ad46f630`.

The source artifact must identify itself as `cuppet-tst-runtime`, report `cuppet.tst.v3`, match the current platform/runtime, and provide the SHA-256 digest of `bin/tst-daemon`. Desktop staging verifies all of those fields, executes `tst-daemon --protocol`, verifies the binary digest, then stages the daemon plus source notices into `vendor/tst/<runtime>/`. Packaging refuses to run unless the staged resource verifies again.

Electron copies that verified staging directory to `resources/tst/<runtime>/`. The runtime resolves only the packaged resource, an explicitly supplied `CUPPET_TST_BIN` development binary, or the explicit external socket override. It does not search `PATH` for a daemon.

Supported F1 packaged runtimes are macOS arm64/x64 and Linux arm64/x64 glibc. Windows does not yet have the native Unix-socket daemon artifact and is not claimed as bundled in F1.

## Lifecycle

`TstSupervisor` owns one lazy daemon per canonical project root. On first use it:

1. verifies the daemon's `--protocol` identity;
2. creates private project/global/run directories;
3. creates a launch-scoped private socket directory;
4. generates a fresh 32-byte random authentication token;
5. starts `tst-daemon` with the canonical project root, project store, shared global store, and socket path;
6. authenticates through the normal `initialize` handshake before serving calls.

The token is process memory only and is never written to disk or returned by status APIs. Socket paths are likewise omitted from status responses.

Idle daemons stop after the supervisor idle window and restart on the next operation. Shutdown first sends the authenticated `shutdown` RPC; if the process does not exit, the supervisor escalates to `SIGTERM` and finally `SIGKILL`.

## Project isolation and routing

`RuntimeTstManager` provides the runtime boundary. Each incoming runtime request is wrapped in project context derived from the durable session/project database. Session-bound memory/context calls are bound to that project; graph/edit calls require an active project context.

A PE3 route may create or reactivate another session asynchronously. Async project context is retained for that generation, so the target session is bound to the same project before its first TST call. This prevents a newly routed session from falling back to another project's graph or memory daemon.

Each canonical project root has a separate project store and daemon identity. The global durable store is intentionally shared so `global` memory scope remains global. TST's durable store already coordinates access through its lock/WAL machinery; F1 does not create a second global-memory format.

Project removal or relocation unregisters the old project runtime. Runtime shutdown waits for the managed daemon close promise rather than abandoning children during process exit.

## Developer override

`CUPPET_TST_SOCKET` and `CUPPET_TST_TOKEN` remain supported only as an explicit developer escape hatch. Both values are required together. When supplied, the managed native supervisor is bypassed and the existing authenticated `TstBridge` is used.

This is not the production packaged mode.

## Packaged acceptance

`npm run f1:package-smoke` launches the actual packaged Cuppet executable in Node mode with no TST binary/socket/token override. It creates two real project workspaces and verifies:

- both projects can start native managed daemons;
- project A's graph cannot see project B symbols and vice versa;
- `graph.refresh_paths` refreshes only the target project;
- project-scoped memories do not cross project boundaries;
- those memories survive a complete desktop runtime restart;
- the packaged TST metadata points at the pinned upstream revision;
- status does not reveal token or private socket values.

The CI packaged-runtime job builds the pinned Cuppet-code Rust daemon, creates the upstream standalone artifact with the upstream packager, stages/verifies it, packages Electron, then runs both the E1 runtime persistence smoke and the F1 real-TST acceptance smoke.

## Non-goals

F1 does not bundle OpenCode, does not migrate the bridge to the unrelated Python TST v0.3 `/v1` API, and does not implement signing/notarization. Signing, notarization, DMG/ZIP release production, and installed-app acceptance remain release-pipeline work after this runtime ownership milestone.
