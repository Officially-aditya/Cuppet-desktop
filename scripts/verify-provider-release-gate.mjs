const branch = text(process.env.GITHUB_REF_NAME);
const eventName = text(process.env.GITHUB_EVENT_NAME);
const commit = text(process.env.GITHUB_SHA);
const attestedCommit = text(process.env.CUPPET_AUTHENTICATED_OPENCODE_COMMIT);
const attestedPass = text(process.env.CUPPET_AUTHENTICATED_OPENCODE_PASSED).toLowerCase() === 'true';

if (branch !== 'feat/provider-architecture-v2') {
  console.log(`[release-gate] branch=${branch || '(unknown)'} does not require the Provider V2 authenticated OpenCode gate.`);
  process.exit(0);
}

if (eventName !== 'workflow_dispatch') {
  fail('Provider V2 Apple Silicon builds must be started manually after the authenticated OpenCode smoke passes. Push-triggered release builds are blocked.');
}
if (!attestedPass) {
  fail('Confirm the authenticated OpenCode smoke passed before building an Apple Silicon candidate. Run `node scripts/smoke-authenticated-opencode-acp.mjs` on the authenticated Mac first.');
}
if (!commit || attestedCommit !== commit) {
  fail(`Authenticated OpenCode smoke must attest the exact build commit. Expected ${commit || '(missing GITHUB_SHA)'}, received ${attestedCommit || '(empty)'}.`);
}

console.log(`[release-gate] PASS: authenticated OpenCode smoke attested for ${commit}.`);

function fail(message) {
  console.error(`[release-gate] FAIL: ${message}`);
  process.exit(1);
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
