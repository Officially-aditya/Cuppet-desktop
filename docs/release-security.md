# Production Release Security

Cuppet currently distributes unsigned releases because Developer ID signing and Apple notarization credentials are not available. The macOS release workflow produces arm64 DMG and ZIP artifacts; the Windows release workflow produces unsigned x64 NSIS and ZIP artifacts.

## Release prerequisites

The exact macOS release commit must already have successful completed runs for both `CI` and `Provider V2 Selected`. The release tag must exactly equal `v` + `package.json` version.

No Apple signing or notarization secrets are required. GitHub Actions supplies `GITHUB_TOKEN`; the macOS workflow requests `actions: read` to check prior validation and `contents: write` to publish release assets.

## Unsigned macOS packaging

Production packaging uses `build/electron-builder.release.json` with `forceCodeSigning: false`, `mac.identity: null`, `hardenedRuntime: false`, and `notarize: false`. The workflow also disables signing identity discovery with `CSC_IDENTITY_AUTO_DISCOVERY: false`.

The workflow checks that the packaged app, DMG, and ZIP exist, generates SHA-256 checksums, and publishes the artifacts and checksums to GitHub Releases. It does not require a Developer ID signature, Gatekeeper assessment, or a notarization staple. Downloaded apps do not carry Apple trust verification.

## Updates

Automatic macOS updates are disabled for unsigned releases, including stable versions. The release workflow does not generate or publish Squirrel update metadata or advance the production update feed. Download and install new versions manually from GitHub Releases.

## Cutting a release

Push the release commit to `release/v<package-version>` with an updated `.github/release-trigger` to run CI, Provider V2 Selected, and both platform builds. Both builds require successful validation of that commit before publishing assets. Alternatively, push a `v<package-version>` tag or use **Production Release → Run workflow** and provide the exact tag. The workflow still rejects mismatched tags, missing successful validation runs, invalid staged runtime resources, and missing packaged artifacts. Versions containing a prerelease suffix are published as GitHub prereleases.
