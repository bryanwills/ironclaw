// "Connect to NEAR AI" via system-browser loopback OAuth (cloud-api.near.ai).
//
// VERIFIED 2026-06-15 against the live host + nearai/cloud-api source:
//   - cloud-api.near.ai/v1/auth/{github,google} accepts a
//     http://127.0.0.1:<port>/callback/<nonce> frontend_callback (HTTP 303 ->
//     the provider). private.near.ai REJECTS loopback (400), which is why the
//     in-app embedded sign-in (nearai_login.rs) targets that host instead.
//   - The callback delivers tokens in the URL FRAGMENT
//     (#token=<access>&refresh_token=<rt_>). A server can't read a fragment, so
//     the loopback page is a tiny HTML shim that reads location.hash in JS and
//     POSTs it back to /token/<nonce>.
//   - We then mint a long-lived data-plane key with the access token:
//       GET  /v1/users/me                       -> first workspace id
//       POST /v1/workspaces/{id}/api-keys {name} -> ApiKeyResponse.key (sk-…)
//     and vault the sk- in the keychain. The WebUI restarts the sidecar, which
//     classifies the sk- and routes it to cloud-api.near.ai for inference
//     (see `nearai_credential_for_profile` in lib.rs).
//
// Opening the system browser (rather than an embedded webview) is the whole
// point: the user authorizes in the Chrome session they're already signed into,
// so it's a one-click "Connect". A random per-flow nonce in the callback path
// keeps another localhost page from injecting a token into our listener.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::AppHandle;

const CLOUD_API: &str = "https://cloud-api.near.ai";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);
const PORT_MIN: u16 = 8765;
const PORT_MAX: u16 = 8800;
const ACCEPT_POLL: Duration = Duration::from_millis(60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// Captured OAuth fragment, posted back by the loopback callback page.
#[derive(Debug, Deserialize)]
struct CapturedTokens {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MeResponse {
    #[serde(default)]
    workspaces: Option<Vec<MeWorkspace>>,
}

#[derive(Debug, Deserialize)]
struct MeWorkspace {
    id: String,
    #[serde(default)]
    is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ApiKeyResp {
    #[serde(default)]
    key: Option<String>,
}

fn callback_page() -> String {
    // Reads the OAuth fragment and relays it to the loopback server, then tells
    // the user they can return to the app. No external resources.
    r#"<!doctype html><html><head><meta charset="utf-8"><title>Connecting IronClaw</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0e14;color:#e8eaed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
<h2 style="font-weight:600">Connecting IronClaw to NEAR AI…</h2>
<p id="s" style="color:#9aa0a6">Finishing sign-in. You can return to the app.</p></div>
<script>
(function(){
  var h=(location.hash||"").replace(/^#/,"");
  var p=new URLSearchParams(h);
  var body=JSON.stringify({token:p.get("token"),refresh_token:p.get("refresh_token")});
  fetch(location.pathname.replace("/callback/","/token/"),{method:"POST",headers:{"content-type":"application/json"},body:body})
    .then(function(){document.getElementById("s").textContent="Connected. You can close this window and return to IronClaw.";})
    .catch(function(){document.getElementById("s").textContent="Could not reach IronClaw. Close this window and try Connect again.";});
})();
</script></body></html>"#
        .to_string()
}

/// Bind the first free loopback port in [PORT_MIN, PORT_MAX].
fn bind_loopback() -> Result<(TcpListener, u16), String> {
    for port in PORT_MIN..=PORT_MAX {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok((listener, port));
        }
    }
    Err(format!(
        "no free loopback port in {PORT_MIN}-{PORT_MAX} for the sign-in callback"
    ))
}

/// Open the system default browser (the user's logged-in session) at `url`.
fn open_in_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open the browser for sign-in: {e}"))
}

/// Serve the loopback callback until the page posts the captured tokens to
/// `/token/<nonce>`, or the deadline passes. Runs on a blocking worker thread.
fn serve_until_token(
    listener: TcpListener,
    nonce: &str,
    timeout: Duration,
) -> Result<CapturedTokens, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("listener nonblocking: {e}"))?;
    let token_path = format!("/token/{nonce}");
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline {
            return Err("Sign-in timed out before NEAR AI returned a token".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(tokens) = handle_conn(stream, &token_path)? {
                    return Ok(tokens);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(e) => return Err(format!("loopback accept: {e}")),
        }
    }
}

/// Handle one connection. Returns Some(tokens) only for a valid POST to the
/// nonce'd token path; serves the callback HTML for the GET; 204 otherwise.
fn handle_conn(
    mut stream: std::net::TcpStream,
    token_path: &str,
) -> Result<Option<CapturedTokens>, String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    // Read until headers complete (\r\n\r\n), capped so a bad client can't grow
    // the buffer unbounded.
    let header_end = loop {
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(None),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                    break pos + 4;
                }
                if buf.len() > 64 * 1024 {
                    respond(&mut stream, 413, "text/plain", b"too large");
                    return Ok(None);
                }
            }
            Err(_) => return Ok(None),
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    if method == "GET" && path.starts_with("/callback/") {
        respond(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            callback_page().as_bytes(),
        );
        return Ok(None);
    }
    if method == "POST" && path == token_path {
        let content_length = lines
            .find_map(|l| {
                let l = l.to_ascii_lowercase();
                l.strip_prefix("content-length:")
                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
            })
            .unwrap_or(0)
            .min(64 * 1024);
        let mut body = buf[header_end..].to_vec();
        while body.len() < content_length {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => body.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
        respond(&mut stream, 200, "text/plain", b"ok");
        let tokens: CapturedTokens = serde_json::from_slice(&body)
            .map_err(|e| format!("could not parse the captured token payload: {e}"))?;
        return Ok(Some(tokens));
    }
    // Favicon and anything else.
    respond(&mut stream, 204, "text/plain", b"");
    Ok(None)
}

