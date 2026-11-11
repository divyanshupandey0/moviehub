/**
 * MOVIE HUB — Premium Settings & Preferences
 *
 * Cinematic dark interface:
 * - Deep black canvas (#080808)
 * - Dark charcoal cards (#141414)
 * - Signature golden accent (#E5B94B)
 * - Complete settings integration preserving all store preferences and offline downloads
 */

import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Switch,
  Image,
  Modal,
  StyleSheet,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useSafeNavigation } from "@/lib/navigation";
import { useSettings } from "../../lib/settings";
import { useDownloadList } from "../../lib/download";
import { useNuvioPlugins, ALL_NUVIO_PLUGINS_ID } from "../../lib/nuvio";
import { getInfoAsync, documentDirectory } from "expo-file-system/legacy";
import Constants from "expo-constants";
import { colors } from "../../theme/colors";
import * as Haptics from "expo-haptics";
import { LanguagePromptSheet } from "../../components/player/LanguagePromptSheet";
import { SpeedLimitSheet, formatSpeed } from "../../components/SpeedLimitSheet";
import { trackFeatureUsed } from "../../lib/telemetry";

const THEME = {
  bg: "#080808",
  card: "#141414",
  cardBorder: "rgba(255, 255, 255, 0.07)",
  gold: "#E5B94B",
  goldMuted: "rgba(229, 185, 75, 0.15)",
  goldBadgeText: "#E5B94B",
  textPrimary: "#FFFFFF",
  textSecondary: "#A1A1AA",
  textTertiary: "#71717A",
  divider: "rgba(255, 255, 255, 0.05)",
};

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );
  const val = bytes / Math.pow(k, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${sizes[i]}`;
}

// ── Selection Sheet Modal Component ──
interface OptionItem<T> {
  value: T;
  label: string;
  subtitle?: string;
}

function SelectionModal<T>({
  visible,
  title,
  subtitle,
  options,
  currentValue,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  options: OptionItem<T>[];
  currentValue: T;
  onSelect: (val: T) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.modalContainer,
            { paddingBottom: Math.max(20, insets.bottom + 12) },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.modalDragHandle} />
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            {subtitle && <Text style={styles.modalSubtitle}>{subtitle}</Text>}
          </View>

          <View style={styles.modalList}>
            {options.map((opt, idx) => {
              const isSelected = opt.value === currentValue;
              return (
                <TouchableOpacity
                  key={String(opt.value) + idx}
                  style={[
                    styles.modalOption,
                    isSelected && styles.modalOptionSelected,
                  ]}
                  onPress={() => {
                    Haptics.impactAsync(
                      Haptics.ImpactFeedbackStyle.Light,
                    ).catch(() => {});
                    onSelect(opt.value);
                    onClose();
                  }}
                  activeOpacity={0.7}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.modalOptionLabel,
                        isSelected && { color: THEME.gold },
                      ]}
                    >
                      {opt.label}
                    </Text>
                    {opt.subtitle && (
                      <Text style={styles.modalOptionSub}>{opt.subtitle}</Text>
                    )}
                  </View>
                  <View
                    style={[
                      styles.radioCircle,
                      isSelected && styles.radioCircleActive,
                    ]}
                  >
                    {isSelected && <View style={styles.radioDot} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Card Container ──
function SectionCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.sectionContainer}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {badge && (
          <View style={styles.badgePill}>
            <Text style={styles.badgePillText}>{badge}</Text>
          </View>
        )}
      </View>
      <View style={styles.cardBox}>{children}</View>
    </View>
  );
}

// ── Row Item ──
function SettingsRow({
  icon,
  label,
  subtitle,
  valueText,
  right,
  onPress,
  isDestructive,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  subtitle?: string;
  valueText?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  isDestructive?: boolean;
}) {
  const Container = onPress ? TouchableOpacity : View;

  return (
    <Container
      onPress={() => {
        if (onPress) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
            () => {},
          );
          onPress();
        }
      }}
      activeOpacity={onPress ? 0.7 : 1}
      style={styles.rowItem}
    >
      <View
        style={[
          styles.rowIconContainer,
          isDestructive && { backgroundColor: "rgba(239, 68, 68, 0.12)" },
        ]}
      >
        <Ionicons
          name={icon}
          size={18}
          color={isDestructive ? "#EF4444" : THEME.gold}
        />
      </View>

      <View style={styles.rowTextContainer}>
        <Text
          style={[
            styles.rowLabel,
            isDestructive && { color: "#EF4444" },
          ]}
        >
          {label}
        </Text>
        {subtitle && <Text style={styles.rowSubtitle}>{subtitle}</Text>}
      </View>

      {valueText && (
        <Text style={styles.rowValueText} numberOfLines={1}>
          {valueText}
        </Text>
      )}

      {right}

      {onPress && !right && (
        <Ionicons
          name="chevron-forward"
          size={16}
          color={THEME.textTertiary}
          style={{ marginLeft: 6 }}
        />
      )}
    </Container>
  );
}

function RowDivider() {
  return <View style={styles.rowDivider} />;
}

export default function SettingsScreen() {
  const nav = useSafeNavigation();
  const insets = useSafeAreaInsets();
  const { settings, updateSetting } = useSettings();
  const { all: downloads } = useDownloadList();
  const appVersion = Constants.expoConfig?.version || "2.5.0";

  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [calculatingStorage, setCalculatingStorage] = useState(false);
  const storageCalculated = useRef(false);

  // Sheets
  const [showLangSheet, setShowLangSheet] = useState(false);
  const [showSpeedSheet, setShowSpeedSheet] = useState(false);
  const [showQualityModal, setShowQualityModal] = useState(false);
  const [showFitModal, setShowFitModal] = useState(false);
  const [showSubtitleModal, setShowSubtitleModal] = useState(false);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);

  // Storage calculation
  const completedDownloads = useMemo(() => {
    return downloads.filter((t) => t.status === "completed");
  }, [downloads]);

  const totalDownloadSize = useMemo(() => {
    return completedDownloads.reduce((sum, t) => sum + (t.totalBytes || 0), 0);
  }, [completedDownloads]);

  const calculateCacheSize = useCallback(async () => {
    setCalculatingStorage(true);
    try {
      const dir = (documentDirectory ?? "") + "downloads/";
      const info = await getInfoAsync(dir);
      if (info.exists && "size" in info) {
        setCacheSize((info as any).size || null);
      }
    } catch {
      setCacheSize(null);
    }
    setCalculatingStorage(false);
  }, []);

  useEffect(() => {
    if (storageCalculated.current || calculatingStorage) return;
    storageCalculated.current = true;
    calculateCacheSize();
  }, [calculateCacheSize, calculatingStorage]);

  const handleClearCache = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    Alert.alert(
      "Clear Streaming Cache",
      "This frees temporary stream chunks and image cache. Your completed downloads, watch progress, and saved titles remain completely safe.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Cache",
          style: "destructive",
          onPress: () => {
            setCacheSize(0);
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            ).catch(() => {});
            Alert.alert("Cache Cleared", "Temporary streaming cache has been successfully reclaimed.");
          },
        },
      ],
    );
  }, []);

  // Nuvio Plugins & Repositories
  const { repos, plugins, getProviderViews } = useNuvioPlugins();
  const enabledPluginsCount = useMemo(
    () => plugins.filter((p) => p.enabled).length,
    [plugins],
  );
  const serverProviders = useMemo(
    () => getProviderViews(),
    [getProviderViews, plugins],
  );

  const selectedServer = settings.defaultServer;
  const selectedProviderName = useMemo(() => {
    if (!selectedServer || selectedServer === ALL_NUVIO_PLUGINS_ID) {
      return "All Enabled Plugins (Auto)";
    }
    const p = serverProviders.find(
      (sp) => sp.id === selectedServer || sp.pluginKey === selectedServer,
    );
    return p ? p.displayName || p.name : "All Enabled Plugins (Auto)";
  }, [selectedServer, serverProviders]);

  const speedLimitKBps = settings.downloadSpeedLimitKBps ?? 0;
  const speedLabel = speedLimitKBps > 0 ? formatSpeed(speedLimitKBps) : "Unlimited";

  // Quality Label
  const qualityLabel = useMemo(() => {
    if (!settings.maxQuality) return "Auto (Highest Available)";
    if (settings.maxQuality === "1080p") return "1080p Full HD";
    if (settings.maxQuality === "720p") return "720p HD";
    if (settings.maxQuality === "480p") return "480p SD (Data Saver)";
    return settings.maxQuality;
  }, [settings.maxQuality]);

  // Screen Fit Label
  const fitLabel = useMemo(() => {
    const fit = settings.playerScreenFit ?? "contain";
    if (fit === "contain") return "Fit to Screen (Original Aspect)";
    if (fit === "cover") return "Fill Screen (Crop)";
    if (fit === "fill") return "Stretch to Fill";
    return "Fit to Screen";
  }, [settings.playerScreenFit]);

  // Subtitle Position Label
  const subtitlePosLabel = useMemo(() => {
    const val = settings.subtitleBottomMargin;
    if (val === null) return "Auto (Adaptive)";
    if (Math.abs(val - 0.08) < 0.01) return "Bottom (Stock)";
    if (Math.abs(val - 0.14) < 0.01) return "Low (Elevated)";
    if (Math.abs(val - 0.20) < 0.01) return "Middle";
    if (Math.abs(val - 0.30) < 0.01) return "High";
    return `${Math.round(val * 100)}% margin`;
  }, [settings.subtitleBottomMargin]);

  // Audio Language Label
  const audioLanguageLabel = useMemo(() => {
    const lang = settings.preferredAudioLanguage ?? "auto";
    if (lang === "auto") return "Auto (Smart Match)";
    if (lang === "multi") return "Multi-Audio (Priority)";
    if (lang === "hindi") return "Hindi";
    if (lang === "english") return "English";
    return "Auto";
  }, [settings.preferredAudioLanguage]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── 1. Top Bar Header ── */}
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => nav.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={22} color={THEME.textPrimary} />
        </TouchableOpacity>

        <View style={styles.topBarTitleBlock}>
          <Text style={styles.topBarMainTitle}>MOVIE HUB</Text>
          <Text style={styles.topBarSubTitle}>Settings & Preferences</Text>
        </View>

        <View style={styles.versionBadge}>
          <Text style={styles.versionBadgeText}>v{appVersion}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: 100 + insets.bottom },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── 2. Profile / App Information Card ── */}
        <View style={styles.appCard}>
          <View style={styles.appCardContent}>
            <Image
              source={require("../../assets/icon.png")}
              style={styles.appLogo}
              resizeMode="cover"
            />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={styles.appCardTitle}>MOVIE HUB</Text>
                <View style={styles.proTag}>
                  <Text style={styles.proTagText}>PRO</Text>
                </View>
              </View>
              <Text style={styles.appCardTagline}>
                Your Entertainment Destination
              </Text>
              <Text style={styles.appCardMeta}>
                Build v{appVersion} • Android Native Engine
              </Text>
            </View>
          </View>
        </View>

        {/* ── 3. Appearance & Experience ── */}
        <SectionCard title="Appearance & Experience">
          {/* Mode Switcher */}
          <View style={styles.rowItem}>
            <View style={styles.rowIconContainer}>
              <Ionicons name="film-outline" size={18} color={THEME.gold} />
            </View>
            <View style={styles.rowTextContainer}>
              <Text style={styles.rowLabel}>Catalog Mode</Text>
              <Text style={styles.rowSubtitle}>
                Toggle between Movies/TV & Anime
              </Text>
            </View>

            <View style={styles.segmentedControl}>
              {(["movie_tv", "anime"] as const).map((modeKey) => {
                const active = settings.mode === modeKey;
                return (
                  <TouchableOpacity
                    key={modeKey}
                    onPress={() => {
                      Haptics.impactAsync(
                        Haptics.ImpactFeedbackStyle.Light,
                      ).catch(() => {});
                      trackFeatureUsed(
                        modeKey === "anime"
                          ? "mode_toggle_anime"
                          : "mode_toggle_movie_tv",
                        "settings",
                      );
                      updateSetting("mode", modeKey);
                    }}
                    activeOpacity={0.8}
                    style={[
                      styles.segmentBtn,
                      active && styles.segmentBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.segmentBtnText,
                        active && styles.segmentBtnTextActive,
                      ]}
                    >
                      {modeKey === "anime" ? "Anime" : "Cinema"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <RowDivider />

          {/* Home Layout */}
          <SettingsRow
            icon="grid-outline"
            label="Home Screen Customization"
            subtitle="Reorder feeds, discover carousels, and sections"
            onPress={() => nav.push("/home-layout")}
          />

          <RowDivider />

          {/* Preferred Audio */}
          <SettingsRow
            icon="language-outline"
            label="Preferred Audio Language"
            subtitle="Default language prioritization for source ranking"
            valueText={audioLanguageLabel}
            onPress={() => setShowLangSheet(true)}
          />
        </SectionCard>

        {/* ── Nuvio Plugins & Repositories ── */}
        <SectionCard title="Plugins">
          <SettingsRow
            icon="extension-puzzle-outline"
            label="Manage Nuvio Plugins"
            subtitle={
              repos.length > 0
                ? `${enabledPluginsCount}/${plugins.length} active across ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`
                : "Add Nuvio plugin repositories to discover streams"
            }
            valueText={
              enabledPluginsCount > 0 ? `${enabledPluginsCount} Active` : "Setup"
            }
            onPress={() => nav.push("/plugins")}
          />
        </SectionCard>

        {/* ── 4. Playback Settings ── */}
        <SectionCard title="Playback & Streaming">
          {/* Default Server */}
          <SettingsRow
            icon="server-outline"
            label="Default Streaming Server"
            subtitle="Source provider prioritized on launch"
            valueText={selectedProviderName}
            onPress={() => setServerPickerOpen(!serverPickerOpen)}
          />

          {serverPickerOpen && (
            <View style={styles.serverPickerDropdown}>
              <TouchableOpacity
                style={[
                  styles.serverOptionRow,
                  selectedServer === "" && styles.serverOptionRowActive,
                ]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                    () => {},
                  );
                  updateSetting("defaultServer", "");
                  setServerPickerOpen(false);
                }}
              >
                <View style={styles.radioDotWrapper}>
                  {selectedServer === "" && <View style={styles.radioDot} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.serverOptionTitle,
                      selectedServer === "" && { color: THEME.gold },
                    ]}
                  >
                    Auto Select (Recommended)
                  </Text>
                  <Text style={styles.serverOptionSub}>
                    Dynamically chooses the fastest verified provider
                  </Text>
                </View>
              </TouchableOpacity>

              {serverProviders.map((p) => {
                const isSelected = selectedServer === p.id;
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={[
                      styles.serverOptionRow,
                      isSelected && styles.serverOptionRowActive,
                    ]}
                    onPress={() => {
                      Haptics.impactAsync(
                        Haptics.ImpactFeedbackStyle.Light,
                      ).catch(() => {});
                      updateSetting("defaultServer", p.id);
                      setServerPickerOpen(false);
                    }}
                  >
                    <View style={styles.radioDotWrapper}>
                      {isSelected && <View style={styles.radioDot} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.serverOptionTitle,
                          isSelected && { color: THEME.gold },
                        ]}
                      >
                        {p.displayName || p.name}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <RowDivider />

          {/* Maximum Quality */}
          <SettingsRow
            icon="speedometer-outline"
            label="Maximum Streaming Quality"
            subtitle="Resolution ceiling for cellular and Wi-Fi"
            valueText={qualityLabel}
            onPress={() => setShowQualityModal(true)}
          />

          <RowDivider />

          {/* Video Screen Fit */}
          <SettingsRow
            icon="scan-outline"
            label="Video Screen Fit"
            subtitle="Default display mode for full-screen playback"
            valueText={fitLabel}
            onPress={() => setShowFitModal(true)}
          />

          <RowDivider />

          {/* Subtitle Position */}
          <SettingsRow
            icon="text-outline"
            label="Subtitle Position"
            subtitle="Vertical offset padding above controls"
            valueText={subtitlePosLabel}
            onPress={() => setShowSubtitleModal(true)}
          />

          <RowDivider />

          {/* Server Notes Visibility */}
          <View style={styles.rowItem}>
            <View style={styles.rowIconContainer}>
              <Ionicons
                name="information-circle-outline"
                size={18}
                color={THEME.gold}
              />
            </View>
            <View style={styles.rowTextContainer}>
              <Text style={styles.rowLabel}>Streaming Source Tips</Text>
              <Text style={styles.rowSubtitle}>
                Show helpful hints and speed advice below player
              </Text>
            </View>
            <Switch
              value={settings.showServerNotes}
              onValueChange={(val) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                  () => {},
                );
                updateSetting("showServerNotes", val);
              }}
              trackColor={{ false: "#27272A", true: THEME.goldMuted }}
              thumbColor={settings.showServerNotes ? THEME.gold : "#71717A"}
            />
          </View>
        </SectionCard>

        {/* ── 5. Downloads & Storage ── */}
        <SectionCard title="Downloads & Storage">
          {/* Storage Information */}
          <View style={styles.storageOverviewBox}>
            <View style={styles.storageStatItem}>
              <Text style={styles.storageStatValue}>
                {formatBytes(totalDownloadSize)}
              </Text>
              <Text style={styles.storageStatLabel}>
                Offline Storage ({completedDownloads.length} titles)
              </Text>
            </View>
            <View style={styles.storageStatDivider} />
            <View style={styles.storageStatItem}>
              <Text style={styles.storageStatValue}>
                {calculatingStorage
                  ? "..."
                  : cacheSize != null
                  ? formatBytes(cacheSize)
                  : "0 B"}
              </Text>
              <Text style={styles.storageStatLabel}>Streaming Cache</Text>
            </View>
          </View>

          <RowDivider />

          {/* Manage Downloads */}
          <SettingsRow
            icon="download-outline"
            label="Manage Offline Downloads"
            subtitle="View, pause, play, or remove downloaded titles"
            onPress={() => nav.push("/downloads")}
          />

          <RowDivider />

          {/* Download Speed Limit */}
          <SettingsRow
            icon="hardware-chip-outline"
            label="Download Speed Limit"
            subtitle="Bandwidth throttle for background downloads"
            valueText={speedLabel}
            onPress={() => setShowSpeedSheet(true)}
          />

          <RowDivider />

          {/* Clear Cache */}
          <SettingsRow
            icon="trash-outline"
            label="Clear Streaming Cache"
            subtitle="Reclaim temporary stream cache without touching downloads"
            isDestructive
            right={
              calculatingStorage ? (
                <ActivityIndicator size="small" color={THEME.gold} />
              ) : undefined
            }
            onPress={handleClearCache}
          />
        </SectionCard>

        {/* ── 6. Privacy & Security ── */}
        <SectionCard title="Privacy & Security">
          {/* Anonymous Analytics & Crash Reporting */}
          <View style={styles.rowItem}>
            <View style={styles.rowIconContainer}>
              <Ionicons
                name="shield-checkmark-outline"
                size={18}
                color={THEME.gold}
              />
            </View>
            <View style={styles.rowTextContainer}>
              <Text style={styles.rowLabel}>Anonymous Diagnostics</Text>
              <Text style={styles.rowSubtitle}>
                Send anonymous crash reports & stream reliability stats to fix broken sources
              </Text>
            </View>
            <Switch
              value={settings.analyticsEnabled !== false}
              onValueChange={(val) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                  () => {},
                );
                updateSetting("analyticsEnabled", val);
              }}
              trackColor={{ false: "#27272A", true: THEME.goldMuted }}
              thumbColor={
                settings.analyticsEnabled !== false ? THEME.gold : "#71717A"
              }
            />
          </View>

          <RowDivider />

          {/* Privacy Policy */}
          <SettingsRow
            icon="lock-closed-outline"
            label="Privacy Policy"
            subtitle="Zero personal data collected · Safe local-first design"
            onPress={() => nav.push("/privacy")}
          />

          <RowDivider />

          {/* Transparency & Security */}
          <SettingsRow
            icon="eye-outline"
            label="Transparency & Sandboxing"
            subtitle="Sandboxed stream engines and active ad-blocking"
            onPress={() => nav.push("/transparency")}
          />

          <RowDivider />

          {/* Legal / Disclaimer */}
          <SettingsRow
            icon="document-text-outline"
            label="Legal & Disclaimer"
            subtitle="Content ownership terms, non-hosting policy & DMCA"
            onPress={() => nav.push("/legal")}
          />
        </SectionCard>

        {/* ── 7. About Movie Hub ── */}
        <SectionCard title="About MOVIE HUB">
          <SettingsRow
            icon="chatbubble-ellipses-outline"
            label="Feedback & Support"
            subtitle="Submit bug reports or suggest improvements"
            onPress={() => nav.push("/feedback")}
          />
        </SectionCard>

        {/* Footer info */}
        <View style={styles.footer}>
          <Image
            source={require("../../assets/icon.png")}
            style={styles.footerIcon}
            resizeMode="cover"
          />
          <Text style={styles.footerBrand}>MOVIE HUB</Text>
          <Text style={styles.footerTagline}>Your Entertainment Destination</Text>
          <Text style={styles.footerCopy}>
            Version {appVersion} • All rights reserved
          </Text>
        </View>
      </ScrollView>

      {/* ── Modals & Sheets ── */}

      {/* 1. Preferred Audio Language Picker */}
      <LanguagePromptSheet
        visible={showLangSheet}
        onClose={() => setShowLangSheet(false)}
        currentValue={settings.preferredAudioLanguage ?? "auto"}
        title="Preferred Audio Language"
        subtitle="Rank sources that provide this language first."
        onSelect={(val) => {
          updateSetting("preferredAudioLanguage", val);
          updateSetting("hasAnsweredLanguagePrompt", true);
          setShowLangSheet(false);
        }}
      />

      {/* 2. Download Speed Limit Sheet */}
      <SpeedLimitSheet
        visible={showSpeedSheet}
        value={speedLimitKBps}
        onChange={(v) => updateSetting("downloadSpeedLimitKBps", v)}
        onClose={() => setShowSpeedSheet(false)}
      />

      {/* 3. Max Streaming Quality Modal */}
      <SelectionModal
        visible={showQualityModal}
        title="Max Streaming Quality"
        subtitle="Select the highest video quality to load automatically"
        currentValue={settings.maxQuality}
        options={[
          {
            value: null,
            label: "Auto / Highest Available",
            subtitle: "Streams at highest resolution possible",
          },
          {
            value: "1080p",
            label: "1080p (Full HD)",
            subtitle: "Crystal clear resolution for high speed connections",
          },
          {
            value: "720p",
            label: "720p (HD)",
            subtitle: "Smooth streaming with reduced bandwidth",
          },
          {
            value: "480p",
            label: "480p (SD Data Saver)",
            subtitle: "Lowest cellular data consumption",
          },
        ]}
        onSelect={(val) => updateSetting("maxQuality", val)}
        onClose={() => setShowQualityModal(false)}
      />

      {/* 4. Video Screen Fit Modal */}
      <SelectionModal<"contain" | "cover" | "fill">
        visible={showFitModal}
        title="Video Screen Fit"
        subtitle="Choose default aspect ratio behavior in player"
        currentValue={settings.playerScreenFit ?? "contain"}
        options={[
          {
            value: "contain",
            label: "Fit to Screen",
            subtitle: "Preserves native aspect ratio with black bars",
          },
          {
            value: "cover",
            label: "Fill Screen (Zoom)",
            subtitle: "Expands video to fill display without distortion",
          },
          {
            value: "fill",
            label: "Stretch to Fill",
            subtitle: "Fills the entire display (may alter aspect ratio)",
          },
        ]}
        onSelect={(val) => updateSetting("playerScreenFit", val)}
        onClose={() => setShowFitModal(false)}
      />

      {/* 5. Subtitle Position Modal */}
      <SelectionModal
        visible={showSubtitleModal}
        title="Subtitle Vertical Position"
        subtitle="Adjust the bottom offset margin of subtitles"
        currentValue={settings.subtitleBottomMargin}
        options={[
          {
            value: null,
            label: "Auto (Adaptive)",
            subtitle: "Smart offset: Low in portrait, Middle in landscape",
          },
          {
            value: 0.08,
            label: "Bottom (Stock)",
            subtitle: "Standard position near bottom border",
          },
          {
            value: 0.14,
            label: "Low (Elevated)",
            subtitle: "Slightly raised to clear playback controls",
          },
          {
            value: 0.20,
            label: "Middle",
            subtitle: "Comfortably raised above lower controls",
          },
          {
            value: 0.30,
            label: "High",
            subtitle: "Elevated high above all banners and controls",
          },
        ]}
        onSelect={(val) => updateSetting("subtitleBottomMargin", val)}
        onClose={() => setShowSubtitleModal(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: THEME.bg,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: THEME.cardBorder,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: THEME.card,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  topBarTitleBlock: {
    flex: 1,
  },
  topBarMainTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: THEME.textPrimary,
    letterSpacing: 0.5,
  },
  topBarSubTitle: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 1,
  },
  versionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: THEME.goldMuted,
    borderWidth: 0.5,
    borderColor: "rgba(229, 185, 75, 0.3)",
  },
  versionBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: THEME.gold,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  appCard: {
    backgroundColor: THEME.card,
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: THEME.cardBorder,
    padding: 16,
    marginBottom: 20,
  },
  appCardContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  appLogo: {
    width: 52,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(229, 185, 75, 0.4)",
  },
  appCardTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: THEME.textPrimary,
    letterSpacing: 0.5,
  },
  proTag: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: THEME.gold,
  },
  proTagText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#080808",
  },
  appCardTagline: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: THEME.gold,
    marginTop: 2,
  },
  appCardMeta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 3,
  },
  sectionContainer: {
    marginBottom: 20,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: THEME.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  badgePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: THEME.goldMuted,
  },
  badgePillText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: THEME.gold,
  },
  cardBox: {
    backgroundColor: THEME.card,
    borderRadius: 16,
    borderWidth: 0.5,
    borderColor: THEME.cardBorder,
    overflow: "hidden",
  },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  rowIconContainer: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rowTextContainer: {
    flex: 1,
    marginRight: 8,
  },
  rowLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: THEME.textPrimary,
  },
  rowSubtitle: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 2,
    lineHeight: 15,
  },
  rowValueText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: THEME.gold,
    maxWidth: 130,
    textAlign: "right",
  },
  rowDivider: {
    height: 0.5,
    backgroundColor: THEME.divider,
    marginLeft: 62,
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderRadius: 999,
    padding: 2,
    borderWidth: 0.5,
    borderColor: THEME.cardBorder,
  },
  segmentBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
  },
  segmentBtnActive: {
    backgroundColor: THEME.gold,
  },
  segmentBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: THEME.textSecondary,
  },
  segmentBtnTextActive: {
    color: "#080808",
  },
  serverPickerDropdown: {
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderTopWidth: 0.5,
    borderTopColor: THEME.divider,
    paddingVertical: 4,
  },
  serverOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  serverOptionRowActive: {
    backgroundColor: "rgba(229, 185, 75, 0.06)",
  },
  radioDotWrapper: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: THEME.gold,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: THEME.gold,
  },
  serverOptionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: THEME.textPrimary,
  },
  serverOptionSub: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 1,
  },
  storageOverviewBox: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: "rgba(255, 255, 255, 0.02)",
  },
  storageStatItem: {
    flex: 1,
  },
  storageStatValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: THEME.gold,
  },
  storageStatLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 2,
  },
  storageStatDivider: {
    width: 1,
    height: 28,
    backgroundColor: THEME.divider,
    marginHorizontal: 12,
  },
  footer: {
    alignItems: "center",
    paddingVertical: 24,
  },
  footerIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    marginBottom: 8,
    opacity: 0.8,
  },
  footerBrand: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: THEME.textPrimary,
    letterSpacing: 0.5,
  },
  footerTagline: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: THEME.gold,
    marginTop: 2,
  },
  footerCopy: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 4,
  },
  // Modal styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "flex-end",
  },
  modalContainer: {
    backgroundColor: "#161618",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 0.5,
    borderColor: THEME.cardBorder,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  modalDragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignSelf: "center",
    marginBottom: 14,
  },
  modalHeader: {
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: THEME.textPrimary,
  },
  modalSubtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 3,
  },
  modalList: {
    gap: 8,
  },
  modalOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: THEME.card,
    borderWidth: 0.5,
    borderColor: THEME.cardBorder,
  },
  modalOptionSelected: {
    borderColor: THEME.gold,
    backgroundColor: "rgba(229, 185, 75, 0.08)",
  },
  modalOptionLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: THEME.textPrimary,
  },
  modalOptionSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: THEME.textTertiary,
    marginTop: 2,
  },
  radioCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: THEME.textTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  radioCircleActive: {
    borderColor: THEME.gold,
  },
});
