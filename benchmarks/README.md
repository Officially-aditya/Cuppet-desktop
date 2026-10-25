# Chat-switch benchmark

The fixture contains 1,000 messages, 10,000 activity rows, 500 tool executions and three PNG attachments. Both commands use a temporary database/profile and send no provider requests.

- `npm run benchmark:chat-switch` measures a cold runtime read and the p95 of 20 warm reads, including JSON serialization and parsing.
- `npm run benchmark:chat-switch:renderer` opens the production Electron app and measures click-to-paint for the first visit and five cached visits. The starting chat includes a formatted assistant response; startup/font paint is reported separately from switching to the unloaded history. It also reports the app's `chat-switch` performance measures. The window needs a visible desktop.

Each run asserts an initial payload below 250 KB, a cold read/switch below 250 ms and warm reads/switches below 100 ms. Runtime timings exclude Electron IPC and rendering; use the renderer command for end-to-end results. The CI benchmark job runs both on macOS arm64 and Windows x64.

The CI workflow's `benchmarks_only` dispatch input runs just these platform benchmarks. A local macOS arm64 run measured a 162,448-byte payload, a 65 ms cold switch and a 51 ms maximum across five warm switches, with 69 ms of startup paint reported separately. Older offscreen rows stay unrendered until they approach the viewport. System load affects paint timing; run the renderer benchmark without concurrent builds.
