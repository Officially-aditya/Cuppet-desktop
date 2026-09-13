# Production Release Security

Cuppet's normal CI/package smoke remains unsigned. Only `.github/workflows/release.yml` is allowed to produce a distributable macOS release.

## Release prerequisites

The exact release commit must already have successful completed runs for both `CI` and `Provider V2 Selected`. The release tag must exactly equal `v` + `package.json` version.

Configure these repository secrets before running the production release workflow:

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate.
- `MAC_CSC_KEY_PASSWORD`: password used when exporting the `.p12`.
- `APPLE_API_KEY_P8_BASE64`: base64-encoded App Store Connect API key (`.p8`).
- `APPLE_API_KEY_ID`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect API issuer ID.

`GITHUB_TOKEN` is supplied by GitHub Actions and the workflow requests only `contents: write` so it can create/upload the release and update the dedicated `update-feed` branch.

## macOS trust chain

Production packaging uses `build/electron-builder.release.json`, not the unsigned smoke config. It requires:

- `forceCodeSigning: true`;
- Developer ID Application signing from `CSC_LINK`;
- Hardened Runtime;
- the checked-in production entitlements and inherited entitlements;
- Apple notarization through the App Store Connect API key;
- DMG and ZIP arm64 artifacts.

After packaging, CI independently runs `codesign --verify`, requires a `Developer ID Application` authority, runs Gatekeeper assessment with `spctl`, and validates the notarization staple with `xcrun stapler`.

## Updater trust chain

Stable packaged arm64 macOS builds use Electron's built-in Squirrel.Mac updater. No additional production npm dependency is introduced.

The feed is hosted at:

`https://raw.githubusercontent.com/Officially-aditya/Cuppet-desktop/update-feed/macos/arm64/releases.json`

The release workflow computes the ZIP's SHA-256 digest and exact byte size and writes both into the Squirrel `updateTo` record. Electron 44 verifies those values before unpacking, and Squirrel.Mac also requires the downloaded app to pass macOS code-signing verification.

Prerelease builds (`-alpha`, `-beta`, `-rc`, etc.) do not consume or advance the production feed. They may still be signed, notarized, and published as GitHub prereleases. This avoids relying on Squirrel.Mac's numeric version comparison for prerelease identifiers.

Downloaded stable updates are not allowed to force an unexpected restart. They install on the next normal app launch.

## Cutting a release

Either push a `v<package-version>` tag or use **Production Release → Run workflow** and provide the exact tag. The workflow fails closed if the tag/version, prior validation, Apple credentials, signing identity, notarization, packaged artifacts, or update metadata checks are invalid.
