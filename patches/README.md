# Patches

`git format-patch` output for the review work, kept here so it survives independent of any one branch.
Each applies cleanly to `main`:

    git am patches/0001-*.patch   # fix(permissions): never truncate a request before deciding on it
    git am patches/0002-*.patch   # feat(permissions): describe what a command does in plain language

They are also on their own branches: `fix/permission-resource-truncation`, `feat/permission-command-summary`.
