const WRAPPED_ASSIGNMENT_RE =
  /^```(?:python|py|repl|javascript|js|typescript|ts)?\s*\n([\s\S]*?)\n```$/u;

const TRAILING_TRIPLE_QUOTED_ASSIGNMENT_RE =
  /(?:^|\n)\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*("""|''')([\s\S]*?)\1\s*;?\s*$/u;

/**
 * Some model/tool paths serialize a document as source code, e.g.
 * `agreement = """# Services Agreement ..."""` inside a lone fenced block.
 * That is not a code answer; it is a work product trapped in a code wrapper.
 * Keep this intentionally narrow so real code generation remains untouched.
 */
export function unwrapDocumentAssignment(content: string): string {
  const trimmed = content.trim();
  const fenced = WRAPPED_ASSIGNMENT_RE.exec(trimmed);
  if (!fenced) return content;

  const body = fenced[1]?.trim() ?? '';
  const assignment = TRAILING_TRIPLE_QUOTED_ASSIGNMENT_RE.exec(body);
  if (!assignment) return content;

  const document = (assignment[2] ?? '').trim();
  if (!looksLikeUserDocument(document)) return content;
  return document;
}

function looksLikeUserDocument(document: string): boolean {
  if (document.length < 500) return false;
  if (/^#\s+\S/u.test(document)) return true;
  if (
    /^(?:SERVICES AGREEMENT|MASTER SERVICES AGREEMENT|STATEMENT OF WORK|MEMORANDUM)\b/iu.test(
      document
    )
  ) {
    return true;
  }
  return /^##\s+\S/mu.test(document) && /\n\n[A-Z0-9][\s\S]{120,}/u.test(document);
}
