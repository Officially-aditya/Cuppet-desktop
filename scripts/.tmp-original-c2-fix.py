from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))

# Resolve provider requests lazily so provider-free slash commands remain provider-free.
p = Path('src/runtime/commands.mjs')
s = p.read_text()
for old in [
    "provider: context.providerRequest ?? {}",
    "provider: context.providerRequest ?? {}",
    "provider: context.providerRequest ?? {}",
]:
    if old not in s:
        raise SystemExit('provider request site missing')
    s = s.replace(old, "provider: await resolveProviderRequest(context.providerRequest)", 1)
marker = "function requiredFunction(value, label) { if (typeof value !== 'function') throw new Error(`${label} is unavailable on this surface`); return value; }\n"
helper = "async function resolveProviderRequest(value) { return typeof value === 'function' ? await value() : (value ?? {}); }\n"
if helper not in s:
    if marker not in s:
        raise SystemExit('requiredFunction marker missing')
    s = s.replace(marker, helper + marker, 1)
p.write_text(s)

replace_once(
    'src/runtime/remote/commands.mjs',
    "        providerRequest:this.#selectedProvider(state),",
    "        providerRequest:()=>this.#selectedProvider(state),",
    'remote lazy provider request',
)

replace_once(
    'test/e-session-control.test.mjs',
    "  assert.equal(status.version, '0.8.0-alpha.1');",
    "  assert.equal(status.version, '0.9.0-alpha.1');",
    'phase E release version assertion',
)

p = Path('test/original-c2-remote.test.mjs')
s = p.read_text()
old = """    providerConfig: {
      providerID: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-a',
      backgroundModel: 'model-b',
      apiKey: 'secret',
      models: [
        { providerID: 'openai-compatible', modelID: 'model-a', roles: ['primary'], variants: ['low', 'medium', 'high'] },
        { providerID: 'openai-compatible', modelID: 'model-b', roles: ['secondary'], variants: [] },
      ],
    },
"""
new = """    providerConfig: {
      baseUrl: 'https://api.example.test/v1',
      model: 'model-a',
      backgroundModel: 'model-b',
      apiKey: 'secret',
    },
"""
if s.count(old) != 1:
    raise SystemExit(f'original C2 remote provider fixture: expected one match, found {s.count(old)}')
s = s.replace(old, new, 1)
append = r'''

test('remote provider-free status slash stays provider-free', async () => {
  const calls = [];
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case 'health': return { ok: true, activeRuns: 0 };
      case 'project.list': return [];
      case 'session.list': return [];
      case 'permission.list': return [];
      case 'cognitive.status': return { orchestratorEnabled: false, backgroundPaused: false, tst: { configured: false, connected: false }, roles: {} };
      default: throw new Error(`unexpected runtime call: ${method}`);
    }
  };
  const adapter = new RemoteCommandAdapter({ call, identity: { hostId: 'host_1', deviceName: 'Laptop' }, providerConfig: {} });
  const actor = { deviceID: 'viewer', scopes: ['session.read'] };
  const result = await adapter.execute(actor, 'session.submit', { prompt: '/status' }, { sessionId: 's1' });
  assert.equal(result.command, true);
  assert.equal(result.id, 'status');
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);
});
'''
if "remote provider-free status slash stays provider-free" not in s:
    s += append
p.write_text(s)
