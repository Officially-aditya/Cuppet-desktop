import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon']);

export function createLinkPreviewLoader({ resolveHost = lookup, requestResource = readResource, now = Date.now } = {}) {
  const cache = new Map();
  async function fetchResource(value, headOnly) {
    let url = previewUrl(value);
    for (let redirects = 0; redirects <= 4; redirects++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const family = isIP(hostname);
      let timer;
      const addresses = family ? [{ address: hostname, family }] : await Promise.race([
        resolveHost(hostname, { all: true }),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Preview address lookup timed out.')), 5000); }),
      ]).finally(() => clearTimeout(timer));
      if (!addresses.length || addresses.some(({ address, family }) => blocked.check(address, family === 6 ? 'ipv6' : 'ipv4'))) {
        throw new Error('Link previews only fetch public web addresses.');
      }
      const response = await requestResource(url, { addresses, headOnly, maxBytes: headOnly ? 256 * 1024 : 1024 * 1024 });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location || redirects === 4) throw new Error('Too many preview redirects.');
        url = previewUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error('Preview page is unavailable.');
      return { ...response, url: url.href };
    }
  }
  async function imageData(value) {
    if (!value) return null;
    try {
      const response = await fetchResource(value, false);
      const type = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      return IMAGE_TYPES.has(type) ? `data:${type};base64,${response.body.toString('base64')}` : null;
    } catch { return null; }
  }
  return async (value) => {
    const url = previewUrl(value).href;
    const existing = cache.get(url);
    if (existing && existing.expires > now()) return existing.promise;
    const promise = (async () => {
      const page = await fetchResource(url, true);
      if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(String(page.headers['content-type'] || ''))) {
        throw new Error('This link does not contain a web preview.');
      }
      const metadata = parseLinkPreview(page.body.toString('utf8'), page.url);
      const [image, icon] = await Promise.all([imageData(metadata.image), imageData(metadata.icon)]);
      return { ...metadata, image, icon };
    })();
    cache.delete(url);
    cache.set(url, { expires: now() + 10 * 60_000, promise });
    while (cache.size > 32) cache.delete(cache.keys().next().value);
    promise.catch(() => { if (cache.get(url)?.promise === promise) cache.delete(url); });
    return promise;
  };
}

export function parseLinkPreview(html, value) {
  const url = previewUrl(value);
  const head = String(html).split(/<\/head\s*>/i, 1)[0];
  const tags = new Map();
  for (const tag of head.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = attributes(tag[0]);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !tags.has(key)) tags.set(key, attrs.content);
  }
  const title = tags.get('og:title') || tags.get('twitter:title') || head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const icon = [...head.matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map(tag => attributes(tag[0])).find(attrs => /(?:^|\s)icon(?:\s|$)/i.test(attrs.rel || ''))?.href;
  return {
    url: url.href,
    hostname: url.hostname,
    title: text(title || url.hostname, 180),
    description: text(tags.get('og:description') || tags.get('twitter:description') || tags.get('description') || '', 360),
    siteName: text(tags.get('og:site_name') || url.hostname, 80),
    image: imageUrl(tags.get('og:image:secure_url') || tags.get('og:image') || tags.get('twitter:image'), url),
    icon: imageUrl(icon || '/favicon.ico', url),
  };
}

function previewUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('A web link is required.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /(?:^|\.)(?:localhost|local)$/i.test(url.hostname)) {
    throw new Error('Only public HTTP and HTTPS links can have previews.');
  }
  url.hash = '';
  return url;
}
function imageUrl(value, base) {
  try { return value ? previewUrl(new URL(value, base).href).href : null; } catch { return null; }
}
function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    values[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return values;
}
function text(value, limit) { return decodeEntities(String(value)).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function decodeEntities(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity) => {
    const names = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    if (entity[0] !== '#') return names[entity.toLowerCase()] || match;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : match;
  });
}

function readResource(url, { addresses, headOnly, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const request = transport(url, {
      method: 'GET',
      headers: { accept: headOnly ? 'text/html,application/xhtml+xml' : 'image/*', 'accept-encoding': 'identity', 'user-agent': 'CuppetLinkPreview/1.0', connection: 'close' },
      lookup: (_hostname, options, callback) => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
    }, (response) => {
      const chunks = [];
      let size = 0;
      const complete = () => finish(null, { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) { complete(); response.destroy(); return; }
      response.on('data', (chunk) => {
        const remaining = maxBytes - size;
        if (chunk.length > remaining && !headOnly) { request.destroy(new Error('Preview image is too large.')); return; }
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
        if (headOnly && (size >= maxBytes || /<\/head\s*>/i.test(Buffer.concat(chunks).toString('utf8')))) {
          complete(); response.destroy();
        }
      });
      response.on('end', complete);
      response.on('error', error => finish(error));
    });
    const timer = setTimeout(() => request.destroy(new Error('Link preview timed out.')), 5000);
    request.on('error', error => finish(error));
    request.end();
  });
}
