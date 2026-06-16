#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

export const ASSET_GROUPS = {
  cold: [
    'vendor/purify.min.js',
    'vendor/marked.umd.js',
    'js/main.bundle.js',
    'styles/tailwind.generated.css',
    'styles/app.css'
  ],
  code: ['vendor/highlight.min.js'],
  diagram: ['vendor/mermaid.min.js'],
  document: ['vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs'],
  ocr: [
    'ocr/tesseract.esm.min.js',
    'ocr/worker.min.js',
    'ocr/tesseract-core-simd-lstm.wasm.js',
    'ocr/tesseract-core-simd-lstm.wasm'
  ]
};

const GROUP_BUDGET_KEYS = {
  cold: 'cold_gzip_kb',
  code: 'code_highlight_gzip_kb',
  diagram: 'diagram_gzip_kb',
  document: 'document_gzip_kb',
  ocr: 'ocr_gzip_kb'
};

const DEFAULT_STATIC_ROOT = path.join(projectRoot, 'crates/ironclaw_webui_v2_static/static');
const DEFAULT_BUDGET_FILE = path.join(scriptDir, 'static-bundle-budget.json');

function kb(bytes) {
  return bytes / 1024;
}

function formatKb(bytes) {
  return `${kb(bytes).toFixed(1)} KB`;
}

function gzipSize(filePath) {
  return gzipSync(readFileSync(filePath), { level: 9 }).length;
}

function assertBudgetNumber(budget, key) {
  const value = Number(budget[key]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Missing positive numeric budget key: ${key}`);
  }
  return value;
}

export function measureStaticBundle({
  staticRoot = DEFAULT_STATIC_ROOT,
  budgetFile = DEFAULT_BUDGET_FILE
} = {}) {
  const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
  const requiredBudgetKeys = [
    ...Object.values(GROUP_BUDGET_KEYS),
    'main_bundle_gzip_kb',
    'vendor_boot_gzip_kb',
    'total_gzip_kb',
    'largest_asset_gzip_kb'
  ];
  for (const key of requiredBudgetKeys) assertBudgetNumber(budget, key);

  const groups = {};
  const files = [];
  for (const [groupName, relativeFiles] of Object.entries(ASSET_GROUPS)) {
    let bytes = 0;
    const groupFiles = [];
    for (const relativePath of relativeFiles) {
      const absolutePath = path.join(staticRoot, relativePath);
      const gzipBytes = gzipSize(absolutePath);
      const row = {
        group: groupName,
        relativePath,
        gzipBytes
      };
      files.push(row);
      groupFiles.push(row);
      bytes += gzipBytes;
    }
    groups[groupName] = {
      gzipBytes: bytes,
      budgetKb: assertBudgetNumber(budget, GROUP_BUDGET_KEYS[groupName]),
      files: groupFiles
    };
  }

  const mainBundle = files.find((file) => file.relativePath === 'js/main.bundle.js');
  const vendorBootBytes = files
    .filter((file) => file.group === 'cold' && file.relativePath.startsWith('vendor/'))
    .reduce((sum, file) => sum + file.gzipBytes, 0);
  const totalBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  const largestAsset = files.reduce((largest, file) =>
    !largest || file.gzipBytes > largest.gzipBytes ? file : largest
  );

  const metrics = [
    {
      key: 'cold',
      label: 'cold start',
      gzipBytes: groups.cold.gzipBytes,
      budgetKb: groups.cold.budgetKb
    },
    {
      key: 'main_bundle',
      label: 'main bundle',
      gzipBytes: mainBundle.gzipBytes,
      budgetKb: assertBudgetNumber(budget, 'main_bundle_gzip_kb'),
      detail: mainBundle.relativePath
    },
    {
      key: 'vendor_boot',
      label: 'boot vendor',
      gzipBytes: vendorBootBytes,
      budgetKb: assertBudgetNumber(budget, 'vendor_boot_gzip_kb'),
      detail: 'purify + marked'
    },
    {
      key: 'code_highlight',
      label: 'code highlight',
      gzipBytes: groups.code.gzipBytes,
      budgetKb: groups.code.budgetKb,
      detail: 'lazy Highlight.js'
    },
    {
      key: 'diagram',
      label: 'diagram lazy',
      gzipBytes: groups.diagram.gzipBytes,
      budgetKb: groups.diagram.budgetKb,
      detail: 'lazy Mermaid'
    },
    {
      key: 'document',
      label: 'document lazy',
      gzipBytes: groups.document.gzipBytes,
      budgetKb: groups.document.budgetKb
    },
    {
      key: 'ocr',
      label: 'ocr lazy',
      gzipBytes: groups.ocr.gzipBytes,
      budgetKb: groups.ocr.budgetKb
    },
    {
      key: 'total',
      label: 'all tracked',
      gzipBytes: totalBytes,
      budgetKb: assertBudgetNumber(budget, 'total_gzip_kb')
    },
    {
      key: 'largest_asset',
      label: 'largest asset',
      gzipBytes: largestAsset.gzipBytes,
      budgetKb: assertBudgetNumber(budget, 'largest_asset_gzip_kb'),
      detail: largestAsset.relativePath
    }
  ];

  return {
    staticRoot,
    budgetFile,
    groups,
    files,
    metrics,
    violations: metrics.filter((metric) => kb(metric.gzipBytes) > metric.budgetKb)
  };
}

function renderReport(result) {
  console.log('');
  console.log('Static WebUI bundle size check');
  console.log(`budget: ${path.relative(projectRoot, result.budgetFile)}`);
  console.log(`static root: ${path.relative(projectRoot, result.staticRoot)}`);
  console.log('');
  console.log('  METRIC             ACTUAL      BUDGET      STATUS');
  console.log('  ------             ------      ------      ------');
  for (const metric of result.metrics) {
    const actualKb = kb(metric.gzipBytes);
    const status =
      actualKb > metric.budgetKb ? 'OVER' : actualKb > metric.budgetKb * 0.9 ? 'WARN' : 'OK';
    const detail = metric.detail ? `  ${metric.detail}` : '';
    console.log(
      `  ${metric.label.padEnd(16)} ${actualKb.toFixed(1).padStart(8)} KB ${String(
        metric.budgetKb
      ).padStart(7)} KB   ${status}${detail}`
    );
  }
  console.log('');
  if (result.violations.length > 0) {
    console.error('FAIL static bundle is over budget:');
    for (const metric of result.violations) {
      console.error(
        `  ${metric.label}: ${kb(metric.gzipBytes).toFixed(1)} KB / ${metric.budgetKb} KB`
      );
    }
  } else {
    console.log('OK static bundle under budget.');
  }
}

export function main() {
  const result = measureStaticBundle({
    staticRoot: process.env.STATIC_BUNDLE_ROOT || DEFAULT_STATIC_ROOT,
    budgetFile: process.env.STATIC_BUNDLE_BUDGET || DEFAULT_BUDGET_FILE
  });
  renderReport(result);
  return result.violations.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR ${error?.message || error}`);
    process.exitCode = 1;
  }
}
