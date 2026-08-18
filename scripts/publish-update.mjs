// Controleert en uploadt de gebouwde release naar de publieke GitHub Releases-pagina.
// Gebruik: npm run release        (bouwt eerst, uploadt daarna)
//          npm run verify:release (controleert artefacten, uploadt niets)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const repository = 'JustMLC4real/LLMelt';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const verifyOnly = process.argv.includes('--verify-only');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Publiceren geweigerd: package.json-versie "${version}" is geen stabiele semver (x.y.z).`);
  process.exit(1);
}
const files = [
  `release/LLMelt-Setup-${version}.exe`,
  `release/LLMelt-Setup-${version}.exe.blockmap`,
  'release/latest.yml',
];

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`Ontbreekt: ${file}. Draai eerst "npm run package".`);
    process.exit(1);
  }
}

const installer = files[0];
const signature = execFileSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  '(Get-AuthenticodeSignature -LiteralPath $env:AI_SUPERAPP_INSTALLER).Status',
], {
  encoding: 'utf8',
  env: { ...process.env, AI_SUPERAPP_INSTALLER: resolve(installer) },
}).trim();
if (signature === 'Valid') console.log('Authenticode: geldig ondertekend.');
else console.warn(`Authenticode: ${signature || 'onbekend'}; deze release wordt bewust unsigned toegestaan.`);

const manifest = readFileSync('release/latest.yml', 'utf8');
const manifestHash = manifest.match(/^sha512:\s*(\S+)/m)?.[1];
const manifestVersion = manifest.match(/^version:\s*(\S+)/m)?.[1];
const manifestPath = manifest.match(/^path:\s*(.+)$/m)?.[1]?.trim();
const manifestSize = Number(manifest.match(/^\s+size:\s*(\d+)/m)?.[1]);
const actualHash = createHash('sha512').update(readFileSync(installer)).digest('base64');
if (!manifestHash || manifestHash !== actualHash) {
  console.error('Publiceren geweigerd: SHA-512 in latest.yml komt niet overeen met de installer.');
  process.exit(1);
}
if (manifestVersion !== version || manifestPath !== installer.replace(/^release[\\/]/, '')) {
  console.error('Publiceren geweigerd: versie of installerpad in latest.yml komt niet overeen met package.json.');
  process.exit(1);
}
if (!Number.isFinite(manifestSize) || manifestSize !== statSync(installer).size) {
  console.error('Publiceren geweigerd: bestandsgrootte in latest.yml komt niet overeen met de installer.');
  process.exit(1);
}

if (verifyOnly) {
  console.log(`Artefactcontrole geslaagd voor v${version}; er is niets geüpload.`);
  process.exit(0);
}

