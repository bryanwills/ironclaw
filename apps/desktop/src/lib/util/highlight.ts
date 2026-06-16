// Substring-highlight segmentation, shared by search surfaces. Splices a
// haystack into [pre, match, post] segments around every (case-insensitive)
// occurrence of the needle; the renderer tints `hit` segments. Extracted from
// GlobalSearch (audit R200 P2) so the fiddly splice logic is unit-tested and
// reusable (CommandPalette / Omnibar can adopt it later).

export interface Segment {
  text: string;
  /** True if this segment is a match — the renderer tints it. */
  hit: boolean;
}

/**
 * Split `haystack` into highlight segments around each case-insensitive
 * occurrence of `needle`. Empty/absent haystack → `[]`; empty needle → a
 * single non-hit segment with the whole string. Match text preserves the
 * haystack's original casing. Never throws.
 */
export function highlight(haystack: string | undefined | null, needle: string): Segment[] {
  if (!haystack) return [];
  if (!needle) return [{ text: haystack, hit: false }];
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  const segs: Segment[] = [];
  let i = 0;
  while (i < haystack.length) {
    const found = lower.indexOf(target, i);
    if (found < 0) {
      segs.push({ text: haystack.slice(i), hit: false });
      break;
    }
    if (found > i) segs.push({ text: haystack.slice(i, found), hit: false });
    segs.push({ text: haystack.slice(found, found + target.length), hit: true });
    i = found + target.length;
  }
  return segs;
}
