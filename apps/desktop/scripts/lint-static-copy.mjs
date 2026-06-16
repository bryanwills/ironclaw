#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = [
  'crates/ironclaw_webui_v2_static/static/js/i18n/en.js',
  'crates/ironclaw_webui_v2_static/static/js/components',
  'crates/ironclaw_webui_v2_static/static/js/design-system',
  'crates/ironclaw_webui_v2_static/static/js/pages'
];

const ignoredPathSegments = new Set(['vendor']);
const forbidden = [
  {
    name: 'third-party model brand in normal desktop copy',
    pattern: /\b(OpenRouter|Anthropic|Claude|ChatGPT)\b/i
  },
  {
    name: '"ask me anything" front-door framing',
    pattern: /ask\b.*\banything/i
  },
  {
    name: 'provider marketplace framing',
    pattern: /\bprovider marketplace\b/i
  },
  {
    name: 'Codex login framing',
    pattern: /\bCodex login\b/i
  },
  {
    name: 'operator persona leak',
    pattern: /\boperators?\b/i
  },
  {
    name: 'Gateway v2 product leak',
    pattern: /\bGateway v2\b/i
  },
  {
    name: 'v2 route/product leak',
    pattern: /\bwithout leaving v2\b/i
  },
  {
    name: 'generic console framing',
    pattern: /\bconsole\b/i,
    allow: (text) =>
      text.includes('Google Cloud Console') || text.includes('https://console.cloud.google.com')
  },
  {
    // DSYS-5: keep product copy plain. These marketing/LLM-tell words have no
    // place in a calm chief-of-staff desk; honest product copy never needs them.
    name: 'marketing / AI-tell jargon',
    pattern:
      /\b(?:seamless(?:ly)?|effortless(?:ly)?|unleash|supercharge|delve|cutting[ -]?edge|best[ -]?in[ -]?class|world[ -]?class|game[ -]?chang(?:er|ing)|revolutioniz(?:e|ing)|unlock (?:the )?(?:full )?potential|harness the power)\b/i
  },
  {
    // DSYS-5: the "It's not X. It's Y" / "This is X. This is not Y" emphasis-card
    // construction is a flagged AI tell. Matches only the two-clause contrast
    // within one string (single honest phrases like "not available yet" are fine).
    name: 'emphasis-card AI-tell ("it is not X. it is Y")',
    pattern:
      /\b(?:it'?s|it is|this is)\s+not\b[^.!?]{1,70}[.!?]+\s*(?:it'?s|it is|this is)\b|\bthis is\b[^.!?]{1,70}[.!?]+\s*this is not\b/is
  }
];

const KEY_LIKE_STRING = /^[a-z][a-z0-9_.-]*$/i;
const MAYBE_FORBIDDEN = new RegExp(forbidden.map((rule) => rule.pattern.source).join('|'), 'i');

function walk(target) {
  const fullPath = path.join(repoRoot, target);
  const stat = fs.statSync(fullPath);
  if (stat.isFile()) return [fullPath];

  return fs.readdirSync(fullPath, { withFileTypes: true }).flatMap((entry) => {
    if (ignoredPathSegments.has(entry.name)) return [];
    const child = path.join(fullPath, entry.name);
    if (entry.isDirectory()) return walk(path.relative(repoRoot, child));
    if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name.endsWith('.test.mjs')) {
      return [];
    }
    if (entry.name === 'main.bundle.js') return [];
    return [child];
  });
}

function lineAndColumnFor(source, index) {
  const before = source.slice(0, index);
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function unquote(raw) {
  return raw
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(['"`])/g, '$1');
}

function* stringLiterals(source) {
  const pattern = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gs;
  let match;
  while ((match = pattern.exec(source))) {
    yield {
      raw: match[0],
      text: unquote(match[0]),
      index: match.index
    };
  }
}

function inspectableText(text) {
  if (!text.includes('<') && !text.includes('${')) return text;
  return text
    .replace(/\$\{[\s\S]*?\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const failures = [];
const scannedFiles = scanRoots.flatMap(walk);

for (const filePath of scannedFiles) {
  const relativePath = path.relative(repoRoot, filePath);
  const source = fs.readFileSync(filePath, 'utf8');
  if (!MAYBE_FORBIDDEN.test(source)) continue;
  for (const literal of stringLiterals(source)) {
    if (typeof literal.text !== 'string') continue;
    if (KEY_LIKE_STRING.test(literal.text)) continue;
    const text = inspectableText(literal.text);
    if (!text) continue;
    for (const rule of forbidden) {
      if (!rule.pattern.test(text)) continue;
      if (rule.allow?.(text)) continue;
      const { line, column } = lineAndColumnFor(source, literal.index);
      failures.push(`${relativePath}:${line}:${column} ${rule.name}: ${text}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Static copy lint failed:');
  failures.forEach((failure) => console.error(`  ${failure}`));
  process.exit(1);
}

console.log(`Static copy lint OK: ${scannedFiles.length} shipped JS files scanned.`);