const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty) {
  console.error('Publiceren geweigerd: commit eerst alle releasewijzigingen.');
  process.exit(1);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tag = `v${version}`;
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
if (branch !== 'main') {
  console.error(`Publiceren geweigerd: releases moeten direct vanaf main komen (huidige branch: ${branch || 'detached HEAD'}).`);
  process.exit(1);
}
const tagHead = execFileSync('git', ['rev-list', '-n', '1', tag], { encoding: 'utf8' }).trim();
if (head !== tagHead) {
  console.error(`Publiceren geweigerd: tag ${tag} wijst niet naar de huidige commit.`);
  process.exit(1);
}

execFileSync('gh', ['auth', 'status'], { stdio: 'inherit' });
const repositoryInfo = JSON.parse(execFileSync('gh', [
  'repo', 'view', repository, '--json', 'visibility,url',
], { encoding: 'utf8' }));
if (repositoryInfo.visibility !== 'PUBLIC') {
  console.error('Publiceren geweigerd: GitHub-auto-updates werken voor eindgebruikers alleen vanuit een publieke release-repository. Maak JustMLC4real/LLMelt eerst openbaar.');
  process.exit(1);
}

const remoteRefs = execFileSync('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const remoteCommit = remoteRefs.find((line) => line.endsWith(`refs/tags/${tag}^{}`))?.split(/\s+/)[0]
  || remoteRefs.find((line) => line.endsWith(`refs/tags/${tag}`))?.split(/\s+/)[0];
if (remoteCommit !== head) {
  console.error(`Publiceren geweigerd: push ${tag} eerst naar origin en laat die tag naar HEAD wijzen.`);
  process.exit(1);
}
const remoteMain = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' })
  .trim()
  .split(/\s+/)[0];
if (remoteMain !== head) {
  console.error('Publiceren geweigerd: push de releasecommit eerst rechtstreeks naar origin/main.');
  process.exit(1);
}

const releases = JSON.parse(execFileSync('gh', [
  'release', 'list', '--repo', repository, '--limit', '100',
  '--json', 'tagName,isDraft,isPrerelease,publishedAt',
], { encoding: 'utf8' }));
const publishedVersions = releases
  .filter((release) => !release.isDraft && !release.isPrerelease && /^v\d+\.\d+\.\d+$/.test(release.tagName))
  .map((release) => release.tagName.slice(1));
const newestVersion = publishedVersions.sort(compareVersions).at(-1);
if (newestVersion && compareVersions(version, newestVersion) <= 0) {
  console.error(`Publiceren geweigerd: op GitHub staat al ${newestVersion}; verhoog eerst package.json.`);
  process.exit(1);
}

console.log(`Uploaden ${tag} naar GitHub Releases...`);
execFileSync('gh', [
  'release', 'create', tag, ...files,
  '--repo', repository,
  '--verify-tag',
  '--title', `LLMelt ${tag}`,
  '--generate-notes',
  '--latest',
], { stdio: 'inherit' });

const published = JSON.parse(execFileSync('gh', [
  'release', 'view', tag, '--repo', repository,
  '--json', 'url,isDraft,isPrerelease,assets',
], { encoding: 'utf8' }));
if (published.isDraft || published.isPrerelease) {
  throw new Error('GitHub-verificatie mislukt: de release is niet als stabiele publieke release gepubliceerd.');
}
const assets = new Map(published.assets.map((asset) => [asset.name, asset]));
for (const file of files) {
  const name = file.replace(/^release[\\/]/, '');
  const asset = assets.get(name);
  const localSize = statSync(file).size;
  if (!asset || asset.size !== localSize) {
    throw new Error(`GitHub-verificatie mislukt: ${name} ontbreekt of heeft een afwijkende bestandsgrootte.`);
  }

  const localDigest = `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  if (asset.digest !== localDigest) {
    throw new Error(`GitHub-verificatie mislukt: de serverdigest van ${name} wijkt af van het lokale artefact.`);
  }

  const response = await fetchMetRetry(asset.url, { method: 'HEAD', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`GitHub-verificatie mislukt: ${name} is publiek niet bereikbaar (HTTP ${response.status}).`);
  }
  const remoteSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(remoteSize) && remoteSize > 0 && remoteSize !== localSize) {
    throw new Error(`GitHub-verificatie mislukt: ${name} heeft via de publieke download-URL een afwijkende bestandsgrootte.`);
  }
}

const remoteManifestAsset = assets.get('latest.yml');
const remoteManifestResponse = await fetchMetRetry(remoteManifestAsset.url, { redirect: 'follow' });
if (!remoteManifestResponse.ok) {
  throw new Error(`GitHub-verificatie mislukt: latest.yml is publiek niet leesbaar (HTTP ${remoteManifestResponse.status}).`);
}
const remoteManifest = await remoteManifestResponse.text();
const remoteManifestHash = remoteManifest.match(/^sha512:\s*(\S+)/m)?.[1];
if (remoteManifestHash !== actualHash) {
  throw new Error('GitHub-verificatie mislukt: de gepubliceerde latest.yml verwijst niet naar de lokale installerhash.');
}
console.log(`Klaar: ${tag} staat op ${published.url}`);

async function fetchMetRetry(url, init, attempts = 4) {
  let lastResponse;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      lastResponse = await fetch(url, init);
      if (lastResponse.ok || attempt === attempts) return lastResponse;
    } catch (error) {
      if (attempt === attempts) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  return lastResponse;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}
