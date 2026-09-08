# Phase B clone containment note

A repository clone may create and clean up only a direct descendant of the user-selected destination folder.

Phase B enforces this twice:

1. repository owner/name segments reject `.` and `..` and path separators;
2. the resolved checkout target must pass an explicit descendant check against the canonical destination parent before clone or cleanup.

On clone failure, cleanup is skipped unless the same descendant check still passes. Existing destination contents are never removed.
