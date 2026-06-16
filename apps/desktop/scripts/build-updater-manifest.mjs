import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_ARCHES = ['aarch64', 'x86_64'];
const PLATFORM_BY_ARCH = {
  aarch64: 'darwin-aarch64',
  x86_64: 'darwin-x86_64'
};
const UNIVERSAL_ARCH = 'universal';
const DEFAULT_REPO = 'nearai/ironclaw-desktop-app';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

function usage() {
  return `Usage: node scripts/build-updater-manifest.mjs [options]

Generates a Tauri v2 updater latest.json from signed macOS .app.tar.gz artifacts.

Options:
  --artifacts <dir>              Directory containing release artifacts (default: release-artifacts)
  --output <file>                Manifest path (default: <artifacts>/latest.json)
  --repo <owner/name>            GitHub repo for download URLs (default: GITHUB_REPOSITORY or ${DEFAULT_REPO})
  --tag <tag>                    Release tag for download URLs (default: GitHub tag ref or v<package version>)
  --version <semver>             App version (default: package.json version)
  --notes <text>                 Release notes string (default: IronClaw Desktop <version>)
  --pub-date <rfc3339>           Publication date (default: current time)
  --allow-missing-signature      Emit an empty signature instead of failing; never use for public releases
  --print                        Print the generated JSON to stdout
  --help                         Show this help
`;
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === '--artifacts') options.artifactsDir = readValue();
    else if (arg === '--output') options.outputPath = readValue();
    else if (arg === '--repo') options.repo = readValue();
    else if (arg === '--tag') options.tag = readValue();
    else if (arg === '--version') options.version = readValue();
    else if (arg === '--notes') options.notes = readValue();
    else if (arg === '--pub-date') options.pubDate = readValue();
    else if (arg === '--allow-missing-signature') options.allowMissingSignature = true;
    else if (arg === '--print') options.print = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  if (!packageJson.version) {
    throw new Error('package.json does not contain a version');
  }
  return packageJson.version;
}

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
}

function assertRfc3339(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid RFC3339 pub-date: ${value}`);
  }
}

function normalizeTag(tag, version) {
  const trimmed = String(tag || '').trim();
  return trimmed || `v${version}`;
}

function assertTagMatchesVersion(tag, version) {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(
      `Release tag ${tag} does not match manifest version ${version}; expected ${expected}`
    );
  }
}

function envReleaseTag() {
  if (process.env.GITHUB_REF_TYPE === 'tag') {
    return process.env.GITHUB_REF_NAME;
  }
  return '';
}

function normalizeRepo(repo) {
  const trimmed = String(repo || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }
  return trimmed;
}

function inferArch(fileName) {
  if (/(^|[_-])universal([_.-]|$)/.test(fileName)) return UNIVERSAL_ARCH;
  if (/(^|[_-])aarch64([_.-]|$)/.test(fileName)) return 'aarch64';
  if (/(^|[_-])x86_64([_.-]|$)/.test(fileName)) return 'x86_64';
  return null;
}

function releaseAssetUrl(repo, tag, fileName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

async function signedPlatform(artifactsDir, repo, tag, archiveName, allowMissingSignature) {
  const signaturePath = path.join(artifactsDir, `${archiveName}.sig`);
  let signature = '';
  try {
    signature = (await readFile(signaturePath, 'utf8')).trim();
  } catch (error) {
    if (!allowMissingSignature || error?.code !== 'ENOENT') {
      throw new Error(`Missing updater signature for ${archiveName}: expected ${signaturePath}`);
    }
  }

  if (!signature && !allowMissingSignature) {
    throw new Error(`Empty updater signature for ${archiveName}: ${signaturePath}`);
  }

  return {
    signature,
    url: releaseAssetUrl(repo, tag, archiveName)
  };
}

export async function buildUpdaterManifest({
  artifactsDir = path.join(repoRoot, 'release-artifacts'),
  repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
  tag,
  version,
  notes,
  pubDate = new Date().toISOString(),
  allowMissingSignature = false
} = {}) {
  const resolvedVersion = version || (await readPackageVersion());
  assertSemver(resolvedVersion);
  assertRfc3339(pubDate);

  const resolvedRepo = normalizeRepo(repo);
  const resolvedTag = normalizeTag(tag || envReleaseTag(), resolvedVersion);
  assertTagMatchesVersion(resolvedTag, resolvedVersion);
  const artifactNames = await readdir(artifactsDir);
  const archivesByArch = new Map(REQUIRED_ARCHES.map((arch) => [arch, []]));
  const universalArchives = [];

  for (const artifactName of artifactNames) {
    if (!artifactName.endsWith('.app.tar.gz')) continue;
    const arch = inferArch(artifactName);
    if (!arch) {
      throw new Error(
        `Updater archive ${artifactName} is ambiguous. Rename it with _aarch64, _x86_64, or _universal before generating latest.json.`
      );
    }
    if (arch === UNIVERSAL_ARCH) {
      universalArchives.push(artifactName);
    } else {
      archivesByArch.get(arch)?.push(artifactName);
    }
  }

  const platforms = {};
  if (universalArchives.length > 1) {
    throw new Error(`Multiple universal updater archives found: ${universalArchives.join(', ')}`);
  }
  if (universalArchives.length === 1) {
    const perArchArchives = [...archivesByArch.values()].flat();
    if (perArchArchives.length > 0) {
      throw new Error(
        `Mixed universal and per-arch updater archives found: ${[
          universalArchives[0],
          ...perArchArchives
        ].join(', ')}. Clean release-artifacts before generating latest.json.`
      );
    }
    const platform = await signedPlatform(
      artifactsDir,
      resolvedRepo,
      resolvedTag,
      universalArchives[0],
      allowMissingSignature
    );
    for (const arch of REQUIRED_ARCHES) {
      platforms[PLATFORM_BY_ARCH[arch]] = platform;
    }
    return {
      version: resolvedVersion,
      notes: notes ?? `IronClaw Desktop ${resolvedVersion}`,
      pub_date: pubDate,
      platforms
    };
  }

  for (const arch of REQUIRED_ARCHES) {
    const archives = archivesByArch.get(arch) || [];
    if (archives.length === 0) {
      throw new Error(`Missing ${arch} updater archive in ${artifactsDir}`);
    }
    if (archives.length > 1) {
      throw new Error(`Multiple ${arch} updater archives found: ${archives.join(', ')}`);
    }
    platforms[PLATFORM_BY_ARCH[arch]] = await signedPlatform(
      artifactsDir,
      resolvedRepo,
      resolvedTag,
      archives[0],
      allowMissingSignature
    );
  }

  return {
    version: resolvedVersion,
    notes: notes ?? `IronClaw Desktop ${resolvedVersion}`,
    pub_date: pubDate,
    platforms
  };
}

export async function writeUpdaterManifest({ outputPath, print = false, ...options } = {}) {
  const manifest = await buildUpdaterManifest(options);
  const artifactsDir = options.artifactsDir || path.join(repoRoot, 'release-artifacts');
  const resolvedOutputPath = outputPath || path.join(artifactsDir, 'latest.json');
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolvedOutputPath, json);
  if (print) {
    process.stdout.write(json);
  }
  return { manifest, outputPath: resolvedOutputPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const { outputPath } = await writeUpdaterManifest(options);
  console.error(`[ironclaw] wrote Tauri updater manifest: ${outputPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[ironclaw] ${error.message}`);
    process.exit(1);
  });
}
