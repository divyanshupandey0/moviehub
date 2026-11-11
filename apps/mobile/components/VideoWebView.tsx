/**
 * VideoWebView — Unified Nuvio Direct Playback Host for Movie Hub Mobile.
 *
 * Replaces all legacy WebView embed waterfalls and hardcoded providers.
 * Coordinates:
 * - Nuvio plugin discovery results passed in via `directStream`
 * - Native Media3/ExoPlayer rendering via `<HevcPlayer />` wrapped in `<ErrorBoundary>`
 * - Episode rail, plugin switcher, and stream/quality selector via `<PlayerHub />`
 * - `<ServerPickerSheet />` for switching between `All Enabled Plugins` or a specific plugin
 * - Explicit actionable states for "No Plugins Enabled" and playback failures (never black-screen)
 */

import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeNavigation } from "@/lib/navigation";
import { useKeepAwake } from "expo-keep-awake";
import type { VideoPlayer } from "expo-video";
import type { ProviderDefinition } from "@filmsnaps/shared";
import { colors } from "../theme/colors";
import { useSettings } from "../lib/settings";
import { tmdbApi } from "../lib/api";
import { getNextEpisode } from "../lib/tvUtils";
import {
  ALL_NUVIO_PLUGINS_ID,
  useNuvioPlugins,
  usePluginDiagnostics,
} from "../lib/nuvio";
import { ServerPickerSheet } from "./player/ServerPickerSheet";
import { PlayerHub } from "./player/PlayerHub";
import { HevcPlayer } from "./HevcPlayer";
import { ErrorBoundary } from "./ErrorBoundary";
import type { StreamLink } from "./player/streamTypes";
import type { ValidationResult, ProbeOutcome } from "../lib/streamValidator";
import type { IntroDbResponse } from "../lib/introDetect";

export interface VideoWebViewProps {
  type: "movie" | "tv";
  id: string;
  season?: number;
  episode?: number;
  initialProvider?: string;
  backdropUrl?: string;
  isAnime?: boolean;
  animeMalId?: number;
  animeAnilistId?: number | null;
  animeAudio?: "sub" | "dub";
  onAnimeAudioChange?: (audio: "sub" | "dub") => void;
  onClose: () => void;
  title?: string;
  startAt?: number;
  directStream?: {
    links: StreamLink[];
    bestIndex: number;
    prevalidated: Map<string, ValidationResult> | null;
    selectionReason: string;
    lastWorkingIndex?: number;
    loading: boolean;
    error: string | null;
    noPluginsConfigured?: boolean;
    stageMessage?: string | null;
  };
  onDirectSelected?: (providerId: string) => void;
  onDirectRetry?: () => void;
  nativeIntroSegments?: IntroDbResponse | null;
  onDirectEpisodeChange?: (season: number, episode: number) => void;
  earlyPlayer?: VideoPlayer | null;
  earlyPlayerKey?: string;
  earlyPlayerUrl?: string;
}

