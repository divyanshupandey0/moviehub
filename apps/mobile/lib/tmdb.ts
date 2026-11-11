/**
 * TMDB anime exclusion (Hard Mode Split).
 *
 * Movie/TV mode must never surface Japanese anime in its home/search feeds.
 * TMDB tags anime as Animation (genre id 16) AND Japanese language. Requiring
 * BOTH isolates Japanese anime while leaving Western animation (Arcane,
 * Spider-Verse) in the movie/TV feed. Client-side, zero-latency, no network.
 *
 * Reference verdict (MOBILE-ANIME-ARCHITECTURE-CONSULTATION.md Q2): do NOT use
 * `without_genres=16` (drops wanted Western animation) and do NOT use the
 * anime-map.json id exclusion (leaks unmapped new titles).
 */

const ANIMATION_GENRE_ID = 16;

export function isTmdbAnime(item: {
  genre_ids?: number[];
  genres?: Array<{ id: number }>;
  original_language?: string;
}): boolean {
  const genreIds = item.genre_ids ?? (item.genres ?? []).map((g) => g.id);
  const isAnimation = genreIds.includes(ANIMATION_GENRE_ID);
  const isJapanese = item.original_language === "ja";
  return Boolean(isAnimation && isJapanese);
}

/** Drop anime from a TMDB result list (home/search). */
export function filterTmdbAnime<T>(items: T[]): T[] {
  return items.filter((item) => !isTmdbAnime(item as any));
}

/**
 * Strict TV Show Release-Date Filtering.
 *
 * Rules:
 * - Uses TMDB's `first_air_date` as the primary release-date field for TV shows.
 * - Displays a TV show as released ONLY when its first episode has actually premiered.
 * - Excludes all shows with future `first_air_date` values (> today).
 * - Excludes upcoming, unreleased, announced, and not-yet-premiered shows.
 * - Excludes TV shows with missing or invalid premiere dates from release-based sections.
 * - Does not use `last_air_date`, season dates, episode dates, popularity or trending status.
 */

export function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const localToday = `${year}-${month}-${day}`;
  const utcToday = now.toISOString().split("T")[0];
  return localToday > utcToday ? localToday : utcToday;
}

export function isValidReleasedTVShow(
  show: any,
  today: string = getTodayDateString(),
): show is { id: number; first_air_date: string; [key: string]: any } {
  if (!show || typeof show !== "object") return false;
  if (!show.id || (!show.title && !show.name)) return false;
  if (!show.poster_path && !show.backdrop_path) return false;

  // Primary release date field MUST be first_air_date
  const airDate = show.first_air_date;
  if (!airDate || typeof airDate !== "string" || airDate.trim().length < 10) {
    // Missing, null, empty or invalid date -> MUST NOT APPEAR
    return false;
  }

  const cleanDate = airDate.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    return false;
  }

  // Future first_air_date -> strictly excluded (not yet premiered)
  if (cleanDate > today) {
    return false;
  }

  // Explicit unreleased status check if status field is present
  if (show.status && typeof show.status === "string") {
    const s = show.status.toLowerCase().trim();
    if (
      s === "planned" ||
      s === "in production" ||
      s === "upcoming" ||
      s === "unreleased" ||
      s === "pilot"
    ) {
      return false;
    }
  }

  return true;
}

export function filterReleasedTV<T extends { id?: number | null; first_air_date?: string | null }>(
  items: T[],
  today: string = getTodayDateString(),
): Array<T & { id: number; first_air_date: string; _mediaType: "tv" }> {
  if (!Array.isArray(items)) return [];
  const seen = new Set<number>();
  const list: Array<T & { id: number; first_air_date: string; _mediaType: "tv" }> = [];

  for (const item of items) {
    if (!isValidReleasedTVShow(item, today)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const cleanDate = item.first_air_date.trim().slice(0, 10);
    list.push({
      ...item,
      id: item.id,
      first_air_date: cleanDate,
      _mediaType: "tv",
    });
  }

  return list;
}

export function filterAndSortRecentTV<T extends { id?: number | null; first_air_date?: string | null }>(
  items: T[],
  today: string = getTodayDateString(),
): Array<T & { id: number; first_air_date: string; _mediaType: "tv" }> {
  const verified = filterReleasedTV(items, today);
  // Sort eligible shows by actual first_air_date, newest first
  return verified.sort((a, b) => {
    const dateA = a.first_air_date || "";
    const dateB = b.first_air_date || "";
    return dateB.localeCompare(dateA);
  });
}

