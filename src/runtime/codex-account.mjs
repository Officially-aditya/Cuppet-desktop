export function parseCodexAccount(value) {
  const root = record(value);
  const account = record(root.account);
  const type = normalizeType(account.type ?? root.type);
  return {
    type,
    loggedIn: type === 'chatgpt',
    method: type || null,
    planType: text(account.planType ?? account.plan_type ?? root.planType ?? root.plan_type, 120) || null,
    email: text(account.email ?? root.email, 320) || null,
  };
}

export function isCodexChatGptAccount(value) {
  return parseCodexAccount(value).loggedIn;
}

function normalizeType(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.toLowerCase() === 'chatgpt') return 'chatgpt';
  if (raw.toLowerCase() === 'apikey' || raw.toLowerCase() === 'api_key' || raw.toLowerCase() === 'api-key') return 'apiKey';
  return raw.slice(0, 80);
}
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
