# Provider Architecture V2

Status: implementation branch foundation.

This design is Cuppet-native. External projects may inform the architectural questions we ask, but this implementation does not copy their source, contracts, component APIs, event names, or code structure.

## Why this exists

Cuppet currently supports several provider transports with provider-specific model discovery, configuration, event handling, process lifecycle, and renderer bridging. That has made unrelated operations capable of affecting each other: settings writes can influence model state, protocol additions require renderer work, and local CLI behavior can leak into product-level logic.

Provider Architecture V2 creates one ownership boundary around coding/model backends while keeping Cuppet's journal, TST, permissions, browserControl, remote control, and personal-agent orchestration above it.

Owning the provider process is not sufficient. Cuppet must also own execution policy. A provider is a reasoning engine; Cuppet decides how repository inspection, editing, validation, memory, browser work, permissions, and fallback execution happen.

## Target shape

```text
                        Cuppet
                          │
                 Context / orchestration
                          │
                  Execution Kernel
                          │
                    ToolRuntime
              TST / journal / permissions
                          │
                Provider Runtime contract
                    ┌─────┴─────┐
                    │           │
             ACP transport   Codex app-server
                    │           │
             ACP backends      Codex
```

ACP is a transport abstraction, not Cuppet's universal architecture. Codex legitimately uses its own app-server wire protocol. Both transports converge on the same Execution Kernel, Cuppet tool surface, Activity vocabulary, permissions, journal, and optimization policy.

## Core concepts

### Backend

A provider family such as Codex, OpenCode, Kiro, or Antigravity. A backend declares static identity and constructs a runtime for a configured connection. It does not own user state.

ACP-compatible backends are descriptors plus genuine protocol quirks. OpenCode is the first production backend using the shared ACP adapter; it is not a separate runtime architecture.

### Connection

A user's configured backend. Authentication, executable configuration, and user preferences live in separate nested namespaces so changing credentials cannot implicitly rewrite model/runtime preferences.

### Runtime

A live provider execution environment with a small Cuppet contract: start, advertise capabilities, run a turn, cancel, and close. Protocol details stay behind this boundary.

### Capabilities

A provider-authoritative snapshot of models, runtime settings, attachment support, session features, and transport features. Runtime settings are generic select/boolean values. Cuppet may give known categories such as model or reasoning first-class UI without hardcoding provider values.

Provider capabilities describe the reasoning engine. They are separate from Cuppet execution capabilities such as TST, batching, validation, memory, browser control, and shell execution.

### Activity

A Cuppet-owned vocabulary for visible runtime work: text, reasoning, tools, plans, permissions, usage, status, warnings, and errors. Renderer, journal, remote clients, and future mobile surfaces consume Activity rather than ACP/Codex/native protocol names.

### Conversation bridge

A later migration slice owns the mapping between a Cuppet session and a provider session/resume state. Provider session ownership must not live in React or global settings.

### Execution Kernel

The transport-neutral policy boundary between provider tool requests and ToolRuntime.

Every provider tool call crosses the kernel, regardless of whether it arrived through ACP MCP, ACP v1 host requests, Codex dynamic tools, or a future transport.

The kernel owns:

```text
provider-facing tool surface
optimized-vs-fallback policy
execution path telemetry
fallback unlocking
future deterministic coalescing/routing
```

ToolRuntime remains the single implementation of TST operations, permissions, journaling, project boundaries, mutation tracking, validation, shell execution, memory, and browser tools.

## Cuppet tools through ACP

ACP sessions receive a Cuppet-owned stdio MCP server through `session/new.mcpServers`.

```text
ACP agent
   │
   │ MCP tools/list + tools/call
   ▼
Cuppet MCP facade
   │ authenticated local IPC
   ▼
Execution Kernel
   │
   ▼
ToolRuntime
```

The MCP process is intentionally a thin protocol facade. It does not implement edits, reads, permissions, TST, validation, or memory itself.

Each ACP logical session receives a fresh local endpoint and short-lived random authentication token. Closing the turn closes the tool session, so an old ACP session cannot retain Cuppet execution authority.

Current Cuppet MCP surface includes the existing runtime operations:

```text
cuppet_plan
cuppet_memory_search
question

tst_explore
tst_read
tst_edit_batch
tst_validate

workspace_read
workspace_edit
workspace_write
bash

browser_* when enabled
```

The provider-facing surface is filtered by Execution Kernel policy rather than exposing every primitive equally.

## Optimized-first execution policy

Availability is not enough. Cuppet must make the optimized path authoritative.

Initial mutation policy:

1. Providers receive `tst_edit_batch` but do not receive raw `workspace_edit` / `workspace_write`.
2. ACP v1 native filesystem writes are not allowed to silently bypass that rule.
3. If `tst_edit_batch` actually fails for the session, raw mutation tools are unlocked as an explicit fallback.
4. Raw fallback remains permissioned, journaled, bounded, and observable through ToolRuntime.

