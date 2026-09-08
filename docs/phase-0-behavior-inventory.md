# Increment 0: Cuppet behavior preservation baseline

Status: **complete**  
Prepared: **2026-09-08**  
Pinned source: `Officially-aditya/Cuppet-code@840ed751b61c04afc881a393b7836d4d2c932f61`

This is the migration gate for the independent Cuppet desktop/runtime. It records behavior that must either survive the migration or have an explicit reviewed replacement. It does **not** claim that the desktop application already exists.

The machine-readable source of truth is [`../migration/cuppet-source-baseline.json`](../migration/cuppet-source-baseline.json). Run `npm run phase0:verify` whenever it changes.

## 1. Authority boundaries

The independent runtime keeps the existing separation of truth:

| Fact | Authority after migration |
| --- | --- |
| Current code | Filesystem |
| Durable user/assistant/tool history | New session store (OpenCode transcript today) |
| Canonical long implementation specification | Lossless plan store |
| Verified reusable project/global knowledge | TST LTM |
| Task identity, working set, stale paths, routing epochs | PE3 registry |

Synthetic retrieval remains a model-request projection. It is not copied into visible transcript history and is not recursively re-ingested as user evidence.

## 2. Context compiler inventory

The production contract is `packages/opencode-plugin/src/context.ts`, not the smaller CLI helper. The replacement compiler moves this policy into the independent runtime and continues to operate on a detached model request.

| Mode | Baseline | Disposition |
| --- | --- | --- |
| Ordinary foreground | `min(2048,max(512,floor(usable × .04)))`; STM/graph/LTM approximately 45/35/20 | Preserve |
| Plan | `min(16384,floor(usable × .12))`; projection/graph/STM/LTM approximately 70/15/10/5 | Preserve |
| Graph-only | `CUPPET_GRAPH_CAPSULE_ONLY`; 768-token cap | Preserve opt-in |
| STM-only | three existing compaction flags; exclude LTM/graph/projection where applicable | Preserve opt-in |
| Structured STM events | `CUPPET_STM_EVENT_CONTEXT`; active-turn history; 15k cap; per-step refresh | Preserve opt-in |
| Compiled source capsule | `CUPPET_CONTEXT_COMPILER_AB`; 8192-token cap; stable within a user turn | Preserve opt-in |
| Task-conditioned | `CUPPET_TASK_CONTEXT_AB` / `CUPPET_TASK_CONTEXT`; 4096-token scoped evidence; no history trimming | Preserve opt-in |
| Orchestrator | `CUPPET_ORCHESTRATOR`; automatic retrieval/injection disabled | Preserve |

### Precedence and safety invariants

1. Orchestrator bypasses automatic foreground transformation.
2. Plan uses its distinct projection path.
3. Task-conditioned context outranks compiled context.
4. Compiled context opts into the event-history path.
5. Default history is not trimmed at/below half of usable context, with at most two turns, when usable context is unknown, or when a compaction record exists.
6. Candidate omission does not authorize trimming. TST, a non-empty replacement block, complete observation coverage, and retained STM are required; otherwise preserve full available history.
7. Ordinary and compiled blocks are memoized per user-message epoch. STM-event mode intentionally refreshes differently.
8. Complete-only plan projection may suppress redundant explorer tasks. Incomplete indexing/coverage preserves fallback exploration.

## 3. Behavior-changing flags

The baseline records context/compaction flags, graph permission-profile flags, foreground-instruction override, and PE3 local-embedding configuration. They are not converted into one new “advanced mode.” Defaults and precedence remain distinct until a measured change is reviewed.

Notable PE3 configuration preserved initially:

- `CUPPET_PE3_EMBED_MODEL`
- `CUPPET_PE3_MODEL_CACHE`
- `CUPPET_PE3_MODEL_DIR`
- `CUPPET_PE3_ALLOW_MODEL_DOWNLOAD` (`0` remains strict-offline behavior)

## 4. Registered commands

### Slash-visible product commands

`/status`, `/doctor`, `/remote` (`/remote-control` alias), `/remote-stop`, `/memory`, `/auto`, `/background`, `/orchestrator`, `/platform` (`/login` alias), `/effort`, `/steer`, `/abort`, `/plan`, `/compact`, `/undo`, plus native `/models` behavior.

The current source deliberately does **not** shadow `/models` with `/model`. The desktop replaces the native model dialog with its visible model selector while keeping model/effort semantics.

### Palette-only behavior

Memory remember/forget/clear, background pause/resume, immediate interrupt-and-steer, and the plan-agent picker are inventoried. The plan-agent picker is an OpenCode UI mechanism and is explicitly replaced by the desktop plan/build control rather than silently retained.

### CLI entry points

The migration inventory includes interactive `cuppet`, `--remote-control`, headless `cuppet remote-control`, `cuppet relay`, `cuppet remote-enroll`, `--doctor`, headless `--prompt`, relay selection, and current resume/session/fork flags. OpenCode-specific flag plumbing may change only with the disposition recorded in the manifest.

## 5. Shared/local control contract

The current control router is the compatibility seam for desktop and `/remote`. Increment 0 inventories every shared route plus the local-only control server additions.

Shared families retained:

- host/workspace discovery and attach
- session list/snapshot/messages/new/resume/submit/steer/abort/undo/compact
- plan/build mode
- permission list/reply
- question list/reply/reject
- model list/select and provider/platform compatibility calls
- guarded auto mode
- status/doctor

Local-only families retained or explicitly replaced:

- background pause/status
- orchestrator status/toggle
- remember/forget/clear
- remote start/status/stop
- explicit session adoption
- PE3 native route prepare/commit/abort

The three `pe3.*-native*` methods are OpenCode bridge mechanics. Their **transactional ownership semantics** are preserved, but the methods themselves are replaced by one independent-runtime routing entry point shared by desktop, CLI, and remote.

