/**
 * Stremio Add-on Protocol Adapter
 *
 * Implements the official Stremio Add-on SDK protocol
 * (https://stremio.github.io/stremio-addon-sdk/protocol.html):
 * - Manifest detection & validation (`resources`, `types`, `idPrefixes`)
 * - Stream URL construction: `{addonBaseUrl}/stream/{type}/{id}.json`
 * - Automatic TMDB -> IMDb (`tt...`) & `tmdb:{id}` ID mapping for movies & series episodes
 * - Safe parsing of optional fields (`url`, `externalUrl`, `infoHash`, `ytId`,
 *   `name`, `title`, `description`, `subtitles`, `behaviorHints`) without crashing
 */

import { tmdbApi } from "../api";
import type {
  NuvioMediaType,
  NuvioScraperEntry,
  NuvioStream,
  NuvioSubtitle,
  PluginExecutionResult,
  StremioAddonConfig,
  StremioManifest,
  StremioResourceObject,
  StremioStreamObject,
} from "./types";
import { isPlayableHttpUrl } from "./urlUtils";

const STREMIO_STREAM_TIMEOUT_MS = 14_000;
const IMDB_CACHE = new Map<string, string | null>();

function asSafeString(val: unknown): string {
  return typeof val === "string" ? val.trim() : "";
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

/**
 * Derive the Stremio add-on base URL by stripping trailing `/manifest.json`
 * while preserving path-based add-on configuration segments (e.g. Torrentio/MediaFusion configs).
 */
export function deriveStremioBaseUrl(manifestUrl: string): string {
  const parsed = new URL(manifestUrl);
  const cleanedPath = parsed.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
  parsed.pathname = cleanedPath;
  // Query strings on manifest URLs are typically ignored or preserved before /stream,
  // but standard Stremio protocol puts user config in the path.
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Determine whether a parsed JSON payload is a Stremio Add-on manifest
 * (as opposed to a Nuvio script repository manifest containing `scrapers`/`providers`).
 */
export function isStremioManifestPayload(raw: unknown): raw is StremioManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.scrapers) || Array.isArray(obj.providers)) {
    return false;
  }
  return (
    typeof obj.id === "string" &&
    obj.id.trim().length > 0 &&
    typeof obj.name === "string" &&
    obj.name.trim().length > 0 &&
    Array.isArray(obj.resources) &&
    Array.isArray(obj.types)
  );
}

function mapStremioTypeToMediaType(rawType: string): NuvioMediaType | null {
  const t = rawType.toLowerCase().trim();
  if (t === "movie") return "movie";
  if (t === "series" || t === "tv" || t === "anime") return "tv";
  return null;
}

export interface ParsedStremioManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  logo?: string;
  entry: NuvioScraperEntry;
  config: StremioAddonConfig;
}

/**
 * Validate and convert a Stremio manifest into an installable Movie Hub plugin entry.
 * Throws a descriptive Error if the add-on does not expose a playable `stream` resource.
 */
