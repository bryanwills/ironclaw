// Loopback HTTP server for the OCR asset pack (tesseract worker, wasm core,
// language data). WKWebView does not route fetches made INSIDE Web Workers
// through custom URL-scheme handlers, so a worker can never load assets from
// tauri://localhost — but it can fetch plain http://127.0.0.1. This serves
// exactly five allowlisted files from the bundled resources, nothing else.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

const ALLOWED: [(&str, &str); 5] = [
    ("tesseract.esm.min.js", "text/javascript; charset=utf-8"),
    ("worker.min.js", "text/javascript; charset=utf-8"),
    (
        "tesseract-core-simd-lstm.wasm.js",
        "text/javascript; charset=utf-8",
    ),
    ("tesseract-core-simd-lstm.wasm", "application/wasm"),
    ("eng.traineddata", "application/octet-stream"),
];

#[derive(Clone, Debug, Serialize)]
pub struct OcrAssetEndpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RejectReason {
    Forbidden,
}

static SERVER_ENDPOINT: OnceLock<OcrAssetEndpoint> = OnceLock::new();
static ASSET_ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
static START_LOCK: Mutex<()> = Mutex::new(());

/// Start (once) and return the loopback port. `roots` are searched in order
/// for the allowlisted files — packaged resources first, repo paths in dev.
pub fn ensure_started(roots: Vec<PathBuf>) -> Result<OcrAssetEndpoint, String> {
    if let Some(endpoint) = SERVER_ENDPOINT.get() {
        return Ok(endpoint.clone());
    }
    let _guard = START_LOCK
        .lock()
        .map_err(|_| "ocr asset server start lock poisoned".to_string())?;
    if let Some(endpoint) = SERVER_ENDPOINT.get() {
        return Ok(endpoint.clone());
    }

    ASSET_ROOTS.get_or_init(|| Mutex::new(roots));

    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("ocr asset server bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("ocr asset server addr: {e}"))?
        .port();
    let token = Uuid::new_v4().simple().to_string();
    let thread_token = token.clone();

    std::thread::Builder::new()
        .name("ocr-asset-server".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                // Serial handling is fine: five small files, one client.
                let _ = handle(stream, &thread_token, port);
            }
        })
        .map_err(|e| format!("ocr asset server thread: {e}"))?;

    let endpoint = OcrAssetEndpoint { port, token };
    let _ = SERVER_ENDPOINT.set(endpoint.clone());
    Ok(endpoint)
}

fn lookup(name: &str) -> Option<(&'static str, Vec<u8>)> {
    let (_, content_type) = ALLOWED.iter().find(|(allowed, _)| *allowed == name)?;
    let content_type = *content_type;
    let roots = ASSET_ROOTS.get()?.lock().ok()?;
    lookup_from_roots(name, &roots).map(|bytes| (content_type, bytes))
}

fn lookup_from_roots(name: &str, roots: &[PathBuf]) -> Option<Vec<u8>> {
    for root in roots.iter() {
        let candidate = root.join(name);
        if let Ok(bytes) = std::fs::read(&candidate) {
            return Some(bytes);
        }
    }
    None
}

fn handle(mut stream: TcpStream, token: &str, port: u16) -> std::io::Result<()> {
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf)?;
    let request = String::from_utf8_lossy(&buf[..n]);

    match authorize_asset_name(&request, token, port) {
        Ok(name) => match lookup(name) {
            Some((content_type, bytes)) => write_asset_response(&mut stream, content_type, &bytes)?,
            None => write_empty_response(&mut stream, 404, "Not Found")?,
        },
        Err(RejectReason::Forbidden) => write_empty_response(&mut stream, 403, "Forbidden")?,
    }
    Ok(())
}

fn write_empty_response(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(header.as_bytes())
}

fn write_asset_response(
    stream: &mut TcpStream,
    content_type: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    // CORS open on loopback: the WebView page origin is tauri://, and the
    // worker inherits it. The per-boot path token is the access boundary.
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: max-age=86400\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(bytes)?;
    Ok(())
}

fn authorize_asset_name<'a>(
    request: &'a str,
    token: &str,
    port: u16,
) -> Result<&'a str, RejectReason> {
    if !host_header_is_loopback(request, port) {
        return Err(RejectReason::Forbidden);
    }

    let path = request_path(request).ok_or(RejectReason::Forbidden)?;
    let path = path
        .split('?')
        .next()
        .unwrap_or(path)
        .trim_start_matches('/');
    let mut parts = path.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(candidate), Some(name), None) if candidate == token && !name.is_empty() => Ok(name),
        _ => Err(RejectReason::Forbidden),
    }
}

fn request_path(request: &str) -> Option<&str> {
    let mut parts = request.lines().next()?.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    if method.eq_ignore_ascii_case("GET") {
        Some(path)
    } else {
        None
    }
}

fn host_header_is_loopback(request: &str, port: u16) -> bool {
    let Some(host) = request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("host") {
            Some(value.trim().to_ascii_lowercase())
        } else {
            None
        }
    }) else {
        return false;
    };

    host == format!("127.0.0.1:{port}")
        || host == format!("localhost:{port}")
        || host == format!("[::1]:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 49152;
    const TOKEN: &str = "boot-token";

    fn request(path: &str, host: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n")
    }

    #[test]
    fn authorizes_tokenized_loopback_asset() {
        let request = request(
            &format!("/{TOKEN}/worker.min.js"),
            &format!("127.0.0.1:{PORT}"),
        );

        assert_eq!(
            authorize_asset_name(&request, TOKEN, PORT),
            Ok("worker.min.js")
        );
    }

    #[test]
    fn tokenized_loopback_asset_resolves_to_served_bytes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("worker.min.js"), b"worker bytes").unwrap();
        let request = request(
            &format!("/{TOKEN}/worker.min.js"),
            &format!("127.0.0.1:{PORT}"),
        );
        let name = authorize_asset_name(&request, TOKEN, PORT).unwrap();

        assert_eq!(
            lookup_from_roots(name, &[dir.path().to_path_buf()]).as_deref(),
            Some(&b"worker bytes"[..])
        );
    }

    #[test]
    fn rejects_asset_without_per_boot_token() {
        let request = request("/worker.min.js", &format!("127.0.0.1:{PORT}"));

        assert_eq!(
            authorize_asset_name(&request, TOKEN, PORT),
            Err(RejectReason::Forbidden)
        );
    }

    #[test]
    fn rejects_wrong_token() {
        let request = request("/other-token/worker.min.js", &format!("127.0.0.1:{PORT}"));

        assert_eq!(
            authorize_asset_name(&request, TOKEN, PORT),
            Err(RejectReason::Forbidden)
        );
    }

    #[test]
    fn rejects_non_loopback_host() {
        let request = request(&format!("/{TOKEN}/worker.min.js"), "example.com");

        assert_eq!(
            authorize_asset_name(&request, TOKEN, PORT),
            Err(RejectReason::Forbidden)
        );
    }

    #[test]
    fn rejects_loopback_host_with_wrong_port() {
        let request = request(&format!("/{TOKEN}/worker.min.js"), "127.0.0.1:49153");

        assert_eq!(
            authorize_asset_name(&request, TOKEN, PORT),
            Err(RejectReason::Forbidden)
        );
    }

    #[test]
    fn rejects_non_get_requests() {
        let request = format!(
            "POST /{TOKEN}/worker.min.js HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\n\r\n"
        );

        assert_eq!(
            authorize_asset_name(&request, TOKEN, PORT),
            Err(RejectReason::Forbidden)
        );
    }
}