export function VideoWebView({
  type,
  id,
  season,
  episode,
  initialProvider,
  backdropUrl,
  isAnime = false,
  onClose,
  title,
  startAt = 0,
  directStream,
  onDirectSelected,
  onDirectRetry,
  nativeIntroSegments,
  onDirectEpisodeChange,
  earlyPlayer,
  earlyPlayerKey,
  earlyPlayerUrl,
}: VideoWebViewProps) {
  useKeepAwake();
  const nav = useSafeNavigation();
  const { settings } = useSettings();
  const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = useWindowDimensions();
  const isPhysicalLandscape = SCREEN_WIDTH > SCREEN_HEIGHT;
  const isTV = type === "tv";

  const { getEnabledPlugins } = useNuvioPlugins();
  const diagnostics = usePluginDiagnostics();
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const [providerId, setProviderId] = useState<string>(
    initialProvider || ALL_NUVIO_PLUGINS_ID,
  );
  useEffect(() => {
    if (initialProvider && initialProvider !== providerId) {
      setProviderId(initialProvider);
    }
  }, [initialProvider]);

  const [currentSeason, setCurrentSeason] = useState<number>(season || 1);
  const [currentEpisode, setCurrentEpisode] = useState<number>(episode || 1);
  useEffect(() => {
    if (season != null) setCurrentSeason(season);
  }, [season]);
  useEffect(() => {
    if (episode != null) setCurrentEpisode(episode);
  }, [episode]);

  const [directFullscreen, setDirectFullscreen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [directNextEp, setDirectNextEp] = useState<{
    season: number;
    episode: number;
  } | null>(null);
  const [directSourceApi, setDirectSourceApi] = useState<{
    getLinks: () => StreamLink[];
    getActiveIndex: () => number;
    getStatuses: () => Record<number, ProbeOutcome>;
    getRecommendedIndex: () => number;
    getLastUsedIndex: () => number | undefined;
    select: (index: number) => void;
  } | null>(null);

  // Discover next episode for TV series so HevcPlayer's "Next Episode" stays active
  useEffect(() => {
    if (!isTV || !id) {
      setDirectNextEp(null);
      return;
    }
    let cancelled = false;
    getNextEpisode(id, currentSeason, currentEpisode)
      .then((res) => {
        if (cancelled) return;
        if (res.hasNext) {
          setDirectNextEp({
            season: res.nextSeason,
            episode: res.nextEpisode,
          });
        } else {
          setDirectNextEp(null);
        }
      })
      .catch(() => {
        if (!cancelled) setDirectNextEp(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isTV, id, currentSeason, currentEpisode]);

  const [resolvedTitle, setResolvedTitle] = useState<string | undefined>(title);
  useEffect(() => {
    if (title) {
      setResolvedTitle(title);
      return;
    }
    if (!id) return;
    let cancelled = false;
    (isTV ? tmdbApi.getTVDetails(id) : tmdbApi.getMovieDetails(id))
      .then((res: any) => {
        if (cancelled) return;
        const name = res?.title || res?.name;
        if (typeof name === "string" && name.trim()) {
          setResolvedTitle(name.trim());
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, isTV, title]);

  // Build dynamic server list solely from installed & enabled Nuvio plugins
  const providers: ProviderDefinition[] = useMemo(() => {
    const enabledPlugins = getEnabledPlugins(type);
    const items: ProviderDefinition[] = [
      {
        id: ALL_NUVIO_PLUGINS_ID,
        name: "All Enabled Plugins",
        displayName: "All Enabled Plugins (Auto)",
        note:
          enabledPlugins.length > 0
            ? `Aggregates ${enabledPlugins.length} enabled plugin${enabledPlugins.length > 1 ? "s" : ""}`
            : "No plugins enabled",
        baseUrl: "nuvio://all",
        type: "direct",
      },
      ...enabledPlugins.map((p): ProviderDefinition => {
        const metaParts = [
          p.formats.length > 0 ? p.formats.join("/").toUpperCase() : null,
          p.contentLanguage.length > 0
            ? p.contentLanguage.join(", ").toUpperCase()
            : null,
        ].filter(Boolean);
        return {
          id: p.pluginKey,
          name: p.name,
          displayName: p.name,
          note: metaParts.join(" · ") || `v${p.version}`,
          baseUrl: p.repoUrl,
          type: "direct",
        };
      }),
    ];
    return items;
  }, [getEnabledPlugins, type]);

  const activeProviderDef = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

  const getProviderDisplayName = useCallback(
    (p: ProviderDefinition) => p.displayName || p.name || p.id,
    [],
  );

  const switchProvider = useCallback(
    (nextId: string) => {
      setShowPicker(false);
      setProviderId(nextId);
      onDirectSelected?.(nextId);
    },
    [onDirectSelected],
  );

  const tryNextProvider = useCallback(() => {
    if (providers.length <= 1) return;
    const idx = providers.findIndex((p) => p.id === providerId);
    const next = providers[(idx + 1) % providers.length];
    if (next && next.id !== providerId) {
      switchProvider(next.id);
    }
  }, [providers, providerId, switchProvider]);

  const openPluginsManager = useCallback(() => {
    nav.push("/plugins");
  }, [nav]);

  const playerBoxStyle =
    directFullscreen || isPhysicalLandscape
      ? { flex: 1 as const }
      : {
          width: "100%" as const,
          height: Math.min(
            Math.round(SCREEN_WIDTH * (9 / 16)),
            Math.round(SCREEN_HEIGHT * 0.45),
          ),
          justifyContent: "center" as const,
          alignItems: "center" as const,
          backgroundColor: colors.playerBg,
        };

  return (
    <View className="flex-1" style={{ backgroundColor: colors.playerBg }}>
      {/* Nuvio Plugin Switcher Sheet */}
      <ServerPickerSheet
        visible={showPicker}
        providers={providers}
        currentId={providerId}
        onSelect={switchProvider}
        onClose={() => setShowPicker(false)}
        getDisplayName={getProviderDisplayName}
      />

      {/* 16:9 / Fullscreen Video Surface */}
      <View style={playerBoxStyle}>
        {directStream?.loading ? (
          <View className="flex-1 items-center justify-center px-6">
            <ActivityIndicator size="large" color={colors.gold} />
            <Text
              className="text-sm mt-4 text-center"
              style={{ color: colors.textSecondary }}
            >
              {directStream.stageMessage || "Finding streams via Nuvio plugins…"}
            </Text>
            {providers.length > 1 && (
              <TouchableOpacity
                onPress={() => setShowPicker(true)}
                className="rounded-xl py-2.5 px-4 mt-5 flex-row items-center"
                style={{
                  backgroundColor: colors.bgSurface,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="layers-outline"
                  size={14}
                  color={colors.textSecondary}
                />
                <Text
                  className="text-xs ml-2 font-semibold"
                  style={{ color: colors.textSecondary }}
                >
                  Select Plugin
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : directStream?.noPluginsConfigured ? (
          <View className="flex-1 items-center justify-center px-8">
            <View
              className="w-14 h-14 rounded-2xl items-center justify-center mb-4 border"
              style={{
                backgroundColor: "rgba(229, 185, 75, 0.12)",
                borderColor: "rgba(229, 185, 75, 0.35)",
              }}
            >
              <Ionicons
                name="extension-puzzle-outline"
                size={28}
                color={colors.gold}
              />
            </View>
            <Text
              className="text-base font-bold mb-1.5 text-center"
              style={{ color: colors.textPrimary }}
            >
              No Nuvio Plugins Enabled
            </Text>
            <Text
              className="text-xs mb-5 text-center leading-5 max-w-xs"
              style={{ color: colors.textSecondary }}
            >
              Add a Nuvio plugin repository and enable at least one provider in
              Settings to discover streams.
            </Text>
            <View className="flex-row gap-2.5">
              <TouchableOpacity
                onPress={openPluginsManager}
                className="rounded-xl py-2.5 px-4 flex-row items-center"
                style={{ backgroundColor: colors.gold }}
                activeOpacity={0.85}
              >
                <Ionicons name="add-circle-outline" size={16} color={colors.bg} />
                <Text
                  className="font-bold text-xs ml-1.5"
                  style={{ color: colors.bg }}
                >
                  Open Plugins Manager
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onDirectRetry}
                className="rounded-xl py-2.5 px-4 flex-row items-center border"
                style={{
                  backgroundColor: colors.bgCard,
                  borderColor: colors.borderSubtle,
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="refresh" size={14} color={colors.textPrimary} />
                <Text
                  className="font-bold text-xs ml-1.5"
                  style={{ color: colors.textPrimary }}
                >
                  Retry
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : directStream?.error ||
          !directStream ||
          directStream.links.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <View
              className="w-14 h-14 rounded-2xl items-center justify-center mb-4 border"
              style={{
                backgroundColor: "rgba(239, 68, 68, 0.12)",
                borderColor: "rgba(239, 68, 68, 0.3)",
              }}
            >
              <Ionicons name="alert-circle" size={28} color={colors.error} />
            </View>
            <Text
              className="text-sm mb-5 text-center leading-5 max-w-xs"
              style={{ color: colors.textSecondary }}
            >
              {directStream?.error ||
                "No valid streams found from enabled Nuvio plugins. Try switching plugins or retrying."}
            </Text>
            <View
              className="flex-row gap-2.5"
              style={{ flexWrap: "wrap", justifyContent: "center" }}
            >
              <TouchableOpacity
                onPress={onDirectRetry}
                className="rounded-xl py-2.5 px-4 flex-row items-center"
                style={{ backgroundColor: colors.gold }}
                activeOpacity={0.8}
              >
                <Ionicons name="refresh" size={14} color={colors.bg} />
                <Text
                  className="font-bold text-xs ml-1.5"
                  style={{ color: colors.bg }}
                >
                  Retry
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setShowPicker(true)}
                className="rounded-xl py-2.5 px-4 flex-row items-center border"
                style={{
                  backgroundColor: colors.bgCard,
                  borderColor: colors.borderSubtle,
                }}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="extension-puzzle-outline"
                  size={14}
                  color={colors.textSecondary}
                />
                <Text
                  className="font-bold text-xs ml-1.5"
                  style={{ color: colors.textSecondary }}
                >
                  Switch Provider
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={openPluginsManager}
                className="rounded-xl py-2.5 px-4 flex-row items-center border"
                style={{
                  backgroundColor: colors.bgSurface,
                  borderColor: colors.borderSubtle,
                }}
                activeOpacity={0.8}
              >
                <Text
                  className="font-bold text-xs"
                  style={{ color: colors.textSecondary }}
                >
                  Manage Repositories
                </Text>
              </TouchableOpacity>
              {diagnostics.length > 0 && (
                <TouchableOpacity
                  onPress={() => setShowDiagnostics(true)}
                  className="rounded-xl py-2.5 px-3 flex-row items-center border"
                  style={{
                    backgroundColor: colors.bgSurface,
                    borderColor: colors.borderSubtle,
                  }}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name="pulse-outline"
                    size={13}
                    color={colors.gold}
                  />
                  <Text
                    className="font-bold text-xs ml-1"
                    style={{ color: colors.gold }}
                  >
                    Diagnostics
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <Modal
              visible={showDiagnostics}
              transparent
              animationType="slide"
              onRequestClose={() => setShowDiagnostics(false)}
            >
              <View
                style={{
                  flex: 1,
                  backgroundColor: "rgba(0,0,0,0.72)",
                  justifyContent: "flex-end",
                }}
              >
                <View
                  style={{
                    backgroundColor: colors.bgCard,
                    borderTopLeftRadius: 18,
                    borderTopRightRadius: 18,
                    padding: 16,
                    maxHeight: "72%",
                    borderTopWidth: 1,
                    borderColor: colors.border,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      marginBottom: 10,
                    }}
                  >
                    <Text
                      style={{
                        flex: 1,
                        color: colors.textPrimary,
                        fontSize: 15,
                        fontWeight: "700",
                      }}
                    >
                      Provider Diagnostics ({diagnostics.length})
                    </Text>
                    <TouchableOpacity onPress={() => setShowDiagnostics(false)}>
                      <Ionicons
                        name="close"
                        size={20}
                        color={colors.textSecondary}
                      />
                    </TouchableOpacity>
                  </View>
                  <ScrollView showsVerticalScrollIndicator={false}>
                    {diagnostics.slice(0, 40).map((d) => (
                      <View
                        key={d.pluginKey}
                        style={{
                          paddingVertical: 8,
                          borderBottomWidth: 1,
                          borderBottomColor: colors.border,
                        }}
                      >
                        <Text
                          style={{
                            color: colors.textPrimary,
                            fontSize: 12,
                            fontWeight: "700",
                          }}
                        >
                          {d.providerName} · {d.repositoryName}
                        </Text>
                        <Text
                          style={{
                            color: colors.textSecondary,
                            fontSize: 11,
                            marginTop: 2,
                          }}
                        >
                          Init: {d.initStatus} | Req: {d.requestStatus} | Sources:{" "}
                          {d.sourcesReturned}
                          {d.responseTimeMs != null
                            ? ` | ${d.responseTimeMs}ms`
                            : ""}
                          {d.playbackHandoffStatus !== "not_started"
                            ? ` | Handoff: ${d.playbackHandoffStatus}`
                            : ""}
                        </Text>
                        {d.compatibilityError ? (
                          <Text
                            style={{
                              color: colors.error,
                              fontSize: 11,
                              marginTop: 2,
                            }}
                          >
                            Compat: {d.compatibilityError}
                          </Text>
                        ) : null}
                        {d.parsingError ? (
                          <Text
                            style={{
                              color: colors.error,
                              fontSize: 11,
                              marginTop: 2,
                            }}
                          >
                            Error: {d.parsingError}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                  </ScrollView>
                </View>
              </View>
            </Modal>
          </View>
        ) : (
          <ErrorBoundary
            fallback={
              <View
                className="flex-1 items-center justify-center px-8"
                style={{ backgroundColor: "#000" }}
              >
                <Ionicons
                  name="alert-circle"
                  size={32}
                  color={colors.error}
                />
                <Text
                  className="text-base font-semibold mt-3 mb-1.5 text-center"
                  style={{ color: colors.textPrimary }}
                >
                  Playback Error
                </Text>
                <Text
                  className="text-xs mb-5 text-center leading-5 max-w-xs"
                  style={{ color: colors.textSecondary }}
                >
                  An error occurred rendering this stream. Please select another
                  source or retry.
                </Text>
                <View className="flex-row gap-2.5">
                  <TouchableOpacity
                    onPress={onDirectRetry}
                    className="rounded-xl py-2.5 px-4 flex-row items-center"
                    style={{ backgroundColor: colors.gold }}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="refresh" size={14} color={colors.bg} />
                    <Text
                      className="font-bold text-xs ml-1.5"
                      style={{ color: colors.bg }}
                    >
                      Retry
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setShowPicker(true)}
                    className="rounded-xl py-2.5 px-4 flex-row items-center border"
                    style={{
                      backgroundColor: colors.bgCard,
                      borderColor: colors.borderSubtle,
                    }}
                    activeOpacity={0.8}
                  >
                    <Text
                      className="font-bold text-xs"
                      style={{ color: colors.textSecondary }}
                    >
                      All Plugins
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            }
          >
            <HevcPlayer
              links={directStream.links}
              defaultIndex={directStream.bestIndex}
              prevalidatedResults={directStream.prevalidated}
              selectionReason={directStream.selectionReason}
              lastWorkingIndex={directStream.lastWorkingIndex}
              preferredLanguage={settings.preferredAudioLanguage ?? "auto"}
              providerDisplayName={
                activeProviderDef
                  ? getProviderDisplayName(activeProviderDef)
                  : "Nuvio Plugin"
              }
              tmdbId={id}
              mediaType={type}
              season={isTV ? currentSeason : undefined}
              episode={isTV ? currentEpisode : undefined}
              isAnime={isAnime}
              title={resolvedTitle}
              backdropUrl={backdropUrl}
              startAt={startAt}
              introSegments={nativeIntroSegments ?? null}
              nextEpisode={isTV ? directNextEp : null}
              onNextEpisode={(s, e) => {
                setCurrentSeason(s);
                setCurrentEpisode(e);
                onDirectEpisodeChange?.(s, e);
              }}
              onFullscreenChange={setDirectFullscreen}
              externalFullscreen={directFullscreen}
              onRegisterSourceApi={setDirectSourceApi}
              onClose={onClose}
              onExhausted={tryNextProvider}
              onTryProvider={() => setShowPicker(true)}
              externalPlayer={earlyPlayer ?? undefined}
              earlyPlayerKey={earlyPlayerKey}
              earlyPlayerUrl={earlyPlayerUrl}
            />
          </ErrorBoundary>
        )}
      </View>

      {/* Portrait PlayerHub: Episodes + Nuvio Plugins + Sources/Qualities */}
      {!directFullscreen && !isPhysicalLandscape && (
        <PlayerHub
          showEpisodes={isTV}
          tvId={isTV ? id : null}
          currentSeason={currentSeason}
          currentEpisode={currentEpisode}
          onSelectEpisode={(s, e) => {
            if (s !== currentSeason || e !== currentEpisode) {
              setCurrentSeason(s);
              setCurrentEpisode(e);
              onDirectEpisodeChange?.(s, e);
            }
          }}
          providers={providers}
          currentProviderId={providerId}
          getProviderName={getProviderDisplayName}
          onSelectProvider={switchProvider}
          sourceApi={directSourceApi}
        />
      )}
    </View>
  );
}