export function parseStremioManifest(
  raw: StremioManifest,
  manifestUrl: string,
): ParsedStremioManifest {
  const addonId = asSafeString(raw.id);
  const addonName = asSafeString(raw.name) || addonId;
  const addonVersion = asSafeString(raw.version) || "1.0.0";
  const description = asSafeString(raw.description);
  const logo = asSafeString(raw.logo) || undefined;

  if (!addonId) {
    throw new Error("Unsupported plugin format: Stremio manifest missing id.");
  }

  let hasStreamResource = false;
  let resourceTypes: string[] = [];
  let resourceIdPrefixes: string[] = [];

  for (const resItem of raw.resources) {
    if (typeof resItem === "string") {
      if (resItem.toLowerCase().trim() === "stream") {
        hasStreamResource = true;
      }
    } else if (resItem && typeof resItem === "object") {
      const obj = resItem as StremioResourceObject;
      if (asSafeString(obj.name).toLowerCase() === "stream") {
        hasStreamResource = true;
        resourceTypes = asStringArray(obj.types);
        resourceIdPrefixes = asStringArray(obj.idPrefixes);
      }
    }
  }

  if (!hasStreamResource) {
    throw new Error(
      `Unsupported plugin format: "${addonName}" does not provide a Stremio "stream" resource.`,
    );
  }

  const manifestTypes = asStringArray(raw.types);
  const rawStreamTypes =
    resourceTypes.length > 0 ? resourceTypes : manifestTypes;

  const supportedHubTypes = new Set<NuvioMediaType>();
  const streamTypes: string[] = [];
  for (const st of rawStreamTypes) {
    const mapped = mapStremioTypeToMediaType(st);
    if (mapped) {
      supportedHubTypes.add(mapped);
      if (!streamTypes.includes(st.toLowerCase())) {
        streamTypes.push(st.toLowerCase());
      }
    }
  }

  if (supportedHubTypes.size === 0 || streamTypes.length === 0) {
    throw new Error(
      `Unsupported plugin format: "${addonName}" supports neither movies nor series streams.`,
    );
  }

  const topPrefixes = asStringArray(raw.idPrefixes);
  const idPrefixes =
    resourceIdPrefixes.length > 0
      ? resourceIdPrefixes
      : topPrefixes.length > 0
        ? topPrefixes
        : ["tt"];

  const addonBaseUrl = deriveStremioBaseUrl(manifestUrl);
  const stremioConfig: StremioAddonConfig = {
    addonBaseUrl,
    streamTypes,
    idPrefixes,
    configurable: raw.behaviorHints?.configurable === true,
    configurationRequired: raw.behaviorHints?.configurationRequired === true,
  };

  const entry: NuvioScraperEntry = {
    id: addonId,
    name: addonName,
    description:
      description ||
      `Stremio add-on (${streamTypes.join(", ")})`,
    version: addonVersion,
    author: "Stremio Add-on",
    supportedTypes: Array.from(supportedHubTypes),
    url: manifestUrl,
    enabled: true,
    logo,
    contentLanguage: ["en"],
    formats: ["http", "hls", "mp4", "mkv"],
    supportsExternalPlayer: true,
    hasSettings: false,
    kind: "stremio",
    stremioConfig,
  };

  return {
    id: addonId,
    name: addonName,
    version: addonVersion,
    description: entry.description ?? "",
    logo,
    entry,
    config: stremioConfig,
  };
}

/**
 * Resolve IMDb ID (`tt...`) from a TMDB ID using Movie Hub's configured TMDB proxy,
 * caching lookups cleanly so Stremio IMDb-prefixed add-ons work seamlessly for both
 * movies and TV series.
 */
export async function resolveExternalImdbId(
  tmdbId: string,
  mediaType: NuvioMediaType,
  signal?: AbortSignal,
): Promise<string | null> {
  const cleanId = asSafeString(tmdbId);
  if (!cleanId) return null;
  if (/^tt\d+/i.test(cleanId)) return cleanId;

  const cacheKey = `${mediaType}:${cleanId}`;
  if (IMDB_CACHE.has(cacheKey)) {
    return IMDB_CACHE.get(cacheKey) ?? null;
  }

  try {
    const ext = await tmdbApi.getExternalIds(cleanId, mediaType, signal);
    const imdbFromExt = asSafeString(ext?.imdb_id);
    if (imdbFromExt) {
      IMDB_CACHE.set(cacheKey, imdbFromExt);
      return imdbFromExt;
    }
  } catch {
    // Fall back to details endpoint for movies
  }

  if (mediaType === "movie") {
    try {
      const details = await tmdbApi.getMovieDetails(cleanId, signal);
      const imdbFromDetails = asSafeString(details?.imdb_id);
      if (imdbFromDetails) {
        IMDB_CACHE.set(cacheKey, imdbFromDetails);
        return imdbFromDetails;
      }
    } catch {
      // Ignore network/proxy failures
    }
  }

  IMDB_CACHE.set(cacheKey, null);
  return null;
}

