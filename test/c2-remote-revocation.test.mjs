import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteBridge } from '../src/runtime/remote/bridge.mjs';
import { authenticateDevice, claimPairingInvite, createPairingInvite, revokeDevice } from '../src/runtime/remote/pairing.mjs';

class FakeTransport {
  connected = false;
  sent = [];
  messages = new Set();
  statuses = new Set();
  start() {}
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.connected = false; }
  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener); }
  onStatusChange(listener) { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  connect() { this.connected = true; for (const listener of this.statuses) listener(true); }
  receive(value) { const data = JSON.stringify(value); for (const listener of this.messages) listener(data); }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const command = (id, type, deviceId) => ({ version: 1, id, type, ts: Date.now(), payload: {}, deviceId });

test('deleting a real paired credential invalidates the already-authenticated bridge session on its next command', async () => {
  const remoteDir = await mkdtemp(join(tmpdir(), 'cuppet-live-revoke-'));
  const transport = new FakeTransport();
  let calls = 0;
  try {
    const invite = await createPairingInvite(remoteDir, { role: 'trusted', hostId: 'host_real' });
    const credential = await claimPairingInvite(remoteDir, invite.code, 'phone');
    assert.ok(credential?.deviceId && credential?.secret);

    const bridge = new RemoteBridge({
      hostId: 'host_real',
      transport,
      commandAdapter: { detachDevice() {}, async execute() { calls += 1; return []; } },
      authenticateDevice: async (deviceId, secret) => {
        const reauthorize = () => authenticateDevice(remoteDir, deviceId, secret);
        const authenticated = await reauthorize();
        return authenticated ? { ...authenticated, reauthorize } : undefined;
      },
    });

    bridge.start();
    transport.connect();
    await settle();
    transport.receive({ version: 1, type: 'device.hello', deviceId: credential.deviceId, ts: Date.now(), payload: { secret: credential.secret } });
    await settle();
    assert.equal(bridge.activeDevices.length, 1);

    transport.receive(command('before', 'session.list', credential.deviceId));
    await settle();
    assert.equal(calls, 1);

    assert.equal(await revokeDevice(remoteDir, credential.deviceId), true);
    transport.receive(command('after', 'session.list', credential.deviceId));
    await settle();
    assert.equal(calls, 1, 'revoked credential must not reach command execution');
    assert.deepEqual(bridge.activeDevices, []);
    assert.ok(transport.sent.some((frame) => frame.type === 'client.reject' && frame.deviceId === credential.deviceId));
    assert.match(String(transport.sent.find((frame) => frame.replyTo === 'after')?.error), /authorization is no longer valid/i);
    bridge.stop();
  } finally {
    await rm(remoteDir, { recursive: true, force: true });
  }
});
