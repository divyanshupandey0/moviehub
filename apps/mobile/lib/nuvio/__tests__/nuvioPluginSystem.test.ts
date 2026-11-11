import { describe, it, expect, vi, beforeEach } from "vitest";

const memoryStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => memoryStore.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      memoryStore.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      memoryStore.delete(k);
    }),
  },
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: null,
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  makeDirectoryAsync: vi.fn(async () => {}),
  readAsStringAsync: vi.fn(async () => ""),
  writeAsStringAsync: vi.fn(async () => {}),
  deleteAsync: vi.fn(async () => {}),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

vi.mock("../../api", () => ({
  getApiBaseUrl: () => "",
  tmdbApi: {
    getExternalIds: vi.fn(async (id: string) => ({
      imdb_id: id === "27205" ? "tt1375666" : id === "1396" ? "tt0903747" : null,
    })),
    getMovieDetails: vi.fn(async (id: string) => ({
      imdb_id: id === "27205" ? "tt1375666" : null,
    })),
  },
}));

vi.mock("../../streamValidator", () => ({
  validateStreamUrl: vi.fn(async (url: string) => ({
    outcome: url.includes("dead.cdn") ? "dead" : "valid",
    valid: !url.includes("dead.cdn"),
    statusCode: url.includes("dead.cdn") ? 404 : 200,
    timestamp: Date.now(),
  })),
}));

vi.mock("../../streamSelector", () => ({
  rankStreams: vi.fn((links: any[]) => ({
    links,
    reason: "Best available quality",
  })),
}));

import {
  normalizeManifestUrl,
  validateManifestPayload,
  fetchAndValidateManifest,
  compareVersions,
  resolvePluginScriptUrl,
  ManifestValidationError,
} from "../manifestManager";
import { executeNuvioGetStreams, executeNuvioOnSettings } from "../pluginRuntime";
import {
  parseStremioManifest,
  parseStremioStreamResponse,
  buildStremioStreamUrl,
  executeStremioGetStreams,
} from "../stremioAdapter";
import { pluginManager } from "../pluginManager";
import { diagnosticsStore, redactSensitiveText } from "../diagnostics";
import { prefetchNuvioStreams, clearNuvioPrefetchCache } from "../sourceDiscovery";
import { isDirectDownloadableUrl, isPlayableHttpUrl } from "../urlUtils";

