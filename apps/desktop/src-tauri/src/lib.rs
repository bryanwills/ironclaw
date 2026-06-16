// IronClaw Desktop — Tauri command surface.
//
// The packaged Reborn static WebUI calls these via @tauri-apps/api invoke().
// Settings live on disk (as an opaque JSON blob — the WebUI owns the
// schema, see the Profiles system); the bearer token (and OpenRouter
// key, and the auto-generated local-gateway token) live in the macOS
// Keychain.
//
// Profile-scoped credentials: `get_token` / `set_token` / `delete_token`
// (and the OpenRouter equivalents) all take a `profile_id`. The legacy
// suffix-less Keychain entries are auto-migrated to `:default` on first
// read — see `keychain::promote_legacy_if_needed`.
//
// The Local Sidecar mode (`mode: 'local'`) spawns the bundled IronClaw
// binary as a child process. Lifecycle is managed via `SidecarState`,
// exposed through `start_sidecar` / `stop_sidecar` / `sidecar_status`.

#[cfg(all(not(debug_assertions), dev))]
compile_error!(
    "Release builds must enable the custom-protocol feature so Tauri embeds frontendDist instead of loading build.devUrl."
);

mod crashes;
mod fs_mount;
mod ironhub;
mod keychain;
mod nearai_connect;
mod nearai_login;
mod notes_export;
mod ocr_assets;
mod sandbox_exec;
mod settings;
mod sidecar;
mod spotlight;
mod tray;
mod tts;
mod windows;

use crashes::CrashEntry;
use serde::{Deserialize, Serialize};
use settings::AppSettings;
use sidecar::{BackendConfig, SidecarState, SidecarStatus};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Tagged backend kind passed from the frontend to `start_sidecar`. Mirrors
/// the JS `LlmBackend` type but kept narrow so the IPC payload stays
/// explicit at the boundary. NEAR.AI Cloud is the product path; advanced
/// bring-your-own-key providers go through `provider_id` instead.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BackendKind {
    Nearai,
}

#[derive(Debug, Deserialize)]
struct GatewayHttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    data: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
struct GatewayHttpResponse {
    status: u16,
    status_text: String,
    url: String,
    headers: Vec<(String, String)>,
    data: Vec<u8>,
}

const GATEWAY_HTTP_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

// ---- Settings -------------------------------------------------------------

// =============================================================================
// !!! DO NOT REMOVE diag_log without an explicit ship-prep ticket !!!
//
// This is the side-channel that surfaces frontend state into RUST_LOG when
// devtools are unavailable (release builds, signed bundles). Used by
// connection.svelte.ts and api/ironclaw.ts to confirm token loads + every
// HTTP request goes through the Tauri http plugin. Removing this — or the
// JS-side calls — re-blinds the production debug story.
//
// Tagged log target so it's trivial to grep: RUST_LOG=ironclaw_diag=info.
// =============================================================================

/// Diagnostic side-channel: JS can pump strings to Rust stderr so the
/// (devtools-less) production .app surfaces frontend state through the
/// already-captured RUST_LOG pipeline. Removed only as part of an
/// explicit ship-prep round once a Sentry-style telemetry surface lands.
#[tauri::command]
fn diag_log(msg: String) {
    log::info!(target: "ironclaw_diag", "{msg}");
}

#[tauri::command]
async fn gateway_http_fetch(
    app: AppHandle,
    request: GatewayHttpRequest,
) -> Result<GatewayHttpResponse, String> {
    let request_url = request.url.clone();
    log::info!(
        target: "ironclaw_gateway",
        "gateway_http_fetch start method={} url={}",
        request.method,
        request_url
    );
    // SSRF guard: this command fetches an arbitrary caller-supplied URL with
    // caller-supplied headers (which carry the gateway bearer token). Restrict
    // it to loopback (the bundled sidecar) or the active profile's configured
    // gateway origin so a hostile WebView payload can't pivot it into a
    // credential-exfil / internal-network probe primitive. Fails closed.
    if !is_allowed_gateway_url(&app, &request_url) {
        log::warn!(
            target: "ironclaw_gateway",
            "gateway_http_fetch rejected non-allowlisted url={}",
            request_url
        );
        return Err(format!("gateway URL not allowed: {request_url}"));
    }
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|e| format!("invalid HTTP method {}: {e}", request.method))?;
    let client = build_gateway_http_client()?;

    let mut builder = client.request(method, &request_url);
    for (header_name, header_value) in filtered_gateway_request_headers(request.headers) {
        builder = builder.header(header_name, header_value);
    }
    if let Some(data) = request.data {
        builder = builder.body(data);
    }

    let response = match builder.send().await {
        Ok(response) => response,
        Err(err) => {
            log::warn!(
                target: "ironclaw_gateway",
                "gateway_http_fetch send failed url={}: {}",
                request_url,
                err
            );
            return Err(format!("gateway HTTP send {}: {err}", request_url));
        }
    };
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let url = response.url().to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect::<Vec<_>>();
    let data = read_gateway_response_body_with_limit(
        response,
        GATEWAY_HTTP_MAX_RESPONSE_BYTES,
        &request_url,
    )
    .await?;

    log::info!(
        target: "ironclaw_gateway",
        "gateway_http_fetch done status={} url={}",
        status.as_u16(),
        url
    );

    Ok(GatewayHttpResponse {
        status: status.as_u16(),
        status_text,
        url,
        headers,
        data,
    })
}

fn build_gateway_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Trust boundary: the WebView supplies both URL and Authorization
        // header. Never follow a server-provided Location with that bearer.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8))
        .connect_timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| format!("build HTTP client: {e}"))
}

fn gateway_request_header_allowed(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "content-length"
            | "cookie"
            | "cookie2"
            | "forwarded"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "x-forwarded-for"
            | "x-forwarded-host"
            | "x-forwarded-proto"
            | "x-real-ip"
    )
}

fn filtered_gateway_request_headers(
    headers: Vec<(String, String)>,
) -> Vec<(reqwest::header::HeaderName, reqwest::header::HeaderValue)> {
    headers
        .into_iter()
        .filter(|(name, _)| gateway_request_header_allowed(name))
        .filter_map(|(name, value)| {
            let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).ok()?;
            let header_value = reqwest::header::HeaderValue::from_str(&value).ok()?;
            Some((header_name, header_value))
        })
        .collect()
}

