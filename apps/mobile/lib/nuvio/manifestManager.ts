/**
 * Nuvio Manifest Manager
 *
 * - Normalizes repository & GitHub URLs into canonical `manifest.json` URLs
 * - Fetches manifests with timeouts and cancellation support
 * - Validates Nuvio manifest schema strictly
 * - Deduplicates providers & filters platform incompatibilities
 * - Resolves relative script paths (`providers/xxx.js`) against manifest base
 */

import {
  isStremioManifestPayload,
  parseStremioManifest,
} from "./stremioAdapter";
import type {
  NuvioManifest,
  NuvioMediaType,
  NuvioScraperEntry,
  PluginKind,
} from "./types";

const MANIFEST_FETCH_TIMEOUT_MS = 12_000;

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

/**
 * Normalizes a repository input URL into its direct `manifest.json` URL.
 * Supports:
 * - Direct URL ending in `manifest.json`
 * - Raw GitHub repo root (`https://raw.githubusercontent.com/u/r/main`)
 * - GitHub web repo root (`https://github.com/u/r` -> `raw.githubusercontent.com/u/r/HEAD/manifest.json`)
 * - GitHub blob URL (`https://github.com/u/r/blob/main/manifest.json`)
 */
export function normalizeManifestUrl(rawInput: string): string {
  let trimmed = String(rawInput ?? "").trim();
  if (!trimmed) {
    throw new ManifestValidationError("Repository URL cannot be empty.");
  }
  if (/^stremio:\/\//i.test(trimmed)) {
    trimmed = trimmed.replace(/^stremio:\/\//i, "https://");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ManifestValidationError("Invalid repository URL format.");
  }

  const isLoopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new ManifestValidationError(
      "Repository URL must use HTTPS (https://).",
    );
  }

  // Reject localhost/private schemes in production if malformed; allow valid http/https hosts
  const host = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname.split("/").filter(Boolean);

  // Convert github.com/owner/repo(/tree/branch | /blob/branch/manifest.json) to raw.githubusercontent.com
  if (host === "github.com" && pathParts.length >= 2) {
    const owner = pathParts[0];
    const repo = pathParts[1].replace(/\.git$/, "");
    if (pathParts[2] === "blob" && pathParts.length >= 5) {
      const rest = pathParts.slice(3).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
    }
    if (pathParts[2] === "tree" && pathParts.length >= 4) {
      const branchAndSub = pathParts.slice(3).join("/");
      const suffix = branchAndSub.endsWith(".json")
        ? branchAndSub
        : `${branchAndSub}/manifest.json`;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${suffix}`;
    }
    return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/manifest.json`;
  }

  if (parsed.pathname.toLowerCase().endsWith(".json")) {
    return parsed.toString();
  }

  // Append /manifest.json when user entered repo base URL (matches tapframe/nuvio-providers quick start)
  const cleanBase = trimmed.replace(/\/+$/, "");
  return `${cleanBase}/manifest.json`;
}

/** Stable repository ID derived from canonical manifest URL. */
export function computeRepoId(manifestUrl: string): string {
  let hash = 2166136261;
  for (let i = 0; i < manifestUrl.length; i++) {
    hash ^= manifestUrl.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `repo_${(hash >>> 0).toString(36)}`;
}

/** Resolve a scraper's `filename` or `url` against its repository manifest URL. */
export function resolvePluginScriptUrl(
  manifestUrl: string,
  entry: NuvioScraperEntry,
): string {
  const target = (entry.filename || entry.url || "").trim();
  if (!target) {
    throw new ManifestValidationError(
      `Plugin "${entry.id}" is missing a valid script filename or url.`,
    );
  }

  let resolved: URL;
  try {
    resolved = new URL(target, manifestUrl);
  } catch {
    throw new ManifestValidationError(
      `Plugin "${entry.id}" has an invalid script URL: ${target}`,
    );
  }

  const isLoopback =
    resolved.hostname === "localhost" || resolved.hostname === "127.0.0.1";
  if (resolved.protocol !== "https:" && !(resolved.protocol === "http:" && isLoopback)) {
    throw new ManifestValidationError(
      `Plugin "${entry.id}" script URL must use HTTPS (https://).`,
    );
  }

  return resolved.toString();
}

/** Normalize supportedTypes (`"series"` -> `"tv"`, default `["movie", "tv"]` if omitted). */
export function normalizeSupportedTypes(
  rawTypes: unknown,
): NuvioMediaType[] {
  if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
    return ["movie", "tv"];
  }
  const result = new Set<NuvioMediaType>();
  for (const t of rawTypes) {
    const lower = String(t).toLowerCase().trim();
    if (lower === "movie" || lower === "movies") result.add("movie");
    else if (lower === "tv" || lower === "series" || lower === "show") {
      result.add("tv");
    }
  }
  return result.size > 0 ? Array.from(result) : ["movie", "tv"];
}

/** Compare dotted semver strings (`1.2.0` > `1.0.2`). Returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || "0")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export interface ValidatedManifestResult {
  manifest: NuvioManifest;
  manifestUrl: string;
  entries: NuvioScraperEntry[];
  kind: PluginKind;
}

export function validateManifestPayload(
  raw: unknown,
  manifestUrl: string,
): ValidatedManifestResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestValidationError(
      "Unsupported plugin format: Manifest JSON must be an object.",
    );
  }

  if (isStremioManifestPayload(raw)) {
    const parsedStremio = parseStremioManifest(raw, manifestUrl);
    return {
      manifest: {
        name: parsedStremio.name,
        version: parsedStremio.version,
        scrapers: [parsedStremio.entry],
      },
      manifestUrl,
      entries: [parsedStremio.entry],
      kind: "stremio",
    };
  }

  const obj = raw as Record<string, unknown>;
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : "Nuvio Repository";
  const version =
    typeof obj.version === "string" && obj.version.trim()
      ? obj.version.trim()
      : "1.0.0";

  const rawList = Array.isArray(obj.scrapers)
    ? obj.scrapers
    : Array.isArray(obj.providers)
      ? obj.providers
      : null;

  if (!rawList) {
    throw new ManifestValidationError(
      'Unsupported plugin format: manifest is missing Nuvio "scrapers" or Stremio "resources".',
    );
  }

  const seenIds = new Set<string>();
  const validEntries: NuvioScraperEntry[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const pName = typeof rec.name === "string" ? rec.name.trim() : id;
    const filename =
      typeof rec.filename === "string" ? rec.filename.trim() : undefined;
    const url = typeof rec.url === "string" ? rec.url.trim() : undefined;

    if (!id || (!filename && !url)) continue;
    if (seenIds.has(id)) continue; // prevent duplicates within manifest

    const disabledPlatforms = Array.isArray(rec.disabledPlatforms)
      ? rec.disabledPlatforms.map((p) => String(p).toLowerCase())
      : [];
    if (disabledPlatforms.includes("android")) {
      continue;
    }

    // Validate resolved script URL eagerly
    const candidateEntry: NuvioScraperEntry = {
      id,
      name: pName || id,
      description:
        typeof rec.description === "string" ? rec.description.trim() : "",
      version:
        typeof rec.version === "string" && rec.version.trim()
          ? rec.version.trim()
          : "1.0.0",
      author:
        typeof rec.author === "string" && rec.author.trim()
          ? rec.author.trim()
          : "Community",
      supportedTypes: normalizeSupportedTypes(rec.supportedTypes),
      ...(filename ? { filename } : {}),
      ...(url ? { url } : {}),
      enabled: rec.enabled !== false,
      logo: typeof rec.logo === "string" ? rec.logo.trim() : undefined,
      contentLanguage: Array.isArray(rec.contentLanguage)
        ? rec.contentLanguage.map((l) => String(l).toLowerCase())
        : ["en"],
      formats: Array.isArray(rec.formats)
        ? rec.formats.map((f) => String(f).toLowerCase())
        : [],
      limited: rec.limited === true,
      disabledPlatforms,
      supportsExternalPlayer: rec.supportsExternalPlayer !== false,
      hasSettings: rec.hasSettings === true,
    };

    try {
      resolvePluginScriptUrl(manifestUrl, candidateEntry);
      seenIds.add(id);
      validEntries.push(candidateEntry);
    } catch {
      // Skip malformed plugin entry without failing entire manifest
    }
  }

  if (validEntries.length === 0) {
    throw new ManifestValidationError(
      "Unsupported plugin format: repository manifest contains no valid Android-compatible plugins.",
    );
  }

  return {
    manifest: { name, version, scrapers: validEntries },
    manifestUrl,
    entries: validEntries,
    kind: "nuvio",
  };
}

export async function fetchAndValidateManifest(
  inputUrl: string,
  externalSignal?: AbortSignal,
): Promise<ValidatedManifestResult> {
  const manifestUrl = normalizeManifestUrl(inputUrl);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MANIFEST_FETCH_TIMEOUT_MS,
  );

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeout);
      throw new Error("Manifest fetch cancelled");
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(manifestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new ManifestValidationError(
        `Repository unavailable (HTTP ${res.status}).`,
      );
    }

    const rawText = await res.text();
    const text = rawText.replace(/^\uFEFF/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ManifestValidationError(
        "Unsupported plugin format: repository did not return valid JSON manifest data.",
      );
    }

    return validateManifestPayload(parsed, manifestUrl);
  } catch (err) {
    if (err instanceof ManifestValidationError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new ManifestValidationError(
        "Repository unavailable: manifest request timed out.",
      );
    }
    throw new ManifestValidationError(
      err instanceof Error
        ? `Repository unavailable: ${err.message}`
        : "Repository unavailable.",
    );
  } finally {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export async function fetchPluginScriptText(
  scriptUrl: string,
  externalSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeout);
      throw new Error("Plugin download cancelled");
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(scriptUrl, {
      method: "GET",
      headers: {
        Accept: "application/javascript, text/javascript, text/plain, */*",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching plugin script`);
    }
    const code = await res.text();
    if (!code || code.trim().length < 20) {
      throw new Error("Downloaded plugin script is empty or invalid.");
    }
    // Reject obvious HTML error pages returned with HTTP 200
    const head = code.trimStart().slice(0, 80).toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
      throw new Error("Plugin URL returned an HTML page instead of JavaScript.");
    }
    return code;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
