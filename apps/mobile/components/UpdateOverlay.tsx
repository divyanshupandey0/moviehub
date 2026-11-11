import React, { useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { usePathname } from "expo-router";
import { colors } from "../theme/colors";
import { useUpdateCheck } from "../hooks/useUpdateCheck";

/**
 * In-app update overlay.
 *
 * Works with expo-updates — no APK downloads, no permissions.
 * When a new JS bundle is available, it auto-downloads silently.
 * When ready, shows "Restart to update" prompt.
 *
 * Guarantees:
 * - Never shows persistent error banners across navigation.
 * - Suppresses banners completely during video playback (/watch).
 * - Auto-dismisses transient error notices after 4 seconds.
 */
export function UpdateOverlay() {
  const {
    phase,
    progress,
    showRestartPrompt,
    isDownloading,
    errorMessage,
    dismissError,
    applyUpdate,
  } = useUpdateCheck();

  const pathname = usePathname();
  const isPlaybackScreen = pathname?.includes("/watch");

  // Auto-dismiss transient errors after 4 seconds
  useEffect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        dismissError();
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [errorMessage, dismissError]);

  return (
    <>
      {/* ── Downloading indicator (hidden on playback screen) ── */}
      {isDownloading && !isPlaybackScreen && (
        <View style={styles.bar}>
          <View style={styles.row}>
            <ActivityIndicator size="small" color={colors.secondary} />
            <Text style={styles.barText}>Downloading update...</Text>
          </View>
          {progress > 0 && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progress}%` }]} />
            </View>
          )}
        </View>
      )}

      {/* ── Transient Error indicator (auto-dismisses & user-dismissible) ── */}
      {phase === "error" && errorMessage && !isPlaybackScreen && (
        <View style={[styles.bar, styles.errorBar]}>
          <View style={styles.errorRow}>
            <Text style={styles.errorText} numberOfLines={1}>
              {errorMessage}
            </Text>
            <TouchableOpacity
              onPress={dismissError}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.closeBtn}
            >
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── "Restart to update" modal (only when verified update is pending) ── */}
      <Modal
        visible={showRestartPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.overlay}>
          <View style={styles.dialog}>
            <Text style={styles.emoji}>✨</Text>
            <Text style={styles.title}>Update Ready</Text>
            <Text style={styles.body}>
              A new version has been downloaded. Restart the app to apply it
              instantly.
            </Text>
            <Text style={styles.hint}>
              No APK download needed — this is a seamless JS update.
            </Text>
            <TouchableOpacity style={styles.restartBtn} onPress={applyUpdate}>
              <Text style={styles.restartBtnText}>Restart Now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.black75,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  dialog: {
    backgroundColor: colors.zincBgFull,
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 340,
    borderWidth: 1,
    borderColor: colors.zinc800,
    alignItems: "center",
  },
  emoji: {
    fontSize: 44,
    marginBottom: 12,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
  },
  body: {
    color: colors.zinc300,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 8,
  },
  hint: {
    color: colors.zinc500,
    fontSize: 12,
    textAlign: "center",
    marginBottom: 24,
  },
  restartBtn: {
    width: "100%",
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.secondary,
    alignItems: "center",
  },
  restartBtnText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
  bar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.zinc800,
    padding: 12,
    paddingBottom: 28,
    zIndex: 1000,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  closeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  closeBtnText: {
    color: colors.zinc400,
    fontSize: 14,
    fontWeight: "bold",
  },
  barText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  progressTrack: {
    height: 3,
    backgroundColor: colors.zinc800,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.secondary,
    borderRadius: 2,
  },
  errorBar: {
    borderTopColor: colors.red400,
  },
  errorText: {
    color: colors.red400,
    fontSize: 13,
    flex: 1,
  },
});