async fn read_gateway_response_body_with_limit(
    mut response: reqwest::Response,
    max_bytes: usize,
    request_url: &str,
) -> Result<Vec<u8>, String> {
    if let Some(content_length) = response.content_length() {
        if content_length > max_bytes as u64 {
            return Err(format!(
                "gateway HTTP body {request_url}: response too large ({content_length} > {max_bytes} bytes)"
            ));
        }
    }

    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("gateway HTTP body {request_url}: {e}"))?
    {
        let next_len = data
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| format!("gateway HTTP body {request_url}: response too large"))?;
        if next_len > max_bytes {
            return Err(format!(
                "gateway HTTP body {request_url}: response too large (>{max_bytes} bytes)"
            ));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

/// True if `host` is a loopback name/address. The bundled sidecar always binds
/// here, so loopback is allowed unconditionally regardless of stored settings.
fn host_is_loopback(host: &str) -> bool {
    if matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return true;
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// `host[:port]` (lowercased host) for a parsed URL, the comparison key used to
/// match a request against the active profile's configured gateway origin.
fn url_host_port(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    match url.port_or_known_default() {
        Some(port) => Some(format!("{host}:{port}")),
        None => Some(host),
    }
}

/// The active profile's configured gateway `host:port`, read from the opaque
/// settings blob (the same `profiles[]` / `activeProfileId` shape the JS schema
/// owns and `sidecar_boot_selection_from_settings` consumes). `None` on any
/// miss — no settings, no profiles, or an unparseable base URL.
fn active_profile_gateway_origin(app: &AppHandle) -> Option<String> {
    let settings = settings::load(app).ok()?;
    let profiles = settings
        .get("profiles")
        .and_then(|value| value.as_array())?;
    let active_profile_id = settings
        .get("activeProfileId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let profile = active_profile_id
        .and_then(|id| {
            profiles.iter().find(|profile| {
                profile
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|candidate| candidate == id)
                    .unwrap_or(false)
            })
        })
        .or_else(|| profiles.first())?;

    let base_field = match profile.get("mode").and_then(|value| value.as_str()) {
        Some("local") => "localBaseUrl",
        _ => "remoteBaseUrl",
    };
    let base = profile.get(base_field).and_then(|value| value.as_str())?;
    let base_url = reqwest::Url::parse(base.trim()).ok()?;
    url_host_port(&base_url)
}

/// Pure SSRF-allowlist decision: permits `raw` only when the scheme is
/// `http`/`https` AND the host is loopback (the bundled sidecar — always
/// allowed) OR its `host:port` matches `allowed_origin` (the active profile's
/// configured gateway origin). Fails closed on any parse failure / miss.
/// Split out from `is_allowed_gateway_url` so the policy is unit-testable
/// without an `AppHandle`.
fn gateway_url_allowed_against(raw: &str, allowed_origin: Option<&str>) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if host_is_loopback(host) {
        return true;
    }
    let Some(target) = url_host_port(&url) else {
        return false;
    };
    allowed_origin == Some(target.as_str())
}

/// SSRF allowlist for `gateway_http_fetch`. Loopback (the bundled sidecar) is
/// always allowed; everything else must match the active profile's configured
/// gateway origin. See `gateway_url_allowed_against` for the policy.
fn is_allowed_gateway_url(app: &AppHandle, raw: &str) -> bool {
    let allowed_origin = active_profile_gateway_origin(app);
    gateway_url_allowed_against(raw, allowed_origin.as_deref())
}

#[cfg(test)]
mod gateway_ssrf_tests {
    use crate::{
        build_gateway_http_client, filtered_gateway_request_headers, gateway_url_allowed_against,
        read_gateway_response_body_with_limit,
    };
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn loopback_allowed_regardless_of_origin() {
        assert!(gateway_url_allowed_against(
            "http://127.0.0.1:3100/api/gateway/status",
            None
        ));
        assert!(gateway_url_allowed_against("http://localhost:3100/", None));
        assert!(gateway_url_allowed_against("http://[::1]:3100/", None));
    }

    #[test]
    fn external_hosts_rejected() {
        // Cloud-metadata SSRF target and an arbitrary external host: both
        // rejected, even when an unrelated origin is configured.
        assert!(!gateway_url_allowed_against(
            "http://169.254.169.254/",
            Some("gateway.example.test:3100")
        ));
        assert!(!gateway_url_allowed_against(
            "http://evil.example.com/",
            Some("gateway.example.test:3100")
        ));
        // No configured origin at all → only loopback would pass.
        assert!(!gateway_url_allowed_against(
            "http://evil.example.com/",
            None
        ));
    }

    #[test]
    fn configured_origin_allowed_non_http_scheme_rejected() {
        assert!(gateway_url_allowed_against(
            "https://gateway.example.test:3100/api/gateway/status",
            Some("gateway.example.test:3100")
        ));
        // Scheme outside http/https is rejected even for an allowed host.
        assert!(!gateway_url_allowed_against(
            "file://gateway.example.test/etc/passwd",
            Some("gateway.example.test:3100")
        ));
    }

    #[test]
    fn strips_cookie_proxy_and_forwarding_headers() {
        let headers = filtered_gateway_request_headers(vec![
            ("Authorization".into(), "Bearer local-token".into()),
            ("Cookie".into(), "sid=secret".into()),
            ("Proxy-Authorization".into(), "Basic secret".into()),
            ("X-Forwarded-For".into(), "10.0.0.7".into()),
            ("Forwarded".into(), "for=10.0.0.7".into()),
            ("Content-Length".into(), "999".into()),
            ("Accept".into(), "application/json".into()),
        ]);
        let names = headers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["authorization", "accept"]);
    }

    #[tokio::test]
    async fn gateway_client_does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/leak\r\nContent-Length: 0\r\n\r\n",
                )
                .unwrap();
        });

        let client = build_gateway_http_client().unwrap();
        let response = client
            .get(format!("http://{addr}/redirect"))
            .header("Authorization", "Bearer must-not-leak")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        assert_eq!(response.url().as_str(), format!("http://{addr}/redirect"));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn body_reader_rejects_large_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n")
                .unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/oversize"))
            .await
            .unwrap();
        let err = read_gateway_response_body_with_limit(response, 8, "http://test/oversize")
            .await
            .unwrap_err();
        assert!(err.contains("response too large"));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn body_reader_rejects_chunked_body_over_limit() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n")
                .unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/chunked"))
            .await
            .unwrap();
        let err = read_gateway_response_body_with_limit(response, 8, "http://test/chunked")
            .await
            .unwrap_err();
        assert!(err.contains("response too large"));
        handle.join().unwrap();
    }
}

