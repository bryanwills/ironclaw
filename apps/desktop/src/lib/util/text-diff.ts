export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  op: DiffOp;
  /** The line text (without trailing newline). */
  text: string;
  /** 1-based line number in the OLD text, or null for inserts. */
  oldLine: number | null;
  /** 1-based line number in the NEW text, or null for deletes. */
  newLine: number | null;
}

function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Line-level diff via LCS. Splits on \n (\r\n tolerated). Returns the
 *  merged sequence: unchanged lines as 'equal', removed as 'delete',
 *  added as 'insert', in reading order (deletes before inserts at a hunk).
 *  Two identical texts -> all 'equal'. Empty old -> all 'insert'; empty new
 *  -> all 'delete'. Deterministic. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lcsLengths: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    Array.from({ length: newLines.length + 1 }, () => 0)
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        lcsLengths[oldIndex][newIndex] = lcsLengths[oldIndex + 1][newIndex + 1] + 1;
      } else {
        lcsLengths[oldIndex][newIndex] = Math.max(
          lcsLengths[oldIndex + 1][newIndex],
          lcsLengths[oldIndex][newIndex + 1]
        );
      }
    }
  }

  const diff: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];

    if (oldLine === newLine) {
      diff.push({
        op: 'equal',
        text: oldLine,
        oldLine: oldIndex + 1,
        newLine: newIndex + 1
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (lcsLengths[oldIndex + 1][newIndex] >= lcsLengths[oldIndex][newIndex + 1]) {
      diff.push({
        op: 'delete',
        text: oldLine,
        oldLine: oldIndex + 1,
        newLine: null
      });
      oldIndex += 1;
    } else {
      diff.push({
        op: 'insert',
        text: newLine,
        oldLine: null,
        newLine: newIndex + 1
      });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    diff.push({
      op: 'delete',
      text: oldLines[oldIndex],
      oldLine: oldIndex + 1,
      newLine: null
    });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    diff.push({
      op: 'insert',
      text: newLines[newIndex],
      oldLine: null,
      newLine: newIndex + 1
    });
    newIndex += 1;
  }

  return diff;
}

/** Counts for a summary chip. */
export function diffStats(lines: DiffLine[]): {
  added: number;
  removed: number;
  unchanged: number;
} {
  return lines.reduce(
    (stats, line) => {
      if (line.op === 'insert') {
        stats.added += 1;
      } else if (line.op === 'delete') {
        stats.removed += 1;
      } else {
        stats.unchanged += 1;
      }

      return stats;
    },
    { added: 0, removed: 0, unchanged: 0 }
  );
}
