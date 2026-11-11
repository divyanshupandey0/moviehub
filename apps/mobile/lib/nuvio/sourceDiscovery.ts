/**
 * Nuvio Source Discovery & Stream Pipeline
 *
 * Sole source-discovery engine for Movie Hub mobile — replaces all old
 * hardcoded direct and WebView embed providers.
 *
 * Flow:
 * 1. Identify eligible enabled Nuvio plugins supporting `mediaType` ("movie" | "tv")
 * 2. Load cached scripts cleanly & execute `getStreams(tmdbId, mediaType, season, episode)`
 *    inside isolated sandboxed runtimes with timeout & cancellation
 * 3. Normalize, deduplicate, and validate candidate URLs
 * 4. Rank via user preferences (preferredAudioLanguage, maxQuality, cellularMaxMB)
 * 5. Probe top candidate(s) with OkHttp `validateStreamUrl`
 */

import type { StreamLink } from "../../components/player/streamTypes";
import { validateStreamUrl, type ValidationResult } from "../streamValidator";
import { rankStreams, type PreferredLanguage } from "../streamSelector";
import { ensurePluginsLoaded, pluginManager } from "./pluginManager";
import { executeNuvioGetStreams } from "./pluginRuntime";
import { diagnosticsStore, redactSensitiveText } from "./diagnostics";
import {
  executeStremioGetStreams,
  resolveExternalImdbId,
} from "./stremioAdapter";
import {
  detectStreamContainer,
  isDirectDownloadableUrl,
  isPlayableHttpUrl,
} from "./urlUtils";
import type {
  InstalledPlugin,
  NuvioMediaType,
  NuvioStream,
  PluginErrorCategory,
} from "./types";

export const ALL_NUVIO_PLUGINS_ID = "__all__";

export interface PluginDiagnosticError {
  pluginName: string;
  error: string;
  category?: PluginErrorCategory;
  diagnosticDetail?: string;
}

export interface NuvioStreamCacheResult {
  links: StreamLink[];
  bestIndex: number;
  bestValidated: boolean;
  validationResults: Map<string, ValidationResult>;
  allDead: boolean;
  selectionReason: string;
  capBytes: number;
  prefetchedAt: number;
  noPluginsConfigured?: boolean;
  pluginErrors?: PluginDiagnosticError[];
  summaryError?: string;
}

export interface NuvioDiscoveryOptions {
  /** Specific pluginKey / plugin id, or "__all__" (default) to query all enabled plugins */
  pluginKeyOrId?: string;
  cellularMaxMB?: number;
  maxQuality?: string | null;
  preferredAudioLanguage?: PreferredLanguage;
  force?: boolean;
  signal?: AbortSignal;
  onStage?: (message: string | null) => void;
  onEarlyHead?: (head: StreamLink) => void;
}

const QUALITY_REGEX = /\b(2160p|4k|uhd|1440p|1080p|fhd|720p|hd|480p|sd|360p|cam|hdcam|ts|hdts)\b/i;
const LANG_MAP: Array<[RegExp, string]> = [
  [/\bhindi\b|\bhin\b|\b\[hi\]/i, "hindi"],
  [/\bmulti[\s-]*(audio|lang)?\b|\bdual[\s-]*audio\b/i, "multi"],
  [/\btamil\b|\btam\b/i, "tamil"],
  [/\btelugu\b|\btel\b/i, "telugu"],
  [/\bmalayalam\b|\bmal\b/i, "malayalam"],
  [/\bkannada\b|\bkan\b/i, "kannada"],
  [/\benglish\b|\beng\b|\b\[en\]/i, "english"],
];

function safeStr(val: unknown): string {
  if (typeof val === "string") return val.trim();
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  return "";
}

function parseQuality(s: NuvioStream): string {
  const q = safeStr(s.quality);
  if (q) {
    if (/2160|4k|uhd/i.test(q)) return "4K";
    const m = q.match(/(\d{3,4}p)/i);
    if (m) return m[1].toLowerCase();
    return q;
  }
  const combined = `${safeStr(s.name)} ${safeStr(s.title)} ${safeStr(s.description)}`;
  const m = combined.match(QUALITY_REGEX);
  if (m) {
    const val = m[1].toUpperCase();
    if (val === "2160P" || val === "UHD" || val === "4K") return "4K";
    if (val === "FHD") return "1080p";
    if (val === "HD") return "720p";
    return m[1].toLowerCase();
  }
  return "Auto";
}

