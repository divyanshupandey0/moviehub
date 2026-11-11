/**
 * Content eligibility & release-date verification system.
 *
 * Distinguishes between:
 *  - UPCOMING: official release date is in the future, or status is unreleased.
 *  - RELEASED: official release date has passed, but provider availability is unconfirmed.
 *  - AVAILABLE_TO_WATCH: released and at least one valid, authorized playable source is confirmed.
 *  - UNAVAILABLE: released, but no playable source is currently available.
 */

export type ContentStatus =
  | "UPCOMING"
  | "RELEASED"
  | "AVAILABLE_TO_WATCH"
  | "UNAVAILABLE";

export interface ReleaseEligibilityResult {
  status: ContentStatus;
  statusLabel: string;
  badgeText: string;
  isPlayable: boolean;
  releaseDate?: string;
  formattedReleaseDate?: string;
  isUpcoming: boolean;
  isReleased: boolean;
  hasPlayableSource: boolean;
}

/** Get today's date in YYYY-MM-DD format (local/UTC max). */
export function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const localToday = `${year}-${month}-${day}`;
  const utcToday = now.toISOString().split("T")[0];
  return localToday > utcToday ? localToday : utcToday;
}

/** Check if an air_date or release_date string has passed today. */
export function isDatePassed(dateStr?: string | null, today: string = getTodayDateString()): boolean {
  if (!dateStr || typeof dateStr !== "string") return false;
  const clean = dateStr.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return false;
  return clean <= today;
}

/** Check if an episode is aired. */
export function isEpisodeAired(airDate?: string | null, today: string = getTodayDateString()): boolean {
  if (!airDate) return false;
  return isDatePassed(airDate, today);
}

/** Format YYYY-MM-DD into a human-readable date e.g. "Nov 20, 2026". */
export function formatReleaseDate(dateStr?: string | null): string {
  if (!dateStr || typeof dateStr !== "string") return "";
  const clean = dateStr.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return dateStr;
  const parts = clean.split("-").map(Number);
  if (parts.length < 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) return dateStr;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Check if a movie or TV show status represents an unreleased title.
 */
export function isUnreleasedStatus(status?: string | null): boolean {
  if (!status || typeof status !== "string") return false;
  const s = status.toLowerCase().trim();
  return (
    s === "planned" ||
    s === "in production" ||
    s === "post production" ||
    s === "upcoming" ||
    s === "unreleased" ||
    s === "rumored" ||
    s === "pilot"
  );
}

export type ContentEligibility = ReleaseEligibilityResult;

/**
 * Determine the content status and eligibility of a movie or TV show.
 */
export function getContentEligibility(params: {
  mediaType?: "movie" | "tv";
  releaseDate?: string | null;
  firstAirDate?: string | null;
  status?: string | null;
  hasConfirmedPlayableSource?: boolean;
  today?: string;
}): ReleaseEligibilityResult {
  const mediaType = params.mediaType ?? (params.firstAirDate ? "tv" : "movie");
  const today = params.today ?? getTodayDateString();
  const rawDate =
    mediaType === "tv"
      ? (params.firstAirDate ?? params.releaseDate)
      : (params.releaseDate ?? params.firstAirDate);
  const cleanDate = rawDate?.trim().slice(0, 10);
  const formatted = formatReleaseDate(cleanDate);

  const isStatusUpcoming = isUnreleasedStatus(params.status);
  const isDateFuture = !!cleanDate && cleanDate > today;
  const noValidDate = !cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate);

  // If date is in the future, or status explicitly says unreleased/planned
  if (isDateFuture || (isStatusUpcoming && (isDateFuture || noValidDate))) {
    return {
      status: "UPCOMING",
      statusLabel: formatted ? `Releases ${formatted}` : "Upcoming",
      badgeText: formatted ? `Releases ${formatted}` : "Upcoming",
      isPlayable: false,
      releaseDate: cleanDate,
      formattedReleaseDate: formatted,
      isUpcoming: true,
      isReleased: false,
      hasPlayableSource: false,
    };
  }

  // Official release date has passed
  const isReleased = isDatePassed(cleanDate, today);

  if (!isReleased && noValidDate) {
    return {
      status: "UPCOMING",
      statusLabel: "Release Date TBA",
      badgeText: "Release Date TBA",
      isPlayable: false,
      isUpcoming: true,
      isReleased: false,
      hasPlayableSource: false,
    };
  }

  // If verified playable source is confirmed
  if (params.hasConfirmedPlayableSource) {
    return {
      status: "AVAILABLE_TO_WATCH",
      statusLabel: "Available to Watch",
      badgeText: "Available",
      isPlayable: true,
      releaseDate: cleanDate,
      formattedReleaseDate: formatted,
      isUpcoming: false,
      isReleased: true,
      hasPlayableSource: true,
    };
  }

  // If explicitly confirmed that no playable source is available
  if (params.hasConfirmedPlayableSource === false) {
    return {
      status: "UNAVAILABLE",
      statusLabel: "Currently Unavailable",
      badgeText: "Unavailable",
      isPlayable: false,
      releaseDate: cleanDate,
      formattedReleaseDate: formatted,
      isUpcoming: false,
      isReleased: true,
      hasPlayableSource: false,
    };
  }

  // Default when released: show as released (waiting for stream check)
  return {
    status: "RELEASED",
    statusLabel: formatted ? `Released ${formatted}` : "Released",
    badgeText: "Watch Now",
    isPlayable: true, // provisionally playable pending provider check
    releaseDate: cleanDate,
    formattedReleaseDate: formatted,
    isUpcoming: false,
    isReleased: true,
    hasPlayableSource: false,
  };
}
