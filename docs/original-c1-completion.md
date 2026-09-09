# Original C1 completion contract

Original C1 closes the gap between the independent Phase C1 tool loop and the stronger structural-editing behavior required by the original migration plan.

The production runtime remains independent of OpenCode. The correction is additive to Phases 0 through E and preserves their existing authority boundaries.

## Model-facing coding path

For supported source edits, the preferred path is:

```text
tst_explore
→ revision-bound target
→ tst_read
→ tst_edit_batch prepare
→ permission on exact prepared batch + diff digest
→ tst_edit_batch apply
→ graph refresh receipt for final hashes
→ tst_validate
```

Generic `workspace_edit`, `workspace_write`, and shell execution remain fallbacks for unsupported or inappropriate structural edits. They do not become the preferred code-editing substrate.

## Revision-bound targets

The TST daemon exposes `edit.resolve_targets`. Every returned edit reference is bound to:

- project-relative path;
- language and structural symbol/kind;
- SHA-256 base file hash;
- UTF-8 byte start/end offsets;
- row/column coordinates;
- exact expected source;
- deterministic target ID.

`tst_read` rechecks the current filesystem hash and expected byte slice. A stale target fails closed instead of guessing offsets.

## Prepare is write-free

`tst_edit_batch action=prepare`:

1. resolves every requested operation;
2. rejects missing, ambiguous, stale, conflicting, or overlapping operations;
3. materializes each final staged file buffer in memory;
4. asks TST `edit.parse_staged` to parse supported staged source;
5. rejects newly introduced syntax errors;
6. computes the complete diff and diff digest;
7. persists only bounded private prepared-batch metadata.

No project file is written during prepare. A prepared batch therefore creates no mutation event, no mutation journal entry, and no durable TST action observation.

## Apply is one checked mutation transaction

`tst_edit_batch action=apply` revalidates every base hash and prepared final buffer before publication. Permission is bound to the exact batch ID and diff digest.

All project mutation paths share one runtime-owned `ProjectWriter`, including:

- structural batch publication;
- generic edit/write mutation;
- mutating shell work;
- Undo.

This is an in-process serialization boundary for a project. It prevents two Cuppet mutation paths from silently interleaving, while filesystem hashes remain the final concurrency truth against external editors/processes.

A successful multi-file apply creates one `MutationJournal` batch checkpoint. Undo first verifies every current postimage, then restores the complete recorded batch or fails closed. It never uses destructive Git reset/checkout/clean/restore behavior.

## Graph freshness barrier

After files are published, batch apply calls TST `graph.refresh_paths` exactly once for the changed path set.

The acknowledgement is accepted only when every changed file is returned with its current final content hash. A missing path or mismatched hash marks graph state stale. Further structural prepare work is blocked until the graph can acknowledge current filesystem truth.

The runtime does not perform a second duplicate graph refresh for a batch whose manager already handled the barrier.

## Validation and reusable memory

`tst_validate` runs explicit approved repository checks against a stable post-edit snapshot. It hashes the requested files before the command set, runs the commands, hashes the files again, and accepts validation only when:

- every command exits successfully; and
- no validated path changed while validation was running.

Only successful stable validation can create the behavioral validation memory observation. Its provenance is `verifier`, and TST receives both:

- `command_success` evidence for each successful verifier command;
- `content_hash` evidence for each validated post-edit file hash.

This preserves the existing evidence-gated LTM promotion policy instead of allowing model assertions or a bare hash to become behavioral truth.

## Authority map

- filesystem: code/content truth;
- TST Tree-sitter parsing: structural target and staged syntax authority;
- SQLite `tool_executions`: durable model-requested execution audit;
- `ProjectWriter`: Cuppet in-process mutation serialization;
- `MutationJournal`: reversible Cuppet-owned preimage/postimage authority;
- TST graph: structural projection trusted after current-hash refresh acknowledgement;
- TST LTM: reusable verified memory under evidence policy;
- renderer/Remote/headless UI: projection/control surfaces only.

## Acceptance gate

`npm run original-c1:verify` is a permanent migration gate. It checks the structural contracts and executes dedicated behavioral tests for:

- revision-bound exploration/read;
- write-free prepare;
- checked apply;
- single graph refresh ownership;
- stable post-edit validation;
- no prepare mutation evidence;
- batch undo checkpoint behavior;
- fail-closed graph receipt mismatch.

CI must keep every earlier Phase 0 → E gate green and then pass `original-c1:verify` before this correction is considered complete.

## Deferred

Original C1 does not claim completion of the rest of the original Phase C scope. After this gate lands, the next migration increment remains `original-C`.
