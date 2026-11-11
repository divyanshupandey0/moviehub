import { describe, it, expect } from "vitest";
import {
  getContentEligibility,
  isDatePassed,
  isEpisodeAired,
  formatReleaseDate,
} from "./releaseEligibility";

describe("releaseEligibility", () => {
  const referenceToday = "2026-11-07";

  it("identifies upcoming movies whose release date is in the future", () => {
    const res = getContentEligibility({
      mediaType: "movie",
      releaseDate: "2026-12-25",
      today: referenceToday,
    });
    expect(res.status).toBe("UPCOMING");
    expect(res.isPlayable).toBe(false);
    expect(res.isUpcoming).toBe(true);
    expect(res.isReleased).toBe(false);
    expect(res.badgeText).toContain("Dec 25, 2026");
  });

  it("identifies planned/in-production movies as UPCOMING", () => {
    const res = getContentEligibility({
      mediaType: "movie",
      releaseDate: null,
      status: "In Production",
      today: referenceToday,
    });
    expect(res.status).toBe("UPCOMING");
    expect(res.isPlayable).toBe(false);
  });

  it("identifies past release date without stream check as provisionally RELEASED", () => {
    const res = getContentEligibility({
      mediaType: "movie",
      releaseDate: "2026-05-15",
      today: referenceToday,
    });
    expect(res.status).toBe("RELEASED");
    expect(res.isPlayable).toBe(true);
    expect(res.isReleased).toBe(true);
    expect(res.isUpcoming).toBe(false);
  });

  it("identifies confirmed playable source as AVAILABLE_TO_WATCH", () => {
    const res = getContentEligibility({
      mediaType: "movie",
      releaseDate: "2024-07-12",
      hasConfirmedPlayableSource: true,
      today: referenceToday,
    });
    expect(res.status).toBe("AVAILABLE_TO_WATCH");
    expect(res.isPlayable).toBe(true);
  });

  it("identifies released movie with confirmed 0 sources as UNAVAILABLE", () => {
    const res = getContentEligibility({
      mediaType: "movie",
      releaseDate: "2024-07-12",
      hasConfirmedPlayableSource: false,
      today: referenceToday,
    });
    expect(res.status).toBe("UNAVAILABLE");
    expect(res.isPlayable).toBe(false);
    expect(res.badgeText).toBe("Unavailable");
  });

  it("correctly checks episode air date", () => {
    expect(isEpisodeAired("2026-10-01", referenceToday)).toBe(true);
    expect(isEpisodeAired("2026-11-07", referenceToday)).toBe(true);
    expect(isEpisodeAired("2026-11-20", referenceToday)).toBe(false);
    expect(isEpisodeAired(null, referenceToday)).toBe(false);
  });

  it("formats dates gracefully", () => {
    expect(formatReleaseDate("2026-11-07")).toBe("Nov 7, 2026");
  });
});
