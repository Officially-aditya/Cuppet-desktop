import { createPublicKey, verify as verifySignature } from 'node:crypto';

const BACKEND_SCOPE_MAP = Object.freeze({
  'sessions:read':'session.read',
  'sessions:write':'session.write',
  'permissions:reply':'permission.write',
  'questions:reply':'question.write',
  'models:write':'model.write',
});
const MAX_TOKEN_BYTES = 16 * 1024;

export function verifyRemoteToken(token, publicKey, expectedHostId, expectedDeviceId, now = Math.floor(Date.now()/1000)) {
  if (typeof token !== 'string' || Buffer.byteLength(token,'utf8') > MAX_TOKEN_BYTES || typeof publicKey !== 'string') return undefined;
  const parts=token.split('.');
  if (parts.length!==3 || parts.some((part)=>!part)) return undefined;
  const [encodedHeader, encodedPayload, encodedSignature]=parts;
  try {
    const header=JSON.parse(Buffer.from(encodedHeader,'base64url').toString('utf8'));
    if (header.alg!=='EdDSA' || header.typ!=='JWT') return undefined;
    const key=createPublicKey({ key:Buffer.from(publicKey,'base64'), format:'der', type:'spki' });
    if (key.asymmetricKeyType!=='ed25519') return undefined;
    if (!verifySignature(null,Buffer.from(`${encodedHeader}.${encodedPayload}`),key,Buffer.from(encodedSignature,'base64url'))) return undefined;
    const payload=JSON.parse(Buffer.from(encodedPayload,'base64url').toString('utf8'));
    if (payload.iss!=='cuppet-backend' || payload.aud!=='cuppet-relay' || typeof payload.sub!=='string' || !payload.sub || payload.host!==expectedHostId || payload.device!==expectedDeviceId) return undefined;
    if (typeof payload.exp!=='number' || !Number.isFinite(payload.exp) || payload.exp<=now) return undefined;
    if (typeof payload.iat==='number' && payload.iat>now+60) return undefined;
    const scopes=Array.isArray(payload.scopes) ? payload.scopes.map((scope)=>typeof scope==='string'?BACKEND_SCOPE_MAP[scope]:undefined).filter(Boolean) : [];
    const unique=[...new Set(scopes)];
    return unique.length ? { scopes:unique, expiresAt:payload.exp } : undefined;
  } catch { return undefined; }
}
