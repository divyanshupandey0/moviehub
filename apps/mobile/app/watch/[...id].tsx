/**
 * Watch route — Nuvio Plugin Playback & Offline Local Media Player.
 *
 * Uses exclusively:
 * - Nuvio Plugin System for movie & TV episode stream discovery
 * - Existing HevcPlayer (Media3 / ExoPlayer) for playback, subtitles, audio tracks, and controls
 * - Offline fileUri direct playback for downloaded media
 */
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StatusBar, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeNavigation } from "@/lib/navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { VideoPlayer } from "expo-video";
import { VideoWebView } from "../../components/VideoWebView";
import { HevcPlayer } from "../../components/HevcPlayer";
import { isDirectVideoUrl } from "../../lib/hevc";
import { useSettings } from "../../lib/settings";
import { getLastProvider, saveLastProvider } from "../../lib/lastProvider";
import { resolvePlaybackProviderIdTiered } from "../../lib/resolvePlaybackProvider";
import {
  takeEarlyPlayer,
  disposeEarlyPlayer,
} from "../../lib/earlyPlayerHolder";
import { LanguagePromptSheet } from "../../components/player/LanguagePromptSheet";
import { useDirectStreamPipeline } from "../../hooks/useDirectStreamPipeline";
import { useDoubleBackExit } from "../../hooks/useDoubleBackExit";
import {
  BackExitToast,
  BackdropGate,
  InvalidWatchScreen,
} from "../../components/watch/WatchRouteUI";
import { colors } from "../../theme/colors";
import {
  trackFeatureUsed,
  trackPlayerError,
  trackWatchOpened,
} from "../../lib/telemetry";

