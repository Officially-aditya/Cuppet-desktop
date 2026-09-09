import { ipcMain, shell } from 'electron';
import { CodexAppServerClient, resolveCodexAppServerCommand } from '../runtime/codex-app-server.mjs';

let loginInFlight = false;
let lastMessage = '';

export function installCodexAuthIpc() {
  ipcMain.handle('cuppet:codex-auth:status', () => codexAuthStatus());
  ipcMain.handle('cuppet:codex-auth:login', () => startCodexLogin());
  ipcMain.handle('cuppet:codex-auth:logout', () => logoutCodex());
}

async function codexAuthStatus() {
  const launch = await resolveCodexAppServerCommand({ resourcesPath: process.resourcesPath });
  if (!launch) return unavailableStatus();
  try {
    return await withClient(launch, async (client) => {
      const result = record(await client.request('account/read', {}));
      const account = record(result.account);
      const authMode = String(account.authMode ?? result.authMode ?? '').toLowerCase();
      const planType = String(account.planType ?? result.planType ?? '').toLowerCase();
      const email = safeText(account.email ?? result.email, 320);
      const name = safeText(account.name ?? account.displayName ?? result.name ?? result.displayName, 160);
      const loggedIn = authMode === 'chatgpt';
      return {
        available: true,
        loggedIn,
        loginRunning: loginInFlight,
        method: authMode || null,
        planType: planType || null,
        email: email || null,
        name: name || null,
        source: launch.source,
        message: loggedIn
          ? `Connected with ChatGPT${planType ? ` · ${planType}` : ''}. Codex owns and refreshes your subscription credentials.`
          : (lastMessage || 'Not connected to ChatGPT.'),
      };
    });
  } catch (error) {
    return { ...unavailableStatus(), available: true, message: cleanError(error) };
  }
}

async function startCodexLogin() {
  const launch = await resolveCodexAppServerCommand({ resourcesPath: process.resourcesPath });
  if (!launch) throw new Error('Official Codex app-server is unavailable in this Cuppet build.');
  if (loginInFlight) return { started: false, running: true };
  loginInFlight = true;
  try {
    const result = await withClient(launch, async (client) => client.request('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    }));
    const authUrl = safeUrl(record(result).authUrl);
    const loginId = safeText(record(result).loginId, 256);
    if (!authUrl) throw new Error('Codex did not return a ChatGPT sign-in URL.');
    lastMessage = 'Complete the ChatGPT sign-in in your browser. Cuppet never receives the OAuth tokens.';
    await shell.openExternal(authUrl);
    return { started: true, running: false, loginId: loginId || null };
  } finally {
    loginInFlight = false;
  }
}

async function logoutCodex() {
  const launch = await resolveCodexAppServerCommand({ resourcesPath: process.resourcesPath });
  if (!launch) throw new Error('Official Codex app-server is unavailable in this Cuppet build.');
  await withClient(launch, async (client) => client.request('account/logout', {}));
  lastMessage = 'Signed out of ChatGPT in Codex.';
  return codexAuthStatus();
}

async function withClient(launch, fn) {
  const client = new CodexAppServerClient(launch);
  try { await client.start(); return await fn(client); }
  finally { await client.close().catch(() => undefined); }
}

function unavailableStatus() {
  return {
    available: false,
    loggedIn: false,
    loginRunning: loginInFlight,
    method: null,
    planType: null,
    email: null,
    name: null,
    message: 'Official Codex app-server was not found. Reinstall this Cuppet build or set CUPPET_CODEX_APP_SERVER_BIN for development.',
  };
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function safeText(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function safeUrl(value) {
  try { const url = new URL(String(value ?? '')); return url.protocol === 'https:' ? url.toString() : ''; }
  catch { return ''; }
}
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 2000); }