fn respond(stream: &mut std::net::TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        413 => "Payload Too Large",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Exchange the OAuth access token for a long-lived `sk-` API key by minting one
/// against the user's first workspace.
async fn mint_api_key(access_token: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let workspace_id = resolve_workspace_id(&client, access_token).await?;

    // The key name must be UNIQUE per workspace — NEAR AI returns 409 Conflict
    // on a duplicate. The host alone is constant, so every re-Connect collided
    // with the prior key; append a short unique suffix so reconnecting always
    // mints a fresh key. The host keeps it recognizable in the cloud.near.ai
    // console.
    let name = format!(
        "IronClaw Desktop {} {}",
        hostname().unwrap_or_else(|| "mac".into()),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let resp = client
        .post(format!("{CLOUD_API}/v1/workspaces/{workspace_id}/api-keys"))
        .bearer_auth(access_token)
        .header("User-Agent", "ironclaw-desktop")
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| format!("create api key request: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "NEAR AI rejected the API-key request (HTTP {status}). Sign-in worked — you can finish by creating a key at cloud.near.ai and pasting it."
        ));
    }
    let parsed: ApiKeyResp = serde_json::from_str(&text)
        .map_err(|e| format!("could not parse the API-key response: {e}"))?;
    parsed
        .key
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            "NEAR AI created the key but did not return its secret; create a key at cloud.near.ai and paste it instead.".to_string()
        })
}

