// Bearer-token storage backed by the macOS Keychain (via the `keyring` crate).
//
// Service name is shared across accounts so all IronClaw Desktop secrets sit
// in a single namespace in the keychain.
//
// Accounts (per-profile shape introduced by the Profiles system):
//   - `gateway-token:<profile-id>`    : remote gateway bearer
//   - `openrouter-key:<profile-id>`   : OpenRouter API key for local sidecar
//   - `local-gateway-token`           : auto-generated UUID used as the bearer
//                                       for the local sidecar's own gateway
//                                       (kept global — there is one bundled
//                                       sidecar per app install regardless of
//                                       how many profiles exist).
//
// Legacy fallback: a pre-Profiles install will have credentials at the
// suffix-less accounts `gateway-token` and `openrouter-key`. On the first
// read of a profile-scoped account we promote that legacy value to
// `<account>:default` (matching the migrated default-profile id) and clear
// the legacy entry. Idempotent — safe to call repeatedly.

use keyring::{Entry, Error as KeyringError};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "com.openclaw.ironclaw-desktop";
const ACCOUNT_GATEWAY_PREFIX: &str = "gateway-token";
const ACCOUNT_LOCAL_TOKEN: &str = "local-gateway-token";
/// Prefix for per-LLM-provider credentials stored by the desktop's
/// LlmProviderPicker. Combined with the provider id and profile id this
/// produces `llm-<provider-id>:<profile-id>` slots (e.g.
/// `llm-openai:default`, `llm-anthropic:abc-123`).
const ACCOUNT_LLM_PROVIDER_PREFIX: &str = "llm";
const KEYCHAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

// =============================================================================
// !!! DO NOT REMOVE the token-file fallback below !!!
//
// Shipped in v0.2.8 (commit 79b5543) after a 6-hour bug hunt traced the
// "Disconnected forever" production bug to the macOS keychain ACL prompt
// hanging invisibly behind the app's main window. The fallback is
// load-bearing: without it, every cargo --release rebuild produces a
// binary whose ad-hoc signature isn't trusted by the prior "Always Allow"
// grant, and the new prompt may never surface (covered window, headless
// dev loop, etc.). Removing the file fallback re-introduces that wedge.
//
// If you're reviewing this code as part of a cleanup pass: the file is
// mode 0600 in app_data_dir, the keychain write path is kept too so a
// signed/notarised production build still gets keychain-only persistence.
// =============================================================================

/// Path to the file fallback for an account. Used when the macOS keychain
/// ACL prompt hangs invisibly (every cargo --release rebuild invalidates
/// the signature-bound "Always Allow" grant, and the new prompt may be
/// hidden behind other windows or never surface in a headless dev loop).
///
/// Location: app_data_dir/tokens/<account>.token (mode 0600).
fn token_file_path(app: &AppHandle, account: &str) -> Result<PathBuf, String> {
    if !account_allows_file_fallback(account) {
        return Err(format!("file fallback denied for account [{account}]"));
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    let dir = base.join("tokens");
    fs::create_dir_all(&dir).map_err(|e| format!("create tokens dir: {e}"))?;
    // Sanitise the account name so it can't escape the tokens dir.
    let safe = account.replace(['/', '\\', '.', ':'], "_");
    Ok(dir.join(format!("{safe}.token")))
}

fn account_allows_file_fallback(account: &str) -> bool {
    account == ACCOUNT_LOCAL_TOKEN
        || matches!(
            account.strip_prefix(ACCOUNT_GATEWAY_PREFIX),
            Some(suffix) if suffix.starts_with(':') && suffix.len() > 1
        )
}

fn read_token_file(app: &AppHandle, account: &str) -> Option<String> {
    let path = match token_file_path(app, account) {
        Ok(p) => p,
        Err(e) => {
            log::warn!(target: "ironclaw_keychain", "file fallback path resolve FAILED [{account}]: {e}");
            return None;
        }
    };
    log::info!(target: "ironclaw_keychain", "file fallback path [{account}]: {}", path.display());
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) => {
            log::warn!(target: "ironclaw_keychain", "file fallback read FAILED [{account}] at {}: {e}", path.display());
            return None;
        }
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        log::warn!(target: "ironclaw_keychain", "file fallback EMPTY [{account}]");
        None
    } else {
        log::info!(target: "ironclaw_keychain", "file fallback read OK [{account}] len={}", trimmed.len());
        Some(trimmed.to_string())
    }
}

