// IronHub catalog browser.
//
// IronHub (github.com/nearai/ironhub) is the upstream marketplace of WASM
// tools and SKILL.md skills for IronClaw. The desktop client lets the user
// browse the catalog and install a skill into the local sidecar's
// `~/.ironclaw/skills/` directory without having to clone the repo by hand.
//
// Three commands surface here:
//   * `list_ironhub_catalog`  — enumerate the `tools/` + `skills/` dirs of
//     the repo via the GitHub contents API, fetch a short README excerpt
//     per entry, and cache the assembled blob to `app_data_dir/
//     ironhub-catalog.json` with a 1-hour TTL. The cache is the canonical
//     store (the JS side never re-implements caching in localStorage).
//   * `fetch_ironhub_skill`   — pull the raw `SKILL.md` for a slug. Used
//     by the UI to preview before install and to copy-to-clipboard.
//   * `install_ironhub_skill_local` — write the SKILL.md into the local
//     sidecar's skills dir. Errors if no local sidecar is running because
//     remote-mode gateways don't expose a skill-upload endpoint yet.
//
// Network calls go out through `reqwest` directly rather than through the
// tauri-plugin-http channel — those plugin routes are wired for the
// webview fetcher (webview-origin allowlist). The Rust commands here
// run server-side so there's no CORS layer to bypass.

use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::sidecar::{self, SidecarState};

/// Cache TTL — GitHub's anonymous contents API allows 60 req/hr per IP.
/// A 1h window keeps refresh latency snappy while honouring the cap.
const CACHE_TTL_SECS: u64 = 60 * 60;
const CACHE_FILE: &str = "ironhub-catalog.json";
const SCHEMA: &str = "ironhub-catalog.v1";

const GH_CONTENTS_BASE: &str = "https://api.github.com/repos/nearai/ironhub/contents";
const GH_RAW_BASE: &str = "https://raw.githubusercontent.com/nearai/ironhub/main";
const USER_AGENT: &str = "ironclaw-desktop";

/// Cap a README excerpt at this many bytes so we never serialize a 10 KB
/// preamble into the catalog response. The UI clips the first ~100 chars
/// for display; we leave a bit more on disk so the modal preview has a
/// slightly richer view without a second fetch.
const README_EXCERPT_LIMIT: usize = 600;

/// Repo paths we enumerate. The upstream repo is two siblings — `tools/`
/// (WASM artefacts) and `skills/` (SKILL.md bundles). If either is absent
/// we surface an empty list rather than failing the whole call.
const TOOL_PATH: &str = "tools";
const SKILL_PATH: &str = "skills";

/// One entry returned by the GitHub contents API. We only model the
/// fields we actually consume — anything else (sha, html_url, _links)
/// is silently dropped on deserialise.
#[derive(Debug, Deserialize)]
struct ContentsEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
}

