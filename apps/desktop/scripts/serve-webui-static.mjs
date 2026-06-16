import http from "node:http";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crateRoot = path.join(repoRoot, "crates", "ironclaw_webui_v2_static");
const staticRoot = path.join(crateRoot, "static");
const port = Number(process.env.PORT || process.env.TAURI_DEV_PORT || 1420);
const gatewayOrigin = (process.env.IRONCLAW_GATEWAY_ORIGIN || "http://127.0.0.1:3000").replace(
  /\/+$/,
  "",
);

await import("./prepare-webui-static.mjs");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".wasm", "application/wasm"],
  [".traineddata", "application/octet-stream"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function proxyGateway(req, res, rawUrl) {
  const upstreamUrl = `${gatewayOrigin}${rawUrl.pathname}${rawUrl.search}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null || key.toLowerCase() === "host") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
      duplex: "half",
      redirect: "manual",
    });
    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body || req.method === "HEAD") {
      res.end();
      return;
    }
    const upstreamStream = Readable.fromWeb(upstream.body);
    upstreamStream.on("error", (err) => {
      if (!res.destroyed) {
        res.destroy(err);
      }
    });
    res.on("close", () => {
      upstreamStream.destroy();
    });
    upstreamStream.pipe(res);
  } catch (err) {
    if (rawUrl.pathname === "/auth/providers") {
      send(res, 200, JSON.stringify({ providers: [] }), {
        "Content-Type": "application/json; charset=utf-8",
      });
      return;
    }
    send(res, 502, `Gateway proxy failed: ${err.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  const rawUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(rawUrl.pathname);

  if (pathname === "/") {
    res.writeHead(302, { Location: "/index.html" });
    res.end();
    return;
  }

  if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
    await proxyGateway(req, res, rawUrl);
    return;
  }

  if (pathname.startsWith("/v2/")) {
    pathname = pathname.slice(3) || "/index.html";
  }

  if (!pathname.startsWith("/")) {
    send(res, 404, "Not found");
    return;
  }

  let filePath = path.normalize(path.join(staticRoot, pathname));
  if (!filePath.startsWith(staticRoot + path.sep)) {
    send(res, 403, "Forbidden");
    return;
  }

  if (!(await fileExists(filePath))) {
    filePath = path.join(staticRoot, "index.html");
  }

  try {
    await access(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes.get(ext) || "application/octet-stream",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    send(res, 404, "Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Serving IronClaw WebUI v2 static app at http://127.0.0.1:${port}/`);
});