export default function WatchScreen() {
  const nav = useSafeNavigation();
  const insets = useSafeAreaInsets();
  const { settings, updateSetting } = useSettings();
  const params = useLocalSearchParams<{
    id: string[];
    backdrop?: string;
    provider?: string;
    videoUrl?: string;
    fileUri?: string;
    title?: string;
    startAt?: string;
    fs?: string;
    t?: string;
    isAnime?: string;
  }>();

  const segments = params.id ?? [];
  const type = segments[0] as "movie" | "tv";
  const id = segments[1];
  const season = segments[2] ? Number(segments[2]) : undefined;
  const episode = segments[3] ? Number(segments[3]) : undefined;

  const routeProvider =
    typeof params.provider === "string" ? params.provider : undefined;
  const hasUrlParams = !!(params.videoUrl || params.fileUri);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [providerReady, setProviderReady] = useState(
    !!routeProvider || hasUrlParams,
  );

  useEffect(() => {
    if (routeProvider || hasUrlParams) {
      setProviderReady(true);
      return;
    }
    if (!id) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setProviderReady(true);
    }, 250);
    getLastProvider(type, id)
      .then((p) => {
        if (cancelled) return;
        setLastProvider(p);
        setProviderReady(true);
        clearTimeout(timer);
      })
      .catch(() => {
        if (cancelled) return;
        setProviderReady(true);
        clearTimeout(timer);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [routeProvider, hasUrlParams, id, type]);

  const resolvedSync = providerReady
    ? resolvePlaybackProviderIdTiered({
        routeProvider,
        savedServer: settings.defaultServer || null,
        lastProvider,
        mediaType: type,
      })
    : null;
  const provider = resolvedSync?.providerId;

  const backdropUrl = params.backdrop || undefined;
  const videoUrl = params.videoUrl || undefined;
  const fileUri = params.fileUri || undefined;
  const title = params.title || undefined;
  const isLocalPlayback = !!fileUri;
  const startFullscreen = params.fs === "1";
  const startAt = params.startAt
    ? Number(params.startAt)
    : params.t
      ? Number(params.t)
      : 0;

  useEffect(() => {
    trackWatchOpened({
      surface: "direct",
      ...(type ? { mediaType: type } : {}),
    });
  }, [type]);

  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const activeDirectProvider =
    pickedProvider ?? (providerReady ? provider : (routeProvider ?? null));

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const languageAnswered = settings.hasAnsweredLanguagePrompt;

  const isUrlDirectOnly =
    isLocalPlayback || isDirectVideoUrl(videoUrl || "");

  const direct = useDirectStreamPipeline({
    id,
    type,
    isDirectPlayback:
      !isUrlDirectOnly && !!activeDirectProvider && providerReady,
    provider: activeDirectProvider ?? undefined,
    languageAnswered,
    initialSeason: season,
    initialEpisode: episode,
    settingsRef,
  });

  const handleDirectSelected = (selectedId: string) => {
    setPickedProvider(selectedId);
  };

  useEffect(() => {
    if (isUrlDirectOnly || !id || !activeDirectProvider) return;
    if (direct.links.length === 0) return;
    saveLastProvider(type, id, activeDirectProvider).catch(() => {});
  }, [isUrlDirectOnly, id, type, activeDirectProvider, direct.links.length]);

  const { showToast, toastOpacity } = useDoubleBackExit();
  const directVideoUrl = fileUri || videoUrl;

  const earlyPlayerStateRef = useRef<{
    key: string;
    player: VideoPlayer;
    url: string;
  } | null>(null);

  useEffect(() => {
    return () => {
      const held = earlyPlayerStateRef.current;
      if (held) {
        earlyPlayerStateRef.current = null;
        disposeEarlyPlayer(held.key);
      }
    };
  }, []);

  if (
    providerReady &&
    !isUrlDirectOnly &&
    activeDirectProvider &&
    !directVideoUrl &&
    !earlyPlayerStateRef.current &&
    id
  ) {
    const earlyKey = `${type}:${parseInt(id, 10)}:s${season ?? 0}:e${episode ?? 0}:${activeDirectProvider}`;
    const taken = takeEarlyPlayer(earlyKey);
    if (taken) {
      earlyPlayerStateRef.current = {
        key: earlyKey,
        player: taken.player,
        url: taken.url,
      };
    }
  }

  const invalidReportedRef = useRef(false);
  useEffect(() => {
    if ((!id || !type) && !invalidReportedRef.current) {
      invalidReportedRef.current = true;
      trackPlayerError({
        errorClass: "invalid-route",
        surface: "route",
        providerId: "unknown",
        mediaType: "movie",
      });
    }
  }, [id, type]);

  let content: React.ReactNode;

  if (!id || !type) {
    content = (
      <InvalidWatchScreen
        onGoBack={() => nav.goBack({ fallback: "/(tabs)" })}
      />
    );
  } else if (isUrlDirectOnly && directVideoUrl) {
    content = (
      <HevcPlayer
        videoUrl={directVideoUrl}
        tmdbId={Number(id) > 0 ? id : undefined}
        mediaType={type}
        season={season}
        episode={episode}
        startAt={startAt}
        title={title}
        backdropUrl={backdropUrl}
        startFullscreen={startFullscreen}
        offline={isLocalPlayback}
        onClose={() => nav.goBack({ fallback: "/(tabs)" })}
      />
    );
  } else if (!providerReady || !activeDirectProvider) {
    content = (
      <BackdropGate backdropUrl={backdropUrl}>
        <StatusBar barStyle="light-content" hidden />
        <ActivityIndicator size="large" color={colors.gold} />
      </BackdropGate>
    );
  } else if (!languageAnswered) {
    content = (
      <BackdropGate backdropUrl={backdropUrl}>
        <StatusBar barStyle="light-content" hidden />
        <LanguagePromptSheet
          onSelect={(value) => {
            trackFeatureUsed("language_prompt_answered", "watch");
            updateSetting("preferredAudioLanguage", value);
            updateSetting("hasAnsweredLanguagePrompt", true);
          }}
        />
      </BackdropGate>
    );
  } else {
    content = (
      <VideoWebView
        type={type}
        id={id}
        season={season}
        episode={episode}
        initialProvider={activeDirectProvider}
        backdropUrl={backdropUrl}
        title={title}
        startAt={startAt}
        onClose={() => nav.goBack({ fallback: "/(tabs)" })}
        directStream={{
          links: direct.links,
          bestIndex: direct.bestIndex,
          prevalidated: direct.prevalidated,
          selectionReason: direct.selectionReason,
          lastWorkingIndex: direct.lastWorkingIndex,
          loading: direct.loading,
          error: direct.error,
          noPluginsConfigured: direct.noPluginsConfigured,
          stageMessage: direct.stageMessage,
        }}
        onDirectSelected={handleDirectSelected}
        onDirectRetry={direct.refetch}
        onDirectEpisodeChange={(s, e) => {
          direct.setSeason(s);
          direct.setEpisode(e);
        }}
        earlyPlayer={earlyPlayerStateRef.current?.player ?? null}
        earlyPlayerKey={earlyPlayerStateRef.current?.key}
        earlyPlayerUrl={earlyPlayerStateRef.current?.url}
      />
    );
  }

  return (
    <View className="flex-1" style={{ backgroundColor: colors.playerBg }}>
      {content}
      <BackExitToast
        visible={showToast}
        opacity={toastOpacity}
        bottomInset={insets.bottom}
      />
    </View>
  );
}
