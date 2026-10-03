# Command execution on Mac/Linux

Cuppet runs foreground commands, validation checks and background processes in the native OS sandbox. Commands can write to the active project and its dedicated cache/temp directories under `~/.cache/cuppet-execution/<project-hash>`. npm, pnpm, Yarn, Electron, electron-builder, pip, uv, Cargo, Go and Gradle receive explicit cache locations. Those directories persist across commands for the same canonical project path. Symlinked cache directories are rejected.

Git staging and commits use the same sandbox, including hooks and subprocesses. Unix Full Access removes ordinary permission prompts but retains workspace write limits and credential protection. macOS requires Seatbelt; Linux requires `/usr/bin/bwrap` (the distribution's bubblewrap package) and enabled user namespaces. Missing isolation produces an error instead of running the command on the host. Windows retains its existing unrestricted execution behavior; these helpers are not exposed there.

## Authenticated push

Use `git_push` with a configured remote name, destination branch and full current HEAD hash. Approval is bound to the canonical project, resolved remote URL, branch and commit. Auto and Full Access still require this approval. An exact approval can be remembered for that operation; another commit, branch or URL requires another approval. Plan mode blocks push.

The sandbox exports a Git bundle. The broker verifies its advertised HEAD, imports it into a private bare repository outside the project, and pushes only the approved commit/ref. Repository hooks, repository credential helpers, global URL rewrites, redirects, force pushes and recursive submodule pushes are disabled. Credentials remain in the broker's host process. HTTPS uses a standard user-configured Git credential helper: osxkeychain, libsecret, manager, manager-core, cache or store. Custom shell helpers are rejected. SSH uses the agent or default keys in batch mode, with SSH configuration overrides disabled; use a real hostname rather than an SSH alias.

## DMG creation

On macOS, use `package_dmg` with a project `.app` directory and project `.dmg` output path. Approval is specific to those paths. The helper copies the app in the sandbox into private staging, rejects absolute/escaping symlinks, creates and verifies its own compressed image using fixed `hdiutil` arguments, then copies the image back through the sandbox. It never accepts arbitrary mount/detach commands or touches other images. Staging is removed on completion or failure. Package output establishes an undo barrier because it has no byte-exact preimage.

Build the `.app` in the sandbox first (for example, with electron-builder's directory target), then invoke the helper for the image. Scripts that create their own mounts must use this helper or an isolated builder instead of gaining unrestricted host execution.
