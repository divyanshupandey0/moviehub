import { useEffect, useCallback, useRef, useState } from "react";
import * as Updates from "expo-updates";

const CHECK_COOLDOWN_MS = 15 * 60 * 1000; // 15-minute cooldown between automated checks

/**
 * useUpdateCheck — call once at app root.
 *
 * Uses expo-updates to check for and apply JS bundle updates.
 * - Handles server unavailability / missing channels gracefully.
 * - Prevents multiple simultaneous update requests.
 * - Suppresses persistent error banners across navigation.
 * - Displays update notification modal only when a valid update is ready.
 */
export function useUpdateCheck() {
  const {
    isUpdateAvailable,
    isUpdatePending,
    isChecking: hookChecking,
    isDownloading: hookDownloading,
    downloadProgress,
    currentlyRunning,
  } = Updates.useUpdates();

  const [manualCheckActive, setManualCheckActive] = useState(false);
  const [transientError, setTransientError] = useState<string | null>(null);
  const [downloadingInternal, setDownloadingInternal] = useState(false);

  const inFlightRef = useRef(false);
  const lastCheckTimeRef = useRef(0);
  const hasAutoAttemptedRef = useRef(false);

  // ── Auto-download when a verified update becomes available ──
  useEffect(() => {
    if (!Updates.isEnabled) return;
    if (
      isUpdateAvailable &&
      !isUpdatePending &&
      !hookDownloading &&
      !downloadingInternal
    ) {
      if (hasAutoAttemptedRef.current) return;
      hasAutoAttemptedRef.current = true;
      setDownloadingInternal(true);
      console.log("[UpdateCheck] Verified update available, downloading bundle...");

      Updates.fetchUpdateAsync()
        .then(() => {
          console.log("[UpdateCheck] Update downloaded successfully and ready for reload.");
        })
        .catch((err) => {
          console.warn(
            "[UpdateCheck] Remote update download failed gracefully (server may be unavailable):",
            err?.message,
          );
        })
        .finally(() => {
          setDownloadingInternal(false);
        });
    }
  }, [isUpdateAvailable, isUpdatePending, hookDownloading, downloadingInternal]);

  // ── Safe manual check with concurrency lock & timeout ──
  const checkNow = useCallback(async () => {
    if (!Updates.isEnabled) {
      console.log("[UpdateCheck] Updates are disabled in this environment.");
      return;
    }
    if (inFlightRef.current) return;

    const now = Date.now();
    if (now - lastCheckTimeRef.current < 5000) {
      console.log("[UpdateCheck] Check throttled.");
      return;
    }

    inFlightRef.current = true;
    lastCheckTimeRef.current = now;
    setManualCheckActive(true);
    setTransientError(null);

    try {
      console.log("[UpdateCheck] Checking for remote update...");
      const result = await Promise.race([
        Updates.checkForUpdateAsync(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Update check timed out")), 10000),
        ),
      ]);

      if (result.isAvailable) {
        console.log("[UpdateCheck] Remote update found, fetching...");
        setDownloadingInternal(true);
        await Updates.fetchUpdateAsync();
      } else {
        console.log("[UpdateCheck] Already on latest version.");
      }
    } catch (err: any) {
      const msg = err?.message || "Remote update server unavailable";
      console.warn("[UpdateCheck] Check handled gracefully:", msg);
      setTransientError(msg);
    } finally {
      inFlightRef.current = false;
      setManualCheckActive(false);
      setDownloadingInternal(false);
    }
  }, []);

  // ── Apply update (restart app) ──
  const applyUpdate = useCallback(async () => {
    try {
      console.log("[UpdateCheck] Reloading to apply update...");
      await Updates.reloadAsync();
    } catch (err: any) {
      console.error("[UpdateCheck] Reload failed:", err?.message);
    }
  }, []);

  const dismissError = useCallback(() => {
    setTransientError(null);
  }, []);

  const isDownloading = hookDownloading || downloadingInternal;
  const isChecking = hookChecking || manualCheckActive;

  // Background launch check errors are handled gracefully (never persistent)
  const errorMessage = transientError;

  const phase = isDownloading
    ? ("downloading" as const)
    : isUpdatePending
      ? ("pending" as const)
      : isChecking
        ? ("checking" as const)
        : errorMessage
          ? ("error" as const)
          : ("idle" as const);

  const progress =
    downloadProgress != null ? Math.round(downloadProgress * 100) : 0;

  return {
    phase,
    progress,
    showRestartPrompt: isUpdatePending,
    isDownloading,
    isChecking,
    errorMessage,
    dismissError,
    currentVersion: currentlyRunning?.updateId ? "update" : "embedded",
    isOriginalBuild: currentlyRunning?.isEmbeddedLaunch ?? true,
    applyUpdate,
    checkNow,
  };
}