export function buildStremioStreamUrl(
  addonBaseUrl: string,
  stremioType: string,
  contentId: string,
): string {
  const base = addonBaseUrl.replace(/\/+$/, "");
  return `${base}/stream/${encodeURIComponent(stremioType)}/${encodeURIComponent(contentId)}.json`;
}

const DIRECT_VIDEO_OR_MANIFEST_RE = /\.(mp4|mkv|webm|mov|m4v|m3u8|mpd)(\?|$|#)/i;

function normalizeStremioSubtitles(rawSubs: unknown): NuvioSubtitle[] | undefined {
  if (!Array.isArray(rawSubs)) return undefined;
  const out: NuvioSubtitle[] = [];
  for (const item of rawSubs) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const url = asSafeString(rec.url);
    if (!isPlayableHttpUrl(url)) continue;
    const lang = asSafeString(rec.lang) || asSafeString(rec.language) || "en";
    out.push({
      url,
      lang,
      language: lang,
    });
  }
  return out.length > 0 ? out : undefined;
}

export interface StremioParseSummary {
  streams: NuvioStream[];
  skippedTorrentCount: number;
  skippedYoutubeCount: number;
  skippedExternalPageCount: number;
}

/**
 * Safely parse any Stremio `/stream/{type}/{id}.json` payload into normalized `NuvioStream`s.
 */
export function parseStremioStreamResponse(
  payload: unknown,
  addonName: string,
): StremioParseSummary {
  const streamsOut: NuvioStream[] = [];
  let skippedTorrentCount = 0;
  let skippedYoutubeCount = 0;
  let skippedExternalPageCount = 0;

  let rawStreams: unknown[] | null = null;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.streams)) {
      rawStreams = obj.streams;
    } else if (Array.isArray(obj.result)) {
      rawStreams = obj.result;
    }
  } else if (Array.isArray(payload)) {
    rawStreams = payload;
  }

  if (!rawStreams) {
    return {
      streams: [],
      skippedTorrentCount: 0,
      skippedYoutubeCount: 0,
      skippedExternalPageCount: 0,
    };
  }

  for (const item of rawStreams) {
    if (!item || typeof item !== "object") continue;
    const s = item as StremioStreamObject;

    const directUrl = asSafeString(s.url);
    const externalUrl = asSafeString(s.externalUrl);
    const ytId = asSafeString(s.ytId);
    const infoHash = asSafeString(s.infoHash);

    let resolvedUrl = "";
    if (isPlayableHttpUrl(directUrl)) {
      resolvedUrl = directUrl;
    } else if (
      isPlayableHttpUrl(externalUrl) &&
      DIRECT_VIDEO_OR_MANIFEST_RE.test(externalUrl)
    ) {
      resolvedUrl = externalUrl;
    } else {
      if (infoHash || /^magnet:/i.test(directUrl)) skippedTorrentCount++;
      else if (ytId) skippedYoutubeCount++;
      else if (externalUrl) skippedExternalPageCount++;
      continue;
    }

    const name = asSafeString(s.name) || addonName;
    const title = asSafeString(s.title) || asSafeString(s.description) || undefined;
    const filename = asSafeString(s.behaviorHints?.filename);
    const videoSize =
      typeof s.behaviorHints?.videoSize === "number" &&
      Number.isFinite(s.behaviorHints.videoSize) &&
      s.behaviorHints.videoSize > 0
        ? s.behaviorHints.videoSize
        : undefined;

    const reqHeadersRaw = s.behaviorHints?.proxyHeaders?.request;
    const proxyRequestHeaders: Record<string, string> = {};
    if (reqHeadersRaw && typeof reqHeadersRaw === "object") {
      for (const [k, v] of Object.entries(reqHeadersRaw)) {
        if (typeof v === "string" && v.trim()) {
          proxyRequestHeaders[k] = v;
        }
      }
    }

    const subtitles = normalizeStremioSubtitles(s.subtitles);

    streamsOut.push({
      name,
      ...(title ? { title } : filename ? { title: filename } : {}),
      url: resolvedUrl,
      ...(videoSize ? { size: videoSize } : {}),
      ...(Object.keys(proxyRequestHeaders).length > 0
        ? { headers: proxyRequestHeaders }
        : {}),
      ...(subtitles ? { subtitles } : {}),
      ...(s.behaviorHints
        ? {
            behaviorHints: {
              bingeGroup: asSafeString(s.behaviorHints.bingeGroup) || undefined,
              notWebReady: s.behaviorHints.notWebReady === true,
              filename: filename || undefined,
              videoSize,
              ...(Object.keys(proxyRequestHeaders).length > 0
                ? { proxyHeaders: { request: proxyRequestHeaders } }
                : {}),
            },
          }
        : {}),
    });
  }

  return {
    streams: streamsOut,
    skippedTorrentCount,
    skippedYoutubeCount,
    skippedExternalPageCount,
  };
}

