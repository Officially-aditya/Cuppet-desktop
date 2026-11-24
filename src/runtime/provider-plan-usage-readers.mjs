import { resolveCopilotAcpRuntime } from './copilot-acp-runtime.mjs';
import { localCliEnvironment } from './local-cli-environment.mjs';
import { CopilotPlanUsageClient } from './copilot-plan-usage.mjs';
import { emptyPlanUsage, normalizeCopilotPlanUsage, record } from './plan-usage-normalizers.mjs';

function environment(options) { return { ...(options.env ?? process.env), ...record(options.configuration?.cliEnv) }; }

export async function readCopilotPlanUsage(options = {}) {
  const base = emptyPlanUsage('github-copilot', 'signed-out', 'Connect GitHub Copilot in Settings → Account to view plan usage.');
  const env = localCliEnvironment(environment(options), { home: options.home });
  const launch = await (options.resolveCopilotRuntime ?? resolveCopilotAcpRuntime)(options.configuration ?? {}, { environment: env, allowUnverified: true });
  if (!launch) return { ...base, status: 'unavailable', message: 'GitHub Copilot is unavailable. Connect it in Settings → Account.' };
  let client;
  try {
    const args = ['--server', '--stdio', '--no-auto-update', '--disable-builtin-mcps',
      ...(launch.args ?? []).filter(arg => ['--no-remote', '--no-remote-export', '--sync-session=off'].includes(arg))];
    client = (options.createCopilotClient ?? (launch => new CopilotPlanUsageClient(launch)))({ ...launch, args, env });
    await client.start();
    const account = record(await client.request('auth.getStatus', {}, 10000));
    if (account.isAuthenticated !== true) return base;
    let response;
    try { response = await client.request('account.getQuota', {}, 10000); }
    catch (error) {
      if (error?.code === -32601) return { ...base, status: 'unavailable', message: 'Update GitHub Copilot to read plan usage, then reconnect it in Settings.' };
      throw error;
    }
    return normalizeCopilotPlanUsage(response);
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}