function parseSizeBytes(raw: string | number | undefined): {
  bytes?: number;
  label?: string;
} {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const gb = raw / 1024 ** 3;
    const label =
      gb >= 1
        ? `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`
        : `${Math.max(1, Math.round(raw / 1024 ** 2))} MB`;
    return { bytes: raw, label };
  }
  if (typeof raw === "string" && raw.trim()) {
    const clean = raw.trim();
    const m = clean.match(/([\d.]+)\s*(tb|gb|mb|kb|b)\b/i);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const mult =
        unit === "tb"
          ? 1024 ** 4
          : unit === "gb"
            ? 1024 ** 3
            : unit === "mb"
              ? 1024 ** 2
              : unit === "kb"
                ? 1024
                : 1;
      return { bytes: Math.round(n * mult), label: clean };
    }
    return { label: clean };
  }
  return {};
}

function detectExplicitAudioLabel(
  s: NuvioStream,
  plugin: InstalledPlugin,
): string | undefined {
  const hay = `${safeStr(s.name)} ${safeStr(s.title)} ${safeStr(s.description)}`;
  for (const [re, lang] of LANG_MAP) {
    if (re.test(hay)) return lang;
  }
  // Only fall back to plugin metadata when it declares a single specific language
  if (Array.isArray(plugin.contentLanguage) && plugin.contentLanguage.length === 1) {
    const code = safeStr(plugin.contentLanguage[0]).toLowerCase();
    if (code === "hi" || code === "hin") return "hindi";
    if (code === "en" || code === "eng") return "english";
    if (code === "ta" || code === "tam") return "tamil";
    if (code === "te" || code === "tel") return "telugu";
  }
  return undefined;
}

function normalizeNuvioStream(
  raw: NuvioStream,
  plugin: InstalledPlugin,
  index: number,
): StreamLink | null {
  if (!raw || typeof raw !== "object") return null;
  const url = safeStr(raw.url);
  if (!isPlayableHttpUrl(url)) return null;

  const rawType = safeStr(raw.type) || undefined;
  const container = detectStreamContainer(url, rawType);
  const quality = parseQuality(raw);
  const titleStr = safeStr(raw.title);
  const nameStr = safeStr(raw.name);
  const descStr = safeStr(raw.description);
  const sizeInfo = parseSizeBytes(raw.size ?? raw.behaviorHints?.videoSize);
  if (!sizeInfo.bytes && (titleStr || descStr)) {
    const inTitle = parseSizeBytes(titleStr || descStr);
    if (inTitle.bytes) {
      sizeInfo.bytes = inTitle.bytes;
      sizeInfo.label = inTitle.label;
    }
  }

  const mergedHeaders: Record<string, string> = {};
  const proxyReq = raw.behaviorHints?.proxyHeaders?.request;
  if (proxyReq && typeof proxyReq === "object") {
    for (const [k, v] of Object.entries(proxyReq)) {
      if (typeof v === "string" && v.trim()) mergedHeaders[k] = v;
    }
  }
  if (raw.headers && typeof raw.headers === "object") {
    for (const [k, v] of Object.entries(raw.headers)) {
      if (typeof v === "string" && v.trim()) mergedHeaders[k] = v;
    }
  }

  const audioLanguage = detectExplicitAudioLabel(raw, plugin);
  const subtitles = Array.isArray(raw.subtitles)
    ? raw.subtitles
        .filter((sub) => sub && typeof sub === "object" && isPlayableHttpUrl(safeStr(sub.url)))
        .map((sub) => ({
          lang: safeStr(sub.language) || safeStr(sub.lang) || "en",
          url: safeStr(sub.url),
          default: false,
        }))
    : undefined;

  const displayName =
    [nameStr, titleStr || descStr]
      .filter((x) => x.length > 0)
      .join(" · ")
      .replace(/\s+/g, " ")
      .trim() || `${safeStr(plugin.name) || "Source"} ${quality}`;

  const codec = /hevc|h265|x265|10bit/i.test(displayName)
    ? "HEVC"
    : /av1/i.test(displayName)
      ? "AV1"
      : "H264";

  return {
    id: `${plugin.id}-${index}`,
    quality,
    name: displayName,
    size: sizeInfo.label,
    url,
    type: container,
    ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
    _meta: {
      codec,
      audio: audioLanguage || "",
      ...(audioLanguage ? { audioLanguage } : {}),
      source: safeStr(plugin.name) || plugin.id,
      isDownloadOnly: false,
      isWebReady: container === "mp4" || container === "webm" || container === "m3u8",
      sizeBytes: sizeInfo.bytes,
      providerId: plugin.pluginKey,
      ...(subtitles && subtitles.length > 0 ? { subtitles } : {}),
    },
  };
}