/**
 * Determine candidate Stremio request targets for `(tmdbId, imdbId, mediaType, season, episode)`
 * based on the add-on's supported types and `idPrefixes`.
 */
export function buildStremioCandidateRequests(params: {
  stremioConfig: StremioAddonConfig;
  tmdbId: string;
  imdbId: string | null;
  mediaType: NuvioMediaType;
  season?: number | null;
  episode?: number | null;
}): Array<{ stremioType: string; contentId: string; url: string }> {
  const { stremioConfig, tmdbId, imdbId, mediaType } = params;
  const sNum = params.season ?? 1;
  const eNum = params.episode ?? 1;

  const targetStremioTypes = stremioConfig.streamTypes.filter(
    (st) => mapStremioTypeToMediaType(st) === mediaType,
  );
  if (targetStremioTypes.length === 0) return [];

  const prefixes = stremioConfig.idPrefixes.map((p) => p.toLowerCase());
  const allowsImdb = prefixes.length === 0 || prefixes.some((p) => p === "tt");
  const allowsTmdb = prefixes.some((p) => p === "tmdb" || p === "tmdb:");

  const candidateIds: string[] = [];
  if (allowsImdb && imdbId) {
    candidateIds.push(
      mediaType === "tv" ? `${imdbId}:${sNum}:${eNum}` : imdbId,
    );
  }
  if (allowsTmdb && tmdbId) {
    const cleanTmdb = tmdbId.replace(/^tmdb:/i, "");
    candidateIds.push(
      mediaType === "tv"
        ? `tmdb:${cleanTmdb}:${sNum}:${eNum}`
        : `tmdb:${cleanTmdb}`,
    );
  }
  // If addon declared neither tt nor tmdb explicitly, try raw tmdbId / imdbId fallback
  if (!allowsImdb && !allowsTmdb) {
    if (imdbId) {
      candidateIds.push(
        mediaType === "tv" ? `${imdbId}:${sNum}:${eNum}` : imdbId,
      );
    }
    if (tmdbId) {
      candidateIds.push(
        mediaType === "tv" ? `${tmdbId}:${sNum}:${eNum}` : tmdbId,
      );
    }
  }

  const reqs: Array<{ stremioType: string; contentId: string; url: string }> = [];
  for (const stType of targetStremioTypes) {
    for (const contentId of candidateIds) {
      reqs.push({
        stremioType: stType,
        contentId,
        url: buildStremioStreamUrl(stremioConfig.addonBaseUrl, stType, contentId),
      });
    }
  }
  return reqs;
}

