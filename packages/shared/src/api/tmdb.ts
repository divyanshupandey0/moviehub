import { IMAGE_BASE_URL } from "../constants/tmdb";
import type { Movie } from "../types/movie";

/** Typed HTTP error carrying the response status (for smart retry). */
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string, url?: string) {
    super(`TMDB API error: ${status} ${statusText}${url ? ` (${url})` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
  }
}

export interface FetchJsonOptions {
  /** Caller-owned cancellation (e.g. React Query's AbortSignal). */
  signal?: AbortSignal | null;
  /** Hard timeout; aborts the request. Default 10000ms. */
  timeoutMs?: number;
}

/**
 * fetch + JSON with a merged abort signal (caller signal ∪ manual timeout)
 * and a typed ApiError on non-2xx.
 *
 * Defaults to `any` so existing call sites keep their previous structural
 * typing; pass an explicit type parameter when you need a narrow result.
 */
export async function fetchJson<T = any>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort);
  }

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new ApiError(res.status, res.statusText, url);
    }
    // Read as text first so we can log exact payload size for detail calls.
    const text = await res.text();
    if (
      typeof text === "string" &&
      /\/api\/tmdb\/(movie|tv)\/\d+\?/.test(url)
    ) {
      let bytes = text.length;
      try {
        if (typeof TextEncoder !== "undefined") {
          bytes = new TextEncoder().encode(text).length;
        }
      } catch {
        // Hermes without reliable TextEncoder → character length fallback.
      }
      // Side-channel for mobile detailMetrics (no-op if no session open).
      const mod = globalThis as unknown as {
        __markDetailPayloadBytes?: (n: number) => void;
      };
      if (mod.__markDetailPayloadBytes) {
        mod.__markDetailPayloadBytes(bytes);
      } else {
        // Fallback so the line is never silently dropped (FIX 6).
        console.log(`[detail] payload bytes=${bytes}`);
      }
    }
    return JSON.parse(text) as T;
  } catch (err) {
    // Surface timeout/cancel as-is so React Query can classify retries.
    throw err;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Strict TV Show Release-Date Filtering.
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
  return verified.sort((a, b) => {
    const dateA = a.first_air_date || "";
    const dateB = b.first_air_date || "";
    return dateB.localeCompare(dateA);
  });
}

/**
 * Cross-platform TMDB client.
 *
 * Calls the web app's /api/tmdb pass-through endpoint so the API key
 * stays server-side. Works in both browser and React Native.
 *
 * @param apiBase - Base URL of the Filmsnaps API.
 *   Browser: '' (same origin)
 *   React Native dev: 'http://localhost:3000' or 'http://10.0.2.2:3000'
 *   React Native prod: 'https://filmsnaps.app'
 */
export function createTmdbApi(apiBase: string) {
  const fetchTmdb = (
    path: string,
    signal?: AbortSignal | null,
    timeoutMs?: number,
  ) => fetchJson(`${apiBase}/api/tmdb${path}`, { signal, timeoutMs });

  return {
    getTrendingMovies: (page = 1, signal?: AbortSignal | null) =>
      fetchTmdb(
        `/trending/movie/week${page > 1 ? `?page=${page}` : ""}`,
        signal,
      ),

    getTrendingTV: async (page = 1, signal?: AbortSignal | null) => {
      const res = await fetchTmdb(
        `/trending/tv/week${page > 1 ? `?page=${page}` : ""}`,
        signal,
      );
      if (res && Array.isArray(res.results)) {
        return {
          ...res,
          results: filterReleasedTV(res.results),
        };
      }
      return res;
    },

    getPopularMovies: (page = 1, signal?: AbortSignal | null) =>
      fetchTmdb(`/movie/popular?page=${page}`, signal),

    getUpcomingMovies: (signal?: AbortSignal | null) =>
      fetchTmdb("/movie/upcoming", signal),

    getTop10MoviesToday: async (signal?: AbortSignal | null) => {
      const res = await fetchTmdb("/trending/movie/day", signal);
      if (res && Array.isArray(res.results)) {
        const seen = new Set<number>();
        const unique: Movie[] = [];
        for (const item of res.results) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            unique.push(item);
          }
          if (unique.length === 10) break;
        }
        return { ...res, results: unique };
      }
      return res;
    },

    getRecentAddedMovies: async (
      page = 1,
      signal?: AbortSignal | null,
    ) => {
      const today = new Date().toISOString().split("T")[0];
      const d = new Date();
      d.setDate(d.getDate() - 45);
      const windowStart = d.toISOString().split("T")[0];
      const q = new URLSearchParams({
        page: String(page),
        include_adult: "false",
        "release_date.gte": windowStart,
        "release_date.lte": today,
        with_release_type: "2|3|4|5",
        sort_by: "release_date.desc",
        "vote_count.gte": "5",
      });
      const res = await fetchTmdb(`/discover/movie?${q}`, signal);
      if (res && Array.isArray(res.results)) {
        // Strict verified release filtering: no future dates, no unreleased
        const seen = new Set<number>();
        const verified = res.results.filter((m: Movie) => {
          if (!m || !m.id || !m.release_date) return false;
          if (m.release_date > today) return false;
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        return { ...res, results: verified };
      }
      return res;
    },

    getRecentAddedTV: async (page = 1, signal?: AbortSignal | null) => {
      const today = getTodayDateString();
      const d = new Date();
      d.setDate(d.getDate() - 60);
      const windowStart = d.toISOString().split("T")[0];
      const q = new URLSearchParams({
        page: String(page),
        include_adult: "false",
        "first_air_date.gte": windowStart,
        "first_air_date.lte": today,
        with_status: "0|3|4|5",
        sort_by: "first_air_date.desc",
        "vote_count.gte": "3",
      });
      const res = await fetchTmdb(`/discover/tv?${q}`, signal);
      if (res && Array.isArray(res.results)) {
        return {
          ...res,
          results: filterAndSortRecentTV(res.results, today),
        };
      }
      return res;
    },

    getLatestIndianMovies: async (
      language?: string,
      page = 1,
      signal?: AbortSignal | null,
    ) => {
      const today = new Date().toISOString().split("T")[0];
      const d = new Date();
      d.setDate(d.getDate() - 90);
      const windowStart = d.toISOString().split("T")[0];
      const q = new URLSearchParams({
        page: String(page),
        include_adult: "false",
        with_origin_country: "IN",
        region: "IN",
        "release_date.gte": windowStart,
        "release_date.lte": today,
        with_release_type: "2|3|4|5",
        sort_by: "release_date.desc",
      });
      if (language && language !== "all") {
        q.set("with_original_language", language);
      } else {
        q.set("vote_count.gte", "1");
      }
      const res = await fetchTmdb(`/discover/movie?${q}`, signal);
      if (res && Array.isArray(res.results)) {
        const seen = new Set<number>();
        const verified = res.results.filter((m: Movie) => {
          if (!m || !m.id || !m.release_date) return false;
          if (m.release_date > today) return false;
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        return { ...res, results: verified };
      }
      return res;
    },

    getMovieDetails: (id: number | string, signal?: AbortSignal | null) =>
      fetchTmdb(
        // recommendations = TMDB's own "More Like This" engine (what their
        // website renders); similar kept as fallback for thin catalogs.
        `/movie/${id}?append_to_response=videos,credits,similar,recommendations&trim=1`,
        signal,
        // Detail payloads are large — allow a bit more than the default 10s.
        15_000,
      ),

    getTVDetails: (id: number | string, signal?: AbortSignal | null) =>
      fetchTmdb(
        `/tv/${id}?append_to_response=videos,credits,similar,recommendations&trim=1`,
        signal,
        15_000,
      ),

    getTVSeasonsOnly: (id: number | string, signal?: AbortSignal | null) =>
      fetchTmdb(`/tv/${id}`, signal),

    /**
     * TMDB's OWN relevance engine for "more like this" — materially better
     * than genre-discover (which just returns popular titles sharing a
     * genre) and better curated than /similar.
     */
    getMovieRecommendations: (
      id: number | string,
      page = 1,
      signal?: AbortSignal | null,
    ) => fetchTmdb(`/movie/${id}/recommendations?page=${page}`, signal),

    getTVRecommendations: (
      id: number | string,
      page = 1,
      signal?: AbortSignal | null,
    ) => fetchTmdb(`/tv/${id}/recommendations?page=${page}`, signal),

    getSeasonEpisodes: (
      tvId: number | string,
      seasonNumber: number,
      signal?: AbortSignal | null,
    ) => fetchTmdb(`/tv/${tvId}/season/${seasonNumber}`, signal),

    searchMulti: (query: string, page = 1, signal?: AbortSignal | null) =>
      fetchTmdb(
        `/search/multi?query=${encodeURIComponent(query)}&page=${page}`,
        signal,
      ),

    getMovies: (
      params: {
        genreIds?: number[];
        sortBy?: string;
        yearStart?: number;
        yearEnd?: number;
        minRating?: number;
        maxRating?: number;
        language?: string;
        page?: number;
      },
      signal?: AbortSignal | null,
    ) => {
      const q = new URLSearchParams();
      q.set("page", String(params.page ?? 1));
      q.set("sort_by", params.sortBy ?? "popularity.desc");
      if (params.genreIds?.length)
        q.set("with_genres", params.genreIds.join(","));
      if (params.yearStart && params.yearEnd) {
        q.set("primary_release_date.gte", `${params.yearStart}-01-01`);
        q.set("primary_release_date.lte", `${params.yearEnd}-12-31`);
      }
      if (params.minRating !== undefined)
        q.set("vote_average.gte", String(params.minRating));
      if (params.maxRating !== undefined)
        q.set("vote_average.lte", String(params.maxRating));
      if (params.language) q.set("with_original_language", params.language);

      return fetchTmdb(`/discover/movie?${q}`, signal);
    },

    getMoviesAdvanced: (
      params: {
        genreIds?: number[];
        sortBy?: string;
        yearStart?: number;
        yearEnd?: number;
        minRating?: number;
        language?: string;
        /** vote_count.gte — pair with minRating so zero-vote titles never surface. */
        minVotes?: number;
        page?: number;
      },
      signal?: AbortSignal | null,
    ) => {
      const q = new URLSearchParams();
      q.set("page", String(params.page ?? 1));
      q.set("sort_by", params.sortBy ?? "popularity.desc");
      q.set("include_adult", "false");
      if (params.genreIds?.length)
        q.set("with_genres", params.genreIds.join(","));
      if (params.yearStart !== undefined)
        q.set("primary_release_date.gte", `${params.yearStart}-01-01`);
      if (params.yearEnd !== undefined)
        q.set("primary_release_date.lte", `${params.yearEnd}-12-31`);
      if (params.minRating !== undefined) {
        q.set("vote_average.gte", String(params.minRating));
        q.set("vote_count.gte", String(params.minVotes ?? 60));
      }
      if (params.language) q.set("with_original_language", params.language);

      return fetchTmdb(`/discover/movie?${q}`, signal);
    },

    getTVShowsAdvanced: async (
      params: {
        genreIds?: number[];
        sortBy?: string;
        yearStart?: number;
        yearEnd?: number;
        minRating?: number;
        language?: string;
        /** vote_count.gte — pair with minRating so zero-vote titles never surface. */
        minVotes?: number;
        page?: number;
      },
      signal?: AbortSignal | null,
    ) => {
      const today = getTodayDateString();
      const q = new URLSearchParams();
      q.set("page", String(params.page ?? 1));
      let sortBy = params.sortBy ?? "popularity.desc";
      if (sortBy === "primary_release_date.desc") {
        sortBy = "first_air_date.desc";
      }
      q.set("sort_by", sortBy);
      q.set("include_adult", "false");
      if (params.genreIds?.length)
        q.set("with_genres", params.genreIds.join(","));
      if (params.yearStart !== undefined)
        q.set("first_air_date.gte", `${params.yearStart}-01-01`);
      if (params.yearEnd !== undefined) {
        q.set("first_air_date.lte", `${params.yearEnd}-12-31`);
      } else if (sortBy === "first_air_date.desc") {
        q.set("first_air_date.lte", today);
        q.set("with_status", "0|3|4|5");
      }
      if (params.minRating !== undefined) {
        q.set("vote_average.gte", String(params.minRating));
        q.set("vote_count.gte", String(params.minVotes ?? 60));
      }
      if (params.language) q.set("with_original_language", params.language);

      const res = await fetchTmdb(`/discover/tv?${q}`, signal);
      if (res && Array.isArray(res.results)) {
        return {
          ...res,
          results: filterReleasedTV(res.results, today),
        };
      }
      return res;
    },

    getExternalIds: (
      id: number | string,
      mediaType: "movie" | "tv",
      signal?: AbortSignal | null,
    ) => fetchTmdb(`/${mediaType}/${id}/external_ids`, signal),

    getPersonDetails: (id: number, signal?: AbortSignal | null) =>
      fetchTmdb(`/person/${id}`, signal),

    getPersonCredits: (id: number, signal?: AbortSignal | null) =>
      fetchTmdb(`/person/${id}/combined_credits`, signal),

    getTVShows: async (
      params: {
        genreIds?: number[];
        sortBy?: string;
        yearStart?: number;
        yearEnd?: number;
        minRating?: number;
        maxRating?: number;
        language?: string;
        page?: number;
      },
      signal?: AbortSignal | null,
    ) => {
      const today = getTodayDateString();
      const q = new URLSearchParams();
      q.set("page", String(params.page ?? 1));
      let sortBy = params.sortBy ?? "popularity.desc";
      if (sortBy === "primary_release_date.desc") {
        sortBy = "first_air_date.desc";
      }
      q.set("sort_by", sortBy);
      if (params.genreIds?.length)
        q.set("with_genres", params.genreIds.join(","));
      if (params.yearStart && params.yearEnd) {
        q.set("first_air_date.gte", `${params.yearStart}-01-01`);
        q.set("first_air_date.lte", `${params.yearEnd}-12-31`);
      } else if (sortBy === "first_air_date.desc") {
        q.set("first_air_date.lte", today);
        q.set("with_status", "0|3|4|5");
      }
      if (params.minRating !== undefined)
        q.set("vote_average.gte", String(params.minRating));
      if (params.maxRating !== undefined)
        q.set("vote_average.lte", String(params.maxRating));
      if (params.language) q.set("with_original_language", params.language);

      const res = await fetchTmdb(`/discover/tv?${q}`, signal);
      if (res && Array.isArray(res.results)) {
        return {
          ...res,
          results: filterReleasedTV(res.results, today),
        };
      }
      return res;
    },
  };
}

/** Re-export the image URL builder for convenience */
export { IMAGE_BASE_URL };
export { getImageUrl } from "../utils/image";
export { getTrailerKey } from "../utils/video";