// ── Cache & Handoff ──

const CACHE = new Map<string, NuvioStreamCacheResult & { expiresAt: number }>();
const IN_FLIGHT = new Map<string, Promise<NuvioStreamCacheResult>>();
const MAX_CACHE = 32;
const CACHE_TTL_MS = 15 * 60 * 1000;
let pinnedKey: string | null = null;

function cacheKeyOf(
  tmdbId: number,
  mediaType: NuvioMediaType,
  season?: number,
  episode?: number,
  pluginKeyOrId?: string,
): string {
  return `${mediaType}:${tmdbId}:s${season ?? 0}:e${episode ?? 0}:${pluginKeyOrId || ALL_NUVIO_PLUGINS_ID}`;
}

function purgeCache() {
  const now = Date.now();
  for (const [k, v] of CACHE) {
    if (now >= v.expiresAt) CACHE.delete(k);
  }
  while (CACHE.size > MAX_CACHE) {
    let oldestK: string | null = null;
    let oldestT = Infinity;
    for (const [k, v] of CACHE) {
      if (k === pinnedKey) continue;
      if (v.prefetchedAt < oldestT) {
        oldestT = v.prefetchedAt;
        oldestK = k;
      }
    }
    if (!oldestK) break;
    CACHE.delete(oldestK);
  }
}

export function pinNuvioPrefetchKey(key: string | null): void {
  pinnedKey = key;
}

export function clearNuvioPrefetchCache(): void {
  CACHE.clear();
  STREAM_HANDOFF.clear();
}

const STREAM_HANDOFF = new Map<
  string,
  { result: NuvioStreamCacheResult; storedAt: number }
>();

export function setNuvioStreamHandoff(
  tmdbId: number,
  mediaType: NuvioMediaType,
  season: number | undefined,
  episode: number | undefined,
  result: NuvioStreamCacheResult,
): void {
  const key = `${mediaType}:${tmdbId}:s${season ?? 0}:e${episode ?? 0}`;
  STREAM_HANDOFF.set(key, { result, storedAt: Date.now() });
}

export function peekNuvioStreamHandoff(
  tmdbId: number,
  mediaType: NuvioMediaType,
  season?: number,
  episode?: number,
): NuvioStreamCacheResult | null {
  const key = `${mediaType}:${tmdbId}:s${season ?? 0}:e${episode ?? 0}`;
  const entry = STREAM_HANDOFF.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > 120_000) {
    STREAM_HANDOFF.delete(key);
    return null;
  }
  return entry.result;
}

export function peekNuvioPrefetch(
  tmdbId: number,
  mediaType: NuvioMediaType,
  season?: number,
  episode?: number,
  pluginKeyOrId?: string,
): NuvioStreamCacheResult | null {
  const key = cacheKeyOf(tmdbId, mediaType, season, episode, pluginKeyOrId);
  const entry = CACHE.get(key);
  if (!entry || Date.now() >= entry.expiresAt) return null;
  return entry;
}

const MAX_DISCOVERY_CONCURRENCY = 4;
const PER_PLUGIN_DISCOVERY_TIMEOUT_MS = 12_000;

