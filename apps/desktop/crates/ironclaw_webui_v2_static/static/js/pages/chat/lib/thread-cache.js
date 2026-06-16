// Flatten the react-query ['threads'] cache into a flat thread array. The list
// is paginated with useInfiniteQuery, so the cache is { pages: [{ threads,
// next_cursor }], pageParams }; the legacy single-page { threads } shape is
// tolerated too. Pure + unit-tested so the cache contract can't silently drift
// (a previous read of cached.threads broke when pagination landed).
export function flattenCachedThreads(cached) {
  if (Array.isArray(cached?.pages)) {
    return cached.pages.flatMap((page) => (Array.isArray(page?.threads) ? page.threads : []));
  }
  if (Array.isArray(cached?.threads)) return cached.threads;
  return [];
}
