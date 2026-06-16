import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = path.join(repoRoot, 'crates', 'ironclaw_webui_v2_static', 'static');

const expectedBuild = {
  frontendDist: '../crates/ironclaw_webui_v2_static/static',
  devUrl: 'http://localhost:1420/index.html',
  beforeDevCommand: 'npm run dev:webui-static',
  beforeBuildCommand: 'npm run prepare:webui-static'
};

const requiredStaticFiles = [
  'index.html',
  'js/main.js',
  'js/main.bundle.js',
  'styles/app.css',
  'styles/tailwind.generated.css',
  'vendor/purify.min.js',
  'vendor/marked.umd.js',
  'vendor/highlight.min.js',
  'vendor/mermaid.min.js'
];

const forbiddenIndexFragments = [
  'cdn.tailwindcss.com',
  '@tailwindcss/browser',
  'https://esm.sh',
  'https://unpkg.com',
  'https://cdn.jsdelivr.net'
];

function fail(message) {
  throw new Error(message);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

async function assertAccess(relativePath) {
  await access(path.join(staticRoot, relativePath));
}

async function assertBuildConfig() {
  const tauriConfig = await readJson('src-tauri/tauri.conf.json');
  const build = tauriConfig.build ?? {};

  for (const [key, expected] of Object.entries(expectedBuild)) {
    if (build[key] !== expected) {
      fail(
        `src-tauri/tauri.conf.json build.${key} must be ${JSON.stringify(expected)}, got ${JSON.stringify(build[key])}`
      );
    }
  }

  const packageJson = await readJson('package.json');
  const scripts = packageJson.scripts ?? {};
  if (scripts['prepare:webui-static'] !== 'node scripts/prepare-webui-static.mjs') {
    fail('package.json scripts.prepare:webui-static must prepare the shared static WebUI');
  }
  if (scripts['dev:webui-static'] !== 'node scripts/serve-webui-static.mjs') {
    fail('package.json scripts.dev:webui-static must serve the shared static WebUI');
  }
  if (scripts['smoke:webui-static'] !== 'node scripts/smoke-webui-static.mjs') {
    fail('package.json scripts.smoke:webui-static must exercise the shared static WebUI');
  }
}

async function assertStaticRoot() {
  for (const file of requiredStaticFiles) {
    await assertAccess(file);
  }

  const index = await readFile(path.join(staticRoot, 'index.html'), 'utf8');
  if (!index.includes('loadScript("js/main.bundle.js", "module")')) {
    fail('static index.html must load the bundled shared WebUI entry js/main.bundle.js');
  }
  if (!index.includes('window.__IRONCLAW_LOAD_SCRIPT__ = loadScript')) {
    fail('static index.html must expose the local asset loader for lazy static assets');
  }
  if (index.includes('loadScript("vendor/highlight.min.js")')) {
    fail('static index.html must not load Highlight.js on the cold boot path');
  }
  if (!index.includes('loadStyle("styles/tailwind.generated.css")')) {
    fail('static index.html must load generated local Tailwind CSS');
  }
  if (!index.includes('loadStyle("styles/app.css")')) {
    fail('static index.html must load local app.css');
  }
  if (!index.includes('location.pathname === "/v2"') || !index.includes('`/v2/${path}`')) {
    fail('static index.html must preserve hosted /v2 asset loading for the Reborn gateway');
  }

  for (const fragment of forbiddenIndexFragments) {
    if (index.includes(fragment)) {
      fail(`static index.html must not depend on external frontend asset ${fragment}`);
    }
  }
}

async function assertBundleFreshness() {
  const css = await stat(path.join(staticRoot, 'styles', 'tailwind.generated.css'));
  if (css.size < 1024) {
    fail('styles/tailwind.generated.css is unexpectedly small; run npm run prepare:webui-static');
  }

  // Content check, not mtime. The old heuristic (bundle.mtime >= entry.mtime) is
  // bypassable — a deep-source edit committed without regenerating, or a clone/CI
  // checkout that resets mtimes, both pass it while shipping a stale bundle.
  // Instead, re-bundle js/main.js in memory with the EXACT prepare-webui-static
  // options and require a byte-for-byte match with the committed bundle.
  const result = await esbuild.build({
    entryPoints: [path.join(staticRoot, 'js', 'main.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    write: false,
    logLevel: 'silent'
  });
  const rebuilt = result.outputFiles?.[0]?.text ?? '';
  const committed = await readFile(path.join(staticRoot, 'js', 'main.bundle.js'), 'utf8');
  if (rebuilt.trimEnd() !== committed.trimEnd()) {
    fail(
      'js/main.bundle.js does not match js/main.js (stale bundle); run npm run prepare:webui-static'
    );
  }
}

await assertBuildConfig();
await assertStaticRoot();
await assertBundleFreshness();

console.log(`Static frontend contract OK: Tauri packages ${path.relative(repoRoot, staticRoot)}`);
