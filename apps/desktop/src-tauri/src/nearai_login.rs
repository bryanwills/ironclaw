// In-app NEAR.AI sign-in.
//
// private.near.ai accepts exactly one frontend_callback origin —
// https://private.near.ai/* (any path; no loopback, no other host, no http).
// After provider auth it redirects the BROWSER to
// `<frontend_callback>/auth/callback?token=sess_…` — the session token rides
// the URL. So a dedicated WebviewWindow pointed at the auth URL can complete
// the whole flow: the user signs in on the real provider pages, and
// `on_navigation` captures the token the moment the allowlisted callback
// fires — then CANCELS that navigation so the token never reaches the remote
// SPA (which would store it in its own web session).
//
// The captured token is validated against /v1/users/me before being
// persisted to the keychain; the UI then restarts the sidecar, which injects
// NEARAI_SESSION_TOKEN at spawn.

use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const LOGIN_WINDOW_LABEL: &str = "nearai-login";
// Any path under the allowlisted origin works; a distinct marker keeps the
// callback recognizable and un-spoofable by other in-flow redirects.
const CALLBACK_MARKER_PATH: &str = "/ironclaw-desktop";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

enum LoginSignal {
    Token(String),
    WindowClosed,
}

/// Extract the session token if (and only if) this is OUR callback URL:
/// https://private.near.ai<CALLBACK_MARKER_PATH>/auth/callback?token=…
pub fn token_from_callback_url(url: &Url) -> Option<String> {
    if url.scheme() != "https" || url.host_str() != Some("private.near.ai") {
        return None;
    }
    if !url
        .path()
        .starts_with(&format!("{CALLBACK_MARKER_PATH}/auth/callback"))
    {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .filter(|token| !token.is_empty())
}

#[tauri::command]
pub async fn nearai_browser_login(
    app: AppHandle,
    provider: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    if provider != "github" && provider != "google" {
        return Err(format!("unsupported provider: {provider}"));
    }
    // Resolve the active profile in Rust so the WebUI never has to know it.
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
    let auth_url = format!(
        "https://private.near.ai/v1/auth/{provider}?frontend_callback=https%3A%2F%2Fprivate.near.ai{}",
        CALLBACK_MARKER_PATH.replace('/', "%2F")
    );

    // One login window at a time.
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = existing.close();
    }

    let (signal_tx, signal_rx) = mpsc::channel::<LoginSignal>();
    let nav_tx = signal_tx.clone();
    let window = WebviewWindowBuilder::new(
        &app,
        LOGIN_WINDOW_LABEL,
        WebviewUrl::External(auth_url.parse().map_err(|e| format!("auth url: {e}"))?),
    )
    .title("Sign in to NEAR.AI")
    .inner_size(980.0, 760.0)
    .on_navigation(move |url| {
        if let Some(token) = token_from_callback_url(url) {
            let _ = nav_tx.send(LoginSignal::Token(token));
            // Cancel: the token must never reach the remote page.
            return false;
        }
        true
    })
    .build()
    .map_err(|e| format!("login window: {e}"))?;

    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let _ = signal_tx.send(LoginSignal::WindowClosed);
        }
    });

    // Block a worker thread, not the async runtime.
    let signal = tauri::async_runtime::spawn_blocking(move || {
        signal_rx.recv_timeout(LOGIN_TIMEOUT)
    })
    .await
    .map_err(|e| format!("login wait: {e}"))?;

    let token = match signal {
        Ok(LoginSignal::Token(token)) => token,
        Ok(LoginSignal::WindowClosed) => {
            return Err("Sign-in window was closed before completing".into());
        }
        Err(_) => {
            if let Some(w) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
                let _ = w.close();
            }
            return Err("Sign-in timed out".into());
        }
    };
    if let Some(w) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = w.close();
    }

    // Validate before persisting — the allowlist and token format are server
    // policy that can change without notice; never store an unverified value.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let response = client
        .get("https://private.near.ai/v1/users/me")
        .bearer_auth(&token)
        .header("User-Agent", "ironclaw-desktop")
        .send()
        .await
        .map_err(|e| format!("token validation request: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "captured token failed validation: HTTP {}",
            response.status()
        ));
    }

    crate::keychain::set_llm_provider_credential(&profile_id, "nearai", &token)?;
    // Returned to the WebUI so it can hot-swap the LIVE sidecar via the
    // provider upsert endpoint (no restart); the keychain copy above covers
    // the next boot's env injection.
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        value.parse().expect("test url")
    }

    #[test]
    fn captures_token_from_exact_callback() {
        let token = token_from_callback_url(&url(
            "https://private.near.ai/ironclaw-desktop/auth/callback?token=sess_abc123",
        ));
        assert_eq!(token.as_deref(), Some("sess_abc123"));
    }

    #[test]
    fn rejects_other_hosts_schemes_and_paths() {
        for candidate in [
            "https://github.com/login/oauth/authorize?token=sess_x",
            "http://private.near.ai/ironclaw-desktop/auth/callback?token=sess_x",
            "https://private.near.ai/auth/callback?token=sess_x",
            "https://private.near.ai/ironclaw-desktop/auth/callback",
            "https://evil.example/ironclaw-desktop/auth/callback?token=sess_x",
        ] {
            assert!(token_from_callback_url(&url(candidate)).is_none(), "{candidate}");
        }
    }

    #[test]
    fn empty_token_is_rejected() {
        assert!(token_from_callback_url(&url(
            "https://private.near.ai/ironclaw-desktop/auth/callback?token="
        ))
        .is_none());
    }
}
