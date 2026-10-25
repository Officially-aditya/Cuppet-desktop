# Chat-switch benchmark

The fixture contains 1,000 messages, 10,000 activity rows, 500 tool executions and three PNG attachments. Both commands use a temporary database/profile and send no provider requests.

- `npm run benchmark:chat-switch` measures a cold runtime read and the p95 of 20 warm reads, including JSON serialization and parsing.
- `npm run benchmark:chat-switch:renderer` opens the production Electron app and measures click-to-transcript commit and frame timing for the first visit and 20 cached visits, reporting warm p95, maximum and individual samples. The starting chat includes a formatted assistant response; startup/font paint is reported separately from switching to the unloaded history. It also reports the app's `chat-switch` performance measures. The window needs a visible desktop.

Each run asserts an initial payload below 250 KB, a cold read/transcript commit below 250 ms and warm p95 reads/commits below 100 ms. Local runs and Windows CI also enforce those limits after two animation frames. Runtime timings exclude Electron IPC and rendering; use the renderer command for end-to-end results. The CI benchmark job runs both on macOS arm64 and Windows x64.

macOS CI's virtual display exhibited a roughly three-second first-frame wait despite a committed transcript in 112 ms, while physical macOS and Windows passed the paint targets. That runner reports frame timing diagnostically and still enforces transcript commit budgets. The output records GPU features, focus/visibility and renderer script/layout work alongside the timings. Production graphics settings are unchanged.

The CI workflow's `benchmarks_only` dispatch input runs just these platform benchmarks. Older offscreen rows stay unrendered until they approach the viewport. System load affects paint timing; run the renderer benchmark without concurrent builds.
