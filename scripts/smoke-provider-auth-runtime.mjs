import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPackageWithOptions } from '@electron/asar';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const workspace = await mkdtemp(join(tmpdir(), 'cuppet-auth-package-'));
try {
  const source = join(workspace, 'source');
  for (const relative of [
    'src/runtime/providers/provider-auth-flow.mjs', 'src/runtime/providers/cli-command.mjs',
    'src/runtime/local-cli-launch.mjs', 'src/runtime/local-cli-environment.mjs', 'src/runtime/credential-sanitization.mjs',
  ]) {
    await mkdir(dirname(join(source, relative)), { recursive: true });
    await cp(join(root, relative), join(source, relative));
  }
  await cp(join(root, 'node_modules/node-pty'), join(source, 'node_modules/node-pty'), { recursive: true });
  const archive = join(workspace, 'app.asar');
  await createPackageWithOptions(source, archive, { unpackDir: 'node_modules/node-pty' });
  const script = `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const { ProviderAuthFlow } = await import(pathToFileURL(process.env.CUPPET_AUTH_SMOKE_MODULE));
    let flow;
    flow = new ProviderAuthFlow({emit: event => {
      if (event.kind === 'output' && event.data.includes('Paste sign-in code')) flow.respond(event.authId, {data:'123456\\r'});
    }});
    assert.equal(flow.terminalAvailable(), true, 'Packaged authentication requires a real PTY');
    const timeout = setTimeout(() => flow.close(), 15000);
    try {
      await flow.connect('claude-code', () => flow.runTerminal('claude-code', process.env.CUPPET_AUTH_SMOKE_NODE, [process.env.CUPPET_AUTH_SMOKE_FIXTURE, '--login'], {env:process.env}));
      assert.equal(existsSync(process.env.TEST_SETUP_AUTH_FILE), true);
      console.log('Packaged Electron authentication PTY smoke passed.');
    } finally { clearTimeout(timeout); flow.close(); }
  `;
  const result = await promisify(execFile)(require('electron'), ['--input-type=module', '--eval', script], {
    timeout: 25000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
      CUPPET_AUTH_SMOKE_MODULE: join(archive, 'src/runtime/providers/provider-auth-flow.mjs'),
      CUPPET_AUTH_SMOKE_NODE: process.execPath,
      CUPPET_AUTH_SMOKE_FIXTURE: join(root, 'test/fixtures/fake-provider-setup.mjs'),
      TEST_SETUP_AUTH_FILE: join(workspace, 'authenticated'),
    },
  });
  assert.match(result.stdout, /smoke passed/);
  console.log(result.stdout.trim());
} finally { await rm(workspace, { recursive: true, force: true }); }
