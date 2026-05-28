use ironclaw_host_api::{
    CAPABILITY_DISPLAY_OUTPUT_PREVIEW_MAX_BYTES, CapabilityDisplayOutputPreview,
};
use similar::{ChangeTag, TextDiff};

const DIFF_CONTEXT_LINES: usize = 3;

pub(super) fn file_diff_preview(
    path: &str,
    old_content: &str,
    new_content: &str,
) -> CapabilityDisplayOutputPreview {
    let diff = TextDiff::from_lines(old_content, new_content);
    let diff_path = path.trim_start_matches('/');
    let mut output = String::new();
    output.push_str(&format!("--- a/{diff_path}\n"));
    output.push_str(&format!("+++ b/{diff_path}\n"));

    let mut additions = 0usize;
    let mut deletions = 0usize;
    for group in diff.grouped_ops(DIFF_CONTEXT_LINES) {
        let Some(first_op) = group.first() else {
            continue;
        };
        let Some(last_op) = group.last() else {
            continue;
        };
        let old_start = hunk_start(first_op.old_range().start, first_op.old_range().len());
        let new_start = hunk_start(first_op.new_range().start, first_op.new_range().len());
        let old_len = last_op.old_range().end - first_op.old_range().start;
        let new_len = last_op.new_range().end - first_op.new_range().start;
        output.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_start, old_len, new_start, new_len
        ));
        for op in group {
            for change in diff.iter_changes(&op) {
                let prefix = match change.tag() {
                    ChangeTag::Delete => {
                        deletions += 1;
                        '-'
                    }
                    ChangeTag::Insert => {
                        additions += 1;
                        '+'
                    }
                    ChangeTag::Equal => ' ',
                };
                push_diff_line(&mut output, prefix, change.value());
            }
        }
    }

    let bounded = truncate_utf8(&output, CAPABILITY_DISPLAY_OUTPUT_PREVIEW_MAX_BYTES);
    CapabilityDisplayOutputPreview {
        output_summary: Some(format!("Edited 1 file: +{additions}/-{deletions}")),
        output_preview: bounded.text,
        output_kind: "unified_diff".to_string(),
        subtitle: Some(path.to_string()),
        truncated: bounded.truncated,
    }
}

fn hunk_start(start: usize, len: usize) -> usize {
    if len == 0 { start } else { start + 1 }
}

fn push_diff_line(output: &mut String, prefix: char, value: &str) {
    output.push(prefix);
    output.push_str(value);
    if !value.ends_with('\n') {
        output.push('\n');
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BoundedText {
    text: String,
    truncated: bool,
}

fn truncate_utf8(text: &str, max_bytes: usize) -> BoundedText {
    if text.len() <= max_bytes {
        return BoundedText {
            text: text.to_string(),
            truncated: false,
        };
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    BoundedText {
        text: text[..end].to_string(),
        truncated: true,
    }
}

#[cfg(test)]
mod tests {
    use super::file_diff_preview;

    #[test]
    fn file_diff_preview_emits_unified_diff_and_stats() {
        let preview = file_diff_preview(
            "src/main.rs",
            "fn main() {\n    old();\n}\n",
            "fn main() {\n    new();\n}\n",
        );

        assert_eq!(preview.output_kind, "unified_diff");
        assert_eq!(
            preview.output_summary.as_deref(),
            Some("Edited 1 file: +1/-1")
        );
        assert!(
            preview
                .output_preview
                .contains("--- a/src/main.rs\n+++ b/src/main.rs\n@@")
        );
        assert!(preview.output_preview.contains("-    old();"));
        assert!(preview.output_preview.contains("+    new();"));
    }

    #[test]
    fn file_diff_preview_emits_multiple_hunks_without_rewriting_middle_context() {
        let old_content = "one\nold-a\nthree\nfour\nfive\nsix\nold-b\neight\n";
        let new_content = "one\nnew-a\nthree\nfour\nfive\nsix\nnew-b\neight\n";

        let preview = file_diff_preview("src/main.rs", old_content, new_content);

        assert_eq!(
            preview.output_summary.as_deref(),
            Some("Edited 1 file: +2/-2")
        );
        assert!(preview.output_preview.contains("-old-a\n+new-a"));
        assert!(preview.output_preview.contains("-old-b\n+new-b"));
        assert!(
            !preview
                .output_preview
                .contains("-three\n-four\n-five\n-six")
        );
    }
}