fn packaged_webview_smoke_enabled() -> bool {
    std::env::var("IRONCLAW_PACKAGED_WEBVIEW_SMOKE")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn packaged_webview_smoke_ocr_enabled() -> bool {
    std::env::var("IRONCLAW_PACKAGED_WEBVIEW_SMOKE_OCR")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn packaged_webview_smoke_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(path) = std::env::var_os("IRONCLAW_PACKAGED_WEBVIEW_SMOKE_EVIDENCE") {
        return Ok(std::path::PathBuf::from(path));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?
        .join("smoke");
    let generated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(dir.join(format!("packaged-webview-smoke-{generated_at}.json")))
}

/// Packaged-app test hook. The command is intentionally inert unless the
/// smoke harness opts in with IRONCLAW_PACKAGED_WEBVIEW_SMOKE=1; the shared
/// static UI can call it safely on every load without exposing a user-facing
/// action or filesystem write path.
#[tauri::command]
async fn packaged_smoke_request(app: AppHandle) -> Result<serde_json::Value, String> {
    let enabled = packaged_webview_smoke_enabled();
    let evidence_path = if enabled {
        Some(
            packaged_webview_smoke_path(&app)?
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        None
    };
    if enabled {
        log::info!(
            target: "ironclaw_packaged_smoke",
            "WebView smoke requested evidence_path={}",
            evidence_path.as_deref().unwrap_or("")
        );
    }
    Ok(serde_json::json!({
        "enabled": enabled,
        "ocr_enabled": enabled && packaged_webview_smoke_ocr_enabled(),
        "evidence_path": evidence_path,
        "schema": "ironclaw-packaged-webview-smoke-request.v1",
    }))
}

#[tauri::command]
async fn packaged_smoke_report(
    app: AppHandle,
    report: serde_json::Value,
) -> Result<String, String> {
    if !packaged_webview_smoke_enabled() {
        return Err("packaged WebView smoke is disabled".into());
    }

    let path = packaged_webview_smoke_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let written_at_epoch_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let evidence_path = path.to_string_lossy().into_owned();
    log::info!(
        target: "ironclaw_packaged_smoke",
        "WebView smoke report writing evidence_path={}",
        evidence_path
    );
    let payload = match report {
        serde_json::Value::Object(mut map) => {
            map.insert(
                "written_at_epoch_seconds".into(),
                serde_json::json!(written_at_epoch_seconds),
            );
            map.insert("evidence_path".into(), serde_json::json!(evidence_path));
            serde_json::Value::Object(map)
        }
        other => serde_json::json!({
            "schema": "ironclaw-packaged-webview-smoke.v1",
            "written_at_epoch_seconds": written_at_epoch_seconds,
            "evidence_path": evidence_path,
            "report": other,
        }),
    };
    let bytes =
        serde_json::to_vec_pretty(&payload).map_err(|e| format!("serialize smoke report: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    log::info!(
        target: "ironclaw_diag",
        "packaged WebView smoke evidence written to {}",
        path.display()
    );
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    settings::load(&app)
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    settings::save(&app, &settings)
}

// ---- Gateway-token Keychain (per-profile) --------------------------------

#[tauri::command]
async fn get_token(app: AppHandle, profile_id: String) -> Result<Option<String>, String> {
    keychain::get(&app, &profile_id)
}

#[tauri::command]
async fn set_token(app: AppHandle, profile_id: String, token: String) -> Result<(), String> {
    keychain::set(&app, &profile_id, &token)
}

#[tauri::command]
async fn delete_token(app: AppHandle, profile_id: String) -> Result<(), String> {
    keychain::delete(&app, &profile_id)
}

/// Reports the backing store the gateway-token was actually loaded from.
/// One of `"keychain"`, `"file"`, or `"absent"`. Lets the Settings page
/// surface a visible badge so the user can tell whether the macOS keychain
/// ACL prompt is wedged on their machine (a frequent source of confusing
/// "Disconnected" failures on fresh ad-hoc-signed builds — see v0.2.8).
#[tauri::command]
async fn get_token_source(app: AppHandle, profile_id: String) -> Result<String, String> {
    keychain::get_source(&app, &profile_id)
}

/// Describes how the running binary was built. Lets the About dialog
/// signal to a user whether they're on an Apple-notarised release
/// (`signing: "developer-id"`), the ad-hoc dev/CI bundle
/// (`signing: "adhoc"`), or an unsigned build straight out of cargo.
/// Also reports whether devtools + diag scaffolding are compiled in.
///
/// Schema v1:
///   {
///     "version": "0.2.10",
///     "profile":  "release" | "debug",
///     "devtools": bool,
///     "signing":  "developer-id" | "adhoc" | "unsigned" | "unknown",
///     "build_kind": "public" | "support" | "dev",
///   }
#[tauri::command]
async fn build_provenance(app: AppHandle) -> Result<serde_json::Value, String> {
    let version = env!("CARGO_PKG_VERSION").to_string();
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    let devtools = cfg!(feature = "dev-devtools");
    // Probe the running .app's signature via `codesign -dvv`. Anything we
    // can't determine resolves to "unknown" — the field is informational,
    // not enforced.
    let exe = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    let signing = exe
        .as_ref()
        .map(|app_path| {
            let out = std::process::Command::new("codesign")
                .args(["-dvv", "--"])
                .arg(app_path)
                .output();
            match out {
                Ok(o) => {
                    let combined = format!(
                        "{}{}",
                        String::from_utf8_lossy(&o.stdout),
                        String::from_utf8_lossy(&o.stderr)
                    );
                    if combined.contains("Developer ID Application") {
                        "developer-id"
                    } else if combined.contains("adhoc") {
                        "adhoc"
                    } else if combined.contains("not signed") || !combined.contains("Signature") {
                        "unsigned"
                    } else {
                        "unknown"
                    }
                }
                Err(_) => "unknown",
            }
        })
        .unwrap_or("unknown");
    let build_kind = if profile == "debug" {
        "dev"
    } else if devtools {
        "support"
    } else {
        "public"
    };
    Ok(serde_json::json!({
        "schema": "ironclaw-build-provenance.v1",
        "version": version,
        "profile": profile,
        "devtools": devtools,
        "signing": signing,
        "build_kind": build_kind,
    }))
}

/// Self-describing diagnostic blob the user can paste into an issue. Includes
/// the app version, the host OS / arch / kernel, the active token source
/// (without the token value), and a snapshot of in-process state that's
/// frequently relevant to "Disconnected" / connectivity tickets.
///
/// Intentionally **does not** include secrets — the bearer never appears in
/// the output, only its length and source. Tokens stay in their stores.
#[tauri::command]
async fn diagnostic_report(
    app: AppHandle,
    profile_id: String,
) -> Result<serde_json::Value, String> {
    let token_source = keychain::get_source(&app, &profile_id).unwrap_or_else(|_| "error".into());
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("ERR: {e}"));
    let kernel = std::process::Command::new("uname")
        .args(["-srm"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    let sw_vers = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    let arch = std::env::consts::ARCH.to_string();
    let pkg_version = env!("CARGO_PKG_VERSION").to_string();

    Ok(serde_json::json!({
        "schema": "ironclaw-diagnostic-report.v1",
        "generated_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "app": {
            "name": "IronClaw Desktop",
            "version": pkg_version,
            "bundle_id": "com.openclaw.ironclaw-desktop",
            "app_data_dir": app_data_dir,
        },
        "host": {
            "os": "macOS",
            "os_version": sw_vers,
            "arch": arch,
            "kernel": kernel,
        },
        "profile": {
            "id": profile_id,
            "token_source": token_source,
        },
    }))
}

// ---- IronHub catalog -----------------------------------------------------
//
// Browse + install entrypoints for github.com/nearai/ironhub. See
// `src-tauri/src/ironhub.rs` for the cache + fetch logic. The commands
// here are thin Tauri wrappers; the heavy lifting lives in the module.

#[tauri::command]
async fn list_ironhub_catalog(
    app: AppHandle,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    ironhub::list_catalog(app, force.unwrap_or(false)).await
}

#[tauri::command]
async fn fetch_ironhub_skill(slug: String) -> Result<serde_json::Value, String> {
    ironhub::fetch_skill(slug).await
}

#[tauri::command]
async fn install_ironhub_skill_local(
    state: State<'_, SidecarState>,
    slug: String,
) -> Result<serde_json::Value, String> {
    ironhub::install_skill_local(state, slug).await
}

// ---- OCR asset loopback server --------------------------------------------

/// Endpoint for the loopback server that feeds tesseract's worker its assets.
/// WKWebView workers cannot fetch tauri:// URLs, so OCR assets ride plain
/// localhost HTTP behind a per-boot path token. Started lazily on first
/// request.
#[tauri::command]
async fn ocr_assets_port(app: AppHandle) -> Result<ocr_assets::OcrAssetEndpoint, String> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        // bundle.resources flattens `../crates/.../static/ocr/*` under
        // `_up_/crates/.../static/ocr` inside Contents/Resources.
        roots.push(
            resources
                .join("_up_")
                .join("crates")
                .join("ironclaw_webui_v2_static")
                .join("static")
                .join("ocr"),
        );
        roots.push(resources.join("ocr"));
    }
    // Dev fallback: repo checkout layout relative to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(target_dir) = exe.ancestors().nth(3) {
            roots.push(
                target_dir
                    .join("..")
                    .join("crates")
                    .join("ironclaw_webui_v2_static")
                    .join("static")
                    .join("ocr"),
            );
        }
    }
    ocr_assets::ensure_started(roots)
}

// ---- Per-provider LLM credentials (LLM picker) ---------------------------
//
// Keyed on the provider id from the gateway's catalog. Used by the
// LlmProviderPicker for providers that aren't NEAR.AI (session-token).
//
// Slot format: `llm-<provider-id>:<profile-id>` (see keychain.rs).

#[tauri::command]
async fn get_llm_provider_credential(
    _app: AppHandle,
    profile_id: String,
    provider_id: String,
) -> Result<Option<String>, String> {
    keychain::get_llm_provider_credential(&profile_id, &provider_id)
}

