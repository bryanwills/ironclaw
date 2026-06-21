pub(crate) const IRONCLAW_LEARNING_ENABLED_ENV: &str = "IRONCLAW_LEARNING_ENABLED";
pub(crate) const LEARNING_FIELD_NAMES: [&str; 5] =
    ["key", "category", "confidence", "created_at", "source"];

pub(crate) fn learning_enabled() -> bool {
    match std::env::var(IRONCLAW_LEARNING_ENABLED_ENV) {
        Ok(value) => matches!(value.trim(), "1" | "true"),
        Err(std::env::VarError::NotPresent) => false, // silent-ok: absent flag keeps learning default-off.
        Err(std::env::VarError::NotUnicode(_)) => false, // silent-ok: malformed flag is treated as disabled.
    }
}
