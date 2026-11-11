/**
 * Authoritative Nuvio Plugin Manifest & Provider Contract Types.
 *
 * Matches the Nuvio ecosystem specification (`tapframe/nuvio-providers`):
 * - `manifest.json` registry schema (`scrapers` / `providers`)
 * - Provider `getStreams(tmdbId, mediaType, season, episode)` signature
 * - Stream response objects (`url`, `quality`, `size`, `type`, `headers`, `subtitles`, `behaviorHints`)
 * - Optional `onSettings()` configuration UI blueprint
 */

export type NuvioMediaType = "movie" | "tv";
export type PluginKind = "nuvio" | "stremio";

export interface StremioResourceObject {
  name: string;
  types?: string[];
  idPrefixes?: string[];
}

export interface StremioManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  resources: Array<string | StremioResourceObject>;
  types: string[];
  idPrefixes?: string[];
  catalogs?: unknown[];
  behaviorHints?: {
    adult?: boolean;
    p2p?: boolean;
    configurable?: boolean;
    configurationRequired?: boolean;
  };
}

export interface StremioStreamObject {
  url?: string;
  externalUrl?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  name?: string;
  title?: string;
  description?: string;
  subtitles?: NuvioSubtitle[];
  behaviorHints?: {
    countryWhitelist?: string[];
    notWebReady?: boolean;
    bingeGroup?: string;
    filename?: string;
    videoSize?: number;
    videoHash?: string;
    proxyHeaders?: {
      request?: Record<string, string>;
      response?: Record<string, string>;
    };
  };
}

export interface StremioAddonConfig {
  addonBaseUrl: string;
  streamTypes: string[];
  idPrefixes: string[];
  configurable?: boolean;
  configurationRequired?: boolean;
}

export interface NuvioScraperEntry {
  id: string;
  name: string;
  description?: string;
  version: string;
  author?: string;
  supportedTypes: ("movie" | "tv" | "series")[];
  /** Relative path (e.g. "providers/4khdhub.js") or full URL to compiled plugin script */
  filename?: string;
  /** Alternative manifest field used in some community repos */
  url?: string;
  enabled?: boolean;
  logo?: string;
  contentLanguage?: string[];
  formats?: string[];
  limited?: boolean;
  disabledPlatforms?: string[];
  supportsExternalPlayer?: boolean;
  hasSettings?: boolean;
  kind?: PluginKind;
  stremioConfig?: StremioAddonConfig;
}

export interface NuvioManifest {
  name: string;
  version: string;
  scrapers?: NuvioScraperEntry[];
  providers?: NuvioScraperEntry[];
}

export interface NuvioRepository {
  id: string;
  /** Original URL entered by the user */
  url: string;
  /** Normalized absolute URL to manifest.json */
  manifestUrl: string;
  name: string;
  version: string;
  lastUpdatedAt: number;
  lastError?: string | null;
  status: "ok" | "error" | "syncing";
  pluginCount: number;
  compatibleCount?: number;
  incompatibleCount?: number;
  kind?: PluginKind;
}

export interface InstalledPlugin {
  /** Globally unique key (`${repoId}::${id}`) preventing collisions across repositories */
  pluginKey: string;
  id: string;
  repoId: string;
  repoUrl: string;
  repoName?: string;
  kind?: PluginKind;
  stremioConfig?: StremioAddonConfig;
  compatible?: boolean;
  incompatibilityReason?: string | null;
  name: string;
  description: string;
  version: string;
  author: string;
  supportedTypes: NuvioMediaType[];
  scriptUrl: string;
  enabled: boolean;
  logo?: string;
  contentLanguage: string[];
  formats: string[];
  limited: boolean;
  supportsExternalPlayer: boolean;
  hasSettings: boolean;
  installedAt: number;
  updatedAt: number;
  /** Set when a repository refresh finds a newer version than installed */
  updateAvailableVersion?: string;
  lastError?: string | null;
}

export interface NuvioSubtitle {
  url: string;
  language?: string;
  lang?: string;
  name?: string;
  label?: string;
  headers?: Record<string, string>;
}

export interface NuvioStream {
  name?: string;
  title?: string;
  description?: string;
  url: string;
  externalUrl?: string;
  quality?: string;
  size?: string | number;
  type?: string;
  headers?: Record<string, string>;
  subtitles?: NuvioSubtitle[];
  behaviorHints?: {
    bingeGroup?: string;
    notWebReady?: boolean;
    filename?: string;
    videoSize?: number;
    countryWhitelist?: string[];
    proxyHeaders?: {
      request?: Record<string, string>;
      response?: Record<string, string>;
    };
  };
}

export interface NuvioSettingOption {
  label: string;
  value: string;
}

export interface NuvioSettingField {
  type: "header" | "info" | "text" | "toggle" | "select";
  key?: string;
  label: string;
  description?: string;
  placeholder?: string;
  isPassword?: boolean;
  defaultValue?: string | boolean;
  options?: NuvioSettingOption[];
}

export type PluginErrorCategory =
  | "init_failed"
  | "repo_unavailable"
  | "unsupported_format"
  | "no_streams"
  | "invalid_url"
  | "stream_unavailable"
  | "timeout"
  | "runtime_error";

export interface PluginExecutionResult {
  pluginKey: string;
  pluginId: string;
  pluginName: string;
  ok: boolean;
  streams: NuvioStream[];
  durationMs: number;
  timedOut?: boolean;
  error?: string;
  errorCategory?: PluginErrorCategory;
  diagnosticDetail?: string;
}

export interface ProviderDiagnosticRecord {
  pluginKey: string;
  repositoryName: string;
  providerName: string;
  initStatus: "pending" | "ready" | "failed" | "incompatible";
  requestStatus:
    | "idle"
    | "running"
    | "success"
    | "empty"
    | "timeout"
    | "http_error"
    | "error"
    | "skipped_incompatible";
  responseTimeMs: number | null;
  sourcesReturned: number;
  parsingError?: string;
  compatibilityError?: string;
  playbackHandoffStatus:
    | "not_started"
    | "handed_off"
    | "validated"
    | "rejected_invalid"
    | "failed";
  updatedAt: number;
}

export interface NuvioProviderView {
  id: string;
  pluginKey: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  logo?: string;
  contentLanguage: string[];
  formats: string[];
  supportedTypes: NuvioMediaType[];
}
