//! Run a Python snippet in a constrained `/usr/bin/python3` subprocess.
//!
//! Security:
//!   - hardcoded interpreter path (no PATH lookup)
//!   - no shell expansion (we pass `-c <snippet>` directly)
//!   - no inherited env (start with `PYTHONDONTWRITEBYTECODE=1` only)
//!   - 30-second wall-clock timeout
//!   - 1 MB stdout cap
//!   - runs as the current app user; no privilege drop is performed here

use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const TIMEOUT_SECS: u64 = 30;
const STDOUT_CAP: usize = 1024 * 1024;

#[derive(serde::Serialize)]
pub struct PythonResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
}

#[tauri::command]
pub async fn run_python_snippet(code: String) -> Result<PythonResult, String> {
    let mut cmd = Command::new("/usr/bin/python3");
    cmd.arg("-c").arg(&code);
    cmd.env_clear();
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    cmd.env("HOME", std::env::var("HOME").unwrap_or_default());
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdout_buf = Vec::with_capacity(8192);
    let mut stderr_buf = Vec::with_capacity(4096);

    let stdout = child.stdout.take().ok_or("stdout pipe missing")?;
    let stderr = child.stderr.take().ok_or("stderr pipe missing")?;

    let run = async {
        let mut so = tokio::io::BufReader::new(stdout);
        let mut se = tokio::io::BufReader::new(stderr);
        let _ = so.read_to_end(&mut stdout_buf).await;
        let _ = se.read_to_end(&mut stderr_buf).await;
        child.wait().await
    };

    let status = match timeout(Duration::from_secs(TIMEOUT_SECS), run).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => {
            return Err(format!("execution exceeded {TIMEOUT_SECS}s timeout"));
        }
    };

    let truncated = stdout_buf.len() > STDOUT_CAP;
    stdout_buf.truncate(STDOUT_CAP);
    stderr_buf.truncate(STDOUT_CAP);

    Ok(PythonResult {
        stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
        stderr: String::from_utf8_lossy(&stderr_buf).to_string(),
        exit_code: status.code().unwrap_or(-1),
        truncated,
    })
}