/// Public shape for a catalog entry. Both tools + skills use the same
/// shape; the distinction is which array on the response they land in.
#[derive(Debug, Serialize)]
struct CatalogEntry {
    name: String,
    path: String,
    readme_excerpt: Option<String>,
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    std::fs::create_dir_all(&base).map_err(|e| format!("create {}: {e}", base.display()))?;
    Ok(base.join(CACHE_FILE))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read the cache and return it if it's still fresh.
fn read_fresh_cache(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let fetched_at = v.get("fetched_at").and_then(|x| x.as_u64())?;
    let now = now_secs();
    if now.saturating_sub(fetched_at) > CACHE_TTL_SECS {
        return None;
    }
    Some(v)
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

/// List the `path` directory of the upstream repo via the GitHub contents
/// API. Returns the `dir` entries we want to enrich.
async fn list_repo_dir(client: &reqwest::Client, path: &str) -> Result<Vec<ContentsEntry>, String> {
    let url = format!("{GH_CONTENTS_BASE}/{path}");
    log::info!(target: "ironclaw_ironhub", "GET {url}");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("github contents fetch {path}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "github contents {path} returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }
    let entries: Vec<ContentsEntry> = resp
        .json()
        .await
        .map_err(|e| format!("parse contents {path}: {e}"))?;
    Ok(entries
        .into_iter()
        .filter(|e| e.entry_type == "dir")
        .collect())
}

/// Best-effort fetch of `<repo>/<path>/<slug>/README.md`. Returns `None`
/// on 404 / network errors so a single missing README doesn't kill the
/// whole catalog response.
async fn fetch_readme_excerpt(client: &reqwest::Client, repo_path: &str) -> Option<String> {
    let url = format!("{GH_RAW_BASE}/{repo_path}/README.md");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let trimmed = body.trim_start();
    let mut excerpt: String = trimmed.chars().take(README_EXCERPT_LIMIT).collect();
    if body.len() > excerpt.len() {
        excerpt.push('…');
    }
    Some(excerpt)
}

/// Enumerate `tools/` + `skills/` and decorate each `dir` entry with a
/// README excerpt where present.
async fn assemble_catalog(client: &reqwest::Client) -> Result<Value, String> {
    let tools_dirs = list_repo_dir(client, TOOL_PATH)
        .await
        .unwrap_or_else(|err| {
            log::warn!(target: "ironclaw_ironhub", "tools listing failed: {err}");
            Vec::new()
        });
    let skills_dirs = list_repo_dir(client, SKILL_PATH)
        .await
        .unwrap_or_else(|err| {
            log::warn!(target: "ironclaw_ironhub", "skills listing failed: {err}");
            Vec::new()
        });

    let mut tools = Vec::with_capacity(tools_dirs.len());
    for entry in tools_dirs {
        let excerpt = fetch_readme_excerpt(client, &entry.path).await;
        tools.push(CatalogEntry {
            name: entry.name,
            path: entry.path,
            readme_excerpt: excerpt,
        });
    }
    let mut skills = Vec::with_capacity(skills_dirs.len());
    for entry in skills_dirs {
        let excerpt = fetch_readme_excerpt(client, &entry.path).await;
        skills.push(CatalogEntry {
            name: entry.name,
            path: entry.path,
            readme_excerpt: excerpt,
        });
    }

    Ok(json!({
        "schema": SCHEMA,
        "fetched_at": now_secs(),
        "tools": tools,
        "skills": skills,
    }))
}

/// Public entrypoint: returns the catalog from cache when fresh, otherwise
/// re-fetches from GitHub and writes the result back into the cache file.
/// Setting `force` to `true` bypasses the freshness check.
pub async fn list_catalog(app: AppHandle, force: bool) -> Result<Value, String> {
    let path = cache_path(&app)?;
    if !force {
        if let Some(cached) = read_fresh_cache(&path) {
            log::info!(target: "ironclaw_ironhub", "serving cached catalog from {}", path.display());
            return Ok(cached);
        }
    }
    let client = build_client()?;
    let fresh = assemble_catalog(&client).await?;
    if let Ok(bytes) = serde_json::to_vec_pretty(&fresh) {
        // Best-effort cache write — failure here is non-fatal; we just lose
        // the speedup on the next call.
        if let Err(e) = std::fs::write(&path, &bytes) {
            log::warn!(target: "ironclaw_ironhub", "cache write failed at {}: {e}", path.display());
        } else {
            log::info!(
                target: "ironclaw_ironhub",
                "cached catalog ({} bytes) → {}",
                bytes.len(),
                path.display()
            );
        }
    }
    Ok(fresh)
}

/// Fetch the raw SKILL.md for a slug. The slug is the directory name under
/// `skills/` in the upstream repo (matches the `name` field in the
/// catalog response).
pub async fn fetch_skill(slug: String) -> Result<Value, String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() {
        return Err("slug is empty".into());
    }
    // Reject anything that could escape the skills directory. We only
    // permit the same characters GitHub's path resolver allows for a
    // directory child entry — letters, digits, `_`, `-`, `.`. Disallowing
    // `..` and `/` keeps the path safe whether we feed it into a URL or
    // into the local install destination.
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || trimmed.contains("..")
    {
        return Err(format!("invalid slug: {trimmed}"));
    }
    let url = format!("{GH_RAW_BASE}/{SKILL_PATH}/{trimmed}/SKILL.md");
    log::info!(target: "ironclaw_ironhub", "fetching skill {trimmed} from {url}");
    let client = build_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch SKILL.md for {trimmed}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "SKILL.md for {trimmed} returned {status} (does the skill exist on IronHub?)"
        ));
    }
    // GitHub returns an `ETag` header that's stable across content versions
    // for the raw blob; we surface it as `sha` so the UI can render a
    // version hint.
    let sha = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_default();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read SKILL.md body for {trimmed}: {e}"))?;
    Ok(json!({
        "slug": trimmed,
        "content": body,
        "sha": sha,
        "fetched_at": now_secs(),
    }))
}

/// Resolve the directory the local sidecar reads skills from. The sidecar
/// uses `~/.ironclaw/skills/` by default (matches the `SKILLS_DIR` env in
/// the bundled IronClaw binary's startup banner). The directory may not
/// exist yet on a fresh install; we create it lazily on write rather than
/// here, so a remote-mode profile that never spawns the sidecar doesn't
/// leave a stray empty dir lying around.
fn local_skills_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "$HOME not set; cannot resolve ~/.ironclaw/skills/".to_string())?;
    Ok(PathBuf::from(home).join(".ironclaw").join("skills"))
}

