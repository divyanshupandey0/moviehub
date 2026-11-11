/**
 * useDirectStreamPipeline — Nuvio plugin source discovery hook for the watch screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ValidationResult } from "../lib/streamValidator";
import {
  getLastWorkingSource,
  forgetWorkingSource,
  urlKeyOf,
} from "../lib/lastWorkingSource";
import {
  peekStreamHandoff,
  pinPrefetchKey,
  prefetchStreams,
} from "../lib/streamPrefetch";
import { ALL_NUVIO_PLUGINS_ID } from "../lib/nuvio/sourceDiscovery";
import type { StreamLink } from "../components/player/streamTypes";

interface UseDirectStreamPipelineParams {
  id: string | undefined;
  type: "movie" | "tv";
  isDirectPlayback: boolean;
  provider: string | undefined;
  languageAnswered: boolean;
  initialSeason?: number;
  initialEpisode?: number;
  settingsRef: React.MutableRefObject<any>;
  lockProvider?: boolean;
}

export interface DirectStreamPipelineState {
  links: StreamLink[];
  bestIndex: number;
  prevalidated: Map<string, ValidationResult> | null;
  selectionReason: string;
  lastWorkingIndex: number | undefined;
  loading: boolean;
  error: string | null;
  noPluginsConfigured: boolean;
  stageMessage: string | null;
  refetch: () => void;
  season: number | undefined;
  episode: number | undefined;
  setSeason: (s: number | undefined) => void;
  setEpisode: (e: number | undefined) => void;
}

export function useDirectStreamPipeline({
  id,
  type,
  isDirectPlayback,
  provider,
  languageAnswered,
  initialSeason,
  initialEpisode,
  settingsRef,
}: UseDirectStreamPipelineParams): DirectStreamPipelineState {
  const [links, setLinks] = useState<StreamLink[]>([]);
  const [bestIndex, setBestIndex] = useState(0);
  const [prevalidated, setPrevalidated] = useState<Map<
    string,
    ValidationResult
  > | null>(null);
  const [selectionReason, setSelectionReason] = useState<string>("");
  const [lastWorkingIndex, setLastWorkingIndex] = useState<number | undefined>(
    undefined,
  );
  const [noPluginsConfigured, setNoPluginsConfigured] = useState(false);

  const [loading, setLoading] = useState(() => {
    if (!isDirectPlayback || !id) return false;
    const handoff = peekStreamHandoff(
      parseInt(id, 10),
      type,
      initialSeason,
      initialEpisode,
    );
    return !(handoff && handoff.result.links.length > 0);
  });
  const [error, setError] = useState<string | null>(null);
  const [stageMessage, setStageMessage] = useState<string | null>(null);
  const [fetchToken, setFetchToken] = useState(0);
  const [directSeason, setDirectSeason] = useState<number | undefined>(
    initialSeason,
  );
  const [directEpisode, setDirectEpisode] = useState<number | undefined>(
    initialEpisode,
  );
  const forceNextRef = useRef(false);

  const loadStreams = useCallback(() => {
    if (!isDirectPlayback || !id) return;
    if (!languageAnswered) return;

    const controller = new AbortController();
    let cancelled = false;
    setError(null);
    setNoPluginsConfigured(false);
    setStageMessage(null);

    const tmdbNum = parseInt(id, 10);
    const activeProvider = provider || ALL_NUVIO_PLUGINS_ID;

    const handoff =
      tmdbNum && activeProvider === ALL_NUVIO_PLUGINS_ID
        ? peekStreamHandoff(tmdbNum, type, directSeason, directEpisode)
        : null;

    if (handoff && handoff.result.links.length > 0) {
      setLinks(handoff.result.links);
      setBestIndex(handoff.result.bestIndex);
      setPrevalidated(handoff.result.validationResults);
      setSelectionReason(handoff.result.selectionReason);
      setLoading(false);
    } else {
      setLoading(true);
    }

    const s = settingsRef.current;
    const force = forceNextRef.current;
    forceNextRef.current = false;

    const cacheKey = `${type}:${tmdbNum}:s${directSeason ?? 0}:e${directEpisode ?? 0}:${activeProvider}`;
    pinPrefetchKey(cacheKey);

    Promise.all([
      prefetchStreams(tmdbNum, type, directSeason, directEpisode, {
        providerId: activeProvider,
        cellularMaxMB: s.cellularMaxMB,
        maxQuality: s.maxQuality,
        preferredAudioLanguage: s.preferredAudioLanguage,
        trigger: "watch",
        force,
        signal: controller.signal,
        onStage: (msg) => {
          if (!cancelled) setStageMessage(msg);
        },
      }),
      getLastWorkingSource(type, id),
    ])
      .then(([res, rememberedUrlKey]) => {
        if (cancelled) return;

        if (res.noPluginsConfigured) {
          setLinks([]);
          setNoPluginsConfigured(true);
          setError(
            "No Nuvio plugins are enabled. Open Settings → Plugins to add a plugin repository.",
          );
          setLoading(false);
          return;
        }

        if (!res.links || res.links.length === 0) {
          setLinks([]);
          setNoPluginsConfigured(false);
          const pluginErr = res.pluginErrors?.[0]?.error;
          setError(
            res.summaryError ||
              (pluginErr
                ? `No playable streams found (${pluginErr})`
                : "No streams returned by enabled plugins."),
          );
          setLoading(false);
          return;
        }

        let finalBestIndex = res.bestIndex;
        let rememberedIdx: number | undefined;
        let reason = res.selectionReason;

        if (rememberedUrlKey) {
          const foundIdx = res.links.findIndex(
            (l) => urlKeyOf(l.url) === rememberedUrlKey,
          );
          if (foundIdx >= 0) {
            const verdict = res.validationResults.get(res.links[foundIdx].url);
            if (verdict?.outcome === "dead") {
              void forgetWorkingSource(type, id);
            } else {
              rememberedIdx = foundIdx;
              finalBestIndex = foundIdx;
              reason = "Last working source";
            }
          }
        }

        setLinks(res.links);
        setBestIndex(finalBestIndex);
        setPrevalidated(res.validationResults);
        setSelectionReason(reason);
        setLastWorkingIndex(rememberedIdx);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLinks([]);
        setError(
          err instanceof Error
            ? err.message
            : "Could not resolve streams from Nuvio plugins.",
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      pinPrefetchKey(null);
    };
  }, [
    id,
    type,
    isDirectPlayback,
    provider,
    languageAnswered,
    directSeason,
    directEpisode,
    settingsRef,
    fetchToken,
  ]);

  useEffect(() => {
    const cleanup = loadStreams();
    return () => {
      cleanup?.();
    };
  }, [loadStreams]);

  const refetch = useCallback(() => {
    forceNextRef.current = true;
    setFetchToken((n) => n + 1);
  }, []);

  return {
    links,
    bestIndex,
    prevalidated,
    selectionReason,
    lastWorkingIndex,
    loading,
    error,
    noPluginsConfigured,
    stageMessage,
    refetch,
    season: directSeason,
    episode: directEpisode,
    setSeason: setDirectSeason,
    setEpisode: setDirectEpisode,
  };
}