#[tauri::command]
async fn has_llm_provider_credential(
    _app: AppHandle,
    profile_id: String,
    provider_id: String,
) -> Result<bool, String> {
    let provider_id = provider_id.trim();
    let keychain_credential = keychain::get_llm_provider_credential(&profile_id, provider_id)?;
    let keychain_configured = keychain_credential
        .as_deref()
        .map(str::trim)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    let env_configured = match provider_id {
        "nearai" => {
            env_secret("NEARAI_SESSION_TOKEN").is_some() || env_secret("NEARAI_API_KEY").is_some()
        }
        "openai" => env_secret("OPENAI_API_KEY").is_some(),
        "anthropic" => env_secret("ANTHROPIC_API_KEY").is_some(),
        _ => false,
    };
    Ok(keychain_configured || env_configured)
}

#[tauri::command]
async fn set_llm_provider_credential(
    _app: AppHandle,
    profile_id: String,
    provider_id: String,
    value: String,
) -> Result<(), String> {
    keychain::set_llm_provider_credential(&profile_id, &provider_id, &value)
}

#[tauri::command]
async fn delete_llm_provider_credential(
    _app: AppHandle,
    profile_id: String,
    provider_id: String,
) -> Result<(), String> {
    keychain::delete_llm_provider_credential(&profile_id, &provider_id)
}

#[tauri::command]
async fn get_or_create_local_token(app: AppHandle) -> Result<String, String> {
    keychain::get_or_create_local_token(&app)
}

/// Set the main window's native webview zoom (browser-style uniform scale, so the
/// layout never reflow-breaks). Driven by the JS Cmd/Ctrl +/-/0 handler, which
/// persists the factor in localStorage and re-applies it on boot. Clamped to a
/// sane range. Returns the applied factor.
#[tauri::command]
async fn set_webview_zoom(app: AppHandle, factor: f64) -> Result<f64, String> {
    let clamped = if factor.is_finite() {
        factor.clamp(0.5, 3.0)
    } else {
        1.0
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .set_zoom(clamped)
        .map_err(|e| format!("set webview zoom: {e}"))?;
    Ok(clamped)
}

// ---- Sidecar lifecycle ----------------------------------------------------

#[tauri::command]
async fn start_sidecar(
    app: AppHandle,
    state: State<'_, SidecarState>,
    backend: Option<BackendKind>,
    provider_id: Option<String>,
    model_id: Option<String>,
    profile_id: String,
) -> Result<u16, String> {
    // Default to NEAR.AI Cloud — IronClaw's built-in inference path and the
    // product default. NEAR.AI needs no Keychain read at spawn; IronClaw
    // handles auth via its own onboard/login flow.
    //
    // The local-gateway bearer is global — there is one bundled sidecar per
    // app install regardless of how many profiles are configured.
    //
    // `provider_id` is the richer field from the new LlmProviderPicker.
    // When present (and non-empty) it wins over the binary `backend`
    // enum; when absent we fall through to `backend`. This v1 wires
    // three providers explicitly: nearai, openai, anthropic. Other ids
    // fall through to an "unsupported provider" error so misconfiguration
    // surfaces loudly rather than silently spawning NEAR.AI.
    let provider = provider_id
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let backend_cfg = match provider {
        Some("nearai") => {
            let (api_key, session_token) = nearai_credential_for_profile(&profile_id);
            BackendConfig::Nearai {
                model: clean_model_id(model_id.as_deref()),
                session_token,
                api_key,
            }
        }
        Some("openai") => {
            let api_key = keychain::get_llm_provider_credential(&profile_id, "openai")?
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "Set your OpenAI API key in Settings before starting local mode".to_string()
                })?;
            BackendConfig::OpenAi {
                api_key,
                model: clean_model_id(model_id.as_deref()),
            }
        }
        Some("anthropic") => {
            let api_key = keychain::get_llm_provider_credential(&profile_id, "anthropic")?
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "Set your Anthropic API key in Settings before starting local mode".to_string()
                })?;
            BackendConfig::Anthropic {
                api_key,
                model: clean_model_id(model_id.as_deref()),
            }
        }
        Some(other) => {
            return Err(format!(
                "LLM provider \"{other}\" is not yet wired in the desktop sidecar. \
                 Supported providers: nearai, openai, anthropic."
            ));
        }
        None => {
            let BackendKind::Nearai = backend.unwrap_or(BackendKind::Nearai);
            let (api_key, session_token) = nearai_credential_for_profile(&profile_id);
            BackendConfig::Nearai {
                model: clean_model_id(model_id.as_deref()),
                session_token,
                api_key,
            }
        }
    };
    let gateway_token = keychain::get_or_create_local_token(&app)?;
    sidecar::spawn(app, state, backend_cfg, gateway_token).await
}

fn clean_model_id(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn clean_config_string(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn env_secret(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .and_then(|value| clean_config_string(Some(&value)))
}

/// Resolve the NEAR.AI credential for a profile and classify it so the sidecar
/// routes to the right host. A NEAR AI Cloud API key (`sk-…`, used at
/// cloud-api.near.ai) travels as `api_key`; a NEP-413 wallet/browser session
/// token (used at private.near.ai) travels as `session_token`. The desktop
/// keychain slot is shared (`llm-nearai:<profile>`) and written by both the
/// API-key paste and the browser-login flow; env vars are the developer
/// fallback. Never returns both — the two hosts expect different credentials.
/// Returns `(api_key, session_token)`.
fn nearai_credential_for_profile(profile_id: &str) -> (Option<String>, Option<String>) {
    let stored = keychain::get_llm_provider_credential(profile_id, "nearai")
        .ok()
        .flatten()
        .and_then(|value| clean_config_string(Some(&value)));
    let (stored_api, stored_session) = match stored {
        Some(value) if value.starts_with("sk-") => (Some(value), None),
        Some(value) => (None, Some(value)),
        None => (None, None),
    };
    (
        stored_api.or_else(|| env_secret("NEARAI_API_KEY")),
        stored_session.or_else(|| env_secret("NEARAI_SESSION_TOKEN")),
    )
}

#[derive(Debug, Clone)]
struct SidecarBootSelection {
    profile_id: String,
    provider_id: Option<String>,
    backend: Option<BackendKind>,
    model_id: Option<String>,
}

impl Default for SidecarBootSelection {
    fn default() -> Self {
        Self {
            profile_id: "default".into(),
            provider_id: Some("nearai".into()),
            backend: Some(BackendKind::Nearai),
            model_id: None,
        }
    }
}

fn sidecar_boot_selection_from_settings(settings: &AppSettings) -> SidecarBootSelection {
    let Some(profiles) = settings.get("profiles").and_then(|value| value.as_array()) else {
        return SidecarBootSelection::default();
    };
    let active_profile_id = settings
        .get("activeProfileId")
        .and_then(|value| value.as_str())
        .and_then(|value| clean_config_string(Some(value)));
    let active_profile = active_profile_id
        .as_deref()
        .and_then(|id| {
            profiles.iter().find(|profile| {
                profile
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|candidate| candidate == id)
                    .unwrap_or(false)
            })
        })
        .or_else(|| profiles.first());
    let Some(profile) = active_profile else {
        return SidecarBootSelection::default();
    };

    let profile_id = profile
        .get("id")
        .and_then(|value| value.as_str())
        .and_then(|value| clean_config_string(Some(value)))
        .unwrap_or_else(|| "default".into());
    let backend = match profile
        .get("llmBackend")
        .and_then(|value| value.as_str())
        .map(str::trim)
    {
        Some("nearai") => Some(BackendKind::Nearai),
        _ => None,
    };
    let provider_id = profile
        .get("llmProviderId")
        .and_then(|value| value.as_str())
        .and_then(|value| clean_config_string(Some(value)))
        .or_else(|| {
            profile
                .get("llmBackend")
                .and_then(|value| value.as_str())
                .and_then(|value| clean_config_string(Some(value)))
        });
    let model_id = profile
        .get("llmModelId")
        .and_then(|value| value.as_str())
        .and_then(|value| clean_model_id(Some(value)));

    SidecarBootSelection {
        profile_id,
        provider_id,
        backend,
        model_id,
    }
}

fn backend_config_for_selection(selection: &SidecarBootSelection) -> Result<BackendConfig, String> {
    let provider = selection
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|provider| !provider.is_empty());
    match provider {
        Some("nearai") => {
            let (api_key, session_token) = nearai_credential_for_profile(&selection.profile_id);
            Ok(BackendConfig::Nearai {
                model: selection.model_id.clone(),
                session_token,
                api_key,
            })
        }
        Some("openai") => {
            let api_key = keychain::get_llm_provider_credential(&selection.profile_id, "openai")?
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "Set your OpenAI API key in Settings before starting local mode".to_string()
                })?;
            Ok(BackendConfig::OpenAi {
                api_key,
                model: selection.model_id.clone(),
            })
        }
        Some("anthropic") => {
            let api_key =
                keychain::get_llm_provider_credential(&selection.profile_id, "anthropic")?
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        "Set your Anthropic API key in Settings before starting local mode"
                            .to_string()
                    })?;
            Ok(BackendConfig::Anthropic {
                api_key,
                model: selection.model_id.clone(),
            })
        }
        Some(other) => Err(format!(
            "LLM provider \"{other}\" is not yet wired in the desktop sidecar. \
             Supported providers: nearai, openai, anthropic."
        )),
        None => {
            let BackendKind::Nearai = selection.backend.unwrap_or(BackendKind::Nearai);
            let (api_key, session_token) = nearai_credential_for_profile(&selection.profile_id);
            Ok(BackendConfig::Nearai {
                model: selection.model_id.clone(),
                session_token,
                api_key,
            })
        }
    }
}

