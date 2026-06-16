//! Push a single assistant turn into Apple Notes via osascript.
//!
//! Best-effort: failures bubble back to the JS caller so the UI can
//! decide whether to surface a toast.
//!
//! SECURITY (R90 P0 fix): `title`/`body` are untrusted — `body` is
//! assistant-generated. They are passed to osascript as discrete
//! `on run argv` values and are NEVER interpolated into the AppleScript
//! source. AppleScript treats argv items as opaque string values, so a
//! body containing quotes, backslashes, or `… & (do shell script "…")`
//! cannot terminate the string literal and execute. The `--` terminates
//! osascript's option parsing so a title/body beginning with `-` is not
//! read as a flag. (The previous build interpolated the values into the
//! script source and escaped only `"` and `\n` — not backslash-first —
//! which allowed a crafted payload to break out and run arbitrary
//! `do shell script` commands.)

use std::io::Read;
use std::process::{Command, Stdio};

/// The AppleScript run by osascript. Reads the note's name + body from
/// `argv` so untrusted content is never parsed as script source.
const NOTES_SCRIPT: &str = "on run argv\n  tell application \"Notes\"\n    tell account 1\n      make new note at folder \"Notes\" with properties {name:(item 1 of argv), body:(item 2 of argv)}\n    end tell\n  end tell\nend run";

/// Build the full osascript argument vector. Factored out so the
/// argv-not-source contract can be unit-tested without invoking osascript.
fn build_osascript_args(title: &str, body: &str) -> Vec<String> {
    vec![
        "-e".to_string(),
        NOTES_SCRIPT.to_string(),
        // `--` ends option parsing; everything after is `argv` for the
        // `on run argv` handler, passed verbatim as string values.
        "--".to_string(),
        title.to_string(),
        body.to_string(),
    ]
}

#[tauri::command]
pub async fn export_to_notes(title: String, body: String) -> Result<(), String> {
    let args = build_osascript_args(&title, &body);
    let mut child = Command::new("/usr/bin/osascript")
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut err);
        }
        return Err(format!("osascript exited {}: {}", status, err.trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::build_osascript_args;

    #[test]
    fn passes_title_and_body_as_discrete_argv_after_separator() {
        let args = build_osascript_args("My Note", "hello\nworld");
        // Script is provided via -e and references argv, not the values.
        assert_eq!(args[0], "-e");
        assert!(args[1].contains("on run argv"));
        // The untrusted values are the two args AFTER the `--` option
        // terminator, passed verbatim (no escaping, no interpolation).
        assert_eq!(args[2], "--");
        assert_eq!(args[3], "My Note");
        assert_eq!(args[4], "hello\nworld");
    }

    #[test]
    fn injection_payload_is_passed_through_not_interpreted() {
        // The exact class of payload that broke the old string-interpolation
        // build: a backslash+quote sequence trying to close the literal and
        // run `do shell script`. With argv it is just an opaque value.
        let payload = "x\\\" & (do shell script \"touch /tmp/pwned\") & \"";
        let args = build_osascript_args("t", payload);
        // Carried verbatim as the final argv entry...
        assert_eq!(args.last().unwrap(), payload);
        // ...and nothing in the script source ever carries the payload.
        assert!(!args[1].contains("do shell script"));
    }
}
