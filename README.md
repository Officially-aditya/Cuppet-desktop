# Cuppet Desktop

<p align="center"><img src="src/renderer/assets/cuppet.png" alt="Cuppet" width="88" /></p>

Cuppet is a desktop workspace for AI-assisted software development. Connect a coding provider, open a project, and work through changes in a persistent conversation with file tools, a terminal, and approval controls.

Projects and conversations stay on your computer. Model requests go to your selected provider, and Cuppet Remote lets a paired browser control the running desktop host.

**Cuppet is in alpha.** Get builds from [GitHub Releases](https://github.com/Officially-aditya/Cuppet-desktop/releases). The source version is recorded in [package.json](package.json).

## What you can do

- **Work with projects:** open local folders, clone GitHub repositories, and keep each chat attached to its original project.
- **Choose your provider:** use Codex with a ChatGPT account, connect a local coding CLI, or configure an API provider.
- **Plan, build, and orchestrate:** switch between read-only planning, implementation, and delegated work, review tool activity and file diffs, and run a project terminal.
- **Guide an active task:** queue the next message or steer the current turn without stopping it. Attach files and images when needed.
- **Keep context:** use project code navigation, session context, saved plans, and verified memory through Cuppet's TST context and memory runtime.
- **Continue remotely:** pair a browser with the desktop host, respond to questions and approvals, or give a device viewer access.

## Download and install

Choose the matching artifact from the [releases page](https://github.com/Officially-aditya/Cuppet-desktop/releases):

| Platform | Release target | Packages |
| --- | --- | --- |
| macOS | Apple Silicon / arm64 | DMG and ZIP |
| Windows | x64 | NSIS installer and ZIP |
| Linux | Source only | No prebuilt release package |

Release builds are currently unsigned, and macOS builds are not notarized. Automatic macOS updates are disabled; download and install updates manually. See [release security and packaging](docs/release-security.md) for the current distribution policy.

## Set up your first project

1. Open **Settings → Platform** and choose an AI provider.
2. Connect the provider using its sign-in flow or enter its API key, then select a primary model. Choose a reasoning effort if the model supports it. An optional secondary model handles context-memory work.
3. Choose **Open a folder** or **Clone a repository**. GitHub cloning uses your existing Git credentials; browsing your GitHub repository list requires an authenticated `gh` CLI.
4. Start a project chat and describe what you want to build or change. Use **Plan** to inspect and plan, or **Build** to implement.

General chats work without a project, but do not receive filesystem or shell tools. Removing a project from Cuppet removes its registration, not the folder on disk.

### Providers

| Connection | Providers available in Settings | Authentication |
| --- | --- | --- |
| Codex | Codex through the official OpenAI Codex app-server | **Continue with ChatGPT** |
| Coding CLI | OpenCode, Claude Code, GitHub Copilot, Google Antigravity, Grok Build, Mistral Vibe, Kiro | Connect the provider and complete its local authentication |
| API | OpenAI, Anthropic, Gemini, Qwen, DeepSeek, Kimi, Z.ai, Meta, OpenRouter | Provider API key |

Cuppet manages CLI installation where supported. Available models, settings, and connection requirements depend on the selected provider and its installed version. Model and effort choices are shown in the composer and in **Settings → Platform**.

API keys are saved using Electron's OS-backed credential encryption. Cuppet refuses plaintext key persistence when secure storage is unavailable. Codex and the coding CLIs retain ownership of their own authentication credentials.

The runtime also supports OpenAI-compatible API endpoints for custom headless configurations.

## Working in a chat

**Plan and Build.** Plan mode permits inspection while blocking mutating tools. Build mode enables implementation tools under the selected permission policy.

**Orchestrate.** The primary model can delegate independent work to up to three concurrent subagents. Each uses the configured secondary model and a separate provider session. Workers share the active project and permission policy, and their activity appears in the conversation. Stop cancels the workers with the main turn. Provider model availability and support for the Cuppet tool bridge depend on the connected provider and its installed version.

Antigravity subagents use an isolated provider profile linked to the existing Antigravity sign-in. They receive Cuppet's tools for the current turn; Antigravity's separately configured global MCP servers are not loaded in those workers.

**Queue and Steer.** In **Settings → General**, choose whether a message sent during a run waits for the next turn or adds guidance to the active turn. Queued messages remain visible and can be edited, cancelled, or added to the current turn.

**Commands.** Type `/` to discover the current command palette. It includes status, diagnostics, memory, background-memory controls, compaction, and undo, alongside structured actions for saving memory, steering, and changing modes.

**Approvals.** Cuppet displays the full command or requested resources before a protected action. Choose **Allow once** or **Reject**. **More options** contains **Always this exact request** and, when eligible, **Enable guarded auto**. An exact approval lasts for the current session and does not grant a wildcard permission.

The default permission mode is configurable in **Settings → General**:

| Mode | Behavior |
| --- | --- |
| Default | Ordinary project reads are automatic; protected operations require approval. |
| Auto | Approves web fetches and eligible actions scoped to the active project. |
| Full access | Allows broader automatic project actions while continuing to block deletion outside the project. |

On macOS and Linux, supported command execution uses the OS sandbox and fails closed if required isolation is unavailable. **Windows currently has no OS command sandbox:** commands run with your user permissions, and the approval panel makes this explicit. Inspect the active boundary in **Settings → Security & Sandbox**.

**Undo.** Cuppet can reverse supported file edits when the files still match its recorded changes. It refuses to overwrite later external edits. Arbitrary shell mutations can create an undo barrier, so undo is not a general rollback for terminal commands.

Chats waiting for an approval or answer show **Needs input** in the sidebar. When the window is unfocused, Cuppet also requests attention through supported OS notifications, badges, or taskbar flashing.

### Browser integration

In **Settings → General → Integrations**, choose **Connect Chrome** and connect the browserControl Chrome extension. Once connected, ask Cuppet to use the browser in plain language; mentioning `@browserControl` is optional. The local browserControl runtime and the extension must both be available.

### Remote access

Open **Remote** in the desktop app to start the host, complete account linking or configure a relay, and create a pairing invitation. Pair a trusted device for control or a viewer for read-only access. Paired devices can be revoked from the host.

The desktop remains the execution and permission authority. Remote devices do not receive provider API keys or endpoint credentials. The desktop host must remain running for remote access.

The self-hosted relay is a trusted transport and does not provide end-to-end encryption. Use TLS before exposing it outside localhost. See [Remote architecture and protocol](docs/phase-c2-remote-control.md) for relay setup and scope details.

## Run from source

Use **Node.js 22 or newer**, npm, and Git. Installing native dependencies such as `node-pty` may also require your platform's native build tools.

```bash
git clone https://github.com/Officially-aditya/Cuppet-desktop.git
cd Cuppet-desktop
npm ci
npm start
```

`npm start` builds the renderer and launches Electron. `npm run dev:renderer` starts the Vite renderer development server; native desktop features still require the Electron host.

A fresh checkout does not contain all runtime resources bundled with release builds. Stage the resources needed for the features you are developing:

- **TST code context and memory:** follow [managed TST setup](docs/f1-managed-tst-runtime.md). Developers can supply a compatible daemon through `CUPPET_TST_BIN`, or an external connection through both `CUPPET_TST_SOCKET` and `CUPPET_TST_TOKEN`.
- **Codex:** run `npm run e2:stage-codex` to stage the official app-server package. See the [staging script](scripts/stage-codex-app-server.mjs) for supported platforms and options.
- **Browser integration:** run `npm run browsercontrol:stage -- --source=<browserControl-checkout>` with a built browserControl checkout. See the [staging script](scripts/stage-browsercontrol-runtime.mjs).

On Linux, command sandboxing requires `bubblewrap`, and saving API keys requires an available secure credential backend. Native managed TST is not currently bundled for Windows.

### Checks and packaging

```bash
npm test
npm run renderer:verify
```

The renderer verification checks generated IPC files, renderer types, opted-in runtime types, and the production renderer build. The full test suite includes native sandbox checks; run it on a host that supports the platform's isolation mechanism.

After staging the required runtime resources, use `npm run pack:dir` for an unpacked application, `npm run release:mac` for the macOS arm64 package, or `npm run release:win` for the Windows x64 package. Packaging validates the staged resources before building. The [release guide](docs/release-security.md) describes validation gates and publishing.

## Command-line use

Run the CLI directly from a source checkout:

```bash
node src/cli/main.mjs --help
node src/cli/main.mjs sessions
node src/cli/main.mjs status
node src/cli/main.mjs doctor
node src/cli/main.mjs prompt "Continue this task" --session <session-id>
node src/cli/main.mjs prompt "Try another approach" --session <session-id> --fork
node src/cli/main.mjs undo --session <session-id>
```

Configure headless inference with `CUPPET_PROVIDER_ID`, `CUPPET_API_KEY`, `CUPPET_BASE_URL`, and `CUPPET_MODEL`. Optional settings include `CUPPET_EFFORT`, `CUPPET_BACKGROUND_MODEL`, and `CUPPET_BACKGROUND_EFFORT`.

The CLI stores data in `~/.cuppet-desktop` by default. Override it with `--data-dir` or `CUPPET_DATA_DIR`. A noninteractive command fails rather than waiting indefinitely for an approval or answer it cannot collect.

For a long-running Remote host or a self-hosted relay:

```bash
node src/cli/main.mjs remote-control
node src/cli/main.mjs relay --bind 127.0.0.1 --port 8787
```

## Technical documentation

The React renderer handles presentation. Electron owns native integrations and credential storage, while the independent Node runtime owns conversations, provider execution, permissions, questions, and undo. SQLite stores the durable conversation and tool audit; TST supplies code navigation and memory.

| Topic | Documentation |
| --- | --- |
| Provider ownership, capabilities, and transports | [Provider architecture](docs/provider-architecture-v2.md) |
| Code context, memory, and daemon lifecycle | [Managed TST runtime](docs/f1-managed-tst-runtime.md) |
| Tool permissions and protected operations | [Tools and permissions](docs/phase-c1-tools-permissions.md) |
| Session continuation, questions, and undo | [Session controls](docs/phase-e-session-control.md) |
| Remote pairing, scopes, and relay | [Remote control](docs/phase-c2-remote-control.md) |
| Streaming, IPC, database migrations, and runtime typing | [Architecture review fixes](docs/architecture-review-ar04-ar09.md) |
| Distribution, signing limitations, and publishing | [Release guide](docs/release-security.md) |

The [docs directory](docs/) contains the earlier migration records and acceptance notes. Those documents describe individual increments; current behavior is defined by the source and its tests.