/// Write `content` to `<root>/<slug>/SKILL.md` with mode 0644. Pulled out
/// of `install_skill_local` so unit tests can exercise the write logic
/// without needing a Tauri AppHandle or a running sidecar.
fn write_skill_to(root: &Path, slug: &str, content: &str) -> Result<(PathBuf, u64), String> {
    if slug.trim().is_empty() {
        return Err("slug is empty".into());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || slug.contains("..")
    {
        return Err(format!("invalid slug: {slug}"));
    }
    let dest_dir = root.join(slug);
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("create {}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join("SKILL.md");
    std::fs::write(&dest, content.as_bytes())
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o644);
        if let Err(e) = std::fs::set_permissions(&dest, perms) {
            log::warn!(
                target: "ironclaw_ironhub",
                "chmod 0644 {} failed: {e}",
                dest.display()
            );
        }
    }
    Ok((dest, content.len() as u64))
}

/// Public entrypoint: write the SKILL.md for `slug` into the local
/// sidecar's skills directory. Requires a running local sidecar — remote
/// mode is rejected so a user who's pointed at a shared gateway doesn't
/// silently install a skill on their laptop that the gateway never sees.
pub async fn install_skill_local(
    state: State<'_, SidecarState>,
    slug: String,
) -> Result<Value, String> {
    // Gate on a running local sidecar. Anything else (remote profile, no
    // sidecar started yet, in-flight start) should fail loudly so the
    // user knows the install doesn't go where they expect.
    let status = sidecar::status(state).await;
    if !status.running {
        return Err(
            "install requires the bundled sidecar — remote mode doesn't expose a \
             skill-upload endpoint yet"
                .into(),
        );
    }

    let payload = fetch_skill(slug.clone()).await?;
    let content = payload
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "fetched SKILL.md has no `content` field".to_string())?;
    let resolved_slug = payload
        .get("slug")
        .and_then(|v| v.as_str())
        .unwrap_or(slug.as_str());

    let skills_root = local_skills_dir()?;
    let (dest, bytes_written) = write_skill_to(&skills_root, resolved_slug, content)?;
    log::info!(
        target: "ironclaw_ironhub",
        "installed skill {resolved_slug} ({bytes_written} bytes) → {}",
        dest.display()
    );
    Ok(json!({
        "path": dest.to_string_lossy(),
        "bytes_written": bytes_written,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_freshness_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE);
        let payload = json!({
            "schema": SCHEMA,
            "fetched_at": now_secs(),
            "tools": [],
            "skills": [],
        });
        std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
        let cached = read_fresh_cache(&path);
        assert!(cached.is_some());
    }

    #[test]
    fn stale_cache_drops() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE);
        let stale = now_secs().saturating_sub(CACHE_TTL_SECS + 10);
        let payload = json!({
            "schema": SCHEMA,
            "fetched_at": stale,
            "tools": [],
            "skills": [],
        });
        std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
        let cached = read_fresh_cache(&path);
        assert!(cached.is_none(), "expected stale cache to be discarded");
    }

    #[test]
    fn missing_cache_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        let cached = read_fresh_cache(&path);
        assert!(cached.is_none());
    }

    #[test]
    fn malformed_cache_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE);
        std::fs::write(&path, b"not valid json {{").unwrap();
        let cached = read_fresh_cache(&path);
        assert!(cached.is_none());
    }

    #[tokio::test]
    async fn fetch_skill_rejects_empty_slug() {
        let res = fetch_skill(String::new()).await;
        assert!(res.is_err());
        let res = fetch_skill("   ".into()).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn fetch_skill_rejects_path_traversal() {
        for bad in ["..", "../etc/passwd", "skill/../../escape", "ok/SKILL"] {
            let res = fetch_skill(bad.into()).await;
            assert!(
                res.is_err(),
                "expected `{bad}` to be rejected as an invalid slug"
            );
        }
    }

    #[test]
    fn write_skill_writes_into_slug_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let content = "---\nname: demo\nversion: 0.1.0\n---\n# demo skill\n";
        let (dest, bytes) = write_skill_to(root, "demo", content).unwrap();
        assert_eq!(bytes, content.as_bytes().len() as u64);
        // The destination must land inside the slug-named subdir.
        assert!(dest.starts_with(root.join("demo")));
        assert_eq!(dest.file_name().and_then(|s| s.to_str()), Some("SKILL.md"));
        let read = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(read, content);
    }

    #[test]
    fn write_skill_creates_missing_parent() {
        let dir = tempfile::tempdir().unwrap();
        // Deliberately point at a deeper, not-yet-existing root.
        let root = dir.path().join("never").join("touched");
        let (_, bytes) = write_skill_to(&root, "fresh", "body").unwrap();
        assert_eq!(bytes, 4);
        assert!(root.join("fresh").join("SKILL.md").exists());
    }

    #[test]
    fn write_skill_rejects_bad_slug() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", "  ", "..", "a/b", "../escape"] {
            let res = write_skill_to(dir.path(), bad, "x");
            assert!(res.is_err(), "expected `{bad}` to be rejected");
        }
    }
}