function summarizeFailure(
  errors: PluginDiagnosticError[],
  rawStreamCount: number,
  validUrlCount: number,
): string {
  if (rawStreamCount > 0 && validUrlCount === 0) {
    return "Invalid stream response returned by enabled providers.";
  }
  if (errors.length === 0) {
    return "No authorized sources returned by enabled plugins or add-ons.";
  }
  const first = errors[0];
  switch (first.category) {
    case "init_failed":
      return `Provider initialization failed (${first.pluginName}: ${first.error}).`;
    case "unsupported_format":
      return `Plugin incompatible (${first.pluginName}: ${first.error}).`;
    case "repo_unavailable":
      return `Repository unavailable (${first.pluginName}: ${first.error}).`;
    case "timeout":
      return `Repository unavailable: provider timeout (${first.pluginName}: ${first.error}).`;
    case "invalid_url":
      return `Invalid stream response (${first.pluginName}: ${first.error}).`;
    case "stream_unavailable":
      return `Stream expired or unavailable (${first.error}).`;
    default:
      return errors.length === 1
        ? `No authorized sources returned (${first.pluginName}: ${first.error})`
        : `No authorized sources returned across ${errors.length} plugins (${first.pluginName}: ${first.error}).`;
  }
}

async function runSinglePlugin(params: {
  plugin: InstalledPlugin;
  tmdbId: number;
  imdbId: string | null;
  mediaType: NuvioMediaType;
  season?: number;
  episode?: number;
  signal?: AbortSignal;
}) {
  const { plugin, tmdbId, imdbId, mediaType, season, episode, signal } = params;
  if (plugin.kind === "stremio") {
    return await executeStremioGetStreams({
      pluginKey: plugin.pluginKey,
      pluginId: plugin.id,
      pluginName: plugin.name,
      stremioConfig: plugin.stremioConfig,
      tmdbId: String(tmdbId),
      imdbId,
      mediaType,
      season: mediaType === "tv" ? (season ?? 1) : null,
      episode: mediaType === "tv" ? (episode ?? 1) : null,
      signal,
      timeoutMs: PER_PLUGIN_DISCOVERY_TIMEOUT_MS,
    });
  }

  const scriptCode = await pluginManager.ensurePluginScript(plugin.pluginKey);
  return await executeNuvioGetStreams({
    pluginKey: plugin.pluginKey,
    pluginId: plugin.id,
    pluginName: plugin.name,
    scriptCode,
    tmdbId: String(tmdbId),
    mediaType,
    season: mediaType === "tv" ? (season ?? 1) : null,
    episode: mediaType === "tv" ? (episode ?? 1) : null,
    pluginSettings: pluginManager.getPluginSettings(plugin.pluginKey),
    signal,
    timeoutMs: PER_PLUGIN_DISCOVERY_TIMEOUT_MS,
  });
}

