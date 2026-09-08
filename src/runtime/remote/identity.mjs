import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

const IDENTITY_VERSION = 3;
export function hostIdentityPath(remoteDir) { return join(remoteDir, 'host.json'); }

export async function ensureHostIdentity(remoteDir) {
  const path = hostIdentityPath(remoteDir);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed.hostId === 'string' && typeof parsed.publicKeyPem === 'string' && typeof parsed.privateKeyPem === 'string') {
      const identity = {
        hostId: parsed.hostId,
        deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : hostname(),
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
        relaySecret: typeof parsed.relaySecret === 'string' && parsed.relaySecret.length >= 32 ? parsed.relaySecret : randomBytes(32).toString('hex'),
        ...(typeof parsed.remoteTokenPublicKey === 'string' ? { remoteTokenPublicKey: parsed.remoteTokenPublicKey } : {}),
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      };
      if (parsed.relaySecret !== identity.relaySecret) await writeIdentity(path, identity);
      return identity;
    }
  } catch {}
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const identity = {
    hostId: `host_${randomBytes(8).toString('hex')}`,
    deviceName: hostname(),
    publicKeyPem: publicKey.export({ type:'spki', format:'pem' }).toString(),
    privateKeyPem: privateKey.export({ type:'pkcs8', format:'pem' }).toString(),
    relaySecret: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  await writeIdentity(path, identity);
  return identity;
}

export async function setRemoteTokenPublicKey(remoteDir, remoteTokenPublicKey) {
  if (!isEd25519PublicKey(remoteTokenPublicKey)) throw new Error('Cuppet backend returned an invalid remote-token public key.');
  const path = hostIdentityPath(remoteDir);
  const identity = await ensureHostIdentity(remoteDir);
  const updated = { ...identity, remoteTokenPublicKey };
  await writeIdentity(path, updated);
  return updated;
}

export async function loadHostIdentityOrNull(remoteDir) {
  try { return await ensureHostIdentity(remoteDir); } catch { return undefined; }
}

function isEd25519PublicKey(value) {
  try {
    const key = createPublicKey({ key:Buffer.from(value,'base64'), format:'der', type:'spki' });
    return key.asymmetricKeyType === 'ed25519';
  } catch { return false; }
}
async function writeIdentity(path, identity) {
  await mkdir(join(path, '..'), { recursive:true, mode:0o700 });
  await writeFile(path, `${JSON.stringify({ version:IDENTITY_VERSION, ...identity }, null, 2)}\n`, { encoding:'utf8', mode:0o600 });
  await chmod(path, 0o600);
}
