import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/runtime/remote/protocol.mjs',
  'src/runtime/remote/identity.mjs',
  'src/runtime/remote/pairing.mjs',
  'src/runtime/remote/token.mjs',
  'src/runtime/remote/setup.mjs',
  'src/runtime/remote/connection.mjs',
  'src/runtime/remote/bridge.mjs',
  'src/runtime/remote/commands.mjs',
  'src/runtime/remote/manager.mjs',
  'src/runtime/remote/relay.mjs',
  'src/runtime/main.mjs',
  'src/main/main.mjs',
  'src/preload/preload.cjs',
  'src/renderer/remote.js',
  'src/renderer/index.html',
  'src/cli/main.mjs',
  'src/remote-app/index.html',
  'src/remote-app/app.js',
  'migration/phase-c2-contract.json',
  'docs/phase-c2-remote-control.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const protocol = text['src/runtime/remote/protocol.mjs'];
expect(protocol.includes('PROTOCOL_VERSION = 1') && protocol.includes('MAX_FRAME_BYTES = 512 * 1024'), 'remote protocol version/frame cap changed');
for (const scope of ['session.read', 'session.write', 'permission.write', 'question.write', 'model.write']) expect(protocol.includes(scope), `remote scope missing: ${scope}`);
expect(/['"]session\.submit['"]\s*:\s*['"]session\.write['"]/.test(protocol) && /['"]permission\.reply['"]\s*:\s*['"]permission\.write['"]/.test(protocol), 'remote command scope table incomplete');
expect(protocol.includes('unsupported command type'), 'unknown remote commands do not fail closed');

const pairing = text['src/runtime/remote/pairing.mjs'];
expect(pairing.includes('INVITE_TTL_MS = 2 * 60_000'), 'pairing TTL changed');
expect(pairing.includes('rename(') && pairing.includes('.claiming'), 'single-use atomic pairing claim missing');
expect(pairing.includes('timingSafeEqual') && pairing.includes('VIEWER_DEVICE_SCOPES'), 'pairing credential/scope boundary incomplete');

const token = text['src/runtime/remote/token.mjs'];
expect(token.includes("header.alg !== 'EdDSA'") && token.includes("payload.iss !== 'cuppet-backend'") && token.includes("payload.aud !== 'cuppet-relay'"), 'managed token signature/issuer/audience checks missing');
expect(token.includes('payload.host !== expectedHostId') && token.includes('payload.device !== expectedDeviceId') && token.includes('payload.exp <= now'), 'managed token host/device/expiry binding missing');

const setup = text['src/runtime/remote/setup.mjs'];
expect(setup.includes('pollSecret') && setup.includes('relaySecret') && setup.includes('/claim'), 'managed setup secret/claim flow missing');
expect(!/setupUrl[^\n]*pollSecret/.test(setup) && !/setupUrl[^\n]*relaySecret/.test(setup), 'setup URL appears to include a private setup/relay secret');

const bridge = text['src/runtime/remote/bridge.mjs'];
expect(bridge.includes('seenCommandIds') && bridge.includes('connectionId') && bridge.includes('client.accept') && bridge.includes('client.reject'), 'bridge replay/auth authority missing');
expect(bridge.includes('missing scope') && bridge.includes('duplicate: true'), 'bridge scope or replay-safe command behavior missing');

const commands = text['src/runtime/remote/commands.mjs'];
expect(commands.includes("this.#call('session.send'") && commands.includes("this.#call('permission.reply'") && commands.includes("this.#call('session.stop'"), 'remote adapter bypasses independent runtime methods');
expect(commands.includes('Host provider is not configured') && commands.includes('model is not configured on this host'), 'remote provider/model boundary missing');
expect(commands.includes("#providerList(){return [{id:'openai-compatible',name:'OpenAI-compatible',connected:"), 'remote provider projection changed');
expect(!commands.includes("baseUrl:this.#provider.baseUrl"), 'remote provider projection exposes local endpoint details');
expect(commands.includes('Undo is unavailable until the independent runtime has an authoritative mutation journal.'), 'reviewed undo compatibility gap missing');
expect(commands.includes('Interactive question requests are not implemented by the independent runtime.'), 'reviewed question compatibility gap missing');

const manager = text['src/runtime/remote/manager.mjs'];
expect(manager.includes("'https://connect.cuppet.in'") && manager.includes('verifyRemoteToken') && manager.includes('authenticateDevice'), 'remote manager setup/auth path incomplete');
expect(manager.includes('WebSocketTransport') && manager.includes('buildAttachSnapshot'), 'remote outbound transport/snapshot bridge missing');
expect(manager.includes('Provider configuration is pushed at ordinary desktop startup') && manager.includes('if(this.#bridge) await this.stop()'), 'unused remote configuration/shutdown may create persistent state');

const relay = text['src/runtime/remote/relay.mjs'];
expect(relay.includes('REPLAY_LIMIT') && relay.includes('RATE_LIMIT') && relay.includes('PAIR_ATTEMPT_LIMIT'), 'relay replay/rate/pairing limits missing');
expect(relay.includes('client.accept') && relay.includes('device.authenticated') && relay.includes('room.replay.length=0'), 'relay pre-auth/host replacement isolation missing');

const runtimeMain = text['src/runtime/main.mjs'];
for (const method of ['remote.status', 'remote.provider-config', 'remote.start', 'remote.stop', 'remote.invite', 'remote.devices', 'remote.revoke']) expect(runtimeMain.includes(`case '${method}'`), `local remote runtime method missing: ${method}`);

const main = text['src/main/main.mjs'];
const preload = text['src/preload/preload.cjs'];
const renderer = text['src/renderer/remote.js'];
expect(main.includes('cuppet:remote:start') && main.includes('settings.runtimeValue()'), 'Electron main remote/provider-local bridge missing');
expect(preload.includes('remote:') && preload.includes('invite:') && preload.includes('revoke:'), 'preload remote lifecycle bridge missing');
expect(renderer.includes('Managed app link') && renderer.includes('Viewer') && renderer.includes('Revoke'), 'desktop Remote UI incomplete');
expect(text['src/renderer/index.html'].includes('remote.js'), 'desktop Remote UI is not loaded');

const cli = text['src/cli/main.mjs'];
for (const command of ['remote-control', 'relay', 'remote-enroll']) expect(cli.includes(command), `independent CLI entrypoint missing: ${command}`);
expect(cli.includes('https://connect.cuppet.in'), 'managed API default changed');

expect(text['src/remote-app/index.html'].includes('Cuppet Remote') && text['src/remote-app/app.js'].includes('permission.reply'), 'relay browser client missing independent remote controls');
expect(!Object.entries(text).some(([path, value]) => path.startsWith('src/') && /@opencode|opencode-ai|OpenCode-derived controller/i.test(value)), 'OpenCode leaked into C2 production source');

const contract = JSON.parse(text['migration/phase-c2-contract.json']);
expect(contract.phase === 'C2' && contract.protocol?.version === 1 && contract.security?.providerKeysCrossRelay === false && contract.security?.providerEndpointCrossRelay === false && contract.security?.providerConfigCreatesRemoteState === false && contract.security?.unusedShutdownCreatesRemoteState === false, 'C2 machine contract invalid');

const tests = [
  'test/c2-remote-protocol.test.mjs',
  'test/c2-remote-bridge.test.mjs',
  'test/c2-relay.integration.test.mjs',
  'test/c2-remote-commands.test.mjs',
  'test/c2-remote-lifecycle.test.mjs',
];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Phase C2 gate passed: independent remote protocol, pairing/token/setup, scoped bridge, relay integration, runtime command routing, lifecycle cleanliness, provider projection privacy, desktop/CLI controls, and provider-secret boundary verified.');