async function runDiscovery(
  tmdbId: number,
  mediaType: NuvioMediaType,
  season: number | undefined,
  episode: number | undefined,
  options: NuvioDiscoveryOptions,
): Promise<NuvioStreamCacheResult> {
  await ensurePluginsLoaded();
  const targetFilter = options.pluginKeyOrId || ALL_NUVIO_PLUGINS_ID;
  const enabledPlugins = pluginManager.getEnabledPlugins(mediaType);

  const selectedPlugins: InstalledPlugin[] =
    targetFilter === ALL_NUVIO_PLUGINS_ID
      ? enabledPlugins
      : enabledPlugins.filter(
          (p) => p.pluginKey === targetFilter || p.id === targetFilter,
        );

  if (selectedPlugins.length === 0) {
    // Check if user picked or only has incompatible plugins installed
    const targetPlugin =
      targetFilter !== ALL_NUVIO_PLUGINS_ID
        ? pluginManager.getPluginByKeyOrId(targetFilter)
        : null;
    if (targetPlugin && targetPlugin.compatible === false) {
      return {
        links: [],
        bestIndex: 0,
        bestValidated: false,
        validationResults: new Map(),
        allDead: false,
        selectionReason: "",
        capBytes: (options.cellularMaxMB ?? 3000) * 1024 * 1024,
        prefetchedAt: Date.now(),
        noPluginsConfigured: false,
        pluginErrors: [
          {
            pluginName: targetPlugin.name,
            error: targetPlugin.incompatibilityReason || "Incompatible plugin",
            category: "unsupported_format",
          },
        ],
        summaryError: `Plugin incompatible (${targetPlugin.name}: ${targetPlugin.incompatibilityReason || "Unsupported format"}).`,
      };
    }

    return {
      links: [],
      bestIndex: 0,
      bestValidated: false,
      validationResults: new Map(),
      allDead: false,
      selectionReason: "",
      capBytes: (options.cellularMaxMB ?? 3000) * 1024 * 1024,
      prefetchedAt: Date.now(),
      noPluginsConfigured: true,
    };
  }

  options.onStage?.(
    selectedPlugins.length === 1
      ? `Querying ${selectedPlugins[0].name}…`
      : `Querying ${selectedPlugins.length} verified plugins…`,
  );

  // Pre-resolve IMDb ID once if any selected plugin is a Stremio add-on
  const needsImdb = selectedPlugins.some((p) => p.kind === "stremio");
  const imdbId = needsImdb
    ? await resolveExternalImdbId(String(tmdbId), mediaType, options.signal)
    : null;

  const repoNameMap = new Map(
    pluginManager.getSnapshot().repos.map((r) => [r.id, r.name]),
  );

  const pluginErrors: PluginDiagnosticError[] = [];
  const rawCollected: StreamLink[] = [];
  let totalRawStreams = 0;

  let cursor = 0;
  const runWorker = async () => {
    while (cursor < selectedPlugins.length) {
      if (options.signal?.aborted) break;
      const plugin = selectedPlugins[cursor++];
      const repoName = plugin.repoName || repoNameMap.get(plugin.repoId) || "Repository";
      const t0 = Date.now();

      diagnosticsStore.upsert(plugin.pluginKey, {
        repositoryName: repoName,
        providerName: plugin.name,
        initStatus: plugin.compatible === false ? "incompatible" : "ready",
        requestStatus: "running",
        responseTimeMs: null,
        sourcesReturned: 0,
        parsingError: "",
        playbackHandoffStatus: "not_started",
      });

      try {
        const result = await runSinglePlugin({
          plugin,
          tmdbId,
          imdbId,
          mediaType,
          season,
          episode,
          signal: options.signal,
        });
        const elapsed = result.durationMs ?? Date.now() - t0;

        if (!result.ok && result.error) {
          const safeErr = redactSensitiveText(result.error);
          const safeDetail = redactSensitiveText(result.diagnosticDetail || result.error);
          console.warn(
            `[SourceDiscovery] Plugin "${plugin.name}" failed (${result.errorCategory || "error"}):`,
            safeDetail,
          );
          diagnosticsStore.upsert(plugin.pluginKey, {
            repositoryName: repoName,
            providerName: plugin.name,
            initStatus:
              result.errorCategory === "init_failed"
                ? "failed"
                : result.errorCategory === "unsupported_format"
                  ? "incompatible"
                  : "ready",
            requestStatus:
              result.errorCategory === "timeout"
                ? "timeout"
                : result.errorCategory === "repo_unavailable"
                  ? "http_error"
                  : "error",
            responseTimeMs: elapsed,
            sourcesReturned: 0,
            parsingError: safeErr,
          });
          pluginErrors.push({
            pluginName: plugin.name,
            error: safeErr,
            category: result.errorCategory,
            diagnosticDetail: safeDetail,
          });
          continue;
        }

        totalRawStreams += result.streams.length;
        let acceptedForPlugin = 0;
        result.streams.forEach((rawStream, idx) => {
          const normalized = normalizeNuvioStream(rawStream, plugin, idx);
          if (normalized) {
            rawCollected.push(normalized);
            acceptedForPlugin++;
          }
        });

        diagnosticsStore.upsert(plugin.pluginKey, {
          repositoryName: repoName,
          providerName: plugin.name,
          initStatus: "ready",
          requestStatus: acceptedForPlugin > 0 ? "success" : "empty",
          responseTimeMs: elapsed,
          sourcesReturned: acceptedForPlugin,
          ...(result.streams.length > 0 && acceptedForPlugin === 0
            ? { parsingError: "Returned streams had invalid or non-HTTP URLs." }
            : {}),
        });
      } catch (err) {
        const msg = redactSensitiveText(err instanceof Error ? err.message : String(err));
        const detail = redactSensitiveText(
          err instanceof Error && err.stack ? err.stack : msg,
        );
        console.warn(`[SourceDiscovery] Plugin "${plugin.name}" threw:`, detail);
        diagnosticsStore.upsert(plugin.pluginKey, {
          repositoryName: repoName,
          providerName: plugin.name,
          initStatus: "failed",
          requestStatus: "error",
          responseTimeMs: Date.now() - t0,
          sourcesReturned: 0,
          parsingError: msg,
        });
        pluginErrors.push({
          pluginName: plugin.name,
          error: msg,
          category: "runtime_error",
          diagnosticDetail: detail,
        });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_DISCOVERY_CONCURRENCY, selectedPlugins.length) },
      () => runWorker(),
    ),
  );

  // Deduplicate identical stream URLs while preserving first valid entry
  const seenUrls = new Set<string>();
  const deduped: StreamLink[] = [];
  for (const link of rawCollected) {
    if (seenUrls.has(link.url)) continue;
    seenUrls.add(link.url);
    deduped.push(link);
  }

  if (deduped.length === 0) {
    options.onStage?.(null);
    return {
      links: [],
      bestIndex: 0,
      bestValidated: false,
      validationResults: new Map(),
      allDead: false,
      selectionReason: "",
      capBytes: (options.cellularMaxMB ?? 3000) * 1024 * 1024,
      prefetchedAt: Date.now(),
      noPluginsConfigured: false,
      pluginErrors,
      summaryError: summarizeFailure(pluginErrors, totalRawStreams, 0),
    };
  }

  // Rank streams according to user language, maxQuality, and cellular cap
  const rankedSelection = rankStreams(deduped, {
    cellularMaxMB: options.cellularMaxMB ?? 3000,
    maxQuality: options.maxQuality ?? null,
    preferredAudioLanguage: options.preferredAudioLanguage ?? "auto",
  });
  const rankedLinks = rankedSelection.links;

  if (rankedLinks[0]) {
    options.onEarlyHead?.(rankedLinks[0]);
  }

  options.onStage?.("Validating top stream candidates…");

  // Validate candidate URLs starting from rank 0 until we confirm a valid stream
  const validationResults = new Map<string, ValidationResult>();
  let bestIndex = 0;
  let bestValidated = false;
  let deadCount = 0;

  const probeLimit = Math.min(rankedLinks.length, 4);
  for (let i = 0; i < probeLimit; i++) {
    if (options.signal?.aborted) break;
    const candidate = rankedLinks[i];
    try {
      const verdict = await validateStreamUrl(
        candidate.url,
        candidate.headers,
      );
      validationResults.set(candidate.url, verdict);
      if (verdict.outcome === "valid") {
        bestIndex = i;
        bestValidated = true;
        diagnosticsStore.markPlaybackHandoff(
          candidate._meta?.providerId,
          "validated",
        );
        break;
      }
      if (verdict.outcome === "dead") {
        deadCount++;
        diagnosticsStore.markPlaybackHandoff(
          candidate._meta?.providerId,
          "rejected_invalid",
          verdict.error || `HTTP ${verdict.statusCode ?? "error"}`,
        );
      } else {
        // Inconclusive / unknown -> keep as playable fallback rather than condemning
        if (!bestValidated && bestIndex === 0) {
          bestIndex = i;
        }
      }
    } catch {
      // Probe error does not condemn the candidate
    }
  }

  // If the first probe candidate was dead and subsequent ones were all dead up to probeLimit,
  // pick the first non-dead candidate if any remains
  if (!bestValidated && deadCount > 0) {
    const firstNotDead = rankedLinks.findIndex(
      (l: StreamLink) => validationResults.get(l.url)?.outcome !== "dead",
    );
    if (firstNotDead >= 0) bestIndex = firstNotDead;
  }

  const allDead =
    rankedLinks.length > 0 &&
    deadCount === rankedLinks.length;

  const chosen = rankedLinks[bestIndex];
  if (chosen && !bestValidated && !allDead) {
    diagnosticsStore.markPlaybackHandoff(chosen._meta?.providerId, "handed_off");
  }

  options.onStage?.(null);

  return {
    links: rankedLinks,
    bestIndex,
    bestValidated,
    validationResults,
    allDead,
    selectionReason: rankedSelection.reason,
    capBytes: (options.cellularMaxMB ?? 3000) * 1024 * 1024,
    prefetchedAt: Date.now(),
    noPluginsConfigured: false,
    pluginErrors,
    ...(allDead
      ? { summaryError: "Stream expired or unavailable from selected providers." }
      : {}),
  };
}

