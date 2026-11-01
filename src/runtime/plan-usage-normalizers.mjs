// Provider account figures only; local token totals are deliberately excluded.
export function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
export function text(value, max = 160) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
const bounded = value => Math.max(0, Math.min(100, value));

export function emptyPlanUsage(providerID, status = 'unavailable', message = '') {
  return { providerID, status, planType: null, limits: [], fetchedAt: null, message };
}
function report(providerID, limits, { planType = null, fetchedAt = Date.now() } = {}) {
  return { ...emptyPlanUsage(providerID), status: limits.length ? 'available' : 'unavailable',
    planType: text(planType, 120) || null, limits, fetchedAt,
    message: limits.length ? '' : 'Your provider did not report plan limits for this account. Try refreshing later.' };
}

// Accept provider ISO dates, never locale-dependent dates or numeric strings.
export function usageReset(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  const date = value.slice(0, 10);
  const calendar = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date || (value.length > 10 && Number(value.slice(11, 13)) > 23)) return null;
  const result = Date.parse(value.length === 10 ? value + 'T00:00:00Z' : value);
  return Number.isFinite(result) && result > 0 ? result : null;
}
function window(id, label, used, minutes, reset) {
  const usedPercent = bounded(used);
  return { id, label, usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: minutes, resetsAt: usageReset(reset) };
}

export function normalizeClaudePlanUsage(value, options = {}) {
  const source = record(value);
  const windows = [];
  for (const [id, raw] of Object.entries(source).slice(0, 64)) {
    if (id !== 'five_hour' && !/^seven_day(?:_[a-z0-9_]+)?$/.test(id)) continue;
    const item = record(raw);
    if (!finite(item.utilization)) continue;
    const weekly = id !== 'five_hour';
    const suffix = id === 'seven_day' || !weekly ? '' : ' · ' + id.slice(10).replaceAll('_', ' ');
    windows.push(window(id, weekly ? 'Weekly limit' + suffix : '5-hour limit', item.utilization, weekly ? 10080 : 300, item.resets_at));
  }
  return report('claude-code', windows.length ? [{ id: 'claude', label: 'Claude', windows, credits: null }] : [], options);
}

function quotaWindow(raw, fallbackID) {
  const bucket = record(raw);
  if (bucket.disabled === true || !finite(bucket.remainingFraction)) return null;
  const duration = text(bucket.window, 40);
  const hours = /^(\d+)h$/.exec(duration);
  const minutes = duration === 'weekly' ? 10080 : duration === 'daily' ? 1440 : hours && Number(hours[1]) > 0 && Number(hours[1]) <= 8760 ? Number(hours[1]) * 60 : null;
  const label = duration === 'weekly' ? 'Weekly limit' : duration === 'daily' ? 'Daily limit' : minutes ? hours[1] + '-hour limit' : 'Model allowance';
  return window(text(bucket.bucketId) || fallbackID, label, 100 - bucket.remainingFraction * 100, minutes, bucket.resetTime);
}

export function normalizeAntigravityPlanUsage(value, options = {}) {
  const source = record(value);
  const limits = [];
  const seen = new Set();
  const add = (id, label, windows) => {
    const unique = windows.filter(w => w && !seen.has(w.id) && seen.add(w.id));
    if (unique.length) limits.push({ id, label, windows: unique, credits: null });
  };
  if (Array.isArray(source.groups)) {
    for (const [index, raw] of source.groups.slice(0, 64).entries()) {
      const group = record(raw);
      add('group-' + index, text(group.displayName) || 'Model group',
        (Array.isArray(group.buckets) ? group.buckets.slice(0, 32) : []).map((bucket, i) => quotaWindow(bucket, 'group-' + index + '-' + i)));
    }
  }
  // Old summary responses report flat buckets; do not duplicate the modern groups.
  if (!limits.length && Array.isArray(source.buckets)) {
    for (const [index, raw] of source.buckets.slice(0, 64).entries()) {
      const bucket = record(raw);
      const id = text(bucket.bucketId) || 'bucket-' + index;
      add(id, text(bucket.displayName) || 'Model allowance', [quotaWindow(bucket, id)]);
    }
  }
  // Older backends expose per-model quotas through fetchAvailableModels.
  if (!limits.length) {
    for (const [id, raw] of Object.entries(record(source.models)).slice(0, 64)) {
      const model = record(raw), quota = record(model.quotaInfo);
      add(text(id), text(model.displayName) || text(id), [quotaWindow(quota, text(id))]);
    }
  }
  return report('antigravity', limits, options);
}

export function normalizeCopilotPlanUsage(value, options = {}) {
  const labels = { premium_interactions: 'Premium interactions', chat: 'Chat', completions: 'Completions', ai_credits: 'AI credits' };
  const limits = [];
  for (const [key, raw] of Object.entries(record(record(value).quotaSnapshots)).slice(0, 64)) {
    const item = record(raw);
    const id = text(key), label = Object.hasOwn(labels, id) ? labels[id] : id.replaceAll('_', ' ');
    const entitlement = finite(item.entitlementRequests) && (item.entitlementRequests === -1 || item.entitlementRequests >= 0) ? item.entitlementRequests : null;
    const used = finite(item.usedRequests) && item.usedRequests >= 0 ? item.usedRequests : null;
    const unlimited = item.isUnlimitedEntitlement === true || entitlement === -1;
    const detail = unlimited ? 'Unlimited allowance' + (used === null ? '' : ' · ' + used + ' used this period')
      : used !== null && entitlement !== null ? used + ' of ' + entitlement + ' used this period' : null;
    const remaining = finite(item.remainingPercentage) ? bounded(item.remainingPercentage)
      : used !== null && entitlement > 0 ? bounded(100 - used / entitlement * 100) : null;
    const windows = !unlimited && entitlement !== 0 && remaining !== null
      ? [window('monthly', 'Monthly allowance', 100 - remaining, null, item.resetDate)] : [];
    if (id && (windows.length || detail)) limits.push({ id, label, windows, credits: null, detail });
  }
  return report('github-copilot', limits, options);
}
