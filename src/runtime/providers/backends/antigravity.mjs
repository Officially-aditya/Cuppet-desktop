import { spawn } from 'node:child_process';
import { AntigravityHeadlessProvider } from '../../antigravity-provider.mjs';
import { localCliDescriptor } from '../../local-cli-descriptors.mjs';

const CLI_TIMEOUT_MS = 10_000;

export function antigravityBackendDefinition() {
  const descriptor = localCliDescriptor('antigravity');
  return {
    id: descriptor.id,
    label: descriptor.label,
    transport: descriptor.transport,
    operations: {
      discoverCapabilities: async ({ configuration = {}, options = {} } = {}) => {
        const discover = typeof options.cliDiscover === 'function' ? options.cliDiscover : discoverAntigravityModels;
        const catalog = await discover(descriptor, {
          commandOverride: text(configuration.cliCommand),
          runImpl: typeof options.runImpl === 'function' ? options.runImpl : undefined,
        });
        return {
          providerID: descriptor.id,
          source: 'cli',
          available: catalog.available !== false && Array.isArray(catalog.models) && catalog.models.length > 0,
          models: Array.isArray(catalog.models) ? catalog.models : [],
          settings: [],
          defaultModel: text(catalog.defaultModel) || null,
          currentModel: null,
          modelDependentSettings: false,
        };
      },
    },
    createRuntime: ({ configuration = {} } = {}) => new AntigravityHeadlessProvider(configuration),
  };
}

export async function discoverAntigravityModels(descriptor = localCliDescriptor('antigravity'), { commandOverride = '', runImpl = runCommand } = {}) {
  const command = text(commandOverride) || text(process.env[descriptor.envOverride]) || descriptor.command;
  const { stdout } = await runImpl(command, ['models'], CLI_TIMEOUT_MS);
  const models = parseAntigravityModelOutput(stdout);
  return { available: models.length > 0, models, defaultModel: null };
}

export function parseAntigravityModelOutput(output = '') {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;

    let id = '';
    let label = '';
    const tab = line.indexOf('\t');
    if (tab > 0) {
      id = text(line.slice(0, tab));
      label = text(line.slice(tab + 1)) || id;
    } else {
      const columns = line.match(/^([^\s]+)\s{2,}(.+)$/);
      if (columns) {
        id = text(columns[1]);
        label = text(columns[2]) || id;
      } else if (/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*$/.test(line)) {
        id = text(line);
        label = id;
      } else {
        continue;
      }
    }

    if (!id || seen.has(id) || /^(model|models|slug)$/i.test(id)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*$/.test(id)) continue;
    seen.add(id);
    models.push({ id, label });
    if (models.length >= 512) break;
  }
  return models;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env } });
    } catch (error) {
      rejectRun(error);
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(rejectRun, new Error(`${command} timed out while advertising models.`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-512_000); });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-64_000); });
    child.once('error', (error) => finish(rejectRun, error));
    child.once('exit', (code) => {
      if (code === 0) finish(resolveRun, { stdout, stderr });
      else finish(rejectRun, new Error((stderr || stdout || `${command} exited with code ${code}`).trim().slice(-1200)));
    });
  });
}

function stripAnsi(value) { return String(value ?? '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, ''); }
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 1000) : ''; }
