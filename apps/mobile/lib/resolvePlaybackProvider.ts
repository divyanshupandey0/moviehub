/**
 * Canonical Nuvio plugin resolution for playback and prefetch.
 *
 * Precedence:
 *   1. route param (`?provider=`)
 *   2. session pick (user selected plugin from ServerPicker / PlayerHub)
 *   3. settings.defaultServer (user saved default plugin or empty/"__all__")
 *   4. lastProvider (last working plugin for this title)
 *   5. platform default (`__all__`, querying all enabled Nuvio plugins)
 */
import { ensurePluginsLoaded, pluginManager } from "./nuvio/pluginManager";
import { ALL_NUVIO_PLUGINS_ID } from "./nuvio/sourceDiscovery";
import { getLastProvider } from "./lastProvider";
import type { NuvioMediaType } from "./nuvio/types";

export interface PlaybackProviderQuery {
  routeProvider?: string | null;
  sessionPick?: string | null;
  savedServer?: string | null;
  lastProvider?: string | null;
  mediaType?: NuvioMediaType;
}

export interface ResolvedPlaybackProvider {
  providerId: string;
  tier: "route" | "session" | "saved" | "last" | "default";
}

function isValidCandidate(
  id: string | null | undefined,
  mediaType?: NuvioMediaType,
): string | null {
  if (!id) return null;
  if (id === ALL_NUVIO_PLUGINS_ID) return ALL_NUVIO_PLUGINS_ID;
  const enabled = pluginManager.getEnabledPlugins(mediaType);
  const match = enabled.find((p) => p.pluginKey === id || p.id === id);
  return match ? match.pluginKey : null;
}

export function resolvePlaybackProviderIdCore(
  q: PlaybackProviderQuery,
): string {
  return resolvePlaybackProviderIdTiered(q).providerId;
}

export function resolvePlaybackProviderIdTiered(
  q: PlaybackProviderQuery,
): ResolvedPlaybackProvider {
  const candidates: Array<
    [string | null | undefined, ResolvedPlaybackProvider["tier"]]
  > = [
    [q.routeProvider, "route"],
    [q.sessionPick, "session"],
    [q.savedServer, "saved"],
    [q.lastProvider, "last"],
  ];
  for (const [id, tier] of candidates) {
    const valid = isValidCandidate(id, q.mediaType);
    if (valid) return { providerId: valid, tier };
  }
  return {
    providerId: ALL_NUVIO_PLUGINS_ID,
    tier: "default",
  };
}

export interface PlaybackProviderRequest {
  mediaType: "movie" | "tv";
  tmdbId: number;
  routeProvider?: string | null;
  sessionPick?: string | null;
  savedServer?: string | null;
}

export async function resolvePlaybackProviderId(
  req: PlaybackProviderRequest,
): Promise<string> {
  await ensurePluginsLoaded();
  const last = await getLastProvider(req.mediaType, req.tmdbId);
  const resolved = resolvePlaybackProviderIdTiered({
    routeProvider: req.routeProvider,
    sessionPick: req.sessionPick,
    savedServer: req.savedServer,
    lastProvider: last,
    mediaType: req.mediaType,
  });
  return resolved.providerId;
}
