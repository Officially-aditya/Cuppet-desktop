from pathlib import Path

path = Path('README.md')
text = path.read_text()

old_top = '''## Current increment

**Phase E — independent session/control parity: implemented candidate (`0.8.0-alpha.1`).**

Cuppet now owns the remaining shared session/control behavior without rebuilding an OpenCode-shaped controller:

- durable headless session resume, continue, fork, status, doctor, and undo;
- a runtime-owned interactive `QuestionBroker` shared by Desktop and Remote;
- a private, byte-exact, hash-checked `MutationJournal` for safe undo of Cuppet-owned file mutations;
- Desktop, browser Remote, and headless surfaces routed to the same runtime authorities.

Phases A through D remain intact: SQLite conversation/project state, detached context compilation, lossless plans, TST/STM, evidence-gated background memory, PE3 task routing, runtime-owned coding tools and permissions, host-authoritative Remote, and independent provider/model/effort policy.

The production source has **no OpenCode dependency**.
'''
new_top = '''## Current increment

**Original C1 correction — structural editing contract: implemented candidate (`0.8.0-alpha.1`).**

Cuppet now closes the original C1 structural-editing gap without rebuilding an OpenCode-shaped controller:

- revision-bound TST edit targets tied to current filesystem hashes and exact source bytes;
- write-free multi-file `tst_edit_batch` prepare with staged Tree-sitter validation before publication;
- one runtime-owned `ProjectWriter` across structural batches, generic mutations, mutating shell work, and Undo;
- final-hash graph refresh receipts that fail closed when a changed path is omitted or stale;
- `tst_validate` evidence bound to stable post-edit hashes, with verifier provenance and command-success evidence;
- one conflict-safe `MutationJournal` checkpoint for an applied multi-file batch.

Phases A through E remain intact: SQLite conversation/project state, detached context compilation, lossless plans, TST/STM, evidence-gated background memory, PE3 task routing, runtime-owned permissions, host-authoritative Remote, provider/model/effort policy, and shared session/control behavior.

The production source has **no OpenCode dependency**. The next migration increment is the remaining **original C** scope.
'''
if old_top not in text:
    raise SystemExit('README current-increment block not found')
text = text.replace(old_top, new_top, 1)

old_tools = '''- `tst_explore` — TST workspace/tree/search/trace discovery;
- `tst_read` — exact bounded filesystem reads;
- `workspace_edit` — precise text replacement;
- `workspace_write` — bounded file creation/replacement;
- `bash` — project-scoped shell execution;
'''
new_tools = '''- `tst_explore` — TST workspace/tree/search/trace discovery plus revision-bound edit targets;
- `tst_read` — exact bounded filesystem reads and checked revision-target reads;
- `tst_edit_batch` — write-free structural prepare followed by checked multi-file apply;
- `tst_validate` — explicit approved repository checks bound to stable post-edit hashes;
- `workspace_edit` — precise text replacement fallback for unsupported/unstructured cases;
- `workspace_write` — bounded file creation/replacement fallback;
- `bash` — project-scoped shell execution;
'''
if old_tools not in text:
    raise SystemExit('README runtime-tools list not found')
text = text.replace(old_tools, new_tools, 1)

marker = '''### Structural exploration first

`tst_explore` consolidates structural navigation:
'''
replacement = '''### Structural edit path

For supported code edits, the preferred path is:

```text
tst_explore
→ revision-bound target
→ tst_read
→ tst_edit_batch prepare (zero writes)
→ exact permission for the prepared batch + diff digest
→ tst_edit_batch apply
→ current-hash TST graph refresh receipt
→ tst_validate
```

Prepare never changes project files. Apply revalidates base hashes, publishes one checked batch under the shared project writer, records one multi-file Undo boundary, and owns the graph refresh barrier. If TST cannot acknowledge every changed path at its final filesystem hash, later structural work remains blocked until freshness is recovered.

Successful validation becomes reusable behavioral evidence only when approved checks pass against unchanged post-edit hashes. The observation uses verifier provenance and records both command-success and content-hash evidence. Model claims and prepared-but-unapplied edits do not become verified memory.

### Structural exploration first

`tst_explore` consolidates structural navigation:
'''
if marker not in text:
    raise SystemExit('README structural exploration marker not found')
text = text.replace(marker, replacement, 1)

path.write_text(text)