fn write_token_file(app: &AppHandle, account: &str, value: &str) -> Result<(), String> {
    let path = token_file_path(app, account)?;
    fs::write(&path, value).map_err(|e| format!("write token file: {e}"))?;
    // Make it readable only by the owner. Best-effort.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Profile id used by the JS migration when wrapping an old flat-shape
/// settings file into a single profile. Must stay in sync with the JS
/// constant `DEFAULT_PROFILE_ID` in `settings.svelte.ts`.
const DEFAULT_PROFILE_ID: &str = "default";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("keyring entry: {e}"))
}

fn get_secret(account: &str) -> Result<Option<String>, String> {
    // Log the slot name only — never the secret value. Useful for tracing
    // which credentials each surface reads on startup / IPC dispatch.
    log::info!(target: "ironclaw_keychain", "read service={SERVICE} account={account}");
    // CRITICAL: e.get_password() can BLOCK forever on macOS when the
    // keychain ACL needs user grant. Every cargo --release rebuild
    // changes the binary's ad-hoc signature, which invalidates the
    // "Always Allow" grant the user previously gave, and macOS shows a
    // permission prompt that may be hidden/invisible. The synchronous
    // blocking call freezes the whole Tauri IPC dispatcher, the
    // frontend, and the app.
    //
    // Run the keychain call on a worker thread with a hard timeout so
    // a hung prompt cannot wedge the app. Only gateway/local bearer
    // callers are allowed to consult the plaintext fallback afterwards;
    // LLM provider credentials are keychain-only.
    let account_owned = account.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = entry(&account_owned).and_then(|e| match e.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(err) => Err(format!("keyring read [{account_owned}]: {err}")),
        });
        let _ = tx.send(result);
    });
    match rx.recv_timeout(KEYCHAIN_TIMEOUT) {
        Ok(Ok(Some(s))) => {
            log::info!(target: "ironclaw_keychain", "READ OK [{account}] len={}", s.len());
            Ok(Some(s))
        }
        Ok(Ok(None)) => {
            log::warn!(target: "ironclaw_keychain", "READ NO_ENTRY [{account}]");
            Ok(None)
        }
        Ok(Err(err)) => {
            log::warn!(target: "ironclaw_keychain", "READ FAILED [{account}]: {err}");
            Err(err)
        }
        Err(_) => {
            log::warn!(target: "ironclaw_keychain", "READ TIMEOUT [{account}] after 2s — keychain ACL prompt likely hung; trying file fallback");
            Err(format!(
                "keychain read [{account}] timed out (likely ACL prompt hung)"
            ))
        }
    }
}

fn set_secret(account: &str, value: &str) -> Result<(), String> {
    let e = entry(account)?;
    e.set_password(value)
        .map_err(|err| format!("keyring write [{account}]: {err}"))
}

fn set_secret_with_timeout(account: &str, value: &str) -> Result<(), String> {
    let account_owned = account.to_string();
    let value_owned = value.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = set_secret(&account_owned, &value_owned);
        let _ = tx.send(result);
    });
    match rx.recv_timeout(KEYCHAIN_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err(format!(
            "keychain write [{account}] timed out (likely ACL prompt hung)"
        )),
    }
}

fn delete_secret(account: &str) -> Result<(), String> {
    let e = entry(account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("keyring delete [{account}]: {err}")),
    }
}

fn account_for(prefix: &str, profile_id: &str) -> String {
    format!("{prefix}:{profile_id}")
}

/// Promote a legacy suffix-less entry to its `:default` profile-scoped
/// counterpart, if the target slot is empty. Best-effort — failures don't
/// block subsequent reads, but they're surfaced via the Result so the
/// caller can log.
fn promote_legacy_if_needed(prefix: &str, profile_id: &str) -> Result<(), String> {
    if profile_id != DEFAULT_PROFILE_ID {
        return Ok(());
    }
    let target_account = account_for(prefix, profile_id);
    // If we already have a value at the new slot, leave the legacy slot
    // alone — the user (or this same migration on a previous boot) has
    // already written there.
    if get_secret(&target_account)?.is_some() {
        return Ok(());
    }
    let Some(legacy) = get_secret(prefix)? else {
        return Ok(());
    };
    if legacy.is_empty() {
        // Treat an empty legacy entry as "nothing to migrate" — but still
        // clear it so we don't keep re-checking on every read.
        let _ = delete_secret(prefix);
        return Ok(());
    }
    set_secret(&target_account, &legacy)?;
    // Best-effort clear — if delete fails for any reason, the data is
    // already safely copied to the new slot, so this isn't fatal.
    let _ = delete_secret(prefix);
    Ok(())
}

// ---- Remote gateway bearer ------------------------------------------------

