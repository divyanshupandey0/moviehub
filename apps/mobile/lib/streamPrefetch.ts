/**
 * Stream Prefetch Adapter — powered exclusively by the Nuvio Plugin System.
 */
import type { StreamLink } from "../components/player/streamTypes";
import type { PreferredLanguage } from "./streamSelector";
import {
  ALL_NUVIO_PLUGINS_ID,
  clearNuvioPrefetchCache,
  peekNuvioPrefetch,
  peekNuvioStreamHandoff,
  pinNuvioPrefetchKey,
  prefetchNuvioStreams,
  setNuvioStreamHandoff,
  type NuvioStreamCacheResult,
} from "./nuvio/sourceDiscovery";

export type StreamCacheResult = NuvioStreamCacheResult;

export interface StreamCacheOptions {
  providerId?: string;
  cellularMaxMB?: number;
  maxQuality?: string | null;
  preferredAudioLanguage?: PreferredLanguage;
  trigger?: "details" | "home-cw" | "watch" | "next-episode";
  force?: boolean;
  signal?: AbortSignal;
  onStage?: (stageMessage: string | null) => void;
  onEarlyHead?: (head: StreamLink) => void;
}

export function pinPrefetchKey(key: string | null): void {
  pinNuvioPrefetchKey(key);
}

export function clearPrefetchCache(): void {
  clearNuvioPrefetchCache();
}

export function setStreamHandoff(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season: number | undefined,
  episode: number | undefined,
  providerIdOrResult: string | StreamCacheResult,
  maybeResult?: StreamCacheResult,
): void {
  const result =
    typeof providerIdOrResult === "string" ? maybeResult : providerIdOrResult;
  if (!result) return;
  setNuvioStreamHandoff(tmdbId, mediaType, season, episode, result);
}

export function peekStreamHandoff(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
): { result: StreamCacheResult } | null {
  const result = peekNuvioStreamHandoff(tmdbId, mediaType, season, episode);
  return result ? { result } : null;
}

export function peekPrefetchStreams(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options?: StreamCacheOptions,
): StreamCacheResult | null {
  return peekNuvioPrefetch(
    tmdbId,
    mediaType,
    season,
    episode,
    options?.providerId || ALL_NUVIO_PLUGINS_ID,
  );
}

export async function prefetchStreams(
  tmdbId: number,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  options: StreamCacheOptions = {},
): Promise<StreamCacheResult> {
  return prefetchNuvioStreams(tmdbId, mediaType, season, episode, {
    pluginKeyOrId: options.providerId || ALL_NUVIO_PLUGINS_ID,
    cellularMaxMB: options.cellularMaxMB,
    maxQuality: options.maxQuality,
    preferredAudioLanguage: options.preferredAudioLanguage,
    force: options.force,
    signal: options.signal,
    onStage: options.onStage,
    onEarlyHead: options.onEarlyHead,
  });
}
