import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { DEFAULT_DEVICE_SCOPES, VIEWER_DEVICE_SCOPES } from './protocol.mjs';

const INVITE_TTL_MS = 2 * 60_000;
const DEVICE_ID = /^[A-Za-z0-9_-]+$/;
const PAIR_CODE = /^[A-Za-z0-9_-]+$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function relayWebSocketUrl(relayUrl) {
  const url = new URL(relayUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!['ws:','wss:'].includes(url.protocol)) throw new Error('relay URL must use http(s) or ws(s)');
  url.pathname = '/ws'; url.search = ''; url.hash = '';
  return url.toString();
}

export async function createPairingInvite(remoteDir, { role='trusted', ttlMs=INVITE_TTL_MS, relayUrl, hostId } = {}) {
  if (!['trusted','viewer'].includes(role)) throw new Error('invalid pairing role');
  const invite = { code:randomBytes(6).toString('base64url').toUpperCase(), createdAt:Date.now(), expiresAt:Date.now()+ttlMs, role };
  await mkdir(join(remoteDir,'pending'), { recursive:true, mode:0o700 });
  await sweepExpiredInvites(remoteDir);
  await writeFile(join(remoteDir,'pending',`${invite.code}.json`), JSON.stringify(invite), { encoding:'utf8', mode:0o600 });
  let url;
  if (relayUrl) {
    const page = new URL(relayUrl);
    if (page.protocol === 'wss:') page.protocol = 'https:';
    else if (page.protocol === 'ws:') page.protocol = 'http:';
    if (!['http:','https:'].includes(page.protocol)) throw new Error('relay URL must use http(s) or ws(s)');
    page.pathname='/app'; page.search=''; page.hash='';
    page.searchParams.set('code', invite.code);
    if (hostId) page.searchParams.set('host', String(hostId).slice(0,128));
    url=page.toString();
  }
  return { ...invite, url };
}

export async function claimPairingInvite(remoteDir, code, deviceName) {
  const normalized=String(code ?? '').trim().toUpperCase();
  if (!PAIR_CODE.test(normalized)) return undefined;
  const invitePath=join(remoteDir,'pending',`${normalized}.json`);
  const claimedPath=`${invitePath}.${randomBytes(6).toString('hex')}.claiming`;
  try { await rename(invitePath, claimedPath); } catch { return undefined; }
  try {
    const invite=await readInvite(claimedPath);
    if (!invite || invite.code !== normalized || invite.expiresAt < Date.now()) return undefined;
    const deviceId=`dev_${randomBytes(8).toString('hex')}`;
    const secret=randomBytes(32).toString('base64url');
    const device={ deviceId, name:String(deviceName ?? '').slice(0,64)||'unnamed device', secretHash:sha256(secret), scopes:invite.role==='viewer' ? [...VIEWER_DEVICE_SCOPES] : [...DEFAULT_DEVICE_SCOPES], createdAt:Date.now() };
    await mkdir(join(remoteDir,'devices'), { recursive:true, mode:0o700 });
    await writeFile(join(remoteDir,'devices',`${deviceId}.json`), JSON.stringify(device), { encoding:'utf8', mode:0o600 });
    return { deviceId, secret, scopes:device.scopes, name:device.name };
  } finally { await rm(claimedPath,{force:true}).catch(()=>undefined); }
}

export async function authenticateDevice(remoteDir, deviceId, secret) {
  if (!DEVICE_ID.test(String(deviceId ?? ''))) return undefined;
  try {
    const parsed=JSON.parse(await readFile(join(remoteDir,'devices',`${deviceId}.json`),'utf8'));
    const provided=Buffer.from(sha256(String(secret ?? ''))); const stored=Buffer.from(String(parsed.secretHash ?? ''));
    if (!stored.length || provided.length!==stored.length || !timingSafeEqual(provided,stored)) return undefined;
    const scopes=Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope)=>typeof scope==='string') : [];
    return { scopes, name:typeof parsed.name==='string' ? parsed.name : 'device' };
  } catch { return undefined; }
}

export async function listPairedDevices(remoteDir) {
  try {
    const files=await readdir(join(remoteDir,'devices'));
    const devices=await Promise.all(files.filter((file)=>file.endsWith('.json')).map(async(file)=>{
      try { const parsed=JSON.parse(await readFile(join(remoteDir,'devices',file),'utf8')); return { deviceId:parsed.deviceId, name:parsed.name, scopes:Array.isArray(parsed.scopes)?parsed.scopes:[], createdAt:parsed.createdAt }; } catch { return undefined; }
    }));
    return devices.filter(Boolean);
  } catch { return []; }
}

export async function revokeDevice(remoteDir, deviceId) {
  if (!DEVICE_ID.test(String(deviceId ?? ''))) return false;
  try { await rm(join(remoteDir,'devices',`${deviceId}.json`)); return true; } catch { return false; }
}

async function sweepExpiredInvites(remoteDir) {
  try {
    for (const file of (await readdir(join(remoteDir,'pending'))).filter((item)=>item.endsWith('.json'))) {
      const path=join(remoteDir,'pending',file);
      const parsed=await readInvite(path);
      if (!parsed || parsed.expiresAt < Date.now()) await rm(path,{force:true});
    }
  } catch {}
}
async function readInvite(path) {
  try { const parsed=JSON.parse(await readFile(path,'utf8')); return typeof parsed.code==='string' && typeof parsed.expiresAt==='number' ? parsed : undefined; } catch { return undefined; }
}