export async function prefetchNuvioStreams(
  tmdbId: number,
  mediaType: NuvioMediaType,
  season?: number,
  episode?: number,
  options: NuvioDiscoveryOptions = {},
): Promise<NuvioStreamCacheResult> {
  const key = cacheKeyOf(
    tmdbId,
    mediaType,
    season,
    episode,
    options.pluginKeyOrId,
  );

  if (!options.force) {
    const cached = CACHE.get(key);
    if (cached && Date.now() < cached.expiresAt && cached.links.length > 0) {
      return cached;
    }
    const existing = IN_FLIGHT.get(key);
    if (existing) return existing;
  }

  const runPromise = runDiscovery(tmdbId, mediaType, season, episode, options)
    .then((result) => {
      if (result.links.length > 0) {
        CACHE.set(key, {
          ...result,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        purgeCache();
      }
      return result;
    })
    .finally(() => {
      IN_FLIGHT.delete(key);
    });

  IN_FLIGHT.set(key, runPromise);
  return runPromise;
}

export interface DownloadableStreamCandidate {
  link: StreamLink;
  pluginName: string;
  pluginId: string;
  downloadable: boolean;
  reason?: string;
}

/**
 * Discovers downloadable direct files (MP4/MKV/WEBM) from Nuvio plugins.
 * Explicitly distinguishes direct downloadable media files from stream-only
 * manifests (HLS .m3u8 / DASH .mpd) or restricted streams.
 */
export async function discoverNuvioDownloadCandidates(params: {
  tmdbId: number;
  mediaType: NuvioMediaType;
  season?: number;
  episode?: number;
  pluginKeyOrId?: string;
  signal?: AbortSignal;
}): Promise<{
  candidates: DownloadableStreamCandidate[];
  noPluginsConfigured: boolean;
  errors: Array<{ pluginName: string; error: string }>;
}> {
  await ensurePluginsLoaded();
  const target = params.pluginKeyOrId || ALL_NUVIO_PLUGINS_ID;
  const enabledPlugins = pluginManager.getEnabledPlugins(params.mediaType);
  const selected =
    target === ALL_NUVIO_PLUGINS_ID
      ? enabledPlugins
      : enabledPlugins.filter((p) => p.pluginKey === target || p.id === target);

  if (selected.length === 0) {
    return { candidates: [], noPluginsConfigured: true, errors: [] };
  }

  const needsImdb = selected.some((p) => p.kind === "stremio");
  const imdbId = needsImdb
    ? await resolveExternalImdbId(
        String(params.tmdbId),
        params.mediaType,
        params.signal,
      )
    : null;

  const errors: Array<{ pluginName: string; error: string }> = [];
  const candidates: DownloadableStreamCandidate[] = [];
  const seenUrls = new Set<string>();

  await Promise.all(
    selected.map(async (plugin) => {
      try {
        const exec = await runSinglePlugin({
          plugin,
          tmdbId: params.tmdbId,
          imdbId,
          mediaType: params.mediaType,
          season: params.season,
          episode: params.episode,
          signal: params.signal,
        });

        if (!exec.ok && exec.error) {
          errors.push({ pluginName: plugin.name, error: exec.error });
          return;
        }

        exec.streams.forEach((raw, idx) => {
          const link = normalizeNuvioStream(raw, plugin, idx);
          if (!link || seenUrls.has(link.url)) return;
          seenUrls.add(link.url);

          const downloadable = isDirectDownloadableUrl(
            link.url,
            raw.type,
            plugin.supportsExternalPlayer,
          );
          const container = detectStreamContainer(link.url, raw.type);

          candidates.push({
            link,
            pluginName: plugin.name,
            pluginId: plugin.id,
            downloadable,
            ...(downloadable
              ? {}
              : {
                  reason:
                    container === "m3u8" || container === "mpd"
                      ? `Stream-only (${container.toUpperCase()} manifest)`
                      : "External download not permitted by plugin",
                }),
          });
        });
      } catch (err) {
        errors.push({
          pluginName: plugin.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  // Downloadable direct files first
  candidates.sort((a, b) => Number(b.downloadable) - Number(a.downloadable));

  return {
    candidates,
    noPluginsConfigured: false,
    errors,
  };
}
