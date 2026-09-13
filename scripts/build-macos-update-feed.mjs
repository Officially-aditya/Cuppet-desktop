import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function buildMacUpdateFeed({ version, tag, zipPath, publishedAt = new Date().toISOString() }) {
  const normalizedVersion = String(version ?? '').trim();
  const normalizedTag = String(tag ?? '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) throw new Error('A valid package version is required.');
  if (normalizedTag !== `v${normalizedVersion}`) throw new Error(`Release tag must exactly match v${normalizedVersion}.`);
  const absoluteZip = resolve(zipPath);
  const bytes = await readFile(absoluteZip);
  const metadata = await stat(absoluteZip);
  const filename = absoluteZip.split(/[\\/]/).pop();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const url = `https://github.com/Officially-aditya/Cuppet-desktop/releases/download/${encodeURIComponent(normalizedTag)}/${encodeURIComponent(filename)}`;
  return {
    currentRelease: normalizedVersion,
    releases: [{
      version: normalizedVersion,
      updateTo: {
        version: normalizedVersion,
        name: `Cuppet ${normalizedVersion}`,
        notes: `Cuppet ${normalizedVersion}`,
        pub_date: publishedAt,
        url,
        sha256,
        size: metadata.size,
      },
    }],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '').trim();
  const tag = args.tag || process.env.RELEASE_TAG || '';
  const zipPath = args.zip || resolve(root, 'dist', `Cuppet-${version}-arm64.zip`);
  const output = resolve(args.output || resolve(root, 'dist', 'releases.json'));
  const feed = await buildMacUpdateFeed({ version, tag, zipPath });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(feed, null, 2)}\n`, { mode: 0o644 });
  console.log(`Wrote macOS update feed for ${feed.currentRelease} to ${output}`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--tag') result.tag = values[++index] ?? '';
    else if (value === '--zip') result.zip = values[++index] ?? '';
    else if (value === '--output') result.output = values[++index] ?? '';
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
