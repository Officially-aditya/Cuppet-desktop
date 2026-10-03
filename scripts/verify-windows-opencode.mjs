import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test',
  'test/windows-local-cli.test.mjs', 'test/opencode-setup.test.mjs',
  'test/provider-version-policy.test.mjs', 'test/local-provider-version-check.test.mjs',
  'test/opencode-auth-status.test.mjs', 'test/opencode-provider.test.mjs',
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
process.stdout.write(output);
if (result.status !== 0) {
  const lines = output.split(/\r?\n/);
  const failures = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/not ok|failureType:|error:|SyntaxError|Error \[/.test(lines[i])) failures.push(lines.slice(Math.max(0, i - 2), i + 24).join('\n'));
  }
  const detail = (failures.join('\n') || output).slice(0, 25_000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  process.stdout.write(`\n::error title=Windows OpenCode setup failure::${detail}\n`);
  process.exit(result.status || 1);
}
