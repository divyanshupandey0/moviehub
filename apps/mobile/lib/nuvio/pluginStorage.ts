/**
 * Dedicated Nuvio Plugin Storage Layer.
 *
 * Strictly isolated from TMDB metadata, Watchlist, Watch History,
 * and main app settings.
 *
 * - Repositories, plugin metadata, enable states, and per-plugin user settings
 *   are stored in AsyncStorage under `@moviehub/nuvio/*`.
 * - Compiled plugin `.js` scripts are cached on local filesystem under
 *   `${documentDirectory}nuvio_plugins/` so they survive restarts cleanly
 *   without bloating AsyncStorage SQLite rows.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  readAsStringAsync,
  writeAsStringAsync,
  deleteAsync,
} from "expo-file-system/legacy";
import type { InstalledPlugin, NuvioRepository } from "./types";

const KEY_REPOS = "@moviehub/nuvio/repos/v1";
const KEY_PLUGINS = "@moviehub/nuvio/plugins/v1";
const KEY_PLUGIN_SETTINGS = "@moviehub/nuvio/plugin-settings/v1";

const PLUGINS_DIR = documentDirectory
  ? `${documentDirectory}nuvio_plugins/`
  : null;

function sanitizeFileName(pluginKey: string): string {
  return pluginKey.replace(/[^a-zA-Z0-9._-]/g, "_") + ".js";
}

async function ensurePluginsDir(): Promise<string | null> {
  if (
    !PLUGINS_DIR ||
    typeof getInfoAsync !== "function" ||
    typeof makeDirectoryAsync !== "function"
  ) {
    return null;
  }
  try {
    const info = await getInfoAsync(PLUGINS_DIR);
    if (!info?.exists) {
      await makeDirectoryAsync(PLUGINS_DIR, { intermediates: true });
    }
    return PLUGINS_DIR;
  } catch {
    return null;
  }
}

// Memory fallback if documentDirectory is unavailable in test runners
const MEMORY_SCRIPTS = new Map<string, string>();

export const pluginStorage = {
  async loadRepos(): Promise<NuvioRepository[]> {
    try {
      const raw = await AsyncStorage.getItem(KEY_REPOS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },

  async saveRepos(repos: NuvioRepository[]): Promise<void> {
    await AsyncStorage.setItem(KEY_REPOS, JSON.stringify(repos));
  },

  async loadPlugins(): Promise<InstalledPlugin[]> {
    try {
      const raw = await AsyncStorage.getItem(KEY_PLUGINS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },

  async savePlugins(plugins: InstalledPlugin[]): Promise<void> {
    await AsyncStorage.setItem(KEY_PLUGINS, JSON.stringify(plugins));
  },

  async loadAllPluginSettings(): Promise<
    Record<string, Record<string, string | boolean>>
  > {
    try {
      const raw = await AsyncStorage.getItem(KEY_PLUGIN_SETTINGS);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  },

  async saveAllPluginSettings(
    settingsMap: Record<string, Record<string, string | boolean>>,
  ): Promise<void> {
    await AsyncStorage.setItem(
      KEY_PLUGIN_SETTINGS,
      JSON.stringify(settingsMap),
    );
  },

  async savePluginScript(pluginKey: string, code: string): Promise<void> {
    MEMORY_SCRIPTS.set(pluginKey, code);
    const dir = await ensurePluginsDir();
    if (!dir || typeof writeAsStringAsync !== "function") return;
    try {
      await writeAsStringAsync(`${dir}${sanitizeFileName(pluginKey)}`, code);
    } catch {
      // Keep memory copy if FS write fails
    }
  },

  async loadPluginScript(pluginKey: string): Promise<string | null> {
    const mem = MEMORY_SCRIPTS.get(pluginKey);
    if (mem) return mem;
    const dir = await ensurePluginsDir();
    if (
      !dir ||
      typeof getInfoAsync !== "function" ||
      typeof readAsStringAsync !== "function"
    ) {
      return null;
    }
    try {
      const fileUri = `${dir}${sanitizeFileName(pluginKey)}`;
      const info = await getInfoAsync(fileUri);
      if (!info?.exists) return null;
      const code = await readAsStringAsync(fileUri);
      if (code) MEMORY_SCRIPTS.set(pluginKey, code);
      return code || null;
    } catch {
      return null;
    }
  },

  async deletePluginScript(pluginKey: string): Promise<void> {
    MEMORY_SCRIPTS.delete(pluginKey);
    const dir = await ensurePluginsDir();
    if (
      !dir ||
      typeof getInfoAsync !== "function" ||
      typeof deleteAsync !== "function"
    ) {
      return;
    }
    try {
      const fileUri = `${dir}${sanitizeFileName(pluginKey)}`;
      const info = await getInfoAsync(fileUri);
      if (info?.exists) {
        await deleteAsync(fileUri, { idempotent: true });
      }
    } catch {
      // Ignore delete cleanup errors
    }
  },
};
