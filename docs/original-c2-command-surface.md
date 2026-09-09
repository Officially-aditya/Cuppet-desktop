# Original C2 — Command & Interaction Surface

Original C2 moves Cuppet's user command layer onto the independent runtime without creating a second source of truth for sessions, provider settings, Remote state, or memory.

## Contract

`src/runtime/commands.mjs` is the canonical command registry. It owns command names, aliases, descriptions, declared Remote scope, bounded parsing, and dispatch contracts. It does **not** own the state being changed.

Authority remains where the independent runtime already established it:

- `RuntimeService` owns session controls, Plan/Build mode, guarded auto, background controls, explicit memory operations, compaction, abort, steer, and undo.
- The existing provider policy on each surface owns provider/model/effort selection. Provider credentials stay host-local.
- `RemoteManager` owns Remote host lifecycle.
- TST remains the memory substrate.
- SQLite remains conversation truth.
- The renderer only discovers commands, collects bounded inputs, and presents results.

## Slash commands

The reviewed slash surface is exactly:

| Command | Purpose | Authority |
| --- | --- | --- |
| `/status` | Runtime/provider/project status | host diagnostics |
| `/doctor` | Bounded diagnostics | host diagnostics |
| `/remote` | Inspect/start Remote | Remote lifecycle |
| `/remote-stop` | Stop Remote | Remote lifecycle |
| `/memory` | Search Cuppet memory | runtime/TST |
| `/auto` | Guarded auto status/toggle | runtime permission authority |
| `/background` | Background status/pause/resume/flush | runtime cognitive state |
| `/orchestrator` | Orchestrator status/toggle | runtime cognitive state |
| `/platform` | Provider/platform discovery or selection | provider authority |
| `/effort` | Model effort status/selection | provider authority |
| `/steer` | Interrupt when needed and steer | `RuntimeService.session.steer` |
| `/abort` | Stop active generation | runtime |
| `/plan` | Plan/Build status or selection | runtime cognitive state |
| `/compact` | Prepare compaction directive | runtime context compiler |
| `/undo` | Undo latest safe Cuppet mutation | runtime mutation journal |
| `/models` | List host-advertised coding models | provider authority |

Aliases are `/remote-control` → `/remote` and `/login` → `/platform`.

`/model` is intentionally not part of the contract. `/models` is the reviewed command.

## Palette-only actions

The Desktop command palette also exposes actions that benefit from structured inputs rather than an ad-hoc slash grammar:

- `cuppet.memory.remember`
- `cuppet.memory.forget`
- `cuppet.memory.clear`
- `cuppet.background.pause`
- `cuppet.background.resume`
- `cuppet.steer.interrupt`
- `cuppet.plan.agent`

Memory remember/forget/clear, interrupt-and-steer, and Plan/Build use bounded dialogs. Memory clear requires an explicit confirmation. Structured values are bounded again in Electron main before reaching the registry.

## Desktop flow

The composer shows command discovery when the user types `/` and also exposes a `/` palette button. Recognized slash submissions are intercepted before the ordinary chat send path whenever the required persisted session already exists.

Local commands such as `/status` and `/doctor` do not require a configured inference provider. A session-required slash command entered while composing the first message is allowed to fall through to the existing draft-persistence path so the chat can obtain its real SQLite session ID; Electron then intercepts the command before runtime inference.

Command execution emits `command.completed` and renders a transient command result. It does not create synthetic user/assistant transcript messages.

## Runtime inference boundary

`RuntimeService.send()` is fail-closed for slash text. Both recognized commands and unknown slash-prefixed text are rejected before the provider factory is reached. This means an alternate caller cannot bypass Electron or CLI interception and accidentally send a control command to the model.

Normal non-slash prompts retain the existing inference path.

## Headless flow

The CLI uses the same registry through:

- `cuppet commands`
- `cuppet command "/status"`
- slash interception inside `cuppet prompt`

Headless provider changes remain explicit through the existing flags/environment policy; the command registry does not persist a second provider configuration.

## Remote flow and authorization

Remote `session.submit` parses slash commands before ordinary prompt submission. For a recognized command it reads the command's declared scope from the shared registry and reauthorizes that **inner command** against the authenticated device scopes.

This prevents a device with only `session.write` from wrapping a higher-authority command such as `/effort` inside `session.submit` to bypass `model.write`.

Remote `/steer` delegates to the same runtime `session.steer` authority used elsewhere; Remote does not keep a second stop/wait/send implementation.

## Security and trust boundaries

- Command text is bounded to 8192 characters and parser arguments to 32.
- Structured palette inputs are allowlisted and bounded in Electron main.
- Memory scope is restricted to `session`, `project`, or `global`.
- Mode is restricted to `plan` or `build`.
- Provider keys never enter command metadata or renderer state.
- Slash commands never become model prompts merely because another surface forgot to intercept them.
- Command results are control-plane results, not conversation evidence.

## Acceptance

`npm run original-c2:verify` is the permanent gate. It verifies the exact registry inventory and aliases, `/model` exclusion, Desktop/preload/CLI/Remote wiring, runtime slash fail-closed behavior, transcript isolation, Remote inner-scope authorization, canonical steer delegation, and the focused Original C2 tests.

Original C2 is accepted only when all inherited gates from Phase 0 through Original C1 and the Original C2 gate are green on both the branch and the pull request.