#[cfg(test)]
mod runtime_model_auth_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sidecar_boot_selection_uses_active_profile_provider_and_model() {
        let settings = json!({
            "activeProfileId": "work",
            "profiles": [
                {
                    "id": "default",
                    "llmBackend": "nearai",
                    "llmProviderId": "nearai",
                    "llmModelId": "auto"
                },
                {
                    "id": "work",
                    "llmBackend": "nearai",
                    "llmProviderId": "openai",
                    "llmModelId": "gpt-4o"
                }
            ]
        });

        let selection = sidecar_boot_selection_from_settings(&settings);

        assert_eq!(selection.profile_id, "work");
        assert_eq!(selection.provider_id.as_deref(), Some("openai"));
        assert_eq!(selection.model_id.as_deref(), Some("gpt-4o"));
        assert!(matches!(selection.backend, Some(BackendKind::Nearai)));
    }

    #[test]
    fn sidecar_boot_selection_falls_back_to_nearai_auto_intent() {
        let selection = sidecar_boot_selection_from_settings(&json!({}));

        assert_eq!(selection.profile_id, "default");
        assert_eq!(selection.provider_id.as_deref(), Some("nearai"));
        assert_eq!(selection.model_id, None);
        assert!(matches!(selection.backend, Some(BackendKind::Nearai)));
    }
}

#[cfg(unix)]
fn install_signal_shutdown(handle: &AppHandle) {
    let app_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};

        let term = signal(SignalKind::terminate());
        let int = signal(SignalKind::interrupt());
        let (Ok(mut term), Ok(mut int)) = (term, int) else {
            log::warn!(target: "ironclaw_sidecar", "failed to install SIGTERM/SIGINT shutdown handler");
            return;
        };

        let signal_name = tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        };
        log::info!(target: "ironclaw_sidecar", "{signal_name} received, stopping sidecar");
        let state = app_handle.state::<SidecarState>();
        if let Err(err) = sidecar::stop(state).await {
            log::warn!(target: "ironclaw_sidecar", "signal shutdown sidecar stop failed: {err}");
        }
        app_handle.exit(0);
    });
}

#[cfg(not(unix))]
fn install_signal_shutdown(_handle: &AppHandle) {}

#[tauri::command]
async fn stop_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    sidecar::stop(state).await
}

#[tauri::command]
async fn sidecar_status(state: State<'_, SidecarState>) -> Result<SidecarStatus, String> {
    Ok(sidecar::status(state).await)
}

// ---- Data-dir reveal (Local mode UX) -------------------------------------

#[tauri::command]
async fn local_data_dir(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    let dir = base.join("ironclaw-data");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
async fn reveal_in_finder(app: AppHandle, path: String) -> Result<(), String> {
    // R73 P1: restrict reveal targets to paths the app legitimately
    // owns. Without this, JS could probe filesystem existence of any
    // path by calling reveal_in_finder("/etc/passwd") and watching
    // for a non-error result. We allow the app data dir + the user's
    // Documents/Downloads (for the workspace-files surface).
    let resolved = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("path resolve: {e}"))?;

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let app_data_canon = app_data.canonicalize().unwrap_or(app_data.clone());
    let home_dir = app.path().home_dir().map_err(|e| e.to_string())?;
    let documents = home_dir.join("Documents");
    let downloads = home_dir.join("Downloads");

    let allowed_roots = [&app_data_canon, &documents, &downloads];
    let is_allowed = allowed_roots.iter().any(|root| resolved.starts_with(root));
    if !is_allowed {
        return Err(format!(
            "reveal_in_finder refused: path is outside app-owned roots ({})",
            resolved.display()
        ));
    }

    // `open -R <path>` reveals the item in Finder. Falls back to opening
    // the directory if `-R` isn't applicable for the target.
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(&resolved)
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("open exited with status {s}")),
        Err(e) => Err(format!("open: {e}")),
    }
}

// ---- Save-file dialog (chat / settings exports) --------------------------

/// Show the OS save-file dialog, then write `contents` to the chosen path.
///
/// Used by the chat surface to export a single thread (markdown or JSON) and
/// by Settings to bulk-export every conversation in one JSON blob. The
/// dialog runs the JS plugin's blocking-save shape but we call it through
/// Rust so we never expose the filesystem-write capability to the webview;
/// the only path that ever leaves Rust is the one the user picked.
///
/// Returns the saved path on success, or `None` if the user cancelled.
#[tauri::command]
async fn save_text_dialog(
    app: AppHandle,
    default_filename: String,
    contents: String,
) -> Result<Option<String>, String> {
    // `blocking_save_file` runs the native dialog and returns the chosen
    // FilePath (or None on cancel). It's blocking from the dialog plugin's
    // POV but the Tauri command runtime is fine with it inside an async fn —
    // we just need to make sure we don't call it from the main thread, so
    // we hop onto the blocking pool.
    let dialog = app.dialog().clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .set_file_name(&default_filename)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("dialog task: {e}"))?;

    let Some(path) = chosen else {
        return Ok(None);
    };
    // FilePath may be a URI on mobile, but on macOS desktop it always
    // resolves to a real filesystem path. `into_path()` does the right
    // thing here.
    let path_buf = path.into_path().map_err(|e| format!("resolve path: {e}"))?;
    std::fs::write(&path_buf, contents.as_bytes())
        .map_err(|e| format!("write {}: {e}", path_buf.display()))?;
    Ok(Some(path_buf.to_string_lossy().into_owned()))
}