export async function executeStremioGetStreams(params: {
  pluginKey: string;
  pluginId: string;
  pluginName: string;
  stremioConfig?: StremioAddonConfig;
  tmdbId: string;
  imdbId: string | null;
  mediaType: NuvioMediaType;
  season?: number | null;
  episode?: number | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<PluginExecutionResult> {
  const startedAt = Date.now();
  const cfg = params.stremioConfig;

  if (!cfg || !cfg.addonBaseUrl) {
    return {
      pluginKey: params.pluginKey,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      ok: false,
      streams: [],
      durationMs: Date.now() - startedAt,
      errorCategory: "init_failed",
      error: "Provider initialization failed: invalid Stremio add-on configuration.",
    };
  }

  if (cfg.configurationRequired) {
    return {
      pluginKey: params.pluginKey,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      ok: false,
      streams: [],
      durationMs: Date.now() - startedAt,
      errorCategory: "init_failed",
      error: `Add-on "${params.pluginName}" requires configuration before returning streams.`,
    };
  }

  const candidates = buildStremioCandidateRequests({
    stremioConfig: cfg,
    tmdbId: params.tmdbId,
    imdbId: params.imdbId,
    mediaType: params.mediaType,
    season: params.season,
    episode: params.episode,
  });

  if (candidates.length === 0) {
    return {
      pluginKey: params.pluginKey,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      ok: false,
      streams: [],
      durationMs: Date.now() - startedAt,
      errorCategory: "no_streams",
      error: !params.imdbId
        ? "Could not resolve IMDb ID required by this Stremio add-on."
        : `Add-on does not support ${params.mediaType} streams.`,
    };
  }

  const timeoutMs = params.timeoutMs ?? STREMIO_STREAM_TIMEOUT_MS;
  let lastError: string | undefined;
  let lastCategory: PluginExecutionResult["errorCategory"];
  let totalSkippedTorrent = 0;

  for (const req of candidates) {
    if (params.signal?.aborted) {
      return {
        pluginKey: params.pluginKey,
        pluginId: params.pluginId,
        pluginName: params.pluginName,
        ok: false,
        streams: [],
        durationMs: Date.now() - startedAt,
        errorCategory: "timeout",
        error: "Cancelled",
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    params.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const res = await fetch(req.url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        lastCategory = "repo_unavailable";
        lastError = `Repository unavailable (HTTP ${res.status})`;
        continue;
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        lastCategory = "unsupported_format";
        lastError = "Malformed JSON response from Stremio add-on.";
        continue;
      }

      const parsed = parseStremioStreamResponse(json, params.pluginName);
      totalSkippedTorrent += parsed.skippedTorrentCount;

      if (parsed.streams.length > 0) {
        return {
          pluginKey: params.pluginKey,
          pluginId: params.pluginId,
          pluginName: params.pluginName,
          ok: true,
          streams: parsed.streams,
          durationMs: Date.now() - startedAt,
        };
      }
    } catch (err) {
      if (timedOut) {
        lastCategory = "timeout";
        lastError = `Repository timeout after ${Math.round(timeoutMs / 1000)}s`;
      } else {
        lastCategory = "repo_unavailable";
        lastError = err instanceof Error ? err.message : "Repository unavailable";
      }
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  if (lastError) {
    return {
      pluginKey: params.pluginKey,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      ok: false,
      streams: [],
      durationMs: Date.now() - startedAt,
      timedOut: lastCategory === "timeout",
      errorCategory: lastCategory,
      error: lastError,
    };
  }

  return {
    pluginKey: params.pluginKey,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    ok: totalSkippedTorrent === 0,
    streams: [],
    durationMs: Date.now() - startedAt,
    errorCategory: totalSkippedTorrent > 0 ? "invalid_url" : "no_streams",
    ...(totalSkippedTorrent > 0
      ? {
          error:
            "Add-on returned torrent/infoHash references only (no direct HTTP stream URL).",
        }
      : {}),
  };
}
