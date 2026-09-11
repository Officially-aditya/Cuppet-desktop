# Provider V2 Benchmarking

Provider Architecture V2 is not considered proven merely because providers can call Cuppet tools. Before provider coverage expands, Cuppet must show that its optimized execution surface is more efficient than a raw mediated baseline **without reducing correctness**.

The benchmark harness uses the real `RuntimeService`, context compiler, provider factory, managed provider runtime, Execution Kernel, ToolRuntime, permissions, journal, and validation path. The raw baseline is available only through the developer benchmark policy; it is not a user/provider setting.

## Safety boundary

Use a disposable benchmark checkout. Every task is executed twice and its `prepareCommand` runs before each policy, so the command must restore the repository to an identical known state.

Do not point the suite at a working checkout containing uncommitted work. Do not put API keys, tokens, cookies, login state, or other credentials in benchmark manifests. Provider authentication stays in the normal local CLI/environment.

`benchmarks/provider-v2.example.json` is intentionally a template: `benchmarks/reset-fixture.mjs` and `benchmarks/verify-fixture.mjs` are placeholders for corpus-specific reset/verification logic and are not shipped as fake benchmark fixtures.

## Manifest

The machine-readable schema is `benchmarks/provider-v2.schema.json`.

A manifest contains:

- `schemaVersion: 1`.
- optional non-secret provider/model/effort selection.
- a suite-level `prepareCommand`, or a task-specific one for every task.
- one or more tasks with stable IDs and prompts.
- at least one correctness verifier per task: `verifyCommand` and/or `expectOutput`.
- optional turn/verification timeouts.
- `gate.minImprovements`, defaulting to 2.

Task IDs must be stable across baseline and optimized runs. The suite runner refuses a task without a reset command, while the comparison gate refuses missing or unverified task pairs.

## Run a corpus

With OpenCode already authenticated locally:

```bash
node scripts/run-provider-benchmark-suite.mjs \
  --manifest /path/to/provider-v2-benchmark.json \
  --project /path/to/disposable/benchmark-checkout \
  --out-dir .benchmark-results/opencode
```

Provider selection may be overridden without changing the corpus:

```bash
node scripts/run-provider-benchmark-suite.mjs \
  --manifest /path/to/provider-v2-benchmark.json \
  --project /path/to/disposable/benchmark-checkout \
  --out-dir .benchmark-results/claude \
  --provider-id claude-code \
  --model '<exact provider model id>'
```

The suite creates:

```text
raw-baseline.jsonl
optimized.jsonl
comparison.json
```

Each task is run first through the benchmark-only raw mediated surface and then through normal optimized Cuppet execution, with `prepareCommand` executed independently before both runs.

## What the gate measures

Per task/suite the benchmark records include:

```text
tool calls
optimized-path calls
raw fallback calls
raw reads
shell/command calls
mutation executions
batch read targets
batch edit operations
context/result bytes
paths touched
execution time
wall-clock elapsed time
validation attempts/successes/failures
input/output/total/cached/reasoning tokens when the provider reports them
correctness verification
```

The gate fails if:

1. either policy is missing a task,
2. either side is unverified,
3. optimized correctness is worse than the raw baseline,
4. optimized-path share does not increase, or
5. fewer than the configured number of efficiency metrics improve.

Current lower-is-better gate metrics are tool calls, raw reads, shell calls, mutation executions, returned context bytes, and total tokens. Latency and validation are recorded for analysis but are not yet mandatory pass/fail dimensions because provider/network variance can dominate them.

## Run one task manually

For debugging a corpus task:

```bash
node scripts/run-provider-benchmark.mjs \
  --task-id targeted-bug-fix \
  --project /path/to/disposable/benchmark-checkout \
  --prompt 'Find and fix the benchmark failure, then validate it.' \
  --provider-id opencode \
  --policy optimized \
  --prepare-command 'node /path/to/reset-fixture.mjs' \
  --verify-command 'node /path/to/verify-fixture.mjs targeted-bug-fix' \
  --output /tmp/opencode-optimized.jsonl
```

Repeat with `--policy raw-baseline` from the same reset state. Standalone result sets can be compared with:

```bash
node scripts/compare-provider-benchmarks.mjs \
  /tmp/opencode-raw.jsonl \
  /tmp/opencode-optimized.jsonl
```

## Evidence requirement

Synthetic tests prove the benchmark machinery, not the architecture's product advantage. The provider-expansion gate requires a real authenticated provider, a disposable task corpus, deterministic reset/verification, and captured raw-vs-optimized records. Do not replace that evidence with mocked model output or hand-authored JSONL.
