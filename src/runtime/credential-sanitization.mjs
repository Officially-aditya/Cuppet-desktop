const CREDENTIAL_KEYS = new Set([
  'apikey', 'apitoken', 'authorization', 'proxyauthorization', 'authtoken',
  'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken', 'clientsecret',
  'password', 'passwd', 'credential', 'credentials', 'token', 'secret',
  'cookie', 'setcookie', 'privatekey', 'signingkey', 'accesskey',
  'secretaccesskey', 'awsaccesskeyid', 'awssecretaccesskey',
]);
const FIELD = String.raw`(?:[\w.-]{0,64}(?:api[_. -]?key|api[_. -]?token|access[_. -]?token|refresh[_. -]?token|auth[_. -]?token|client[_. -]?secret|private[_. -]?key|signing[_. -]?key|access[_. -]?key|password|passwd|credentials?|cookie)|authorization|proxy[_.-]?authorization|id[_.-]?token|session[_.-]?token|token|secret|key)`;
const VALUE = String.raw`(?:(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;&}\]"']+)`;
const ASSIGNMENT = new RegExp(String.raw`\b(${FIELD})(["']?\s*(?:(?:provided|supplied)\s*)?[:=]\s*)(${VALUE})`, 'gi');

export function isCredentialKey(key) {
  const normalized = String(key).replace(/[-_.\s]/g, '').toLowerCase();
  return CREDENTIAL_KEYS.has(normalized) || /(?:apikey|apitoken|accesstoken|refreshtoken|authtoken|clientsecret|privatekey|secretaccesskey)$/.test(normalized);
}

export function redactCredentials(value, context = {}) {
  let text = value instanceof Error ? value.message : String(value ?? '');
  if (/^\s*[\[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), (key, item) => isCredentialKey(key) || key.toLowerCase() === 'key' ? '[redacted]' : item);
    } catch {}
  }
  const secrets = new Set();
  const seen = new WeakSet();
  const collect = (source) => {
    if (!source || typeof source !== 'object' || seen.has(source)) return;
    seen.add(source);
    for (const [key, item] of Object.entries(source)) {
      if (typeof item === 'string' && item && (isCredentialKey(key) || /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(key))) {
        secrets.add(item);
        if (/^(?:Bearer|Basic)\s+/i.test(item)) secrets.add(item.replace(/^(?:Bearer|Basic)\s+/i, ''));
      } else if (item && typeof item === 'object') collect(item);
    }
  };
  collect(context);
  collect(process.env);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret === '[redacted]') continue;
    const forms = new Set([secret, JSON.stringify(secret).slice(1, -1)]);
    try { forms.add(encodeURIComponent(secret)); } catch {}
    for (const form of forms) {
      if (form.length >= 8) text = text.split(form).join('[redacted]');
      else {
        const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'g'), '[redacted]');
      }
    }
  }
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
  text = text.replace(/([?&])([^=\s&#]+)=([^&\s#]*)/g, (match, prefix, key) => {
    let decoded;
    try { decoded = decodeURIComponent(key); } catch { return match; }
    return isCredentialKey(decoded) || /^(?:key|code|state|sig|signature|x-amz-signature|x-goog-signature)$/i.test(decoded)
      ? `${prefix}${key}=[redacted]` : match;
  });
  text = text.replace(ASSIGNMENT, (match, key, separator, item) => {
    if (!isCredentialKey(key) && key.toLowerCase() !== 'key') return match;
    if (item.startsWith('[redacted')) return match;
    const quote = item[0] === '"' || item[0] === "'" ? item[0] : '';
    return `${key}${separator}${quote}[redacted]${quote && item.endsWith(quote) ? quote : ''}`;
  });
  return text
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-(?:ant-api\d{2}-|proj-|or-v1-)?|gsk_|xai-|nvapi-|hf_|github_pat_|gh[pousr]_|AIza)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\bya29\.[A-Za-z0-9._~-]+/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@');
}

export function sanitizeProviderError(error, context = {}, seen = new WeakMap()) {
  if (error && typeof error === 'object' && seen.has(error)) return seen.get(error);
  const result = new Error(redactCredentials(error?.message ?? error, context));
  if (!error || typeof error !== 'object') return result;
  seen.set(error, result);
  result.name = redactCredentials(error.name || 'Error', context);
  for (const key of ['code', 'status', 'statusCode']) {
    if (typeof error[key] === 'string') result[key] = redactCredentials(error[key], context);
    else if (typeof error[key] === 'number') result[key] = error[key];
  }
  if (error.response?.status) result.response = { status: error.response.status };
  if (error.providerFailure) {
    const source = error.providerFailure;
    result.providerFailure = Object.freeze({
      category: redactCredentials(source.category, context), retryable: source.retryable === true,
      action: source.action ? redactCredentials(source.action, context) : null,
      providerID: source.providerID ? redactCredentials(source.providerID, context) : null,
      diagnostic: source.diagnostic ? redactCredentials(source.diagnostic, context) : null,
    });
  }
  if (error.cause) result.cause = sanitizeProviderError(error.cause, context, seen);
  if (typeof error.stack === 'string') result.stack = redactCredentials(error.stack, context);
  return result;
}
