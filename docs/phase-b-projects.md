# Phase B — Projects and GitHub import

Phase B adds explicit local projects to the independent Cuppet runtime. It follows Increment A and intentionally precedes B1 context/cognitive-runtime migration.

## Project authority

SQLite owns project registration metadata and chat-to-project binding. The checkout on disk remains filesystem truth and is never deleted when a project registration is removed.

Each project stores a stable ID, display name, canonical local path, optional `owner/repository` identity, remote URL, and last-opened timestamps. Runtime status refresh adds the current Git branch, dirty state, and missing-folder state without persisting those observations as permanent truth.

A selected folder inside a Git checkout resolves to the checkout root. Canonical checkout paths are unique registrations; separate local checkouts of the same remote may be separate projects.

## Add project paths

1. **Local folder** — Electron's main process opens a native directory picker. The runtime detects the Git root and origin when present; a non-Git folder is valid.
2. **GitHub URL** — only normal HTTPS/SSH `github.com` repository URLs are accepted. Credential-bearing URLs are rejected. `git clone` is executed without a shell and with interactive credential prompting disabled. Existing Git credential helpers and SSH configuration remain authoritative.
3. **GitHub repositories** — Phase B uses an already-authenticated GitHub CLI (`gh`) session to list authorized repositories and clone the selected one. This adds no second OAuth application and keeps tokens out of renderer state, command arguments, transcripts, and SQLite.

The implementation plan prefers Sydney's existing GitHub App connection for the eventual account-backed picker. That repository/API surface was not accessible to this implementation environment, so the picker boundary is isolated and the host's existing `gh` authentication is the explicit Phase B adapter. Public URL cloning and manual folders do not require account login. A later Sydney adapter can replace repository discovery without changing project/chat storage semantics.

## Failure and credential behavior

Clone targets must not already exist. If Cuppet starts a clone and Git/GitHub authentication or transport fails, the partial target created by that clone is removed. Existing destination contents are never removed. Error text redacts credential-shaped values.

Missing Git, missing `gh`, unauthenticated `gh`, ordinary Git authentication failures, and invalid repository URLs are distinct actionable errors. Cuppet does not place access tokens into clone URLs or spawn a shell.

## Chat and run binding

A chat stores `project_id` in SQLite. Existing Increment A databases migrate in place by adding a nullable project binding; previous chats remain general chats.

`New chat` creates only a renderer draft. The session is persisted on the first message, with the project selected at draft creation. Opening another project later cannot retarget a running session: the runtime records the project's ID when the run starts and Stop/completion events retain that binding.

General chats have `project_id = NULL`. Removing a project registration uses `ON DELETE SET NULL`, preserving its chats as general history while leaving the checkout untouched. A missing checkout remains registered and can be relocated to a new canonical path without losing chat history.

## Phase B gate

`npm run phaseb:verify` checks the project schema, three import paths, credential-safe clone boundary, authenticated repository picker, renderer draft behavior, and no OpenCode production dependency. Contract tests cover:

- Phase A database upgrade without transcript loss;
- project chat isolation and project removal preserving messages;
- Git root canonicalization and duplicate detection;
- HTTPS/SSH URL validation and credential rejection;
- failed-clone cleanup and secret redaction;
- authenticated repository listing via existing `gh` auth;
- run binding remaining on project A while project B is opened.

B1 may start after this gate and the existing Phase 0/A gates pass.
