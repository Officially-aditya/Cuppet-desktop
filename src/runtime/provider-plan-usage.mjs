import { CodexAppServerClient, resolveCodexAppServerCommand } from './codex-app-server.mjs';
import { parseCodexAccount } from './codex-account.mjs';
import { redactCredentials } from './credential-sanitization.mjs';
import { readAntigravityPlanUsage, readClaudePlanUsage, readCopilotPlanUsage } from './provider-plan-usage-readers.mjs';

const REQUEST_TIMEOUT_MS = 10_000;

// Query the provider's account limits. Local token totals cannot measure a plan allowance.
export async function readProviderPlanUsage(providerID, options = {}) {
  const {
    resourcesPath = process.env.CUPPET_RESOURCES_PATH,
    env = process.env,
    resolveCommand = resolveCodexAppServerCommand,
    createClient = (launch) => new CodexAppServerClient(launch),
  } = options;
  const base = emptyUsage(text(providerID, 120));
  const reader = new Map([['claude-code', readClaudePlanUsage], ['antigravity', readAntigravityPlanUsage], ['github-copilot', readCopilotPlanUsage]]).get(base.providerID);
  if (typeof reader === 'function') {
    try { return await reader(options); }
    catch (error) {
      return { ...base, status: error?.usageStatus === 'signed-out' ? 'signed-out' : 'error',
        message: redactCredentials(error, { env, configuration: options.configuration }).slice(0, 1000) || 'Could not load plan usage. Try refreshing.' };
    }
  }
  if (base.providerID !== 'codex') return {
    ...base, status: 'unsupported',
    message: base.providerID
      ? 'Plan usage is not available for this platform in Cuppet yet. Check your provider’s usage page.'
      : 'Choose a platform to view its plan usage.',
  };

  let client;
  try {
    const launch = await resolveCommand({ resourcesPath, env });
    if (!launch) return { ...base, message: 'Codex is unavailable. Connect Codex in Settings → Account to view plan usage.' };
    client = createClient({ ...launch, env });
    await client.start();
    const account = parseCodexAccount(await client.request('account/read', {}, REQUEST_TIMEOUT_MS));
    if (!account.loggedIn) return {
      ...base, status: 'signed-out',
      message: account.method === 'apiKey'
        ? 'Sign in with ChatGPT in Settings → Account to view subscription usage. API keys do not provide a ChatGPT plan allowance.'
        : 'Sign in with ChatGPT in Settings → Account to view plan usage.',
    };
    const response = await client.request('account/rateLimits/read', {}, REQUEST_TIMEOUT_MS);
    return normalizeCodexPlanUsage(response, { planType: account.planType });
  } catch (error) {
    return { ...base, status: 'error', message: redactCredentials(error).slice(0, 1000) || 'Could not load plan usage. Try refreshing.' };
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}

// The app-server reports reset timestamps in seconds; the desktop uses milliseconds.
// https://developers.openai.com/codex/app-server#6-rate-limits-chatgpt
export function normalizeCodexPlanUsage(value, { planType = null, fetchedAt = Date.now() } = {}) {
  const root = record(value);
  const snapshots = new Map(Object.entries(record(root.rateLimitsByLimitId)).slice(0, 32));
  const legacy = record(root.rateLimits);
  const legacyID = text(legacy.limitId, 160) || 'codex';
  if (Object.keys(legacy).length && !snapshots.has(legacyID)) snapshots.set(legacyID, legacy);
  const seen = new Set();
  const limits = [];
  for (const [key, raw] of snapshots) {
    const item = record(raw);
    const id = text(item.limitId, 160) || text(key, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const windows = ['primary', 'secondary'].flatMap((kind) => {
      const window = normalizeWindow(item[kind], kind);
      return window ? [window] : [];
    });
    const rawCredits = record(item.credits);
    const balance = text(rawCredits.balance, 100);
    const credits = rawCredits.unlimited === true || balance
      ? { unlimited: rawCredits.unlimited === true, balance: balance || null }
      : null;
    if (!windows.length && !credits) continue;
    limits.push({
      id,
      label: text(item.limitName, 160) || (id === 'codex' ? 'Codex' : id),
      windows,
      credits,
    });
    planType ||= text(item.planType, 120) || null;
  }
  return {
    ...emptyUsage('codex'),
    status: limits.length ? 'available' : 'unavailable',
    planType: text(planType, 120) || null,
    limits,
    fetchedAt,
    message: limits.length ? '' : 'Codex did not report plan limits for this account. Try refreshing later.',
  };
}

function normalizeWindow(value, id) {
  const window = record(value);
  if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const minutes = typeof window.windowDurationMins === 'number' && Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0
    ? window.windowDurationMins : null;
  const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0 && window.resetsAt <= 8.64e12
    ? window.resetsAt * 1000 : null;
  let label = id === 'primary' ? 'Primary limit' : 'Secondary limit';
  if (minutes === 10_080) label = 'Weekly limit';
  else if (minutes === 1440) label = 'Daily limit';
  else if (minutes && minutes % 60 === 0) label = `${minutes / 60}-hour limit`;
  else if (minutes) label = `${minutes}-minute limit`;
  return { id, label, usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: minutes, resetsAt };
}

function emptyUsage(providerID) {
  return { providerID, status: 'unavailable', planType: null, limits: [], fetchedAt: null, message: '' };
}
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
