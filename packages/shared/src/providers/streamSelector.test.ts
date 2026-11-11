import { describe, it, expect } from "vitest";
import { parseLinkLanguages, rankStreams } from "./streamSelector";
import type { StreamLink } from "./sources/types";

describe("streamSelector language detection & ranking", () => {
  it("does not falsely identify hardcoded subtitles (.HC.) as Hindi", () => {
    const filename = "Deadpool.and.Wolverine.2024.1080p.HC.HDRip.x264-Scene";
    const langs = parseLinkLanguages(filename);
    expect(langs).not.toContain("hindi");
  });

  it("correctly identifies true Hindi releases", () => {
    const filenames = [
      "Inception.2010.1080p.Hindi.English.Dual.Audio.mkv",
      "Stree.2.2024.1080p.Hin.AAC-Hub",
      "Jawan.2023.Hindi-Cleaned.1080p.mkv",
    ];
    for (const fn of filenames) {
      const langs = parseLinkLanguages(fn);
      expect(langs.includes("hindi") || langs.includes("multi")).toBe(true);
    }
  });

  it("identifies regional languages (Tamil, Telugu, Malayalam, Kannada)", () => {
    expect(parseLinkLanguages("Leo.2023.1080p.Tamil.AAC.mkv")).toContain("tamil");
    expect(parseLinkLanguages("RRR.2022.1080p.Telugu.mkv")).toContain("telugu");
    expect(parseLinkLanguages("Manjummel.Boys.2024.1080p.Malayalam.mkv")).toContain("malayalam");
    expect(parseLinkLanguages("KGF.2.2022.1080p.Kannada.mkv")).toContain("kannada");
  });

  it("extracts language from link metadata (e.g. MovieBox spoken audio)", () => {
    const linkMeta: StreamLink["_meta"] = {
      providerId: "moviebox",
      audioLanguage: "Hindi",
    };
    const langs = parseLinkLanguages("Stream #4", linkMeta);
    expect(langs).toContain("hindi");
  });

  it("prioritizes user preferred language in rankStreams", () => {
    const links: StreamLink[] = [
      {
        id: "1",
        name: "Movie.2024.1080p.English.AAC.mp4",
        quality: "1080p",
        url: "https://example.com/eng.mp4",
        type: "mp4",
      },
      {
        id: "2",
        name: "Movie.2024.1080p.Hindi.Dubbed.AAC.mp4",
        quality: "1080p",
        url: "https://example.com/hin.mp4",
        type: "mp4",
      },
    ];

    const result = rankStreams(links, { preferredLanguage: "hindi" });
    expect(result.bestLink?.id).toBe("2");
    expect(result.sortedLinks[0].id).toBe("2");
  });

  it("falls back gracefully when preferred language is unavailable", () => {
    const links: StreamLink[] = [
      {
        id: "1",
        name: "Movie.2024.1080p.English.AAC.mp4",
        quality: "1080p",
        url: "https://example.com/eng.mp4",
        type: "mp4",
      },
    ];

    const result = rankStreams(links, { preferredLanguage: "tamil" });
    expect(result.bestLink?.id).toBe("1");
    expect(result.sortedLinks[0].id).toBe("1");
  });
});