pub fn get(app: &AppHandle, profile_id: &str) -> Result<Option<String>, String> {
    // Legacy promotion is best-effort. A hung keychain ACL prompt on the
    // legacy account would block the actual read below, so we swallow
    // every error and just continue. The new-account path + file fallback
    // covers all the cases we actually need.
    let _ = promote_legacy_if_needed(ACCOUNT_GATEWAY_PREFIX, profile_id);
    let account = account_for(ACCOUNT_GATEWAY_PREFIX, profile_id);
    // Try keychain first (with timeout — see get_secret). On hang or error,
    // fall through to the on-disk file fallback so a stuck macOS keychain
    // ACL prompt can't wedge the whole app.
    match get_secret(&account) {
        Ok(Some(s)) => Ok(Some(s)),
        Ok(None) => Ok(read_token_file(app, &account)),
        Err(_) => Ok(read_token_file(app, &account)),
    }
}

/// Reports which backing store actually surfaced the token. Lets the UI
/// show a "loaded from keychain | file fallback | absent" badge so the
/// user / a CI run can tell whether the keychain ACL prompt is wedged.
/// Returns one of: "keychain" | "file" | "absent".
pub fn get_source(app: &AppHandle, profile_id: &str) -> Result<String, String> {
    let account = account_for(ACCOUNT_GATEWAY_PREFIX, profile_id);
    // Mirror the read order of `get` so the answer is consistent with what
    // the connection store actually used.
    match get_secret(&account) {
        Ok(Some(_)) => Ok("keychain".into()),
        Ok(None) | Err(_) => {
            if read_token_file(app, &account).is_some() {
                Ok("file".into())
            } else {
                Ok("absent".into())
            }
        }
    }
}

pub fn set(app: &AppHandle, profile_id: &str, token: &str) -> Result<(), String> {
    let account = account_for(ACCOUNT_GATEWAY_PREFIX, profile_id);
    // Remote gateway bearers keep the historical file fallback so a stuck
    // macOS keychain prompt cannot disconnect the app forever. Keychain write
    // is timeout-bound and best-effort; the fallback is written first so the
    // value is recoverable even if the keychain prompt hangs.
    if let Err(err) = write_token_file(app, &account, token) {
        log::warn!(target: "ironclaw_keychain", "file fallback write FAILED [{account}]: {err}");
    }
    match set_secret_with_timeout(&account, token) {
        Ok(()) => Ok(()),
        Err(err) => {
            log::warn!(target: "ironclaw_keychain", "keychain write FAILED [{account}]: {err} — file fallback persisted");
            Ok(())
        }
    }
}

pub fn delete(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    let account = account_for(ACCOUNT_GATEWAY_PREFIX, profile_id);
    if let Ok(path) = token_file_path(app, &account) {
        let _ = fs::remove_file(path);
    }
    delete_secret(&account)
}

// ---- Per-provider LLM credentials (LlmProviderPicker) --------------------
//
// The picker stores each provider's API key / token in its own slot so
// the user can switch between providers without losing their other
// configured credentials.

fn llm_account_for(provider_id: &str, profile_id: &str) -> String {
    // Sanitize the provider id defensively: keyring entries treat the
    // account string as opaque but we still want a predictable layout
    // and no embedded colons (which we use as the profile separator).
    let safe_provider: String = provider_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{ACCOUNT_LLM_PROVIDER_PREFIX}-{safe_provider}:{profile_id}")
}

pub fn get_llm_provider_credential(
    profile_id: &str,
    provider_id: &str,
) -> Result<Option<String>, String> {
    get_secret(&llm_account_for(provider_id, profile_id))
}

pub fn set_llm_provider_credential(
    profile_id: &str,
    provider_id: &str,
    value: &str,
) -> Result<(), String> {
    set_secret_with_timeout(&llm_account_for(provider_id, profile_id), value)
}

pub fn delete_llm_provider_credential(profile_id: &str, provider_id: &str) -> Result<(), String> {
    delete_secret(&llm_account_for(provider_id, profile_id))
}

// ---- Local gateway token (auto-generated if missing) ----------------------

