# Cuppet Desktop

Independent desktop/runtime migration for Cuppet.

## Current increment

**Increment 0 — source baseline and preservation inventory: complete.**

The migration baseline is pinned to `Officially-aditya/Cuppet-code@840ed751b61c04afc881a393b7836d4d2c932f61`. No Electron shell or replacement agent loop is intentionally scaffolded in this increment; Increment 0 exists to prevent later phases from silently dropping Cuppet behavior while removing the OpenCode runtime dependency.

- Human audit: [`docs/phase-0-behavior-inventory.md`](docs/phase-0-behavior-inventory.md)
- Machine-readable baseline: [`migration/cuppet-source-baseline.json`](migration/cuppet-source-baseline.json)
- Gate check: `npm run phase0:verify`

## Migration rule

A later phase may replace an OpenCode mechanism, but it may not silently replace Cuppet policy. Context compilation, lossless plans, PE3, evidence-gated memory, model roles, permissions, session controls, and remote compatibility are treated as product behavior with explicit migration dispositions.

## Next increment

**A — Electron shell + independent runtime process + SQLite conversations + one real provider + streaming + Stop.** The acceptance gate is a real conversation that survives restart with OpenCode absent.
