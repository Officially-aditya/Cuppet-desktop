from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

path = Path('src/main/cli-agent-status.mjs')
s = path.read_text()
s = replace_once(
    s,
    "antigravity: 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --skip-path --skip-aliases',",
    "antigravity: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',",
    'antigravity installer command',
)
path.write_text(s)

path = Path('test/cli-agent-linking.test.mjs')
s = path.read_text()
needle = """test('provider-owned login flows need no copied Terminal command', () => {\n"""
addition = """test('Antigravity uses the canonical installer without stale installer flags', () => {\n  const spec = installSpec('antigravity', 'darwin');\n  assert.equal(spec.command, '/bin/bash');\n  assert.equal(spec.args[0], '-lc');\n  assert.equal(spec.args[1], 'curl -fsSL https://antigravity.google/cli/install.sh | bash');\n  assert.ok(!spec.args[1].includes('--skip-path'));\n  assert.ok(!spec.args[1].includes('--skip-aliases'));\n});\n\n"""
if addition not in s:
    if needle not in s:
        raise SystemExit('test insertion point missing')
    s = s.replace(needle, addition + needle, 1)
path.write_text(s)
