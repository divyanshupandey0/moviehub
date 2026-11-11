/**
 * Nuvio Plugins & Repositories Manager
 *
 * Allows managing third-party Nuvio plugin repositories (`manifest.json`),
 * installing/updating/removing plugins, toggling enable/disable, inspecting status,
 * and configuring plugin-specific `onSettings()` schemas.
 */

import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  Modal,
  StyleSheet,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeNavigation } from "@/lib/navigation";
import {
  useNuvioPlugins,
  usePluginDiagnostics,
  type InstalledPlugin,
  type NuvioRepository,
  type NuvioSettingField,
} from "../lib/nuvio";

const THEME = {
  bg: "#080808",
  card: "#141414",
  surface: "#1C1C1F",
  border: "rgba(255, 255, 255, 0.08)",
  gold: "#E5B94B",
  goldMuted: "rgba(229, 185, 75, 0.14)",
  textPrimary: "#FFFFFF",
  textSecondary: "#A1A1AA",
  textTertiary: "#71717A",
  error: "#EF4444",
  success: "#22C55E",
};

function formatDate(ts: number): string {
  if (!ts) return "Never";
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "Recently";
  }
}

export default function PluginsScreen() {
  const insets = useSafeAreaInsets();
  const nav = useSafeNavigation();

  const {
    loaded,
    repos,
    plugins,
    syncingRepoIds,
    addRepository,
    removeRepository,
    refreshRepository,
    refreshAllRepositories,
    setPluginEnabled,
    updatePlugin,
    updateAllPlugins,
    removePlugin,
    getPluginSettings,
    updatePluginSetting,
    fetchPluginSettingsSchema,
  } = useNuvioPlugins();

  const [repoInput, setRepoInput] = useState("");
  const [addingRepo, setAddingRepo] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [busyPluginKey, setBusyPluginKey] = useState<string | null>(null);

  // Per-plugin settings modal state
  const [settingsTarget, setSettingsTarget] = useState<InstalledPlugin | null>(
    null,
  );
  const [settingsSchema, setSettingsSchema] = useState<NuvioSettingField[]>([]);
  const [loadingSchema, setLoadingSchema] = useState(false);

  // Developer diagnostics modal state
  const diagnostics = usePluginDiagnostics();
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const updatesAvailableCount = plugins.filter(
    (p) => !!p.updateAvailableVersion,
  ).length;
  const enabledCount = plugins.filter((p) => p.enabled).length;

  const handleAddRepo = useCallback(async () => {
    const trimmed = repoInput.trim();
    if (!trimmed) {
      Alert.alert(
        "Repository URL Required",
        "Enter a Nuvio repository URL or manifest.json link.",
      );
      return;
    }
    setAddingRepo(true);
    try {
      const res = await addRepository(trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
      setRepoInput("");
      const compatNote =
        res.incompatibleCount > 0
          ? `\n\n${res.compatibleCount} compatible · ${res.incompatibleCount} incompatible auto-disabled (${res.incompatibleNames.slice(0, 4).join(", ")}${res.incompatibleNames.length > 4 ? "…" : ""}).`
          : ` All ${res.compatibleCount} provider(s) verified compatible.`;
      Alert.alert(
        res.incompatibleCount > 0
          ? "Repository Added (Partial Compatibility)"
          : "Repository Added",
        `${res.repo.name} (v${res.repo.version}) synced.${compatNote}`,
      );
    } catch (err) {
      Alert.alert(
        "Invalid Repository",
        err instanceof Error ? err.message : "Could not load repository.",
      );
    } finally {
      setAddingRepo(false);
    }
  }, [repoInput, addRepository]);

  const handleRemoveRepo = useCallback(
    (repo: NuvioRepository) => {
      Alert.alert(
        "Remove Repository",
        `Remove "${repo.name}" and all ${repo.pluginCount} plugin(s) from this repository?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => {
              void removeRepository(repo.id);
            },
          },
        ],
      );
    },
    [removeRepository],
  );

  const handleRefreshRepo = useCallback(
    async (repoId: string) => {
      try {
        const res = await refreshRepository(repoId);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        if (res.addedCount > 0 || res.updatesFound > 0) {
          Alert.alert(
            "Repository Synced",
            `New plugins: ${res.addedCount} · Updates available: ${res.updatesFound}`,
          );
        }
      } catch (err) {
        Alert.alert(
          "Sync Failed",
          err instanceof Error ? err.message : "Could not refresh repository.",
        );
      }
    },
    [refreshRepository],
  );

  const handleRefreshAll = useCallback(async () => {
    setRefreshingAll(true);
    try {
      await refreshAllRepositories();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshAllRepositories]);

  const handleTogglePlugin = useCallback(
    async (plugin: InstalledPlugin, nextVal: boolean) => {
      setBusyPluginKey(plugin.pluginKey);
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        await setPluginEnabled(plugin.pluginKey, nextVal);
      } catch (err) {
        Alert.alert(
          "Plugin Error",
          err instanceof Error
            ? err.message
            : "Could not download or enable this plugin.",
        );
      } finally {
        setBusyPluginKey(null);
      }
    },
    [setPluginEnabled],
  );

  const handleUpdatePlugin = useCallback(
    async (plugin: InstalledPlugin) => {
      setBusyPluginKey(plugin.pluginKey);
      try {
        await updatePlugin(plugin.pluginKey);
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
      } catch (err) {
        Alert.alert(
          "Update Failed",
          err instanceof Error ? err.message : "Could not update plugin.",
        );
      } finally {
        setBusyPluginKey(null);
      }
    },
    [updatePlugin],
  );

  const handleRemovePlugin = useCallback(
    (plugin: InstalledPlugin) => {
      Alert.alert(
        "Remove Plugin",
        `Remove "${plugin.name}" from Movie Hub?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => {
              void removePlugin(plugin.pluginKey);
            },
          },
        ],
      );
    },
    [removePlugin],
  );

  const handleOpenPluginSettings = useCallback(
    async (plugin: InstalledPlugin) => {
      setSettingsTarget(plugin);
      setSettingsSchema([]);
      setLoadingSchema(true);
      try {
        const schema = await fetchPluginSettingsSchema(plugin.pluginKey);
        setSettingsSchema(schema);
      } finally {
        setLoadingSchema(false);
      }
    },
    [fetchPluginSettingsSchema],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => nav.goBack({ fallback: "/(tabs)/settings" })}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={22} color={THEME.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Nuvio Plugins</Text>
          <Text style={styles.headerSub}>
            {repos.length} {repos.length === 1 ? "repository" : "repositories"} ·{" "}
            {enabledCount}/{plugins.length} active
          </Text>
        </View>
        {diagnostics.length > 0 && (
          <TouchableOpacity
            onPress={() => setShowDiagnostics(true)}
            style={[styles.refreshHeaderBtn, { marginRight: 6 }]}
            activeOpacity={0.75}
          >
            <Ionicons name="pulse-outline" size={18} color={THEME.gold} />
          </TouchableOpacity>
        )}
        {repos.length > 0 && (
          <TouchableOpacity
            onPress={handleRefreshAll}
            disabled={refreshingAll}
            style={styles.refreshHeaderBtn}
            activeOpacity={0.75}
          >
            {refreshingAll ? (
              <ActivityIndicator size="small" color={THEME.gold} />
            ) : (
              <Ionicons name="refresh" size={18} color={THEME.gold} />
            )}
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: Math.max(32, insets.bottom + 16),
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Add Repository Card */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>ADD REPOSITORY</Text>
          <Text style={styles.helperText}>
            Paste a Nuvio repository URL or direct manifest.json link (e.g. from
            GitHub raw URLs).
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              value={repoInput}
              onChangeText={setRepoInput}
              placeholder="https://raw.githubusercontent.com/.../manifest.json"
              placeholderTextColor={THEME.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            <TouchableOpacity
              onPress={handleAddRepo}
              disabled={addingRepo}
              style={[styles.addBtn, addingRepo && { opacity: 0.6 }]}
              activeOpacity={0.85}
            >
              {addingRepo ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Text style={styles.addBtnText}>Add</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Bulk Update Banner */}
        {updatesAvailableCount > 0 && (
          <TouchableOpacity
            onPress={() => void updateAllPlugins()}
            style={styles.updateBanner}
            activeOpacity={0.85}
          >
            <Ionicons name="arrow-up-circle" size={20} color={THEME.gold} />
            <Text style={styles.updateBannerText}>
              {updatesAvailableCount} plugin update
              {updatesAvailableCount > 1 ? "s" : ""} available — Tap to update
              all
            </Text>
          </TouchableOpacity>
        )}

        {/* Repositories List */}
        <Text style={[styles.sectionLabel, { marginTop: 18, marginBottom: 8 }]}>
          REPOSITORIES ({repos.length})
        </Text>
        {!loaded ? (
          <ActivityIndicator
            size="small"
            color={THEME.gold}
            style={{ marginVertical: 16 }}
          />
        ) : repos.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons
              name="git-branch-outline"
              size={28}
              color={THEME.textTertiary}
            />
            <Text style={styles.emptyTitle}>No Repositories Added</Text>
            <Text style={styles.emptyDesc}>
              Add a Nuvio-compatible manifest repository above to discover and
              enable streaming providers.
            </Text>
          </View>
        ) : (
          repos.map((repo) => {
            const syncing =
              syncingRepoIds.includes(repo.id) || repo.status === "syncing";
            const statusColor =
              repo.status === "error"
                ? THEME.error
                : syncing
                  ? THEME.gold
                  : THEME.success;
            return (
              <View key={repo.id} style={styles.repoCard}>
                <View style={styles.repoHeader}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={styles.repoName}>{repo.name}</Text>
                    <Text style={styles.repoUrl} numberOfLines={1}>
                      {repo.manifestUrl}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      { borderColor: statusColor + "55" },
                    ]}
                  >
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusColor },
                      ]}
                    />
                    <Text style={[styles.statusText, { color: statusColor }]}>
                      {syncing
                        ? "Syncing"
                        : repo.status === "error"
                          ? "Error"
                          : "Synced"}
                    </Text>
                  </View>
                </View>

                {repo.lastError ? (
                  <Text style={styles.errorText}>{repo.lastError}</Text>
                ) : null}

                <View style={styles.repoFooter}>
                  <Text style={styles.repoMeta}>
                    v{repo.version} · {repo.pluginCount} plugins · Updated{" "}
                    {formatDate(repo.lastUpdatedAt)}
                  </Text>
                  <View style={styles.repoActions}>
                    <TouchableOpacity
                      onPress={() => void handleRefreshRepo(repo.id)}
                      disabled={syncing}
                      style={styles.iconActionBtn}
                    >
                      {syncing ? (
                        <ActivityIndicator size="small" color={THEME.gold} />
                      ) : (
                        <Ionicons name="refresh" size={16} color={THEME.gold} />
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleRemoveRepo(repo)}
                      style={styles.iconActionBtn}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={16}
                        color={THEME.error}
                      />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })
        )}

        {/* Installed Plugins */}
        <Text style={[styles.sectionLabel, { marginTop: 22, marginBottom: 8 }]}>
          INSTALLED PLUGINS ({plugins.length})
        </Text>
        {plugins.length === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons
              name="extension-puzzle-outline"
              size={28}
              color={THEME.textTertiary}
            />
            <Text style={styles.emptyTitle}>No Plugins Installed</Text>
            <Text style={styles.emptyDesc}>
              Plugins from added repositories will appear here. Enable only the
              providers you want to use.
            </Text>
          </View>
        ) : (
          plugins.map((plugin) => {
            const busy = busyPluginKey === plugin.pluginKey;
            return (
              <View key={plugin.pluginKey} style={styles.pluginCard}>
                <View style={styles.pluginTop}>
                  {plugin.logo ? (
                    <Image
                      source={{ uri: plugin.logo }}
                      style={styles.pluginLogo}
                    />
                  ) : (
                    <View style={styles.pluginLogoFallback}>
                      <Ionicons
                        name="extension-puzzle"
                        size={18}
                        color={THEME.gold}
                      />
                    </View>
                  )}

                  <View style={{ flex: 1, marginLeft: 12, marginRight: 8 }}>
                    <View style={styles.pluginTitleRow}>
                      <Text style={styles.pluginName} numberOfLines={1}>
                        {plugin.name}
                      </Text>
                      <Text style={styles.pluginVersion}>v{plugin.version}</Text>
                      {plugin.compatible === false && (
                        <View
                          style={{
                            marginLeft: 6,
                            paddingHorizontal: 6,
                            paddingVertical: 1,
                            borderRadius: 4,
                            backgroundColor: "rgba(239, 68, 68, 0.16)",
                          }}
                        >
                          <Text
                            style={{
                              color: THEME.error,
                              fontSize: 10,
                              fontWeight: "700",
                            }}
                          >
                            INCOMPATIBLE
                          </Text>
                        </View>
                      )}
                    </View>
                    {plugin.incompatibilityReason ? (
                      <Text style={styles.errorText} numberOfLines={2}>
                        {plugin.incompatibilityReason}
                      </Text>
                    ) : plugin.description ? (
                      <Text style={styles.pluginDesc} numberOfLines={2}>
                        {plugin.description}
                      </Text>
                    ) : null}
                  </View>

                  {busy ? (
                    <ActivityIndicator size="small" color={THEME.gold} />
                  ) : (
                    <Switch
                      value={plugin.enabled}
                      disabled={plugin.compatible === false}
                      onValueChange={(val) =>
                        void handleTogglePlugin(plugin, val)
                      }
                      trackColor={{ false: "#27272A", true: THEME.goldMuted }}
                      thumbColor={plugin.enabled ? THEME.gold : "#71717A"}
                    />
                  )}
                </View>

                <View style={styles.pluginMetaRow}>
                  <View style={styles.badgesWrap}>
                    {plugin.supportedTypes.map((t) => (
                      <View key={t} style={styles.chip}>
                        <Text style={styles.chipText}>
                          {t === "tv" ? "Series" : "Movie"}
                        </Text>
                      </View>
                    ))}
                    {plugin.formats.slice(0, 3).map((fmt) => (
                      <View key={fmt} style={styles.chip}>
                        <Text style={styles.chipText}>{fmt.toUpperCase()}</Text>
                      </View>
                    ))}
                    {plugin.contentLanguage.slice(0, 3).map((lang) => (
                      <View key={lang} style={styles.chip}>
                        <Text style={styles.chipText}>
                          {lang.toUpperCase()}
                        </Text>
                      </View>
                    ))}
                  </View>

                  <View style={styles.pluginActions}>
                    {plugin.updateAvailableVersion && (
                      <TouchableOpacity
                        onPress={() => void handleUpdatePlugin(plugin)}
                        style={styles.updatePill}
                      >
                        <Ionicons
                          name="arrow-up-circle-outline"
                          size={13}
                          color="#000"
                        />
                        <Text style={styles.updatePillText}>
                          v{plugin.updateAvailableVersion}
                        </Text>
                      </TouchableOpacity>
                    )}
                    {plugin.hasSettings && (
                      <TouchableOpacity
                        onPress={() => void handleOpenPluginSettings(plugin)}
                        style={styles.iconActionBtn}
                      >
                        <Ionicons
                          name="settings-outline"
                          size={16}
                          color={THEME.textSecondary}
                        />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      onPress={() => handleRemovePlugin(plugin)}
                      style={styles.iconActionBtn}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={16}
                        color={THEME.textTertiary}
                      />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Dynamic Plugin onSettings() Configuration Modal */}
      <Modal
        visible={!!settingsTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setSettingsTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.modalSheet,
              { paddingBottom: Math.max(24, insets.bottom + 12) },
            ]}
          >
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  {settingsTarget?.name} Settings
                </Text>
                <Text style={styles.modalSub}>
                  Scoped only to this Nuvio plugin
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setSettingsTarget(null)}
                style={styles.iconActionBtn}
              >
                <Ionicons name="close" size={20} color={THEME.textSecondary} />
              </TouchableOpacity>
            </View>

            {loadingSchema ? (
              <ActivityIndicator
                size="small"
                color={THEME.gold}
                style={{ marginVertical: 28 }}
              />
            ) : settingsSchema.length === 0 ? (
              <Text style={styles.emptyDesc}>
                No configurable fields returned by this plugin.
              </Text>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false}>
                {settingsTarget &&
                  settingsSchema.map((field, i) => {
                    const savedValues = getPluginSettings(
                      settingsTarget.pluginKey,
                    );
                    if (field.type === "header") {
                      return (
                        <Text key={i} style={styles.schemaHeader}>
                          {field.label}
                        </Text>
                      );
                    }
                    if (field.type === "info") {
                      return (
                        <Text key={i} style={styles.schemaInfo}>
                          {field.label}
                        </Text>
                      );
                    }
                    if (!field.key) return null;
                    const key = field.key;
                    const curVal =
                      savedValues[key] !== undefined
                        ? savedValues[key]
                        : field.defaultValue;

                    if (field.type === "toggle") {
                      return (
                        <View key={key} style={styles.schemaRow}>
                          <View style={{ flex: 1, marginRight: 12 }}>
                            <Text style={styles.schemaLabel}>
                              {field.label}
                            </Text>
                            {field.description && (
                              <Text style={styles.schemaDesc}>
                                {field.description}
                              </Text>
                            )}
                          </View>
                          <Switch
                            value={Boolean(curVal)}
                            onValueChange={(v) =>
                              void updatePluginSetting(
                                settingsTarget.pluginKey,
                                key,
                                v,
                              )
                            }
                            trackColor={{
                              false: "#27272A",
                              true: THEME.goldMuted,
                            }}
                            thumbColor={curVal ? THEME.gold : "#71717A"}
                          />
                        </View>
                      );
                    }

                    if (field.type === "select" && field.options) {
                      return (
                        <View key={key} style={styles.schemaBlock}>
                          <Text style={styles.schemaLabel}>{field.label}</Text>
                          <View style={styles.optionsWrap}>
                            {field.options.map((opt) => {
                              const active = String(curVal) === opt.value;
                              return (
                                <TouchableOpacity
                                  key={opt.value}
                                  onPress={() =>
                                    void updatePluginSetting(
                                      settingsTarget.pluginKey,
                                      key,
                                      opt.value,
                                    )
                                  }
                                  style={[
                                    styles.optionChip,
                                    active && styles.optionChipActive,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.optionChipText,
                                      active && { color: "#000" },
                                    ]}
                                  >
                                    {opt.label}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </View>
                      );
                    }

                    return (
                      <View key={key} style={styles.schemaBlock}>
                        <Text style={styles.schemaLabel}>{field.label}</Text>
                        {field.description && (
                          <Text style={styles.schemaDesc}>
                            {field.description}
                          </Text>
                        )}
                        <TextInput
                          value={curVal != null ? String(curVal) : ""}
                          onChangeText={(txt) =>
                            void updatePluginSetting(
                              settingsTarget.pluginKey,
                              key,
                              txt,
                            )
                          }
                          placeholder={field.placeholder || ""}
                          placeholderTextColor={THEME.textTertiary}
                          secureTextEntry={field.isPassword}
                          autoCapitalize="none"
                          style={styles.schemaInput}
                        />
                      </View>
                    );
                  })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Developer Diagnostics Modal */}
      <Modal
        visible={showDiagnostics}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDiagnostics(false)}
      >
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.modalSheet,
              { paddingBottom: Math.max(24, insets.bottom + 12) },
            ]}
          >
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  Provider Diagnostics ({diagnostics.length})
                </Text>
                <Text style={styles.modalSub}>
                  Init, request timing, compatibility & playback handoff status
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowDiagnostics(false)}
                style={styles.iconActionBtn}
              >
                <Ionicons name="close" size={20} color={THEME.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {diagnostics.slice(0, 60).map((d) => (
                <View key={d.pluginKey} style={styles.schemaRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.schemaLabel}>
                      {d.providerName} · {d.repositoryName}
                    </Text>
                    <Text style={styles.schemaDesc}>
                      Init: {d.initStatus} | Req: {d.requestStatus} | Sources:{" "}
                      {d.sourcesReturned}
                      {d.responseTimeMs != null ? ` | ${d.responseTimeMs}ms` : ""}
                      {d.playbackHandoffStatus !== "not_started"
                        ? ` | Handoff: ${d.playbackHandoffStatus}`
                        : ""}
                    </Text>
                    {d.compatibilityError ? (
                      <Text style={[styles.errorText, { marginTop: 2 }]}>
                        {d.compatibilityError}
                      </Text>
                    ) : null}
                    {d.parsingError ? (
                      <Text style={[styles.errorText, { marginTop: 2 }]}>
                        {d.parsingError}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: THEME.card,
    marginRight: 10,
  },
  headerTitle: { color: THEME.textPrimary, fontSize: 18, fontWeight: "700" },
  headerSub: { color: THEME.textSecondary, fontSize: 12, marginTop: 1 },
  refreshHeaderBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: THEME.goldMuted,
  },
  card: {
    backgroundColor: THEME.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  sectionLabel: {
    color: THEME.gold,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
  helperText: {
    color: THEME.textSecondary,
    fontSize: 12,
    marginTop: 6,
    lineHeight: 17,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: THEME.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.border,
    color: THEME.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  addBtn: {
    backgroundColor: THEME.gold,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
    justifyContent: "center",
    alignItems: "center",
  },
  addBtnText: { color: "#000", fontWeight: "700", fontSize: 13 },
  updateBanner: {
    marginTop: 12,
    backgroundColor: THEME.goldMuted,
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(229, 185, 75, 0.35)",
  },
  updateBannerText: { color: THEME.gold, fontSize: 13, fontWeight: "600" },
  emptyCard: {
    backgroundColor: THEME.card,
    borderRadius: 14,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: THEME.border,
  },
  emptyTitle: {
    color: THEME.textPrimary,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 10,
  },
  emptyDesc: {
    color: THEME.textSecondary,
    fontSize: 12,
    textAlign: "center",
    marginTop: 4,
    lineHeight: 18,
  },
  repoCard: {
    backgroundColor: THEME.card,
    borderRadius: 12,
    padding: 13,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  repoHeader: { flexDirection: "row", alignItems: "center" },
  repoName: { color: THEME.textPrimary, fontSize: 14, fontWeight: "600" },
  repoUrl: { color: THEME.textTertiary, fontSize: 11, marginTop: 2 },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    gap: 5,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: "600" },
  errorText: { color: THEME.error, fontSize: 11, marginTop: 6 },
  repoFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
  },
  repoMeta: { color: THEME.textSecondary, fontSize: 11, flex: 1 },
  repoActions: { flexDirection: "row", gap: 8 },
  iconActionBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: THEME.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  pluginCard: {
    backgroundColor: THEME.card,
    borderRadius: 12,
    padding: 13,
    marginBottom: 9,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  pluginTop: { flexDirection: "row", alignItems: "center" },
  pluginLogo: {
    width: 38,
    height: 38,
    borderRadius: 9,
    backgroundColor: THEME.surface,
  },
  pluginLogoFallback: {
    width: 38,
    height: 38,
    borderRadius: 9,
    backgroundColor: THEME.goldMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  pluginTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pluginName: {
    color: THEME.textPrimary,
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  pluginVersion: { color: THEME.textTertiary, fontSize: 11 },
  pluginDesc: { color: THEME.textSecondary, fontSize: 12, marginTop: 2 },
  pluginMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
  },
  badgesWrap: { flexDirection: "row", flexWrap: "wrap", gap: 5, flex: 1 },
  chip: {
    backgroundColor: THEME.surface,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
  },
  chipText: { color: THEME.textSecondary, fontSize: 10, fontWeight: "600" },
  pluginActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  updatePill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: THEME.gold,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  updatePillText: { color: "#000", fontSize: 10, fontWeight: "700" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: THEME.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    maxHeight: "75%",
    borderTopWidth: 1,
    borderColor: THEME.border,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },
  modalTitle: { color: THEME.textPrimary, fontSize: 16, fontWeight: "700" },
  modalSub: { color: THEME.textSecondary, fontSize: 12, marginTop: 2 },
  schemaHeader: {
    color: THEME.gold,
    fontSize: 11,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 6,
  },
  schemaInfo: { color: THEME.textSecondary, fontSize: 12, marginBottom: 8 },
  schemaRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
  },
  schemaBlock: { paddingVertical: 10 },
  schemaLabel: { color: THEME.textPrimary, fontSize: 13, fontWeight: "600" },
  schemaDesc: { color: THEME.textSecondary, fontSize: 11, marginTop: 2 },
  schemaInput: {
    marginTop: 8,
    backgroundColor: THEME.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: THEME.border,
    color: THEME.textPrimary,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  optionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  optionChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: THEME.surface,
  },
  optionChipActive: { backgroundColor: THEME.gold },
  optionChipText: {
    color: THEME.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
});