/// Find the user's first workspace; bootstrap an organization (which
/// auto-creates a "default" workspace) if the account has none yet.
async fn resolve_workspace_id(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<String, String> {
    if let Some(id) = first_workspace_id(client, access_token).await? {
        return Ok(id);
    }
    // No workspace yet — create an organization (the cloud-api handler
    // auto-provisions a "default" workspace) and re-read.
    let _ = client
        .post(format!("{CLOUD_API}/v1/organizations"))
        .bearer_auth(access_token)
        .header("User-Agent", "ironclaw-desktop")
        .json(&serde_json::json!({ "name": "IronClaw" }))
        .send()
        .await
        .map_err(|e| format!("create organization request: {e}"))?;
    first_workspace_id(client, access_token)
        .await?
        .ok_or_else(|| {
            "Signed in, but no NEAR AI workspace is available to mint a key in.".to_string()
        })
}

async fn first_workspace_id(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Option<String>, String> {
    let resp = client
        .get(format!("{CLOUD_API}/v1/users/me"))
        .bearer_auth(access_token)
        .header("User-Agent", "ironclaw-desktop")
        .send()
        .await
        .map_err(|e| format!("users/me request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "NEAR AI did not accept the sign-in token (HTTP {}).",
            resp.status()
        ));
    }
    let me: MeResponse = resp
        .json()
        .await
        .map_err(|e| format!("could not parse users/me: {e}"))?;
    let workspaces = me.workspaces.unwrap_or_default();
    // Prefer an active workspace, else the first one.
    let chosen = workspaces
        .iter()
        .find(|w| w.is_active.unwrap_or(true))
        .or_else(|| workspaces.first())
        .map(|w| w.id.clone());
    Ok(chosen)
}

fn hostname() -> Option<String> {
    std::process::Command::new("/bin/hostname")
        .arg("-s")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Connect to NEAR AI Cloud in the system browser, mint an `sk-` API key, and
/// vault it. The WebUI restarts the sidecar afterwards so it picks up the key.
#[tauri::command]
pub async fn nearai_connect_loopback(
    app: AppHandle,
    provider: String,
    profile_id: Option<String>,
) -> Result<(), String> {
    if provider != "github" && provider != "google" {
        return Err(format!(
            "unsupported provider for browser connect: {provider} (use github or google)"
        ));
    }
    let profile_id = match profile_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => {
            let settings = crate::settings::load(&app)?;
            crate::sidecar_boot_selection_from_settings(&settings).profile_id
        }
    };

    let (listener, port) = bind_loopback()?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let callback = format!("http://127.0.0.1:{port}/callback/{nonce}");
    let auth_url = format!(
        "{CLOUD_API}/v1/auth/{provider}?frontend_callback={}",
        urlencode(&callback)
    );

    open_in_browser(&auth_url)?;

    let nonce_for_thread = nonce.clone();
    let tokens = tauri::async_runtime::spawn_blocking(move || {
        serve_until_token(listener, &nonce_for_thread, CONNECT_TIMEOUT)
    })
    .await
    .map_err(|e| format!("sign-in wait: {e}"))??;

    // The access token is the control-plane bearer used to mint the data-plane
    // key; fall back to the refresh token only if the access token is absent.
    let access = tokens
        .token
        .filter(|t| !t.trim().is_empty())
        .or(tokens.refresh_token)
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "NEAR AI sign-in did not return a usable token".to_string())?;

    let api_key = mint_api_key(&access).await?;
    crate::keychain::set_llm_provider_credential(&profile_id, "nearai", &api_key)?;
    Ok(())
}

/// Minimal percent-encoding for the callback URL value (RFC 3986 unreserved set
/// stays; everything else is %XX). Avoids pulling a URL crate just for this.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_escapes_callback_url() {
        assert_eq!(
            urlencode("http://127.0.0.1:8765/callback/abc-123"),
            "http%3A%2F%2F127.0.0.1%3A8765%2Fcallback%2Fabc-123"
        );
    }

    #[test]
    fn find_subslice_locates_header_terminator() {
        assert_eq!(
            find_subslice(b"GET / HTTP/1.1\r\n\r\nbody", b"\r\n\r\n"),
            Some(14)
        );
        assert_eq!(find_subslice(b"no terminator", b"\r\n\r\n"), None);
    }

    #[test]
    fn captured_tokens_parse_from_fragment_json() {
        let t: CapturedTokens =
            serde_json::from_str(r#"{"token":"acc","refresh_token":"rt_x"}"#).unwrap();
        assert_eq!(t.token.as_deref(), Some("acc"));
        assert_eq!(t.refresh_token.as_deref(), Some("rt_x"));
    }
}