/// Returns the stored local gateway token, generating + persisting a fresh
/// UUID v4 if none exists. Idempotent — callers can invoke on every boot.
/// Kept global (no profile scoping) — there is one bundled sidecar per
/// install, and its bearer is an app-level secret, not a per-profile one.
pub fn get_or_create_local_token(app: &AppHandle) -> Result<String, String> {
    match get_secret(ACCOUNT_LOCAL_TOKEN) {
        Ok(Some(existing)) if !existing.is_empty() => return Ok(existing),
        Ok(_) | Err(_) => {
            if let Some(existing) = read_token_file(app, ACCOUNT_LOCAL_TOKEN) {
                return Ok(existing);
            }
        }
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    if let Err(err) = set_secret_with_timeout(ACCOUNT_LOCAL_TOKEN, &fresh) {
        log::warn!(target: "ironclaw_keychain", "keychain write FAILED [{ACCOUNT_LOCAL_TOKEN}]: {err} — writing file fallback");
        write_token_file(app, ACCOUNT_LOCAL_TOKEN, &fresh)?;
    }
    Ok(fresh)
}

// ---- Unit tests ----------------------------------------------------------
//
// Validates the pure-function behavior of the file-fallback path
// (account sanitisation, path layout, plaintext round-trip) without
// touching the keychain or requiring an `AppHandle`. The Tauri-side
// `pub fn get` / `pub fn set` are exercised via the JS-side vitest
// suites and the live `scripts/dev-up.sh` smoke test.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Reimplements the path sanitiser inline so we can test the layout
    /// expectations of `token_file_path` without an `AppHandle` (which
    /// requires a Tauri runtime). Mirror of `token_file_path`'s
    /// `replace(['/', '\\', '.', ':'], "_")` rule.
    fn safe_file_name(account: &str) -> String {
        let safe = account.replace(['/', '\\', '.', ':'], "_");
        format!("{safe}.token")
    }

    #[test]
    fn account_sanitiser_replaces_unsafe_chars() {
        assert_eq!(
            safe_file_name("gateway-token:default"),
            "gateway-token_default.token"
        );
        assert_eq!(
            safe_file_name("openrouter-key:my-prof"),
            "openrouter-key_my-prof.token"
        );
        // Reserved characters that must NOT leak into the filesystem
        assert_eq!(safe_file_name("../etc"), "___etc.token");
        assert_eq!(safe_file_name("a/b\\c.d:e"), "a_b_c_d_e.token");
    }

    #[test]
    fn safe_account_does_not_contain_separators() {
        for raw in ["gateway-token:default", "x/y", "a.b", "z\\w", "a:b"] {
            let safe = safe_file_name(raw);
            assert!(
                !safe.contains('/') && !safe.contains('\\') && !safe.contains(':') &&
                // Only the trailing `.token` extension is allowed; nothing else
                safe.matches('.').count() == 1 && safe.ends_with(".token"),
                "sanitiser leaked an unsafe char in '{safe}' (from '{raw}')"
            );
        }
    }

    #[test]
    fn file_fallback_is_only_for_gateway_bearers() {
        assert!(account_allows_file_fallback("gateway-token:default"));
        assert!(account_allows_file_fallback("gateway-token:profile-123"));
        assert!(account_allows_file_fallback("local-gateway-token"));

        assert!(!account_allows_file_fallback("llm-nearai:default"));
        assert!(!account_allows_file_fallback("llm-openai:default"));
        assert!(!account_allows_file_fallback("llm-anthropic:default"));
        assert!(!account_allows_file_fallback("openrouter-key:default"));
        assert!(!account_allows_file_fallback("gateway-token"));
        assert!(!account_allows_file_fallback("gateway-token:"));
    }

    #[test]
    fn llm_provider_account_slots_stay_out_of_token_files() {
        assert_eq!(llm_account_for("nearai", "default"), "llm-nearai:default");
        assert_eq!(
            llm_account_for("openai/custom", "default"),
            "llm-openai_custom:default"
        );
        assert!(!account_allows_file_fallback(&llm_account_for(
            "anthropic",
            "default"
        )));
    }

    #[test]
    fn token_file_round_trip_via_fs() {
        // Doesn't go through `token_file_path` (needs AppHandle), but
        // proves the on-disk byte layout the Rust loader expects: a
        // trimmed string with mode 0600. This is what
        // `scripts/stage-token.sh` writes.
        let tmp = TempDir::new().unwrap();
        let path = tmp
            .path()
            .join("tokens")
            .join("gateway-token_default.token");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let token = "abcd1234efgh5678".to_string();
        fs::write(&path, &token).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            let perms = fs::metadata(&path).unwrap().permissions();
            assert_eq!(perms.mode() & 0o777, 0o600);
        }
        let read = fs::read_to_string(&path).unwrap();
        assert_eq!(read.trim(), token);
    }

    #[test]
    fn token_file_handles_trailing_whitespace() {
        // `stage-token.sh` may write the token via shell heredoc or
        // `echo $TOK` which appends a newline. The Rust loader must
        // strip whitespace cleanly.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("gateway-token_default.token");
        fs::write(&path, "tok-with-newline\n").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap().trim(),
            "tok-with-newline"
        );

        fs::write(&path, "  spaces  \n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap().trim(), "spaces");
    }

    #[test]
    fn empty_token_file_treated_as_absent() {
        // Mirror the loader's "empty file → None" rule so a half-staged
        // token doesn't accidentally authenticate with the empty
        // string (which the gateway would reject with 401 anyway).
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("gateway-token_default.token");
        fs::write(&path, "").unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.trim().is_empty());
    }
}