This is intentionally stronger than a prompt that merely says "prefer batched edits."

Reads and shell remain available as fallbacks for now. Their optimization policy will tighten only after equivalent deterministic routing is proven not to reduce correctness.

## ACP v1 and v2 direction

Cuppet currently keeps ACP v1 compatibility because deployed agents still use its client filesystem/terminal requests.

ACP v2 removes client filesystem and terminal execution APIs and directs client-side tools through MCP servers. That aligns with Cuppet's intended architecture: Cuppet's MCP tool surface becomes the normal execution path and native ACP host operations disappear naturally as backends adopt v2.

Do not hard-switch the product to ACP v2 until provider support and parity fixtures prove it. Support version-specific behavior behind the shared ACP transport.

## Codex convergence

Codex remains on the official app-server protocol. Its wire adapter is different; its execution architecture is not.

```text
Codex item/tool/call ─┐
                      ├─> Execution Kernel -> ToolRuntime
ACP MCP tools/call ───┘
```

Codex already receives Cuppet dynamic tools and is instructed not to use its built-in project mutation capabilities. Provider Architecture V2 moves that tool path through the same Execution Kernel policy used by ACP.

## Authority rules

1. Provider-advertised IDs are preserved exactly.
2. Cuppet never uses the first advertised model as an inferred default.
3. An explicit user model is changed only by an explicit model operation, provider invalidation, or reset.
4. Credential/executable changes do not rewrite model or effort preferences.
5. Provider-specific events do not cross the Runtime -> Activity boundary.
6. Health checks, setup, authentication, installation, and runtime execution are separate operations.
7. Cuppet remains the permission authority for host mutations.
8. Cuppet's journal remains the durable authority for tool/mutation state.
9. TST remains above provider transports.
10. ACP backends share one protocol runtime; provider-specific runtime copies are not allowed without a real protocol incompatibility.
11. Raw mutation is a fallback, not a peer of the optimized batch path.
12. A provider process/session never owns Cuppet tool authority beyond its active scoped tool session.

## Runtime lifecycle

Managed ACP currently reuses one provider process per Cuppet chat while opening a fresh ACP logical session per turn. This avoids startup/auth churn without pretending the provider owns context that Cuppet's Conversation Bridge has not yet accounted for.

A runtime is replaced when backend, project root, model, effort, command, or execution-authority configuration changes. Failure/cancellation discards ambiguous runtime state. Idle processes are evicted.

Conversation Bridge may later permit persistent logical ACP sessions once duplicated-context semantics are proven.

## Migration path

1. Add contracts, registry, Connection model, Activity model, and compatibility runtime around current providers.
2. Build Cuppet-owned ACP process/RPC/session components and move OpenCode as the first proving backend.
3. Generalize OpenCode-specific runtime management into the shared ACP adapter/runtime manager.
4. Pass the Cuppet tool server to ACP sessions and prove ACP -> MCP -> Execution Kernel -> ToolRuntime end to end.
5. Put ACP and Codex tool calls through the shared Execution Kernel.
6. Enforce optimized-first mutation policy and add execution-path metrics.
7. Replace ACP model/reasoning special cases with generic provider capabilities and model-dependent setting refresh.
8. Add deterministic read/search/validation optimization where correctness can be preserved.
9. Benchmark optimized execution against raw execution before scaling provider coverage.
10. Move a second ACP backend only after the shared runtime/tool path proves provider-neutral.
11. Move Antigravity to ACP where the native/distributable route is appropriate.
12. Move chat/journal rendering to Activity only.
13. Add Conversation Bridge persistence/resume after context ownership is explicit.
14. Separate probe/install/auth/update/runtime operations and installation ownership.
15. Remove compatibility paths only after parity tests pass.

## Testing gates

Before another ACP backend moves to the new path, fixtures must prove:

```text
same ACP runtime works for more than one backend descriptor
Cuppet MCP tools are supplied through session/new
optimized tools are discoverable
raw mutation tools are hidden initially
ACP native write cannot bypass optimized-first policy
failed batch edit unlocks explicit raw fallback
permissions/journal/path refresh still execute in ToolRuntime
stalled providers cancel and terminate
old tool-session credentials cannot retain authority
```

Benchmark gates should measure at least:

```text
optimized vs raw execution path counts
raw reads
shell invocations
edit operations
files per batch
context bytes returned
tokens per task
latency
validation success
task correctness
```

## CI policy for this branch

Do not trigger broad CI for every architectural commit. Pure additive/docs/contract commits should be validated with focused Node tests. Run renderer verification when renderer-facing contracts change. Run the full CI matrix only at meaningful integration boundaries (for example, provider-factory cutover, second-provider migration, Execution Kernel integration readiness, or before PR/release staging).
