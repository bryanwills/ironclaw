export interface FuzzyResult {
  /** True when every char of the (lowercased) query appears in order. */
  matched: boolean;
  /** Higher = better. 0 when !matched. Reward contiguous runs + matches
   *  at word boundaries / string start. */
  score: number;
  /** Indices into the ORIGINAL target string that matched, ascending -
   *  for highlighting. Empty when !matched. */
  indices: number[];
}

interface Candidate {
  score: number;
  indices: number[];
}

const MATCH_SCORE = 10;
const CONTIGUOUS_BONUS = 8;
const BOUNDARY_BONUS = 6;
const START_BONUS = 4;
const GAP_PENALTY = 1;

function isAlphaNumeric(char: string): boolean {
  return /[a-z0-9]/i.test(char);
}

function isWordBoundary(target: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const current = target[index];
  const previous = target[index - 1];

  if (!isAlphaNumeric(previous) && isAlphaNumeric(current)) {
    return true;
  }

  return (
    previous.toLowerCase() === previous &&
    current.toUpperCase() === current &&
    /[A-Z]/.test(current)
  );
}

function scoreMatch(target: string, index: number, previousIndex: number | null): number {
  let score = MATCH_SCORE;

  if (previousIndex !== null) {
    if (index === previousIndex + 1) {
      score += CONTIGUOUS_BONUS;
    } else {
      score -= Math.max(0, index - previousIndex - 1) * GAP_PENALTY;
    }
  }

  if (isWordBoundary(target, index)) {
    score += BOUNDARY_BONUS;
  }

  if (index === 0) {
    score += START_BONUS;
  }

  return score;
}

function isBetterCandidate(candidate: Candidate, best: Candidate | null): boolean {
  if (best === null) {
    return true;
  }

  if (candidate.score !== best.score) {
    return candidate.score > best.score;
  }

  const candidateStart = candidate.indices[0] ?? Number.POSITIVE_INFINITY;
  const bestStart = best.indices[0] ?? Number.POSITIVE_INFINITY;

  if (candidateStart !== bestStart) {
    return candidateStart < bestStart;
  }

  const candidateEnd = candidate.indices[candidate.indices.length - 1] ?? Number.POSITIVE_INFINITY;
  const bestEnd = best.indices[best.indices.length - 1] ?? Number.POSITIVE_INFINITY;

  return candidateEnd < bestEnd;
}

/** Case-insensitive subsequence match of `query` within `target`.
 *  Empty query -> { matched: true, score: 0, indices: [] }. */
export function fuzzyMatch(query: string, target: string): FuzzyResult {
  const normalizedQuery = query.toLowerCase();
  const normalizedTarget = target.toLowerCase();

  if (normalizedQuery.length === 0) {
    return { matched: true, score: 0, indices: [] };
  }

  if (normalizedQuery.length > normalizedTarget.length) {
    return { matched: false, score: 0, indices: [] };
  }

  let previousRow: Array<Candidate | null> = [];

  for (let queryIndex = 0; queryIndex < normalizedQuery.length; queryIndex += 1) {
    const row: Array<Candidate | null> = new Array(normalizedTarget.length).fill(null);

    for (let targetIndex = 0; targetIndex < normalizedTarget.length; targetIndex += 1) {
      if (normalizedQuery[queryIndex] !== normalizedTarget[targetIndex]) {
        continue;
      }

      if (queryIndex === 0) {
        row[targetIndex] = {
          score: scoreMatch(target, targetIndex, null),
          indices: [targetIndex]
        };
        continue;
      }

      let bestCandidate: Candidate | null = null;

      for (let previousIndex = 0; previousIndex < targetIndex; previousIndex += 1) {
        const previous = previousRow[previousIndex];

        if (previous !== null) {
          const lastIndex = previous.indices[previous.indices.length - 1];
          const candidate = {
            score: previous.score + scoreMatch(target, targetIndex, lastIndex),
            indices: [...previous.indices, targetIndex]
          };

          if (isBetterCandidate(candidate, bestCandidate)) {
            bestCandidate = candidate;
          }
        }
      }

      row[targetIndex] = bestCandidate;
    }

    previousRow = row;
  }

  const best = previousRow.reduce<Candidate | null>(
    (currentBest, candidate) =>
      candidate !== null && isBetterCandidate(candidate, currentBest) ? candidate : currentBest,
    null
  );

  if (best === null) {
    return { matched: false, score: 0, indices: [] };
  }

  return { matched: true, score: best.score, indices: best.indices };
}

/** Convenience: rank a list of candidates, returning the matched ones
 *  sorted by score desc (stable for ties), each with its FuzzyResult.
 *  `key` extracts the searchable string from an item (defaults to String). */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  key: (item: T) => string = String
): Array<{ item: T; result: FuzzyResult }> {
  return items
    .map((item, index) => ({ item, index, result: fuzzyMatch(query, key(item)) }))
    .filter((entry) => entry.result.matched)
    .sort((left, right) => right.result.score - left.result.score || left.index - right.index)
    .map(({ item, result }) => ({ item, result }));
}
