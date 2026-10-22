# Architecture review AR04–AR09

Implemented from the engineering review tracker dated 16 October 2026.

| Finding | Change |
| --- | --- |
| AR-04 | Streaming text is buffered for 250 ms. Cached append/session statements persist each batch under WAL with synchronous=NORMAL. First text advances durable lifecycle state immediately. Terminal updates and shutdown flush pending text. Live snapshots include pending text. |
| AR-05 | Live text events coalesce at 50 ms intervals and carry delta plus a UTF-16 end-offset cursor. Completion carries the full saved message. Clients ignore duplicates, reconcile overlapping snapshots, and reload a session on a gap. |
| AR-06 | Completed top-level markdown blocks keep their rendered output and React elements. Only the trailing block is parsed during ordinary streaming updates. Incomplete lines, lists, tables and fences stay mutable until their boundary is known. |
| AR-07 | src/shared/ipc-contract.mjs defines all 85 invocation methods, argument rules and subscriptions. scripts/generate-ipc.mjs generates the sandbox preload and renderer API types. Main handlers validate arguments and require the app's main frame, window and local document. |
| AR-08 | Conversation and turn stores share three ordered, transactional migrations using PRAGMA user_version. Unversioned alpha databases upgrade in place. Newer versions are rejected before schema, journal or recovery writes. Projection triggers and search schema are migrated once. |
| AR-09 | Shared core runtime-event, permission and provider-runtime contracts support gradual typing. permissions.mjs and the provider runtime contract opt into strict checking. npm run runtime:typecheck checks these files and positive/negative type fixtures without enabling checkJs across the runtime. |

Run npm run ipc:generate after changing the IPC contract. npm run renderer:verify checks generated output, renderer types, opted-in runtime types and the production renderer build.

Focused regressions cover batching, final persistence, duplicate/overlapping deltas, gap recovery, incremental markdown parity, all generated IPC methods, sender rejection, migration rollback, legacy preservation and newer-schema refusal.

The unrestricted suite still needs an unrestricted host: this managed environment denies some Unix sockets, nested macOS sandbox execution, credential-helper placement and protected temporary/cache paths. These host-dependent checks are not disabled in repository test configuration.
