import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const SMOKE_FLAG = 'CUPPET_INTERNAL_GUI_CLI_SMOKE';
const SMOKE_RESULT = 'CUPPET_INTERNAL_GUI_CLI_SMOKE_RESULT';

/**
 * Internal macOS acceptance hook used by the LaunchServices smoke test.
 *
 * It deliberately asks the runtime child to resolve/probe OpenCode. This proves
 * the PATH recovered in bootstrap is inherited by the runtime control plane,
 * which is the boundary that Finder/Dock launches previously broke.
 */
export async function maybeRunGuiCliSmoke({ runtime, environment = process.env } = {}) {
  if (environment?.[SMOKE_FLAG] !== '1') return false;
  const resultPath = smokeResultPath(environment?.[SMOKE_RESULT]);
  if (!resultPath) throw new Error(`${SMOKE_RESULT} must be an absolute result path for the internal GUI smoke.`);

  let payload;
  try {
    const status = await runtime.request('provider.local.status', { providerID: 'opencode' }, 15_000);
    payload = {
      ok: status?.installed === true && status?.connected === true,
      providerID: status?.providerID ?? 'opencode',
      installed: status?.installed === true,
      connected: status?.connected === true,
      executable: status?.installation?.executable ?? null,
      version: status?.version ?? null,
      control: status?.control ?? null,
      path: String(environment.PATH ?? ''),
    };
  } catch (error) {
    payload = {
      ok: false,
      providerID: 'opencode',
      error: cleanError(error),
      path: String(environment.PATH ?? ''),
    };
  }

  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function smokeResultPath(value) {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path || path.length > 2048 || path.includes('\0') || !isAbsolute(path)) return '';
  return path;
}

function cleanError(error) {
  return String(error instanceof Error ? error.message : error ?? 'GUI CLI smoke failed')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .slice(0, 1000);
}
