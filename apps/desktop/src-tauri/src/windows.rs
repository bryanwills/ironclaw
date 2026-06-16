// Multi-window support — spawn additional IronClaw webviews scoped to a
// specific profile.
//
// Each window's label is `profile-<sanitized-id>` so the same id always
// resolves to the same window (we focus an existing one instead of
// creating a duplicate). The profile id is also forwarded as a `?profile=`
// query parameter on the App URL so the JS-side connection store can pick
// it up on init and use that profile *for this window only* — the
// persisted `activeProfileId` in settings.json is untouched, so the
// main window and any other detached profile windows keep their own
// contexts.
//
// We deliberately reuse the same App URL ("/") rather than rendering a
// distinct entry — the static WebUI routes are profile-agnostic; everything
// that matters reads from the per-window connection store, which already
// knows how to scope by profile id.
//
// Window lifecycle: closing a profile window closes it normally (no
// custom CloseRequested handler — the main-window-hides-on-close
// behaviour in `lib.rs` is gated on the literal "main" label). Quitting
// the app still goes through the tray "Quit" item or Cmd+Q as before.
//
// TODO: an app-menu (menubar) integration with a "Window → Open profile
// in new window" submenu would be a nicer discovery surface. Punted for
// v1 — the Settings page + Sidebar popover affordances cover the same
// territory without requiring a Tauri menu rebuild on every settings.json
// change. See the README for the larger TODO list.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Open (or focus) a window scoped to the given profile id.
///
/// The label is derived from a sanitized profile id; calling this twice
/// with the same id focuses the existing window rather than creating a
/// duplicate. The new window is sized to match the main window's defaults
/// (1280x800, min 900x600) but stays independent — closing it doesn't
/// affect the main window or the sidecar lifecycle.
#[tauri::command]
pub async fn open_profile_window(app: AppHandle, profile_id: String) -> Result<(), String> {
    let safe_id = sanitize(&profile_id);
    if safe_id.is_empty() {
        return Err("profile id is empty after sanitization".into());
    }
    let label = format!("profile-{safe_id}");

    // Focus the existing window if one is already up for this profile.
    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| format!("show: {e}"))?;
        win.set_focus().map_err(|e| format!("set_focus: {e}"))?;
        return Ok(());
    }

    // PathBuf-based App URLs are joined onto the gateway's base URL with
    // `url::Url::join`; a leading slash makes the path root-relative so
    // the query string survives intact (`tauri://localhost/?profile=…`
    // in prod, `http://localhost:1420/?profile=…` in dev).
    let path = format!("/?profile={safe_id}");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(path.into()))
        .title(format!("IronClaw — {profile_id}"))
        .min_inner_size(900.0, 600.0)
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("build window: {e}"))?;

    Ok(())
}

/// Return the list of currently-open profile-scoped windows (profile ids,
/// not labels). Useful for surfaces that want to show "already open"
/// state on the open-in-new-window button. The main window isn't
/// included (its label is the literal "main", not `profile-*`).
#[tauri::command]
pub async fn list_open_profile_windows(app: AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter_map(|k| k.strip_prefix("profile-").map(String::from))
        .collect()
}

/// Keep the label safe for filesystem-y constraints + the URL roundtrip.
/// Profile ids are already opaque UUIDs in practice, but defensively
/// strip anything outside `[A-Za-z0-9_-]` so a hand-edited settings.json
/// can't smuggle in unexpected characters via the label.
fn sanitize(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn sanitize_keeps_safe_chars() {
        assert_eq!(sanitize("abc-123_def"), "abc-123_def");
    }

    #[test]
    fn sanitize_strips_unsafe_chars() {
        assert_eq!(sanitize("ab/c?=&!"), "abc");
        assert_eq!(sanitize("default"), "default");
        assert_eq!(sanitize(""), "");
    }
}
