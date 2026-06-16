import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticJsRoot = path.join(repoRoot, 'crates/ironclaw_webui_v2_static/static/js');

const excludedDirs = new Set(['vendor']);
const excludedFiles = new Set(['main.bundle.js']);
const rawStatusColorPattern =
  /\b(?:text|bg|border|hover:text|hover:bg|hover:border|focus:text|focus:bg|focus:border|focus:ring|ring)-(?:red|yellow|amber|orange|emerald|green|lime)-\d+(?:\/\d+)?\b/g;

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) return [];
        return collectFiles(fullPath);
      }
      if (!entry.isFile()) return [];
      if (!entry.name.endsWith('.js')) return [];
      if (excludedFiles.has(entry.name)) return [];
      return [fullPath];
    })
  );
  return files.flat();
}

function lineAndColumn(source, index) {
  const before = source.slice(0, index);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: lines.at(-1).length + 1
  };
}

const files = await collectFiles(staticJsRoot);
const violations = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(rawStatusColorPattern)) {
    const position = lineAndColumn(source, match.index ?? 0);
    violations.push(
      `${path.relative(repoRoot, file)}:${position.line}:${position.column} uses ${match[0]}`
    );
  }
}

if (violations.length > 0) {
  console.error('Static UI status states must use --v2 semantic tokens.');
  console.error('Replace raw red/yellow/green Tailwind status utilities with v2 tokens.');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Static status token lint OK: ${files.length} shipped JS files scanned.`);