/// Dependency-free standard base64 decode (with or without padding).
/// Tauri's IPC is JSON, so binary payloads cross as base64 strings; a JSON
/// number-array would be ~4x the size for multi-MB documents.
fn decode_base64_payload(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut reverse = [255u8; 256];
    for (i, &c) in TABLE.iter().enumerate() {
        reverse[c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u8;
    let mut saw_padding = false;
    let mut significant_len = 0usize;
    for &byte in input.as_bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            saw_padding = true;
            continue;
        }
        if saw_padding {
            return Err("invalid base64 data after padding".into());
        }
        let value = reverse[byte as usize];
        if value == 255 {
            return Err(format!("invalid base64 byte 0x{byte:02x}"));
        }
        significant_len += 1;
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if significant_len % 4 == 1 {
        return Err("invalid base64 length".into());
    }
    Ok(out)
}

fn smoke_save_filename(default_filename: &str) -> Result<std::ffi::OsString, String> {
    let trimmed = default_filename.trim();
    if trimmed.is_empty() || trimmed.ends_with('/') || trimmed.ends_with('\\') {
        return Err(format!("invalid filename: {default_filename}"));
    }
    let file_name = std::path::Path::new(default_filename)
        .file_name()
        .ok_or_else(|| format!("invalid filename: {default_filename}"))?;
    let display = file_name.to_string_lossy();
    if display.trim().is_empty()
        || matches!(display.as_ref(), "." | "..")
        || display.contains('/')
        || display.contains('\\')
    {
        return Err(format!("invalid filename: {default_filename}"));
    }
    Ok(file_name.to_os_string())
}

#[cfg(test)]
mod base64_payload_tests {
    use super::{decode_base64_payload, smoke_save_filename};

    #[test]
    fn decodes_padded_and_unpadded() {
        assert_eq!(decode_base64_payload("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64_payload("aGVsbG8").unwrap(), b"hello");
        assert_eq!(decode_base64_payload("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64_payload(" aGk= \n").unwrap(), b"hi");
    }

    #[test]
    fn round_trips_binary() {
        let bytes: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut encoded = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            encoded.push(TABLE[(n >> 18) as usize & 63] as char);
            encoded.push(TABLE[(n >> 12) as usize & 63] as char);
            encoded.push(if chunk.len() > 1 {
                TABLE[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            encoded.push(if chunk.len() > 2 {
                TABLE[n as usize & 63] as char
            } else {
                '='
            });
        }
        assert_eq!(decode_base64_payload(&encoded).unwrap(), bytes);
    }

    #[test]
    fn rejects_invalid_bytes() {
        assert!(decode_base64_payload("a!b").is_err());
        assert!(decode_base64_payload("a").is_err());
        assert!(decode_base64_payload("aG=k").is_err());
    }

    #[test]
    fn smoke_save_filename_strips_traversal_to_final_component() {
        assert_eq!(
            smoke_save_filename("../nested/report.pdf")
                .unwrap()
                .to_string_lossy(),
            "report.pdf"
        );
        assert_eq!(
            smoke_save_filename("/tmp/ironclaw/export.docx")
                .unwrap()
                .to_string_lossy(),
            "export.docx"
        );
    }

    #[test]
    fn smoke_save_filename_rejects_empty_dot_and_separator_components() {
        for invalid in ["", ".", "..", "../", "/tmp/", "nested\\escape.pdf"] {
            assert!(
                smoke_save_filename(invalid).is_err(),
                "expected {invalid:?} to be rejected"
            );
        }
    }
}

/// Binary twin of `save_text_dialog` — the route every export/download in the
/// WebView must take on desktop, because blob-URL anchor downloads are a
/// silent no-op in WKWebView (the gap that shipped "downloads don't work").
///
/// Under the packaged WebView smoke the dialog is bypassed and the file lands
/// in `$TMPDIR/ironclaw-smoke-saves/` — that seam lets the gauntlet prove a
/// real file reaches disk instead of only testing blob construction.
///
/// Returns the saved path on success, or `None` if the user cancelled.
#[tauri::command]
async fn save_bytes_dialog(
    app: AppHandle,
    default_filename: String,
    contents_base64: String,
) -> Result<Option<String>, String> {
    let bytes = decode_base64_payload(&contents_base64)?;

    if packaged_webview_smoke_enabled() {
        let dir = std::env::temp_dir().join("ironclaw-smoke-saves");
        std::fs::create_dir_all(&dir).map_err(|e| format!("smoke save dir: {e}"))?;
        // Take only the final path component so a caller-supplied `../` or an
        // absolute path can't escape the smoke-save directory.
        let file_name = smoke_save_filename(&default_filename)?;
        let path = dir.join(file_name);
        std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
        return Ok(Some(path.to_string_lossy().into_owned()));
    }

    let dialog = app.dialog().clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .set_file_name(&default_filename)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("dialog task: {e}"))?;

    let Some(path) = chosen else {
        return Ok(None);
    };
    let path_buf = path.into_path().map_err(|e| format!("resolve path: {e}"))?;
    std::fs::write(&path_buf, &bytes).map_err(|e| format!("write {}: {e}", path_buf.display()))?;
    Ok(Some(path_buf.to_string_lossy().into_owned()))
}

// ---- Settings backup (export / import) -----------------------------------

/// Show the OS save-file dialog, then dump the current `settings.json`
/// contents (read directly from the AppData directory) to the chosen path.
///
/// We read the raw bytes off disk rather than re-serializing the parsed
/// `AppSettings` value so the exported file is byte-identical to what the
/// app uses internally — preserving any forward-compatible fields the
/// Rust schema doesn't model. Tokens / OpenRouter keys never enter this
/// payload (they live in the Keychain, not settings.json), so this file
/// is safe to email or sync across machines.
///
/// `default_filename` is supplied by the caller so date formatting stays
/// in one place (the JS `todayStamp()` helper) and we avoid pulling a
/// date crate just to format the suggested filename.
///
/// Returns the saved path on success, or `None` if the user cancelled.
#[tauri::command]
async fn export_settings_dialog(
    app: AppHandle,
    default_filename: String,
) -> Result<Option<String>, String> {
    // Resolve the on-disk settings.json path the same way the loader does.
    // If the file doesn't exist yet (fresh install + nothing saved), fall
    // back to the in-memory load → re-serialize path so the user still
    // gets a non-empty export of the materialized defaults.
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    let settings_path = base.join("settings.json");
    let bytes = match std::fs::read(&settings_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Fall back: load (which returns {} for missing file) then
            // pretty-serialize. The JS loader will overlay defaults on
            // import, so this still gives the user something useful.
            let s = settings::load(&app)?;
            serde_json::to_vec_pretty(&s).map_err(|e| format!("serialize fallback: {e}"))?
        }
        Err(e) => return Err(format!("read {}: {e}", settings_path.display())),
    };

    let dialog = app.dialog().clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .set_file_name(&default_filename)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("dialog task: {e}"))?;

    let Some(path) = chosen else {
        return Ok(None);
    };
    let path_buf = path.into_path().map_err(|e| format!("resolve path: {e}"))?;
    std::fs::write(&path_buf, &bytes).map_err(|e| format!("write {}: {e}", path_buf.display()))?;
    Ok(Some(path_buf.to_string_lossy().into_owned()))
}

/// Show the OS open-file dialog, read the chosen file, and return its
/// contents as a UTF-8 string. Validation + persistence happen on the JS
/// side (which owns the settings schema).
///
/// Returns `None` if the user cancelled, or the file contents as a string.
/// Errors on I/O failure or non-UTF-8 contents (settings exports are
/// always JSON, which must be UTF-8 anyway).
#[tauri::command]
async fn open_text_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let dialog = app.dialog().clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .file()
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("dialog task: {e}"))?;

    let Some(path) = chosen else {
        return Ok(None);
    };
    let path_buf = path.into_path().map_err(|e| format!("resolve path: {e}"))?;
    let bytes =
        std::fs::read(&path_buf).map_err(|e| format!("read {}: {e}", path_buf.display()))?;
    let text = String::from_utf8(bytes).map_err(|e| format!("file is not valid UTF-8: {e}"))?;
    Ok(Some(text))
}

// ---- Tray IPC -------------------------------------------------------------

/// Swap the tray icon to reflect a new connection status.
///
/// `status` is one of: `"connected"`, `"connecting"`, `"disconnected"`,
/// `"error"`. The Rust side maps `"error"` onto the disconnected glyph
/// (same red-ish dim claw) — we surface the distinction in the sidebar
/// pill and toast layer, not in the menu bar.
///
/// Pushed from JS by the connection store whenever its `status` field
/// changes.
#[tauri::command]
async fn update_tray_status(app: AppHandle, status: String) -> Result<(), String> {
    tray::update_status(&app, &status).map_err(|e| format!("update_tray_status: {e}"))
}

/// Show or hide the tray icon. Driven by the "Show in menu bar"
/// preference in /settings. We never destroy + recreate the tray on
/// flip — the underlying handle is preserved so re-enabling is instant.
#[tauri::command]
async fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    tray::set_visible(&app, visible).map_err(|e| format!("set_tray_visible: {e}"))
}

/// Render (or clear) the unseen-notification badge inside the tray icon.
///
/// Pushed from JS by the notifications store whenever its derived
/// `unseenCount` changes. `count <= 0` clears the badge (status-only
/// glyph); `count >= 10` is rendered as the `9plus` overlay by the Rust
/// side. The composite uses the last-known status cached in
/// `TrayIconState`, so the status colour stays stable across badge
/// pushes — see `tray::update_badge` for the (status, count) icon
/// table and the build-time generator that produces the 33 PNG
/// variants.
#[tauri::command]
async fn update_tray_badge(app: AppHandle, count: i32) -> Result<(), String> {
    tray::update_badge(&app, count).map_err(|e| format!("update_tray_badge: {e}"))
}

/// Push both status and count in one IPC call.
///
/// Functionally equivalent to calling `update_tray_status(status)` then
/// `update_tray_badge(count)` — the icon repaints once with the new
/// (status, count) composite. Useful for surfaces that have both pieces
/// of state on hand (e.g. a future combined "connection + unseen
/// notifications" sync) without two separate IPCs.
///
/// `status` accepts the same strings as `update_tray_status`:
/// `"connected"`, `"connecting"`, `"disconnected"`, `"error"`. Unknown
/// values degrade to `disconnected` (same fallback as the
/// single-field setter).
#[tauri::command]
async fn update_status_and_count(app: AppHandle, status: String, count: i32) -> Result<(), String> {
    tray::update_status_and_count(&app, &status, count)
        .map_err(|e| format!("update_status_and_count: {e}"))
}

/// Replace the contents of the "Recent notifications" submenu.
///
/// Pushed from JS by the notifications store whenever its `history`
/// array changes (and once on hydrate so the menu reflects last
/// session's seeded entries). The Rust side caps the list at 5 entries
/// and rebuilds the parent tray menu to swap the submenu in.
///
/// When `items` is empty the submenu renders a disabled "No recent
/// notifications" placeholder so the menu always has visible content.
#[tauri::command]
async fn update_tray_recent(app: AppHandle, items: Vec<tray::RecentItem>) -> Result<(), String> {
    tray::update_recent(&app, items).map_err(|e| format!("update_tray_recent: {e}"))
}

/// Show + focus the main window. Used by tray menu items that want to
/// surface a route immediately after firing their event (Settings,
/// Restart). The JS event listeners do the navigation; this just makes
/// sure the window isn't sitting hidden when they fire.
// LANE B7 (R64) — Mini-mode child window.
//
// Opens (or re-focuses) a 320×400 always-on-top floating panel pointed
// at the `/mini` static WebUI route. Triggered from JS via the
// `miniMode.toggle()` store, which fires the Cmd+Shift+M chord in the
// layout-level keydown handler.
//
// Window label is the literal "mini" — calling this twice focuses the
// existing window rather than creating a duplicate. The window has no
// titlebar (decorations: false) so the floating panel reads as a card
// rather than a system window; the drag region in MiniPanel.svelte's
// header restores the move affordance.
#[tauri::command]
async fn open_mini_window(app: AppHandle) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    if let Some(existing) = app.get_webview_window("mini") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let _window = WebviewWindowBuilder::new(&app, "mini", tauri::WebviewUrl::App("mini".into()))
        .title("IronClaw — Mini")
        .inner_size(320.0, 400.0)
        .resizable(false)
        .always_on_top(true)
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn show_main_window(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window not registered".into());
    };
    window
        .show()
        .map_err(|e| format!("show main window: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("focus main window: {e}"))?;
    Ok(())
}

// ---- Local crash log -----------------------------------------------------
//
// Always on, always local. The frontend's last-resort window error +
// unhandledrejection handlers append entries here; Settings → Privacy
// shows the count and lets the user open / reveal / clear the file.
//
// No transmission happens from this side — opt-in telemetry is a
// separate JS-side store (`src/lib/stores/telemetry.svelte.ts`).

#[tauri::command]
async fn record_crash(app: AppHandle, entry: CrashEntry) -> Result<(), String> {
    crashes::write(&app, entry)
}

#[tauri::command]
async fn list_crashes(app: AppHandle, limit: usize) -> Result<Vec<CrashEntry>, String> {
    crashes::list(&app, limit)
}

#[tauri::command]
async fn clear_crashes(app: AppHandle) -> Result<(), String> {
    crashes::clear(&app)
}

#[tauri::command]
async fn crashes_file_path(app: AppHandle) -> Result<String, String> {
    crashes::file_path(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize env_logger before the Tauri builder so every `log::*` call
    // — including those that fire inside the setup hook (tray creation,
    // settings load) — is captured. Default filter is `info` for our crate
    // and `warn` for everything else, so noisy third-party traces stay
    // quiet but our own checkpoints surface. Users can override at runtime
    // with `RUST_LOG=debug` or finer-grained selectors like
    // `RUST_LOG=ironclaw_desktop_lib=trace,tauri=debug`.
    //
    // `try_init` rather than `init` so a hot-reloaded dev session that
    // somehow re-enters `run()` doesn't panic on the second initialization.
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("ironclaw_desktop_lib=info,warn"),
    )
    .format_timestamp_secs()
    .try_init();

    log::info!("IronClaw Desktop v{} starting", env!("CARGO_PKG_VERSION"));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Native save-file dialog used by chat + settings exports. We call
        // it from Rust via `save_text_dialog` so the webview never gets the
        // filesystem-write capability — only the path the user picks ever
        // crosses back into JS.
        .plugin(tauri_plugin_dialog::init())
        // Native notifications (chat replies while unfocused, routine
        // completion, sidecar exits). The JS side
        // (@tauri-apps/plugin-notification) wraps requestPermission /
        // sendNotification — no Rust commands needed here.
        .plugin(tauri_plugin_notification::init())
        // HTTP plugin — frontend uses `@tauri-apps/plugin-http`'s `fetch`
        // to call the IronClaw gateway. This bypasses WKWebView's CORS
        // layer (the gateway's CORS allowlist doesn't whitelist
        // `tauri://localhost`, which is the production webview's origin,
        // so direct browser-fetch hangs forever waiting for CORS approval
        // that never lands). Dev mode worked from `http://localhost:1420`
        // because that IS in the allowlist. Required for production.
        .plugin(tauri_plugin_http::init())
        // Auto-updater plugin. The JS side (@tauri-apps/plugin-updater) wraps
        // check / downloadAndInstall — no Rust commands needed here. The
        // release endpoint and public key live in tauri.conf.json; release
        // builds still need TAURI_SIGNING_PRIVATE_KEY so updater artifacts can
        // be signed with the private half of that keypair.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState::default())
        .manage(tts::TtsState::default())
        .manage(spotlight::SpotlightIndexer::default())
        // Cached "Recent notifications" submenu entries. Lives in app
        // state so `update_tray_recent` can swap the menu on demand
        // and so we can re-seed the menu after future
        // create/visibility flips without the JS side having to
        // re-push the same data.
        .manage(tray::RecentItemsState::default())
        // Cached (status, count) snapshot driving the composite tray
        // icon. The two single-field IPC commands
        // (`update_tray_status`, `update_tray_badge`) each mutate one
        // half and re-paint against the other; `update_status_and_count`
        // writes both at once. Defaults to (Disconnected, 0) — same as
        // the initial paint in `tray::create`.
        .manage(tray::TrayIconState::default())
        .invoke_handler(tauri::generate_handler![
            diag_log,
            gateway_http_fetch,
            packaged_smoke_request,
            packaged_smoke_report,
            get_settings,
            save_settings,
            get_token,
            set_token,
            delete_token,
            get_token_source,
            diagnostic_report,
            build_provenance,
            ocr_assets_port,
            nearai_login::nearai_browser_login,
            nearai_connect::nearai_connect_loopback,
            get_llm_provider_credential,
            has_llm_provider_credential,
            set_llm_provider_credential,
            delete_llm_provider_credential,
            get_or_create_local_token,
            list_ironhub_catalog,
            fetch_ironhub_skill,
            install_ironhub_skill_local,
            fs_mount::export_memory_tree,
            notes_export::export_to_notes,
            sandbox_exec::run_python_snippet,
            start_sidecar,
            stop_sidecar,
            sidecar_status,
            local_data_dir,
            reveal_in_finder,
            save_text_dialog,
            save_bytes_dialog,
            export_settings_dialog,
            open_text_dialog,
            update_tray_status,
            set_tray_visible,
            update_tray_badge,
            update_status_and_count,
            update_tray_recent,
            show_main_window,
            open_mini_window,
            set_webview_zoom,
            record_crash,
            list_crashes,
            clear_crashes,
            crashes_file_path,
            tts::say_text,
            tts::stop_tts,
            tts::list_voices,
            spotlight::spotlight_index_thread,
            spotlight::spotlight_remove_thread,
            windows::open_profile_window,
            windows::list_open_profile_windows,
        ])
        // Build the menu-bar tray on setup so the icon is in place
        // before the first webview event fires. We swallow errors here —
        // a missing tray icon is a degraded UX, not a fatal launch
        // failure, and `update_tray_status` / `set_tray_visible` both
        // no-op when the tray hasn't been registered.
        //
        // Initial visibility honours the persisted `trayEnabled` setting
        // (default: true). We read settings synchronously off disk via
        // the same loader the IPC command uses; if it fails we keep the
        // tray visible (least-surprising default).
        .setup(|app| {
            let handle = app.handle();
            install_signal_shutdown(handle);

            if let Some(window) = app.get_webview_window("main") {
                let initial_visible = window.is_visible().ok();
                let initial_minimized = window.is_minimized().ok();
                log::debug!(
                    target: "ironclaw_window",
                    "main window found during setup: visible={initial_visible:?} minimized={initial_minimized:?}"
                );
                if let Err(e) = window.show() {
                    log::warn!(target: "ironclaw_window", "show main window on setup failed: {e}");
                }
                if let Err(e) = window.set_focus() {
                    log::debug!(target: "ironclaw_window", "focus main window on setup failed: {e}");
                }
                let post_show_visible = window.is_visible().ok();
                let post_show_minimized = window.is_minimized().ok();
                log::debug!(
                    target: "ironclaw_window",
                    "main window after setup show/focus: visible={post_show_visible:?} minimized={post_show_minimized:?}"
                );
            } else {
                log::warn!(target: "ironclaw_window", "main window missing during setup");
            }

            if let Err(e) = tray::create(handle) {
                log::warn!(target: "ironclaw_tray", "create failed: {e}");
            } else if let Ok(s) = settings::load(handle) {
                // `trayEnabled` defaults to true (we only hide when the
                // user explicitly stored `false`). settings.json is an
                // opaque JSON blob owned by the JS schema, so we look up
                // the field by name and treat anything-but-`false` as
                // visible — same fallback behaviour as a fresh install.
                let enabled = s
                    .get("trayEnabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                if !enabled {
                    let _ = tray::set_visible(handle, false);
                }
            }

            let sidecar_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = sidecar_handle.state::<SidecarState>();
                let selection = settings::load(&sidecar_handle)
                    .map(|settings| sidecar_boot_selection_from_settings(&settings))
                    .unwrap_or_else(|err| {
                        log::warn!(
                            target: "ironclaw_sidecar",
                            "auto-start settings load failed; using NEAR.AI Cloud defaults: {err}"
                        );
                        SidecarBootSelection::default()
                    });
                let backend_cfg = match backend_config_for_selection(&selection) {
                    Ok(config) => config,
                    Err(err) => {
                        log::warn!(
                            target: "ironclaw_sidecar",
                            "auto-start provider config failed for profile {}: {err}",
                            selection.profile_id
                        );
                        return;
                    }
                };
                let gateway_token = match keychain::get_or_create_local_token(&sidecar_handle) {
                    Ok(token) => token,
                    Err(err) => {
                        log::warn!(target: "ironclaw_sidecar", "auto-start token load failed: {err}");
                        return;
                    }
                };
                match sidecar::spawn(sidecar_handle.clone(), state, backend_cfg, gateway_token)
                .await
                {
                    Ok(port) => {
                        log::info!(target: "ironclaw_sidecar", "auto-started Reborn WebUI sidecar on port {port}");
                    }
                    Err(err) => {
                        log::warn!(target: "ironclaw_sidecar", "auto-start failed: {err}");
                    }
                }
            });
            Ok(())
        })
        .on_web_content_process_terminate(|webview| {
            log::warn!(
                target: "ironclaw_window",
                "web content process terminated for webview {:?}; attempting reload",
                webview.label()
            );
            if let Err(e) = webview.reload() {
                log::warn!(target: "ironclaw_window", "webview reload after termination failed: {e}");
            }
        })
        // Hide the window on close instead of quitting so the tray stays
        // alive. Quit only happens via the tray "Quit" menu item or
        // Cmd+Q. Per-window event hook so other windows (e.g. future
        // detached chat tabs) don't get the same behaviour for free.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                log::debug!("Window close requested, hiding to tray");
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(err) => {
            // CONTRIBUTING bans `expect` in non-test `run`. A build failure is
            // unrecoverable (no app to run), so log it and return instead of
            // panicking — the process exits cleanly with the cause in the log.
            log::error!(
                target: "ironclaw_window",
                "failed to build tauri application: {err}"
            );
            return;
        }
    };

    // RunEvent::ExitRequested fires before the app actually exits. We kill
    // the sidecar there so we never leak a zombie child after the window
    // closes.
    app.run(|app_handle, event| {
        if let RunEvent::Reopen { .. } = event {
            if let Some(window) = app_handle.get_webview_window("main") {
                if let Err(e) = window.show() {
                    log::warn!(target: "ironclaw_window", "show main window on reopen failed: {e}");
                }
                if let Err(e) = window.set_focus() {
                    log::debug!(target: "ironclaw_window", "focus main window on reopen failed: {e}");
                }
            }
        }
        if let RunEvent::ExitRequested { .. } = event {
            log::info!("App exit requested, stopping sidecar");
            let state = app_handle.state::<SidecarState>();
            // Best-effort: block on the async stop. The runtime is still
            // alive at this point.
            tauri::async_runtime::block_on(async {
                let _ = sidecar::stop(state).await;
            });
        }
    });
}
