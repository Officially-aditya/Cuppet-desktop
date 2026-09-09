# E1 — Production packaging/runtime foundation

E1 turns the source-only Electron application into a reproducible packaged-app candidate without changing the coding-agent architecture.

## Packaging authority

`package.json` owns the package contract through `electron-builder` 26.15.3.

- Product: `Cuppet`
- Application ID: `com.cuppet.desktop`
- Executable: `cuppet`
- ASAR: enabled
- Production application files: `src/**` and `package.json`
- Runtime production dependencies: none; Electron and electron-builder remain development/build dependencies.
- `npm run pack:dir` creates an unpacked platform application for acceptance testing. Signing, notarization, installers, and release publication remain E2.

The packaged Electron executable is also the runtime host. `RuntimeClient` starts the same executable with `ELECTRON_RUN_AS_NODE=1` and points it at `src/runtime/main.mjs` inside the application bundle. That preserves the independent runtime and avoids adding a second Node distribution.

## Production dependency audit

E1 treats the packaged dependency graph as part of the acceptance contract. The packaged-runtime CI job runs `npm run e1:audit-runtime`, which is `npm audit --omit=dev --audit-level=high`, before packaging.

During E1 this gate exposed high-severity transitive advisories under the former PE3 `@huggingface/transformers` dependency through `onnxruntime-node`/`adm-zip` and `sharp`, with no upstream fix available in the audited graph. The gate was not relaxed. Instead, PE3's optional ambiguity breaker was replaced with the built-in dependency-free `cuppet/subword-hash-v1` feature embedding.

That provider performs bounded deterministic word/subword hashing in JavaScript and requires no model download, native runtime, archive extraction, image codec, network access, or model cache. Deterministic task affinity and TST remain higher-authority routing signals, and PE3 still preserves the active task on low-confidence/failure paths.

As a result, Cuppet's packaged runtime currently has zero npm production dependencies. Dev/build dependencies are deliberately excluded from the production audit because they are not shipped as runtime application dependencies.

## Durable state and restart behavior

The Electron host keeps desktop state under `app.getPath('userData')`. Runtime state is under its `runtime/` child directory. `RuntimeClient` creates that directory before launch.

The E1 packaged smoke test launches the runtime through the packaged executable, creates a conversation, shuts the runtime down through stdin EOF, launches it again using the same data directory, and verifies that the conversation is present. This tests the packaged ASAR path rather than only `npm start`.

## Shutdown semantics

Runtime shutdown is cooperative first:

1. close stdin so the runtime receives EOF and runs its existing shutdown path;
2. allow a bounded grace period;
3. send `SIGTERM` if required;
4. use `SIGKILL` only as a final bounded fallback.

The runtime already closes Remote, RuntimeService, background workers, TST bridge, and SQLite handles from its shutdown path.

## Desktop security boundary

`src/main/bootstrap.mjs` runs before the ordinary Electron main module and establishes production defaults:

- one Cuppet desktop instance per user session;
- renderer-created windows are denied;
- only HTTPS targets can be handed to the operating system for external opening;
- renderer navigation away from its local file document is denied;
- browser permission requests/checks are denied by default.

The existing renderer already uses context isolation, sandboxing, disabled Node integration, and a restrictive Content Security Policy.

## Provider credential persistence

Provider configuration stays in the Electron main process. API keys are persisted only after Electron `safeStorage` reports usable OS-backed encryption.

On Linux, `safeStorage.isEncryptionAvailable()` is not sufficient: Electron can report encryption while using the `basic_text` backend, which Electron documents as unprotected. E1 therefore rejects `basic_text` and `unknown` backends for key persistence. Existing encrypted keys are not decrypted while a secure backend is unavailable.

Provider settings are written through a same-directory temporary file and rename so a partial write cannot leave the main settings file half-written. File mode remains `0600` where supported.

## TST packaging boundary

Cuppet desktop's current `TstBridge` speaks the `cuppet.tst.v3` JSON-line Unix-socket protocol and authenticates with a socket/token pair.

The current upstream `Officially-aditya/TST` v0.3 implementation exposes its Python/Rust control plane over its own HTTP/unix `/v1` API. It does not expose the `cuppet.tst.v3` handshake expected by Cuppet desktop. Packaging that project and calling it a working bundled daemon would therefore be incorrect.

E1 keeps the existing behavior instead:

- the desktop/runtime is fully functional without TST;
- an externally supplied compatible `CUPPET_TST_SOCKET` + `CUPPET_TST_TOKEN` daemon is still supported;
- no incompatible TST artifact is silently started;
- a future bundled daemon must implement the desktop bridge protocol or the bridge must intentionally migrate to the upstream control-plane API first.

This is an explicit compatibility boundary, not an omitted packaging step.

## Verification

`npm run e1:verify` permanently checks the source/package/security contract and runs E1 tests.

CI also has a separate packaged-app smoke job that performs a normal dependency install, runs the production dependency audit, builds the unpacked Linux application, and runs `npm run e1:package-smoke`. The normal phase-gate job retains `ELECTRON_SKIP_BINARY_DOWNLOAD=1` so source gates remain fast.

E2 is responsible for distribution mechanics: macOS signing/notarization, DMG/ZIP production, release workflow, and published artifacts.