## 6. Plugin hooks and model-facing tools

Current server/plugin hooks:

- `experimental.chat.messages.transform`
- `tool.execute.before`
- Promise plugin `agent.transform` + reload
- Promise plugin `command.transform` + reload
- Promise plugin `catalog.transform` + reload
- TUI keymap layer registration
- disposal of request-context and graph-call caches

The first two become runtime-native compiler/tool-preflight stages. Agent/command/catalog transforms become ordinary runtime/provider registries. Their policy does not disappear just because the OpenCode plugin disappears.

Current model-facing Cuppet tools:

- `cuppet_plan` — preserved exactly as the lossless-plan retrieval surface
- `cuppet_memory_search` — preserved as memory retrieval
- `cuppet_workspace_info`
- `cuppet_graph_tree`
- `cuppet_graph_search`
- `cuppet_graph_trace`

The four graph-navigation tools have a **reviewed replacement** disposition: C1 may consolidate them into `tst_explore` / `tst_read`, but only after parity tests and the new toolchain gates pass. They are not removed during B1 merely because better tools are planned.

## 7. Agent and worker roles

Five distinct roles are preserved:

1. Foreground coding role — primary model.
2. Plan role — primary model with non-mutating plan policy.
3. Orchestrator master — primary model, explicit retrieval/context curation.
4. Orchestrator execution worker — secondary model, scoped implementation tasks.
5. Hidden memory canonicalizer — secondary model, one-step/tool-free, never verification authority.

The execution worker and memory canonicalizer remain separate roles even when they use the same configured secondary model.

## 8. PE3 controller overrides

`Pe3Controller` currently overrides and therefore owns migration semantics for:

| Method | Preserved policy |
| --- | --- |
| `initialize` | Load/reconcile registry; restored identities remain inert; no implicit resume |
| `close` | Persist bounded registry before shutdown |
| `newSession` | Bind a fresh task identity under routing serialization |
| `resume` | Reactivate/bind a task identity under routing serialization |
| `adoptSession` | Keep explicit selection and handoff suppression behavior; replace OpenCode-specific plumbing |
| `submit` | Route through PE3 once before model dispatch |
| `status` | Include PE3/cache/latency/persistence telemetry |

Native route prepare/commit/abort additionally preserve recoverable ownership: either the destination gets the complete request once, or the transition fails without duplicate model work.

PE3 routing order stays deterministic affinity → targeted TST localization → local embedding only for eligible ambiguity. Embedding failure and weak evidence remain conservative: stay with the active task.

## 9. Background enrichment and memory admission

The background memory path remains idle-only and foreground-preemptible. Baseline defaults include roughly 60 seconds of idle delay, 15-minute per-session cooldown, bounded 4 KiB input, at most eight signals/two user signals, up to four output candidates, capped persisted pending batches, and one transient retry.

The secondary model canonicalizes; it does not verify. The deterministic candidate ledger and Rust memory policy remain separate gates. Corrections/contradictions, explicit-user provenance, independent reinforcement, structural hashes, command success, stale/tombstone rules, and secret rejection remain product behavior.

## 10. Lossless plan and compaction distinctions

The canonical plan source/phases remain independent of the visible todo projection. Todo replacement must not silently drop unfinished canonical phases or resurrect unrelated completed plans.

These remain separate operations:

- model-history selection
- durable transcript compaction
- STM refresh
- TST durable-store compaction

STM-only compaction must refresh successfully before a compaction record can be written. Failure preserves the full transcript.

## 11. OpenCode derivative patch disposition

All 19 patches in the pinned source stack are explicitly classified in the manifest. Presentation-only OpenTUI patches are reviewed drops/replacements because Electron owns presentation. Runtime-policy patches map to independent runtime responsibilities instead of being silently removed.

Especially important migrations:

- model-context hook → native context compiler
- permission recovery/JSON boundary → ordered runtime events + approval reconciliation
- plan mode → runtime tool policy + UI state
- STM-only compaction → independent transcript/compaction path
- PE3 native routing/refresh/attachments/transactions → single shared runtime dispatch with recoverable ownership

## 12. Test migration map

The manifest maps legacy suites to their future acceptance gate rather than copying them blindly. Required families include:

- context mode and history fixtures → B1
- lossless plans → B1
- orchestrator roles/control → B1
- background worker + candidate ledger → B1
- STM compaction + TST contracts → B1
- PE3 routing, weighted fingerprints, localization confidence, adversarial cases, explicit return, semantic routing → B2
- attachment/native handoff/transaction tests → B2
- PE3 restart/persistence/post-freeze regressions → B2
- permission/auto/safe-bash/security → C
- remote control/relay/setup/token → C2
- provider/model/effort → A/D

New adapters must compare old/new model-facing context on identical fixtures before deleting old execution paths.

## 13. Phase 0 gate

Phase 0 is complete when `npm run phase0:verify` passes and the pinned source commit has not changed.

The verifier checks:

- immutable 40-character source pins
- all context modes inventoried
- all behavior/config flags inventoried
- slash and palette command inventory
- shared/local control inventory
- plugin/setup/TUI hook inventory
- all PE3 controller overrides
- all worker roles
- all 19 OpenCode derivative patches
- test-family migration map
- no missing or undecided disposition

### Updating the baseline

Do **not** silently move the pin when Cuppet-code changes. A baseline update is its own reviewed change:

1. compare the old/new source commits;
2. inspect changed commands, hooks, flags, controller overrides, PE3 behavior, memory policy, remote protocol, and patch stack;
3. update this document and the manifest;
4. run `npm run phase0:verify`;
5. name any changed product behavior explicitly.

Increment A may start only from a passing Phase 0 baseline.