describe("Nuvio ManifestManager", () => {
  it("normalizes GitHub and repo base URLs into manifest.json", () => {
    expect(
      normalizeManifestUrl(
        "https://raw.githubusercontent.com/tapframe/nuvio-providers/refs/heads/main",
      ),
    ).toBe(
      "https://raw.githubusercontent.com/tapframe/nuvio-providers/refs/heads/main/manifest.json",
    );
    expect(normalizeManifestUrl("https://github.com/user/repo")).toBe(
      "https://raw.githubusercontent.com/user/repo/HEAD/manifest.json",
    );
    expect(
      normalizeManifestUrl("https://example.com/repo/manifest.json"),
    ).toBe("https://example.com/repo/manifest.json");
  });

  it("rejects unsafe or malformed manifest URLs", () => {
    expect(() => normalizeManifestUrl("")).toThrow(ManifestValidationError);
    expect(() => normalizeManifestUrl("file:///sdcard/manifest.json")).toThrow(
      ManifestValidationError,
    );
    expect(() => normalizeManifestUrl("http://insecure.example.com/manifest.json")).toThrow(
      ManifestValidationError,
    );
    expect(() => normalizeManifestUrl("javascript:alert(1)")).toThrow(
      ManifestValidationError,
    );
  });

  it("validates Nuvio manifest, deduplicates IDs, and skips Android-disabled entries", () => {
    const manifestUrl = "https://example.com/nuvio/manifest.json";
    const validated = validateManifestPayload(
      {
        name: "Test Repo",
        version: "1.2.0",
        scrapers: [
          {
            id: "alpha",
            name: "Alpha",
            version: "1.0.0",
            filename: "providers/alpha.js",
            supportedTypes: ["movie", "tv"],
          },
          {
            id: "alpha",
            name: "Alpha Duplicate",
            version: "2.0.0",
            filename: "providers/alpha2.js",
            supportedTypes: ["movie"],
          },
          {
            id: "ios-only",
            name: "AndroidDisabled",
            version: "1.0.0",
            filename: "providers/ios.js",
            disabledPlatforms: ["android"],
          },
        ],
      },
      manifestUrl,
    );

    expect(validated.entries).toHaveLength(1);
    expect(validated.entries[0].id).toBe("alpha");
    expect(
      resolvePluginScriptUrl(manifestUrl, validated.entries[0]),
    ).toBe("https://example.com/nuvio/providers/alpha.js");
  });

  it("compares semantic versions properly for updates", () => {
    expect(compareVersions("1.2.0", "1.0.9")).toBe(1);
    expect(compareVersions("1.0.2", "1.0.2")).toBe(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });
});

describe("Nuvio PluginRuntime Isolation & Compatibility", () => {
  it("executes getStreams for movie and TV episodes with cheerio, crypto-js, and SCRAPER_SETTINGS", async () => {
    const scriptCode = `
      var cheerio = require("cheerio-without-node-native");
      var CryptoJS = require("crypto-js");
      function getStreams(tmdbId, mediaType, season, episode) {
        var $ = cheerio.load('<div class="res" data-q="1080p">Stream Title</div>');
        var q = $(".res").attr("data-q");
        var hash = CryptoJS.MD5(tmdbId + ":" + mediaType).toString();
        var cfg = globalThis.SCRAPER_SETTINGS || {};
        return Promise.resolve([
          {
            name: "TestPlugin",
            title: $(".res").text() + " [" + hash.slice(0, 6) + "] " + (mediaType === "tv" ? "S" + season + "E" + episode : "Movie"),
            url: "https://cdn.example.com/video/" + tmdbId + ".mp4?key=" + (cfg.token || "default"),
            quality: q,
            size: "1.5 GB",
            subtitles: [{ url: "https://cdn.example.com/sub.vtt", language: "en", name: "English" }]
          }
        ]);
      }
      module.exports = {
        getStreams: getStreams,
        onSettings: function() {
          return [{ type: "text", key: "token", label: "Token" }];
        }
      };
    `;

    const movieRes = await executeNuvioGetStreams({
      pluginKey: "repo::test",
      pluginId: "test",
      pluginName: "TestPlugin",
      scriptCode,
      tmdbId: "872585",
      mediaType: "movie",
      season: null,
      episode: null,
      pluginSettings: { token: "abc" },
    });

    expect(movieRes.ok).toBe(true);
    expect(movieRes.streams).toHaveLength(1);
    expect(movieRes.streams[0].url).toBe(
      "https://cdn.example.com/video/872585.mp4?key=abc",
    );
    expect(movieRes.streams[0].quality).toBe("1080p");
    expect(movieRes.streams[0].subtitles?.[0].language).toBe("en");

    const tvRes = await executeNuvioGetStreams({
      pluginKey: "repo::test",
      pluginId: "test",
      pluginName: "TestPlugin",
      scriptCode,
      tmdbId: "1396",
      mediaType: "tv",
      season: 2,
      episode: 5,
    });
    expect(tvRes.ok).toBe(true);
    expect(tvRes.streams[0].title).toContain("S2E5");

    const schema = await executeNuvioOnSettings("test", scriptCode, {});
    expect(schema).toHaveLength(1);
    expect(schema[0].key).toBe("token");
  });

  it("blocks access to filesystem/restricted Node modules and catches plugin crashes", async () => {
    const evilScript = `
      var fs = require("fs");
      module.exports = { getStreams: function() { return []; } };
    `;
    const res = await executeNuvioGetStreams({
      pluginKey: "repo::evil",
      pluginId: "evil",
      pluginName: "Evil",
      scriptCode: evilScript,
      tmdbId: "100",
      mediaType: "movie",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not permitted on mobile");

    const crashScript = `
      module.exports = {
        getStreams: function() { throw new Error("boom in plugin"); }
      };
    `;
    const crashRes = await executeNuvioGetStreams({
      pluginKey: "repo::crash",
      pluginId: "crash",
      pluginName: "Crash",
      scriptCode: crashScript,
      tmdbId: "100",
      mediaType: "movie",
    });
    expect(crashRes.ok).toBe(false);
    expect(crashRes.error).toContain("boom in plugin");
  });

  it("enforces execution timeout cleanly", async () => {
    const slowScript = `
      module.exports = {
        getStreams: function() {
          return new Promise(function() { /* never resolves */ });
        }
      };
    `;
    const res = await executeNuvioGetStreams({
      pluginKey: "repo::slow",
      pluginId: "slow",
      pluginName: "Slow",
      scriptCode: slowScript,
      tmdbId: "100",
      mediaType: "movie",
      timeoutMs: 120,
    });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  it("handles Function('return this')(), process.env, axios.interceptors, XHR, and callback plugins without undefined function errors", async () => {
    const compatScript = `
      var axios = require("axios");
      axios.interceptors.request.use(function(cfg) { return cfg; });
      axios.interceptors.response.use(function(res) { return res; });
      var g = Function("return this")();
      var decryptUrl = process.env.DECRYPT_SERVER_URL || "https://example.com";
      function getStreams(tmdbId, mediaType, season, episode, cb) {
        if (!g || typeof g.fetch !== "function" || typeof new XMLHttpRequest().open !== "function") {
          return cb(new Error("Missing sandbox globals"));
        }
        cb(null, {
          streams: [
            {
              name: "CompatPlugin",
              quality: 1080,
              url: decryptUrl + "/stream/" + tmdbId + ".m3u8"
            }
          ]
        });
      }
      module.exports = { getStreams: getStreams };
    `;

    const res = await executeNuvioGetStreams({
      pluginKey: "repo::compat",
      pluginId: "compat",
      pluginName: "CompatPlugin",
      scriptCode: compatScript,
      tmdbId: "27205",
      mediaType: "movie",
    });

    expect(res.ok).toBe(true);
    expect(res.streams).toHaveLength(1);
    expect(res.streams[0].url).toBe("https://example.com/stream/27205.m3u8");
    const settings = await executeNuvioOnSettings("compat", compatScript, {});
    expect(settings).toEqual([]);
  });

  it("classifies unsupported formats and initialization failures cleanly", async () => {
    const badInit = `var x = (;`;
    const initRes = await executeNuvioGetStreams({
      pluginKey: "repo::badinit",
      pluginId: "badinit",
      pluginName: "BadInit",
      scriptCode: badInit,
      tmdbId: "100",
      mediaType: "movie",
    });
    expect(initRes.ok).toBe(false);
    expect(initRes.errorCategory).toBe("init_failed");
    expect(initRes.error).toContain("Provider initialization failed");

    const missingFn = `module.exports = { foo: 123 };`;
    const fmtRes = await executeNuvioGetStreams({
      pluginKey: "repo::nofn",
      pluginId: "nofn",
      pluginName: "NoFn",
      scriptCode: missingFn,
      tmdbId: "100",
      mediaType: "movie",
    });
    expect(fmtRes.ok).toBe(false);
    expect(fmtRes.errorCategory).toBe("unsupported_format");
    expect(fmtRes.error).toContain("Unsupported plugin format");
  });
});

describe("Stremio Add-on Protocol Compatibility", () => {
  it("validates Stremio stream manifests and rejects resource-less manifests", () => {
    const validStremio = validateManifestPayload(
      {
        id: "org.community.httpstreams",
        name: "Community HTTP Streams",
        version: "1.4.0",
        resources: [
          {
            name: "stream",
            types: ["movie", "series"],
            idPrefixes: ["tt", "tmdb"],
          },
        ],
        types: ["movie", "series"],
      },
      "https://addon.example.com/cfg=1/manifest.json",
    );

    expect(validStremio.kind).toBe("stremio");
    expect(validStremio.entries).toHaveLength(1);
    expect(validStremio.entries[0].stremioConfig?.addonBaseUrl).toBe(
      "https://addon.example.com/cfg=1",
    );
    expect(
      buildStremioStreamUrl(
        validStremio.entries[0].stremioConfig!.addonBaseUrl,
        "series",
        "tt0903747:2:5",
      ),
    ).toBe("https://addon.example.com/cfg=1/stream/series/tt0903747%3A2%3A5.json");

    expect(() =>
      parseStremioManifest(
        {
          id: "org.catalog.only",
          name: "Catalog Only",
          version: "1.0.0",
          resources: ["catalog", "meta"],
          types: ["movie"],
        },
        "https://catalog.example.com/manifest.json",
      ),
    ).toThrow(/stream/i);
  });

  it("parses Stremio stream responses safely with optional fields and headers", () => {
    const parsed = parseStremioStreamResponse(
      {
        streams: [
          null,
          { infoHash: "abc123", fileIdx: 0 },
          { ytId: "dQw4w9WgXcQ" },
          {
            name: "WebStreamr",
            description: "1080p Dual Audio\n1.9 GB",
            url: "https://media.example.com/movie.mkv",
            behaviorHints: {
              videoSize: 2040109465,
              proxyHeaders: {
                request: { Referer: "https://media.example.com/" },
              },
            },
            subtitles: [{ url: "https://subs.example.com/en.vtt", lang: "eng" }],
          },
        ],
      },
      "WebStreamr",
    );

    expect(parsed.streams).toHaveLength(1);
    expect(parsed.skippedTorrentCount).toBe(1);
    expect(parsed.skippedYoutubeCount).toBe(1);
    expect(parsed.streams[0].url).toBe("https://media.example.com/movie.mkv");
    expect(parsed.streams[0].headers?.Referer).toBe("https://media.example.com/");
    expect(parsed.streams[0].subtitles?.[0].url).toBe("https://subs.example.com/en.vtt");
  });

  it("handles empty responses, malformed JSON, and timeouts on Stremio stream requests", async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ streams: [] }), { status: 200 })) as any;
      const emptyRes = await executeStremioGetStreams({
        pluginKey: "s::empty",
        pluginId: "empty",
        pluginName: "EmptyAddon",
        stremioConfig: {
          addonBaseUrl: "https://addon.example.com",
          streamTypes: ["movie"],
          idPrefixes: ["tt"],
        },
        tmdbId: "27205",
        imdbId: "tt1375666",
        mediaType: "movie",
      });
      expect(emptyRes.streams).toHaveLength(0);

      globalThis.fetch = vi.fn(async () => new Response("{not json", { status: 200 })) as any;
      const badJson = await executeStremioGetStreams({
        pluginKey: "s::1",
        pluginId: "s1",
        pluginName: "BrokenJsonAddon",
        stremioConfig: {
          addonBaseUrl: "https://addon.example.com",
          streamTypes: ["movie"],
          idPrefixes: ["tt"],
        },
        tmdbId: "27205",
        imdbId: "tt1375666",
        mediaType: "movie",
      });
      expect(badJson.ok).toBe(false);
      expect(badJson.error).toContain("Malformed JSON");

      globalThis.fetch = vi.fn(
        (_u: any, init: any) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
          }),
      ) as any;

      const timeoutRes = await executeStremioGetStreams({
        pluginKey: "s::1",
        pluginId: "s1",
        pluginName: "SlowAddon",
        stremioConfig: {
          addonBaseUrl: "https://addon.example.com",
          streamTypes: ["movie"],
          idPrefixes: ["tt"],
        },
        tmdbId: "27205",
        imdbId: "tt1375666",
        mediaType: "movie",
        timeoutMs: 40,
      });
      expect(timeoutRes.ok).toBe(false);
      expect(timeoutRes.timedOut).toBe(true);
      expect(timeoutRes.error).toContain("timeout");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("End-to-End Multi-Provider Fallback, Deduplication & Switching", () => {
  beforeEach(async () => {
    memoryStore.clear();
    clearNuvioPrefetchCache();
    for (const r of [...pluginManager.getSnapshot().repos]) {
      await pluginManager.removeRepository(r.id);
    }
  });

  it("installs Nuvio + Stremio repos, isolates broken providers, deduplicates streams, and switches providers", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://nuvio.example.com/manifest.json") {
        return new Response(
          JSON.stringify({
            name: "Mock Nuvio Repo",
            version: "1.0.0",
            scrapers: [
              {
                id: "broken-p",
                name: "BrokenPlugin",
                version: "1.0.0",
                filename: "broken.js",
                supportedTypes: ["movie", "tv"],
              },
              {
                id: "good-p",
                name: "GoodPlugin",
                version: "1.0.0",
                filename: "good.js",
                supportedTypes: ["movie", "tv"],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://nuvio.example.com/broken.js") {
        return new Response(
          `module.exports = { getStreams: function() { throw new Error("provider 503"); } };`,
          { status: 200 },
        );
      }
      if (url === "https://nuvio.example.com/good.js") {
        return new Response(
          `module.exports = {
            getStreams: async function(id, type, s, e) {
              return [
                { name: "Good", title: "1080p Hindi", url: "https://cdn.good.example/shared.mp4", quality: "1080p" },
                { name: "Good", title: "Invalid", url: "magnet:?xt=urn:btih:000" }
              ];
            }
          };`,
          { status: 200 },
        );
      }
      if (url === "https://stremio.example.com/manifest.json") {
        return new Response(
          JSON.stringify({
            id: "stremio.good",
            name: "StremioGood",
            version: "1.0.0",
            resources: ["stream"],
            types: ["movie", "series"],
          }),
          { status: 200 },
        );
      }
      if (url === "https://stremio.example.com/stream/movie/tt1375666.json") {
        return new Response(
          JSON.stringify({
            streams: [
              { name: "StremioDup", url: "https://cdn.good.example/shared.mp4" },
              {
                name: "Stremio4K",
                title: "4K English",
                url: "https://cdn.stremio.example/movie.m3u8",
                behaviorHints: {
                  proxyHeaders: { request: { Authorization: "Bearer tok" } },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://stremio.example.com/stream/series/tt0903747%3A2%3A5.json") {
        return new Response(
          JSON.stringify({
            streams: [
              { name: "StremioTV", title: "720p S02E05", url: "https://cdn.stremio.example/s2e5.mp4" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as any;

    try {
      await pluginManager.addRepository("https://nuvio.example.com/manifest.json");
      await pluginManager.addRepository("https://stremio.example.com/manifest.json");

      const movieAll = await prefetchNuvioStreams(27205, "movie", undefined, undefined, {
        force: true,
      });
      expect(movieAll.links).toHaveLength(2);
      expect(movieAll.pluginErrors).toHaveLength(1);
      expect(movieAll.links.map((l) => l.url)).toEqual([
        "https://cdn.good.example/shared.mp4",
        "https://cdn.stremio.example/movie.m3u8",
      ]);
      expect(movieAll.links[1].headers?.Authorization).toBe("Bearer tok");

      const stremioPlugin = pluginManager
        .getEnabledPlugins("tv")
        .find((p) => p.kind === "stremio")!;
      const tvSwitch = await prefetchNuvioStreams(1396, "tv", 2, 5, {
        pluginKeyOrId: stremioPlugin.pluginKey,
        force: true,
      });
      expect(tvSwitch.links).toHaveLength(1);
      expect(tvSwitch.links[0].url).toBe("https://cdn.stremio.example/s2e5.mp4");

      globalThis.fetch = vi.fn(
        (_u: any, init: any) =>
          new Promise((_, rej) => {
            init?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              rej(e);
            });
          }),
      ) as any;
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 20);
      await expect(
        fetchAndValidateManifest("https://slow-repo.example.com/manifest.json", ctrl.signal),
      ).rejects.toThrow(ManifestValidationError);

      // Duplicate repository rejection
      await expect(
        pluginManager.addRepository("https://nuvio.example.com/manifest.json"),
      ).rejects.toThrow(/already installed/i);

      // Persistence check in AsyncStorage mock
      const savedReposRaw = memoryStore.get("@moviehub/nuvio/repos/v1");
      expect(savedReposRaw).toBeTruthy();
      expect(JSON.parse(savedReposRaw!).length).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("auto-disables Node-only incompatible scripts (e.g. net/tls/http2), rejects all-incompatible repos, and redacts sensitive secrets in diagnostics", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://mixed.example.com/manifest.json") {
        return new Response(
          JSON.stringify({
            name: "Mixed Compat Repo",
            version: "1.0.0",
            scrapers: [
              { id: "node-only", name: "NodeOnlyVix", version: "1.0.0", filename: "nodeonly.js", supportedTypes: ["movie"] },
              { id: "mobile-ok", name: "MobileOK", version: "1.0.0", filename: "ok.js", supportedTypes: ["movie"] },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://mixed.example.com/nodeonly.js") {
        return new Response(
          `var net = require("net"); var tls = require("tls"); module.exports = { getStreams: function() { return []; } };`,
          { status: 200 },
        );
      }
      if (url === "https://mixed.example.com/ok.js") {
        return new Response(
          `module.exports = { getStreams: async function() { return [{ url: "https://cdn.example.com/hls/master.m3u8" }]; } };`,
          { status: 200 },
        );
      }
      if (url === "https://allbad.example.com/manifest.json") {
        return new Response(
          JSON.stringify({
            name: "Incompatible Repo",
            version: "1.0.0",
            scrapers: [
              { id: "bad", name: "OnlyNode", version: "1.0.0", filename: "nodeonly.js", supportedTypes: ["movie"] },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://allbad.example.com/nodeonly.js") {
        return new Response(`var fs = require("fs");`, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as any;

    try {
      const res = await pluginManager.addRepository("https://mixed.example.com/manifest.json");
      expect(res.compatibleCount).toBe(1);
      expect(res.incompatibleCount).toBe(1);
      expect(res.incompatibleNames).toEqual(["NodeOnlyVix"]);

      const nodePlugin = pluginManager.getPluginByKeyOrId("node-only")!;
      expect(nodePlugin.compatible).toBe(false);
      expect(nodePlugin.enabled).toBe(false);
      await expect(pluginManager.setPluginEnabled(nodePlugin.pluginKey, true)).rejects.toThrow(
        /incompatible|Node-only/i,
      );

      await expect(
        pluginManager.addRepository("https://allbad.example.com/manifest.json"),
      ).rejects.toThrow(/Repository incompatible/i);

      // Credential redaction check in diagnostics
      diagnosticsStore.upsert("sec::1", {
        repositoryName: "TestRepo",
        providerName: "TestProv",
        parsingError: "Failed GET https://api.example.com/v1?api_key=SECRET123&token=XYZ Authorization: Bearer abc.def",
      });
      const rec = diagnosticsStore.list().find((d) => d.pluginKey === "sec::1")!;
      expect(rec.parsingError).not.toContain("SECRET123");
      expect(rec.parsingError).not.toContain("XYZ");
      expect(rec.parsingError).not.toContain("abc.def");
      expect(redactSensitiveText("cookie=mysecret")).toContain("[REDACTED]");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("URL & Download Eligibility", () => {
  it("distinguishes downloadable direct files from stream-only manifests", () => {
    expect(isPlayableHttpUrl("https://cdn.example.com/movie.mp4")).toBe(true);
    expect(isPlayableHttpUrl("magnet:?xt=urn:btih:123")).toBe(false);
    expect(isDirectDownloadableUrl("https://cdn.example.com/movie.mkv", "mkv", true)).toBe(true);
    expect(isDirectDownloadableUrl("https://cdn.example.com/master.m3u8", "m3u8", true)).toBe(false);
    expect(isDirectDownloadableUrl("https://cdn.example.com/movie.mp4", "mp4", false)).toBe(false);
  });
});
