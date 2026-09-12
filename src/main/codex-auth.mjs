import { ipcMain, shell } from 'electron';
import { CodexAppServerClient, resolveCodexAppServerCommand } from '../runtime/codex-app-server.mjs';
import { parseCodexAccount } from '../runtime/codex-account.mjs';
import { listCodexModels as listCodexModelsFromDriver } from '../runtime/providers/backends/codex.mjs';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
let activeLogin = null;
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
      const account = parseCodexAccount(await client.request('account/read', {}));
      return {
        available: true,
        loggedIn: account.loggedIn,
        loginRunning: Boolean(activeLogin),
        method: account.method,
        planType: account.planType,
        email: account.email,
        name: null,
        source: launch.source,
        message: account.loggedIn
          ? `Connected with ChatGPT${account.planType ? ` · ${account.planType}` : ''}. Codex owns and refreshes your subscription credentials.`
          : (lastMessage || (account.method === 'apiKey'
            ? 'Codex is currently authenticated with an API key. Sign in with ChatGPT to use the subscription provider.'
            : 'Not connected to ChatGPT.')),
      };
    });
  } catch (error) {
    return { ...unavailableStatus(), available: true, loginRunning: Boolean(activeLogin), message: cleanError(error) };
  }
}

// Compatibility export for callers that still ask the auth host for models.
// The provider driver is the single model-discovery implementation.
export function listCodexModels() {
  return listCodexModelsFromDriver({ resourcesPath: process.resourcesPath });
}

async function startCodexLogin() {
  const launch = await resolveCodexAppServerCommand({ resourcesPath: process.resourcesPath });
  if (!launch) throw new Error('Official Codex app-server is unavailable in this Cuppet build.');
  if (activeLogin) return { started: false, running: true, loginId: activeLogin.loginId };

  const client = new CodexAppServerClient(launch);
  await client.start();
  try {
    const result = record(await client.request('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    }));
    if (String(result.type ?? '').toLowerCase() !== 'chatgpt') throw new Error('Codex did not start a ChatGPT login flow.');
    const authUrl = safeUrl(result.authUrl);
    const loginId = safeText(result.loginId, 256);
    if (!authUrl || !loginId) throw new Error('Codex did not return a complete ChatGPT sign-in request.');

    const timeout = setTimeout(() => {
      if (activeLogin?.client !== client) return;
      lastMessage = 'ChatGPT sign-in expired. Start the connection again.';
      void closeActiveLogin(client);
    }, LOGIN_TIMEOUT_MS);
    activeLogin = { client, loginId, timeout };
    lastMessage = 'Complete the ChatGPT sign-in in your browser. Cuppet never receives the OAuth tokens.';
    const finish = (message) => {
      if (message?.method !== 'account/login/completed') return;
      const params = record(message.params);
      if (params.loginId && String(params.loginId) !== loginId) return;
      const success = params.success !== false && !params.error;
      lastMessage = success ? 'ChatGPT sign-in completed through Codex.' : safeText(params.error?.message ?? params.error, 1000) || 'ChatGPT sign-in did not complete.';
      void closeActiveLogin(client);
    };
    client.on('notification', finish);
    client.once('exit', () => {
      if (activeLogin?.client !== client) return;
      clearTimeout(activeLogin.timeout);
      activeLogin = null;
    });
    await shell.openExternal(authUrl);
    return { started: true, running: true, loginId };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function logoutCodex() {
  if (activeLogin) await closeActiveLogin(activeLogin.client);
  const launch = await resolveCodexAppServerCommand({ resourcesPath: process.resourcesPath });
  if (!launch) throw new Error('Official Codex app-server is unavailable in this Cuppet build.');
  await withClient(launch, async (client) => client.request('account/logout', {}));
  lastMessage = 'Signed out of ChatGPT in Codex.';
  return codexAuthStatus();
}

async function closeActiveLogin(client) {
  const active = activeLogin?.client === client ? activeLogin : null;
  if (active) {
    clearTimeout(active.timeout);
    activeLogin = null;
  }
  await client.close().catch(() => undefined);
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
    loginRunning: Boolean(activeLogin),
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
