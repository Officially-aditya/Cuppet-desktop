# Windows streaming freeze: agent prompt

Copy the following prompt to the agent running on the affected Windows machine.

---

Investigate a reproducible Cuppet Desktop UI freeze on Windows and produce an evidence-based diagnostic report for the agent maintaining the app. While a model is responding, clicking the **Thought/Thinking** or **Worked/Working** disclosure sometimes freezes the whole app for several seconds. Previous fixes moved Markdown parsing to a worker, retained thought DOM, patched the streaming tail, and batched runtime updates, but the user still sees the freeze.

Work in the Cuppet-desktop repository. Read its AGENTS.md instructions. Use the latest `release/v0.9.0-alpha.30` branch containing this document and record the exact commit SHA and any local modifications. Preserve existing work. This task is diagnosis: do not change production behavior, weaken performance assertions, upgrade dependencies, or permanently disable GPU acceleration. Temporary diagnostic instrumentation is allowed; include its diff in the report.

## 1. Record the affected environment

- Installed Cuppet version and executable path, source checkout SHA, and whether each reproduction uses the installed app or the checkout. Confirm whether the installed app actually contains the previous fixes; a passing checkout does not establish that the installed app is fixed.
- Windows edition/build, CPU, RAM, GPU and driver version, display scaling/refresh rate, power mode, and whether the session uses RDP/a VM.
- Electron/Chromium/Node versions and actual GPU feature status. The streaming smoke test prints these.
- Provider/model, approximate conversation length, which disclosure freezes, whether it is the first opening or a reopening, and whether the content is actively growing. Distinguish the inner commentary “Worked” disclosure from the outer “Cuppet (Worked for…)” activity group.

## 2. Run the updated foreground reproduction

Use Node 22+ and the repository's lockfile dependencies (`npm ci` only if needed). Run from the repository root in PowerShell. Keep the test window visible and the machine unlocked; do not interact with its automated typing. It creates an isolated synthetic profile under `.release/streaming-smoke`, uses no provider requests, and rebuilds `dist-renderer`.

```powershell
New-Item -ItemType Directory -Force .release/windows-streaming | Out-Null
git status --short --branch
git rev-parse HEAD
node --version
npm --version

# First measure without tracing overhead.
npm run renderer:streaming-smoke *>&1 | Tee-Object .release/windows-streaming/smoke.log
"Exit code: $LASTEXITCODE"

# Then capture a Chromium trace, including disclosure timing marks.
$env:CUPPET_STREAMING_TRACE = Join-Path (Get-Location) '.release/windows-streaming/disclosures.trace.json'
try {
    npm run renderer:streaming-smoke *>&1 | Tee-Object .release/windows-streaming/smoke-traced.log
    "Exit code: $LASTEXITCODE"
} finally {
    Remove-Item Env:CUPPET_STREAMING_TRACE -ErrorAction SilentlyContinue
}
```

The test opens and reopens large Thought and Worked blocks during answer previews, answer deltas, and reasoning deltas, in short and 50-turn chats, under 4× renderer CPU throttling. It checks keyboard input, incoming-event delay, event-loop/frame gaps, disclosure opening time, and actual rendered reasoning updates. Trace capture saves on normal completion, assertion failure, or the test timeout. Source maps are emitted when tracing is enabled. Save all metrics and failures; do not stop at the first failing assertion without examining its trace. If the app exits or crashes before a trace is saved, report that separately and collect the available crash/log evidence.

## 3. Capture the user's real failing interaction

Even if the synthetic test passes, reproduce the original issue in the installed app or the affected conversation. Use actual mouse/keyboard input and record a performance trace from before the click until the UI recovers. Keep this local; do not publish chat contents, credentials, or the user's database. Record a short screen capture if supported.

Compare first open and reopen while the model is responding, then the same disclosure after output stops. Include both inner Thought/Worked blocks and the outer activity group. Try a short chat and the affected long chat. Record the number of activities, thought text length, and content shape (one long paragraph, many small paragraphs, code, tables) without exposing private text. If needed, recreate that shape with synthetic text.

During the stall, measure:

- Native click arrival → handler → expanded DOM → next painted frame, not just the duration of JavaScript `button.click()`.
- Renderer long tasks and main-thread stacks: React render/commit, Markdown/tail DOM insertion, style recalculation, layout, paint, garbage collection, and scroll-follow work.
- Worker activity and message size, incoming runtime-event delay, renderer/main/runtime process CPU, and GPU/compositor activity. Attribute each delay to the process/thread actually observed; do not infer the cause from CPU usage alone.
- Whether the composer, sidebar, scrolling, and window interaction remain responsive; whether output arrives in a burst afterward.

Inspect the trace around the `short-chat`/`long-chat` disclosure user-timing marks. Identify the longest tasks, their start times/durations, and the stack or layout/paint evidence tying them to the click. An off-main-thread parser does not exclude expensive DOM/layout work on the renderer.

Only if the baseline points to a GPU/compositor problem, do a separate temporary launch with GPU acceleration disabled and compare the same interaction. Keep the normal baseline, record the exact launch flag, and do not treat that diagnostic experiment as a fix. Likewise, distinguish the automated 4× CPU test from unthrottled real-app measurements.

Relevant files: `src/renderer/react/ChatTranscript.tsx`, `reasoning-renderer.ts`, `reasoning-markdown.worker.ts`, `markdown-tail.ts`, `scroll-follow.ts`, `src/renderer/message-controls.css`, and `scripts/smoke-streaming-interactions.mjs`.

## 4. Deliver the report

Write `.release/windows-streaming/REPORT.md` with:

1. Reproduction verdict: reproduced, not reproduced, or unable to test; exact build and steps.
2. Environment and a comparison table of installed/source, streaming/finished, first/reopen, disclosure type, input-to-paint latency, longest main-thread task, maximum event/frame gap, and runtime-event delay. Mark unmeasured values explicitly.
3. Evidence for the bottleneck, with trace filenames, timestamps, durations, process/thread names, and relevant stacks/source locations. Separate observations from hypotheses.
4. The smallest justified fix recommendation, confidence level, and the specific regression scenario it must pass. Do not claim a cause if the trace does not establish one.
5. Exact commands, exit codes, raw logs, trace/screen-recording paths, and any temporary instrumentation diff. Keep large artifacts local and out of Git.

Return the report text plus accessible artifact paths. If the affected conversation cannot be accessed, state that limitation and describe the closest scenario tested. A passing synthetic smoke test alone is not a resolution of the user's report.
