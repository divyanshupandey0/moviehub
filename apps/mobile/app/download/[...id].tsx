/**
 * Unified Nuvio Plugin Download Picker.
 *
 * Replaces all legacy per-provider download screens (`hdhub`, `falix`, `nxsha`).
 * Uses `discoverNuvioDownloadCandidates()` to fetch streams from enabled Nuvio
 * plugins, strictly marks direct-file candidates (MP4/MKV/WEBM) as downloadable
 * while clearly flagging stream-only manifests (HLS/DASH), and hands verified
 * downloads to Movie Hub's native `DownloadManager` via `useDownloadTrigger()`.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useSafeNavigation } from "@/lib/navigation";
import { colors } from "../../theme/colors";
import { tmdbApi } from "../../lib/api";
import { EpisodeRail } from "../../components/player/EpisodeRail";
import {
  ALL_NUVIO_PLUGINS_ID,
  discoverNuvioDownloadCandidates,
  extractFilenameFromUrl,
  type DownloadableStreamCandidate,
} from "../../lib/nuvio";
import { useDownloadList, useDownloadTrigger } from "../../lib/download";

export default function NuvioDownloadScreen() {
  const insets = useSafeAreaInsets();
  const nav = useSafeNavigation();
  const params = useLocalSearchParams<{
    id: string[];
    provider?: string;
    poster?: string;
    backdrop?: string;
  }>();

  const segments = params.id ?? [];
  const mediaType = (segments[0] === "tv" ? "tv" : "movie") as "movie" | "tv";
  const tmdbId = segments[1] || "";
  const initialSeason = segments[2] ? Number(segments[2]) : 1;
  const initialEpisode = segments[3] ? Number(segments[3]) : 1;

  const [season, setSeason] = useState(initialSeason);
  const [episode, setEpisode] = useState(initialEpisode);
  const [epPickerOpen, setEpPickerOpen] = useState(false);
  const [title, setTitle] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [noPlugins, setNoPlugins] = useState(false);
  const [candidates, setCandidates] = useState<DownloadableStreamCandidate[]>(
    [],
  );
  const [errors, setErrors] = useState<
    Array<{ pluginName: string; error: string }>
  >([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const { trigger } = useDownloadTrigger();
  const { all } = useDownloadList();

  useEffect(() => {
    if (!tmdbId) return;
    let cancelled = false;
    (mediaType === "tv"
      ? tmdbApi.getTVDetails(tmdbId)
      : tmdbApi.getMovieDetails(tmdbId)
    )
      .then((res: any) => {
        if (cancelled) return;
        const name = res?.title || res?.name || "";
        if (name) setTitle(name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tmdbId, mediaType]);

  useEffect(() => {
    if (!tmdbId) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setErrors([]);

    discoverNuvioDownloadCandidates({
      tmdbId: parseInt(tmdbId, 10),
      mediaType,
      season: mediaType === "tv" ? season : undefined,
      episode: mediaType === "tv" ? episode : undefined,
      pluginKeyOrId: params.provider || ALL_NUVIO_PLUGINS_ID,
      signal: controller.signal,
    })
      .then((res) => {
        if (cancelled) return;
        setCandidates(res.candidates);
        setNoPlugins(res.noPluginsConfigured);
        setErrors(res.errors);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [tmdbId, mediaType, season, episode, params.provider, refreshTick]);

  const handleStartDownload = useCallback(
    async (c: DownloadableStreamCandidate) => {
      if (!c.downloadable) return;
      const ext = c.link.type === "mkv" ? "mkv" : "mp4";
      const baseTitle = title || `TMDB ${tmdbId}`;
      const epSuffix =
        mediaType === "tv"
          ? ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
          : "";
      const fileName = `${baseTitle}${epSuffix} [${c.link.quality || "HD"}].${ext}`.replace(
        /[\\/:*?"<>|]/g,
        "_",
      );

      await trigger(
        {
          tmdbId,
          mediaType,
          title: baseTitle,
          fileName: fileName || extractFilenameFromUrl(c.link.url),
          url: c.link.url,
          server: "nuvio",
          quality: c.link.quality,
          posterPath: params.poster || undefined,
          extension: ext,
          ...(mediaType === "tv" ? { season, episode } : {}),
        },
        {
          sizeBytes: c.link._meta?.sizeBytes,
          badges: [
            c.link.quality,
            c.link.size,
            c.pluginName,
            c.link.type.toUpperCase(),
          ].filter((x): x is string => Boolean(x)),
        },
      );
    },
    [title, tmdbId, mediaType, season, episode, params.poster, params.backdrop, trigger],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => nav.goBack({ fallback: "/(tabs)" })}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title || "Download"}
          </Text>
          <Text style={styles.headerSub}>
            {mediaType === "tv"
              ? `Season ${season} · Episode ${episode} · Nuvio Plugins`
              : "Direct File Downloads · Nuvio Plugins"}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setRefreshTick((t) => t + 1)}
          style={styles.refreshBtn}
        >
          <Ionicons name="refresh" size={18} color={colors.gold} />
        </TouchableOpacity>
      </View>

      {mediaType === "tv" && (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <TouchableOpacity
            onPress={() => setEpPickerOpen(true)}
            style={styles.rowCard}
            activeOpacity={0.75}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.qualityPill}>SELECTED EPISODE</Text>
              <Text style={styles.pluginTag}>
                Season {season} · Episode {episode}
              </Text>
            </View>
            <Ionicons name="chevron-down" size={18} color={colors.gold} />
          </TouchableOpacity>
          <EpisodeRail
            visible={epPickerOpen}
            tvId={tmdbId}
            currentSeason={season}
            currentEpisode={episode}
            onSelect={(s: number, e: number) => {
              setSeason(s);
              setEpisode(e);
              setEpPickerOpen(false);
            }}
            onClose={() => setEpPickerOpen(false)}
          />
        </View>
      )}

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: Math.max(32, insets.bottom + 16),
        }}
      >
        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={colors.gold} />
            <Text style={styles.centerText}>
              Scanning enabled Nuvio plugins for downloadable files…
            </Text>
          </View>
        ) : noPlugins ? (
          <View style={styles.centerBox}>
            <Ionicons
              name="extension-puzzle-outline"
              size={34}
              color={colors.gold}
            />
            <Text style={styles.emptyTitle}>No Nuvio Plugins Enabled</Text>
            <Text style={styles.centerText}>
              Add a Nuvio plugin repository and enable a provider first.
            </Text>
            <TouchableOpacity
              onPress={() => nav.push("/plugins")}
              style={styles.goldBtn}
            >
              <Text style={styles.goldBtnText}>Open Plugins Manager</Text>
            </TouchableOpacity>
          </View>
        ) : candidates.length === 0 ? (
          <View style={styles.centerBox}>
            <Ionicons
              name="cloud-offline-outline"
              size={34}
              color={colors.textTertiary}
            />
            <Text style={styles.emptyTitle}>No Download Sources Found</Text>
            <Text style={styles.centerText}>
              {errors[0]?.error ||
                "Enabled Nuvio plugins returned no streams for this title."}
            </Text>
          </View>
        ) : (
          candidates.map((c, idx) => {
            const existing = all.find(
              (t) => t.url === c.link.url && t.status !== "cancelled",
            );
            return (
              <View key={`${c.link.url}-${idx}`} style={styles.rowCard}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <View style={styles.rowTop}>
                    <Text style={styles.qualityPill}>
                      {c.link.quality || "AUTO"}
                    </Text>
                    <Text style={styles.pluginTag}>{c.pluginName}</Text>
                    {c.link.size && (
                      <Text style={styles.sizeTag}>{c.link.size}</Text>
                    )}
                    <Text style={styles.sizeTag}>
                      {c.link.type.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.streamName} numberOfLines={2}>
                    {c.link.name}
                  </Text>
                  {!c.downloadable && c.reason ? (
                    <Text style={styles.warnText}>{c.reason}</Text>
                  ) : null}
                </View>

                {existing ? (
                  <View style={styles.statusPill}>
                    <Ionicons
                      name={
                        existing.status === "completed"
                          ? "checkmark-circle"
                          : "arrow-down-circle"
                      }
                      size={16}
                      color={colors.gold}
                    />
                    <Text style={styles.statusPillText}>
                      {existing.status === "completed" ? "Saved" : existing.status}
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    disabled={!c.downloadable}
                    onPress={() => void handleStartDownload(c)}
                    style={[
                      styles.dlBtn,
                      !c.downloadable && styles.dlBtnDisabled,
                    ]}
                  >
                    <Ionicons
                      name={
                        c.downloadable ? "download-outline" : "lock-closed-outline"
                      }
                      size={17}
                      color={c.downloadable ? "#000" : colors.textTertiary}
                    />
                  </TouchableOpacity>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgCard,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  headerTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: "700" },
  headerSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(229, 185, 75, 0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerBox: { alignItems: "center", paddingVertical: 56, paddingHorizontal: 24 },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "600",
    marginTop: 12,
  },
  centerText: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 18,
  },
  goldBtn: {
    marginTop: 16,
    backgroundColor: colors.gold,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  goldBtnText: { color: "#000", fontSize: 12, fontWeight: "700" },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 13,
    marginBottom: 9,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  qualityPill: {
    color: colors.gold,
    fontSize: 11,
    fontWeight: "700",
  },
  pluginTag: { color: colors.textPrimary, fontSize: 11, fontWeight: "600" },
  sizeTag: { color: colors.textTertiary, fontSize: 11 },
  streamName: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 17,
  },
  warnText: { color: "#F59E0B", fontSize: 10, marginTop: 4 },
  dlBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  dlBtnDisabled: {
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "rgba(229, 185, 75, 0.14)",
  },
  statusPillText: { color: colors.gold, fontSize: 11, fontWeight: "600" },
});
