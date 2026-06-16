import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateRoot = path.join(repoRoot, "crates", "ironclaw_webui_v2_static");
const staticRoot = path.join(crateRoot, "static");
const vendorRoot = path.join(staticRoot, "vendor");
const stylesRoot = path.join(staticRoot, "styles");

async function ensureStaticRoot() {
  await access(path.join(staticRoot, "index.html"));
  await access(path.join(staticRoot, "js", "main.js"));
}

async function bundleIifeVendor(fileName, contents) {
  const outfile = path.join(vendorRoot, fileName);
  await esbuild.build({
    stdin: {
      contents,
      resolveDir: repoRoot,
      sourcefile: fileName,
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: false,
    outfile,
    logLevel: "silent",
  });
  const bundled = await readFile(outfile, "utf8");
  await writeFile(outfile, `${bundled.replace(/[ \t]+$/gm, "").trimEnd()}\n`);
}

async function prepareVendor() {
  await rm(vendorRoot, { recursive: true, force: true });
  await mkdir(vendorRoot, { recursive: true });

  await bundleIifeVendor(
    "highlight.min.js",
    'import hljs from "highlight.js/lib/common"; window.hljs = hljs;',
  );
  await bundleIifeVendor(
    "mermaid.min.js",
    'import mermaid from "mermaid"; window.mermaid = mermaid;',
  );

  await Promise.all([
    copyFile(
      path.join(repoRoot, "node_modules", "dompurify", "dist", "purify.min.js"),
      path.join(vendorRoot, "purify.min.js"),
    ),
    copyFile(
      path.join(repoRoot, "node_modules", "marked", "lib", "marked.umd.js"),
      path.join(vendorRoot, "marked.umd.js"),
    ),
    // pdf.js powers the composer's client-side PDF text extraction (the
    // bundled Reborn sidecar has no binary extractors). Lazy-imported as an
    // ES module only when a PDF is attached; the worker rides alongside.
    copyFile(
      path.join(repoRoot, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.min.mjs"),
      path.join(vendorRoot, "pdf.min.mjs"),
    ),
    copyFile(
      path.join(repoRoot, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs"),
      path.join(vendorRoot, "pdf.worker.min.mjs"),
    ),
    // tesseract.js powers OCR for scanned PDFs (static/ocr is NOT wiped like
    // vendor/ — eng.traineddata lives there committed; these three stay in
    // sync with the installed package).
    copyFile(
      path.join(repoRoot, "node_modules", "tesseract.js", "dist", "tesseract.esm.min.js"),
      path.join(staticRoot, "ocr", "tesseract.esm.min.js"),
    ),
    copyFile(
      path.join(repoRoot, "node_modules", "tesseract.js", "dist", "worker.min.js"),
      path.join(staticRoot, "ocr", "worker.min.js"),
    ),
    copyFile(
      path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"),
      path.join(staticRoot, "ocr", "tesseract-core-simd-lstm.wasm.js"),
    ),
    copyFile(
      path.join(repoRoot, "node_modules", "tesseract.js-core", "tesseract-core-simd-lstm.wasm"),
      path.join(staticRoot, "ocr", "tesseract-core-simd-lstm.wasm"),
    ),
  ]);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function buildTailwindCss() {
  const tmpRoot = path.join(repoRoot, ".tmp-webui-static-tailwind");
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
  await mkdir(stylesRoot, { recursive: true });

  const inputPath = path.join(tmpRoot, "input.css");
  const configPath = path.join(tmpRoot, "tailwind.config.cjs");
  const outputPath = path.join(stylesRoot, "tailwind.generated.css");

  await writeFile(
    inputPath,
    ["@tailwind base;", "@tailwind components;", "@tailwind utilities;", ""].join("\n"),
  );

  await writeFile(
    configPath,
    `module.exports = {
  content: [
    ${JSON.stringify(path.join(staticRoot, "index.html"))},
    ${JSON.stringify(path.join(staticRoot, "js", "**", "*.js"))}
  ],
  theme: {
    extend: {
      colors: {
        iron: {
          950: "var(--v2-canvas-strong)",
          900: "var(--v2-surface)",
          800: "var(--v2-surface-soft)",
          700: "var(--v2-panel-border)",
          400: "var(--v2-text-faint)",
          300: "var(--v2-text-muted)",
          200: "var(--v2-text)",
          100: "var(--v2-text-strong)"
        },
        signal: "var(--v2-accent-text)",
        copper: "var(--v2-warning-text)",
        mint: "var(--v2-accent-text)"
      },
      fontFamily: {
        sans: [
          "Inter Variable",
          "Inter",
          "SF Pro Display",
          "Helvetica Neue",
          "ui-sans-serif",
          "system-ui",
          "sans-serif"
        ],
        serif: ["Newsreader", "Lyon Text", "Instrument Serif", "Georgia", "serif"],
        mono: ["Geist Mono", "SF Mono", "JetBrains Mono", "ui-monospace", "monospace"]
      }
    }
  },
  plugins: []
};
`,
  );

  await run(path.join(repoRoot, "node_modules", ".bin", "tailwindcss"), [
    "-c",
    configPath,
    "-i",
    inputPath,
    "-o",
    outputPath,
    "--minify",
  ]);

  await rm(tmpRoot, { recursive: true, force: true });
}

async function bundleApp() {
  await esbuild.build({
    entryPoints: [path.join(staticRoot, "js", "main.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: false,
    outfile: path.join(staticRoot, "js", "main.bundle.js"),
    logLevel: "silent",
  });
}

await ensureStaticRoot();
await prepareVendor();
await bundleApp();
await buildTailwindCss();
console.log(`Prepared IronClaw WebUI v2 static root at ${staticRoot}`);
