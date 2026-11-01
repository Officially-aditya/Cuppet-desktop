import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runProviderCommand } from './providers/cli-command.mjs';
import { resolveCopilotAcpRuntime } from './copilot-acp-runtime.mjs';
import { localCliEnvironment } from './local-cli-environment.mjs';
import { CopilotPlanUsageClient } from './copilot-plan-usage.mjs';
import { requestUsageJSON, usageError } from './plan-usage-http.mjs';
import { emptyPlanUsage, finite, normalizeAntigravityPlanUsage, normalizeClaudePlanUsage, normalizeCopilotPlanUsage, record, text, usageReset } from './plan-usage-normalizers.mjs';

function environment(options) { return { ...(options.env ?? process.env), ...record(options.configuration?.cliEnv) }; }
function providerHome(env, options) { return options.home || env.HOME || env.USERPROFILE || homedir(); }
function expandHome(path, home) { return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path; }

async function readCredentialFile(path, options, provider) {
  let contents;
  try { contents = await (options.readFileImpl ?? readFile)(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw usageError('Could not read ' + provider + ' sign-in. Reconnect it in Settings → Account.');
  }
  try {
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('oversized');
    return record(JSON.parse(contents));
  } catch { throw usageError(provider + ' sign-in data could not be read. Reconnect it in Settings → Account.'); }
}

export async function readClaudeCredentials(options = {}) {
  const env = environment(options), home = providerHome(env, options);
  if (text(env.CLAUDE_CODE_OAUTH_TOKEN, 20000)) return { accessToken: env.CLAUDE_CODE_OAUTH_TOKEN };
  const configDir = expandHome(text(env.CLAUDE_CONFIG_DIR, 4096) || join(home, '.claude'), home).normalize('NFC');
  if ((options.platform ?? process.platform) === 'darwin') {
    // Match Claude's profile-scoped keychain service; never fall back to a different account.
    const suffix = env.CLAUDE_CONFIG_DIR ? '-' + createHash('sha256').update(configDir).digest('hex').slice(0, 8) : '';
    const service = 'Claude Code-credentials' + suffix;
    let account = env.USER;
    if (!account) { try { account = userInfo().username; } catch {} }
    try {
      const result = await (options.runCommand ?? runProviderCommand)('/usr/bin/security',
        ['find-generic-password', ...(account ? ['-a', account] : []), '-w', '-s', service], 4000, { env, stdin: 'ignore' });
      const credentials = record(JSON.parse(result.stdout));
      if (record(credentials.claudeAiOauth).accessToken) return record(credentials.claudeAiOauth);
    } catch { /* Claude also supports a file-backed credential store. */ }
  }
  const credentials = await readCredentialFile(join(configDir, '.credentials.json'), options, 'Claude Code');
  return credentials ? record(credentials.claudeAiOauth) : null;
}

export async function readAntigravityCredentials(options = {}) {
  const env = environment(options), home = providerHome(env, options);
  const geminiHome = expandHome(text(env.GEMINI_HOME, 4096) || join(home, '.gemini'), home);
  // Cuppet's Antigravity adapter uses AGY_ACP_FORCE_FILE_STORAGE=1.
  return readCredentialFile(join(geminiHome, 'antigravity-acp', 'acp_token.json'), options, 'Antigravity');
}

export async function readClaudePlanUsage(options = {}) {
  const base = emptyPlanUsage('claude-code', 'signed-out', 'Connect Claude Code in Settings → Account to view plan usage.');
  const credentials = record(await (options.readClaudeCredentials ?? readClaudeCredentials)(options));
  const token = text(credentials.accessToken, 20000);
  if (!token) return base;
  if (finite(credentials.expiresAt) && credentials.expiresAt <= Date.now()) return {
    ...base, message: 'Claude Code sign-in has expired. Open Claude Code to refresh your login, then refresh plan usage.',
  };
  if (Array.isArray(credentials.scopes) && !credentials.scopes.includes('user:profile')) return {
    ...base, message: 'This Claude Code login does not grant plan usage access. Sign in with your Claude subscription in Settings → Account.',
  };
  const response = await requestUsageJSON('https://api.anthropic.com/api/oauth/usage', {
    fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, provider: 'Claude Code',
    headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
  });
  return normalizeClaudePlanUsage(response, { planType: credentials.subscriptionType });
}

async function antigravityAccessToken(credentials, options) {
  const token = text(credentials.token, 20000);
  const expiry = usageReset(credentials.expiry);
  if (token && expiry && expiry > Date.now() + 60000) return token;
  const refresh = text(credentials.refresh_token, 20000), clientID = text(credentials.client_id, 4096), secret = text(credentials.client_secret, 4096);
  if (!refresh || !clientID || !secret) return null;
  // Fixed token endpoint: never send refresh credentials to a stored token_uri.
  let response;
  try {
    response = await requestUsageJSON('https://oauth2.googleapis.com/token', {
      fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, provider: 'Antigravity',
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientID, client_secret: secret }).toString(),
    });
  } catch (error) {
    if (error.httpStatus === 400) throw usageError('Antigravity sign-in has expired. Reconnect it in Settings → Account.', 'signed-out');
    throw error;
  }
  return text(record(response).access_token, 20000) || null;
}

export async function readAntigravityPlanUsage(options = {}) {
  const base = emptyPlanUsage('antigravity', 'signed-out', 'Connect Google Antigravity in Settings → Account to view plan usage.');
  const credentials = record(await (options.readAntigravityCredentials ?? readAntigravityCredentials)(options));
  if (!Object.keys(credentials).length) return base;
  const token = await antigravityAccessToken(credentials, options);
  if (!token) return base;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'Cuppet/0.9.0 Antigravity' };
  const request = (url, body) => requestUsageJSON(url, {
    fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, provider: 'Antigravity', method: 'POST', headers, body: JSON.stringify(body),
  });
  // loadCodeAssist is read-only. Account onboarding remains owned by Antigravity.
  const account = record(await request('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }));
  const project = text(account.cloudaicompanionProject, 512) || text(credentials.project_id, 512);
  if (!project) return { ...base, status: 'unavailable', message: 'Finish connecting your Antigravity account in Settings → Account, then refresh plan usage.' };
  const paidTier = record(account.paidTier), tier = Object.keys(paidTier).length ? paidTier : record(account.currentTier);
  const planType = text(tier.name, 120) || text(tier.id, 120) || null;
  const endpoint = paidTier.usesGcpTos === true ? 'https://cloudcode-pa.googleapis.com' : 'https://daily-cloudcode-pa.googleapis.com';
  let response;
  try { response = await request(endpoint + '/v1internal:retrieveUserQuotaSummary', { project }); }
  catch (error) { if (![404, 405, 501].includes(error.httpStatus)) throw error; }
  const normalized = normalizeAntigravityPlanUsage(response, { planType });
  if (normalized.status === 'available') return normalized;
  return normalizeAntigravityPlanUsage(await request(endpoint + '/v1internal:fetchAvailableModels', { project }), { planType });
}

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
