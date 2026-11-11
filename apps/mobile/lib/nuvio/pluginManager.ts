/**
 * Nuvio Plugin Manager
 *
 * Manages Nuvio-compatible plugin repositories, installed plugins, cached scripts,
 * enable/disable states, updates, and per-plugin configuration (`onSettings`).
 */

import { useEffect, useState } from "react";
import {
  compareVersions,
  computeRepoId,
  fetchAndValidateManifest,
  fetchPluginScriptText,
  normalizeManifestUrl,
  normalizeSupportedTypes,
  resolvePluginScriptUrl,
} from "./manifestManager";
import {
  auditPluginScriptCompatibility,
  executeNuvioOnSettings,
} from "./pluginRuntime";
import { diagnosticsStore } from "./diagnostics";
import { pluginStorage } from "./pluginStorage";
import type {
  InstalledPlugin,
  NuvioMediaType,
  NuvioProviderView,
  NuvioRepository,
  NuvioSettingField,
} from "./types";

interface PluginState {
  loaded: boolean;
  repos: NuvioRepository[];
  plugins: InstalledPlugin[];
  pluginSettings: Record<string, Record<string, string | boolean>>;
  syncingRepoIds: string[];
}

const state: PluginState = {
  loaded: false,
  repos: [],
  plugins: [],
  pluginSettings: {},
  syncingRepoIds: [],
};

const listeners = new Set<() => void>();
let initPromise: Promise<void> | null = null;

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

export async function ensurePluginsLoaded(): Promise<void> {
  if (state.loaded) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const [repos, plugins, pluginSettings] = await Promise.all([
      pluginStorage.loadRepos(),
      pluginStorage.loadPlugins(),
      pluginStorage.loadAllPluginSettings(),
    ]);
    state.repos = repos;
    state.plugins = plugins;
    state.pluginSettings = pluginSettings;
    state.loaded = true;

    const repoNames = new Map(repos.map((r) => [r.id, r.name]));
    for (const p of plugins) {
      const repoName = p.repoName || repoNames.get(p.repoId) || "Repository";
      diagnosticsStore.upsert(p.pluginKey, {
        repositoryName: repoName,
        providerName: p.name,
        initStatus:
          p.compatible === false
            ? "incompatible"
            : p.lastError
              ? "failed"
              : "ready",
        compatibilityError: p.incompatibilityReason || undefined,
      });
    }
    notify();
  })();

  return initPromise;
}

async function persistReposAndPlugins() {
  await Promise.all([
    pluginStorage.saveRepos(state.repos),
    pluginStorage.savePlugins(state.plugins),
  ]);
}

async function cacheAndAuditScriptsInPool(
  items: InstalledPlugin[],
  repoName: string,
  concurrency = 6,
): Promise<{ compatibleCount: number; incompatibleCount: number; incompatibleNames: string[] }> {
  let compatibleCount = 0;
  let incompatibleCount = 0;
  const incompatibleNames: string[] = [];

  // Stremio add-ons do not run remote JS scripts
  for (const p of items) {
    if (p.kind === "stremio") {
      p.compatible = true;
      p.incompatibilityReason = null;
      compatibleCount++;
      diagnosticsStore.upsert(p.pluginKey, {
        repositoryName: repoName,
        providerName: p.name,
        initStatus: "ready",
      });
    }
  }

  const scriptItems = items.filter((p) => p.kind !== "stremio");
  if (scriptItems.length === 0) {
    return { compatibleCount, incompatibleCount, incompatibleNames };
  }

  let idx = 0;
  const worker = async () => {
    while (idx < scriptItems.length) {
      const p = scriptItems[idx++];
      try {
        let code = await pluginStorage.loadPluginScript(p.pluginKey);
        if (!code) {
          code = await fetchPluginScriptText(p.scriptUrl);
          await pluginStorage.savePluginScript(p.pluginKey, code);
        }
        const audit = auditPluginScriptCompatibility(p.id, code);
        if (!audit.compatible) {
          p.compatible = false;
          p.enabled = false;
          p.incompatibilityReason =
            audit.reason || "Unsupported plugin format on Android.";
          p.lastError = p.incompatibilityReason;
          incompatibleCount++;
          incompatibleNames.push(p.name);
          diagnosticsStore.upsert(p.pluginKey, {
            repositoryName: repoName,
            providerName: p.name,
            initStatus: "incompatible",
            requestStatus: "skipped_incompatible",
            compatibilityError: p.incompatibilityReason,
          });
        } else {
          p.compatible = true;
          p.incompatibilityReason = null;
          compatibleCount++;
          diagnosticsStore.upsert(p.pluginKey, {
            repositoryName: repoName,
            providerName: p.name,
            initStatus: "ready",
            compatibilityError: "",
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.compatible = false;
        p.enabled = false;
        p.incompatibilityReason = msg;
        p.lastError = msg;
        incompatibleCount++;
        incompatibleNames.push(p.name);
        diagnosticsStore.upsert(p.pluginKey, {
          repositoryName: repoName,
          providerName: p.name,
          initStatus: "failed",
          requestStatus: "skipped_incompatible",
          compatibilityError: msg,
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, scriptItems.length) },
      () => worker(),
    ),
  );
  return { compatibleCount, incompatibleCount, incompatibleNames };
}

export const pluginManager = {
  async init(): Promise<void> {
    await ensurePluginsLoaded();
  },

  getSnapshot(): PluginState {
    return {
      ...state,
      repos: [...state.repos],
      plugins: [...state.plugins],
      syncingRepoIds: [...state.syncingRepoIds],
    };
  },

  /**
   * Add a Nuvio repository by manifest URL or repo root URL.
   * Rejects duplicate repository installations cleanly.
   */
  async addRepository(rawUrl: string): Promise<{
    repo: NuvioRepository;
    addedCount: number;
    compatibleCount: number;
    incompatibleCount: number;
    incompatibleNames: string[];
  }> {
    await ensurePluginsLoaded();
    const manifestUrl = normalizeManifestUrl(rawUrl);
    const repoId = computeRepoId(manifestUrl);

    if (state.repos.some((r) => r.id === repoId || r.manifestUrl === manifestUrl)) {
      throw new Error("This plugin repository is already installed.");
    }

    state.syncingRepoIds = [...state.syncingRepoIds, repoId];
    notify();

    try {
      const validated = await fetchAndValidateManifest(manifestUrl);
      const now = Date.now();

      const existingKeys = new Set(state.plugins.map((p) => p.pluginKey));
      const newPlugins: InstalledPlugin[] = [];

      for (const entry of validated.entries) {
        const pluginKey = `${repoId}::${entry.id}`;
        if (existingKeys.has(pluginKey)) continue;
        const scriptUrl = resolvePluginScriptUrl(validated.manifestUrl, entry);
        const pluginKind = entry.kind ?? validated.kind;
        newPlugins.push({
          pluginKey,
          id: entry.id,
          repoId,
          repoUrl: validated.manifestUrl,
          repoName: validated.manifest.name,
          kind: pluginKind,
          ...(entry.stremioConfig ? { stremioConfig: entry.stremioConfig } : {}),
          name: entry.name,
          description: entry.description ?? "",
          version: entry.version,
          author: entry.author ?? "Community",
          supportedTypes: normalizeSupportedTypes(entry.supportedTypes),
          scriptUrl,
          enabled: entry.enabled !== false,
          compatible: true,
          incompatibilityReason: null,
          logo: entry.logo,
          contentLanguage: entry.contentLanguage ?? ["en"],
          formats: entry.formats ?? [],
          limited: entry.limited === true,
          supportsExternalPlayer: entry.supportsExternalPlayer !== false,
          hasSettings: entry.hasSettings === true,
          installedAt: now,
          updatedAt: now,
          lastError: null,
        });
      }

      // Download & verify compatibility before activating any plugin
      const auditSummary = await cacheAndAuditScriptsInPool(
        newPlugins,
        validated.manifest.name,
      );

      if (newPlugins.length > 0 && auditSummary.compatibleCount === 0) {
        await Promise.all(
          newPlugins.map((p) => pluginStorage.deletePluginScript(p.pluginKey)),
        );
        const sampleReason =
          newPlugins[0]?.incompatibilityReason ||
          "No compatible plugins found for Movie Hub Android.";
        throw new Error(
          `Repository incompatible: 0/${newPlugins.length} plugins verified (${sampleReason})`,
        );
      }

      const repo: NuvioRepository = {
        id: repoId,
        url: rawUrl.trim(),
        manifestUrl: validated.manifestUrl,
        name: validated.manifest.name,
        version: validated.manifest.version,
        lastUpdatedAt: now,
        lastError:
          auditSummary.incompatibleCount > 0
            ? `${auditSummary.incompatibleCount} incompatible plugin(s) auto-disabled`
            : null,
        status: "ok",
        pluginCount: newPlugins.length,
        compatibleCount: auditSummary.compatibleCount,
        incompatibleCount: auditSummary.incompatibleCount,
        kind: validated.kind,
      };

      state.repos = [...state.repos, repo];
      state.plugins = [...state.plugins, ...newPlugins];
      await persistReposAndPlugins();
      notify();

      return {
        repo,
        addedCount: newPlugins.length,
        compatibleCount: auditSummary.compatibleCount,
        incompatibleCount: auditSummary.incompatibleCount,
        incompatibleNames: auditSummary.incompatibleNames,
      };
    } finally {
      state.syncingRepoIds = state.syncingRepoIds.filter((id) => id !== repoId);
      notify();
    }
  },

  async removeRepository(repoId: string): Promise<void> {
    await ensurePluginsLoaded();
    const toRemove = state.plugins.filter((p) => p.repoId === repoId);
    await Promise.all(
      toRemove.map(async (p) => {
        diagnosticsStore.remove(p.pluginKey);
        await pluginStorage.deletePluginScript(p.pluginKey);
      }),
    );

    const nextSettings = { ...state.pluginSettings };
    for (const p of toRemove) {
      delete nextSettings[p.pluginKey];
    }

    state.repos = state.repos.filter((r) => r.id !== repoId);
    state.plugins = state.plugins.filter((p) => p.repoId !== repoId);
    state.pluginSettings = nextSettings;
    await Promise.all([
      persistReposAndPlugins(),
      pluginStorage.saveAllPluginSettings(nextSettings),
    ]);
    notify();
  },

  async refreshRepository(repoId: string): Promise<{
    addedCount: number;
    updatesFound: number;
  }> {
    await ensurePluginsLoaded();
    const repo = state.repos.find((r) => r.id === repoId);
    if (!repo) throw new Error("Repository not found");

    state.syncingRepoIds = [...state.syncingRepoIds, repoId];
    state.repos = state.repos.map((r) =>
      r.id === repoId ? { ...r, status: "syncing", lastError: null } : r,
    );
    notify();

    try {
      const validated = await fetchAndValidateManifest(repo.manifestUrl);
      const now = Date.now();
      const remoteMap = new Map(validated.entries.map((e) => [e.id, e]));

      let updatesFound = 0;
      let addedCount = 0;
      const updatedPlugins: InstalledPlugin[] = [];

      // Keep installed state/versions and mark available updates
      for (const existing of state.plugins) {
        if (existing.repoId !== repoId) {
          updatedPlugins.push(existing);
          continue;
        }
        const remote = remoteMap.get(existing.id);
        if (!remote) {
          // Removed upstream; keep local or update metadata safely
          updatedPlugins.push(existing);
          continue;
        }
        remoteMap.delete(existing.id);

        const scriptUrl = resolvePluginScriptUrl(validated.manifestUrl, remote);
        const hasUpdate = compareVersions(remote.version, existing.version) > 0;
        if (hasUpdate) updatesFound++;

        updatedPlugins.push({
          ...existing,
          kind: remote.kind ?? existing.kind ?? validated.kind,
          ...(remote.stremioConfig
            ? { stremioConfig: remote.stremioConfig }
            : existing.stremioConfig
              ? { stremioConfig: existing.stremioConfig }
              : {}),
          name: remote.name,
          description: remote.description ?? existing.description,
          author: remote.author ?? existing.author,
          supportedTypes: normalizeSupportedTypes(remote.supportedTypes),
          scriptUrl,
          logo: remote.logo ?? existing.logo,
          contentLanguage: remote.contentLanguage ?? existing.contentLanguage,
          formats: remote.formats ?? existing.formats,
          limited: remote.limited === true,
          supportsExternalPlayer: remote.supportsExternalPlayer !== false,
          hasSettings: remote.hasSettings === true,
          updateAvailableVersion: hasUpdate ? remote.version : undefined,
        });
      }

      // Install newly published plugins from this repository
      const addedList: InstalledPlugin[] = [];
      for (const remote of remoteMap.values()) {
        const pluginKey = `${repoId}::${remote.id}`;
        const scriptUrl = resolvePluginScriptUrl(validated.manifestUrl, remote);
        const item: InstalledPlugin = {
          pluginKey,
          id: remote.id,
          repoId,
          repoUrl: validated.manifestUrl,
          kind: remote.kind ?? validated.kind,
          ...(remote.stremioConfig ? { stremioConfig: remote.stremioConfig } : {}),
          name: remote.name,
          description: remote.description ?? "",
          version: remote.version,
          author: remote.author ?? "Community",
          supportedTypes: normalizeSupportedTypes(remote.supportedTypes),
          scriptUrl,
          enabled: remote.enabled !== false,
          logo: remote.logo,
          contentLanguage: remote.contentLanguage ?? ["en"],
          formats: remote.formats ?? [],
          limited: remote.limited === true,
          supportsExternalPlayer: remote.supportsExternalPlayer !== false,
          hasSettings: remote.hasSettings === true,
          installedAt: now,
          updatedAt: now,
          lastError: null,
        };
        addedList.push(item);
        updatedPlugins.push(item);
        addedCount++;
      }

      if (addedList.length > 0) {
        await cacheAndAuditScriptsInPool(addedList, validated.manifest.name);
      }

      const repoPlugins = updatedPlugins.filter((p) => p.repoId === repoId);
      const compatibleCount = repoPlugins.filter((p) => p.compatible !== false).length;
      const incompatibleCount = repoPlugins.length - compatibleCount;

      state.plugins = updatedPlugins;
      state.repos = state.repos.map((r) =>
        r.id === repoId
          ? {
              ...r,
              name: validated.manifest.name,
              version: validated.manifest.version,
              lastUpdatedAt: now,
              lastError:
                incompatibleCount > 0
                  ? `${incompatibleCount} incompatible plugin(s) auto-disabled`
                  : null,
              status: compatibleCount === 0 && incompatibleCount > 0 ? "error" : "ok",
              pluginCount: validated.entries.length,
              compatibleCount,
              incompatibleCount,
            }
          : r,
      );
      await persistReposAndPlugins();
      notify();
      return { addedCount, updatesFound };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Refresh failed";
      state.repos = state.repos.map((r) =>
        r.id === repoId ? { ...r, status: "error", lastError: msg } : r,
      );
      await pluginStorage.saveRepos(state.repos);
      notify();
      throw err;
    } finally {
      state.syncingRepoIds = state.syncingRepoIds.filter((id) => id !== repoId);
      notify();
    }
  },

  async refreshAllRepositories(): Promise<void> {
    await ensurePluginsLoaded();
    for (const r of [...state.repos]) {
      try {
        await this.refreshRepository(r.id);
      } catch {
        // Error recorded on repository status
      }
    }
  },

  async setPluginEnabled(pluginKey: string, enabled: boolean): Promise<void> {
    await ensurePluginsLoaded();
    const target = state.plugins.find((p) => p.pluginKey === pluginKey);
    if (!target) return;

    let compatibilityError: string | null = null;
    if (enabled && target.kind !== "stremio") {
      if (target.compatible === false) {
        throw new Error(
          target.incompatibilityReason ||
            `"${target.name}" is incompatible with Movie Hub Android.`,
        );
      }
      // Download and verify compatibility before enabling
      let code = await pluginStorage.loadPluginScript(pluginKey);
      if (!code) {
        code = await fetchPluginScriptText(target.scriptUrl);
        await pluginStorage.savePluginScript(pluginKey, code);
      }
      const audit = auditPluginScriptCompatibility(target.id, code);
      if (!audit.compatible) {
        compatibilityError =
          audit.reason || "Unsupported plugin format on Android.";
        state.plugins = state.plugins.map((p) =>
          p.pluginKey === pluginKey
            ? {
                ...p,
                enabled: false,
                compatible: false,
                incompatibilityReason: compatibilityError,
                lastError: compatibilityError,
              }
            : p,
        );
        await pluginStorage.savePlugins(state.plugins);
        notify();
        throw new Error(compatibilityError);
      }
    }

    state.plugins = state.plugins.map((p) =>
      p.pluginKey === pluginKey
        ? { ...p, enabled, compatible: true, incompatibilityReason: null, lastError: null }
        : p,
    );
    await pluginStorage.savePlugins(state.plugins);
    notify();
  },

  async updatePlugin(pluginKey: string): Promise<void> {
    await ensurePluginsLoaded();
    const target = state.plugins.find((p) => p.pluginKey === pluginKey);
    if (!target) throw new Error("Plugin not found");

    if (target.kind === "stremio") {
      await this.refreshRepository(target.repoId);
      return;
    }

    const code = await fetchPluginScriptText(target.scriptUrl);
    await pluginStorage.savePluginScript(pluginKey, code);
    const audit = auditPluginScriptCompatibility(target.id, code);

    state.plugins = state.plugins.map((p) =>
      p.pluginKey === pluginKey
        ? {
            ...p,
            version: p.updateAvailableVersion ?? p.version,
            updateAvailableVersion: undefined,
            updatedAt: Date.now(),
            compatible: audit.compatible,
            enabled: audit.compatible ? p.enabled : false,
            incompatibilityReason: audit.compatible ? null : audit.reason ?? "Incompatible",
            lastError: audit.compatible ? null : audit.reason ?? "Incompatible",
          }
        : p,
    );
    await pluginStorage.savePlugins(state.plugins);
    notify();
  },

  async updateAllPlugins(): Promise<number> {
    await ensurePluginsLoaded();
    const outdated = state.plugins.filter((p) => !!p.updateAvailableVersion);
    let updated = 0;
    for (const p of outdated) {
      try {
        await this.updatePlugin(p.pluginKey);
        updated++;
      } catch {}
    }
    return updated;
  },

  async removePlugin(pluginKey: string): Promise<void> {
    await ensurePluginsLoaded();
    await pluginStorage.deletePluginScript(pluginKey);
    const nextSettings = { ...state.pluginSettings };
    delete nextSettings[pluginKey];

    state.plugins = state.plugins.filter((p) => p.pluginKey !== pluginKey);
    state.pluginSettings = nextSettings;
    await Promise.all([
      pluginStorage.savePlugins(state.plugins),
      pluginStorage.saveAllPluginSettings(nextSettings),
    ]);
    notify();
  },

  async ensurePluginScript(pluginKey: string): Promise<string> {
    await ensurePluginsLoaded();
    const target = state.plugins.find((p) => p.pluginKey === pluginKey);
    if (!target) {
      throw new Error("Plugin script not found");
    }
    if (target.kind === "stremio") {
      return "";
    }
    const cached = await pluginStorage.loadPluginScript(pluginKey);
    if (cached) return cached;

    const code = await fetchPluginScriptText(target.scriptUrl);
    await pluginStorage.savePluginScript(pluginKey, code);
    return code;
  },

  getPluginSettings(pluginKey: string): Record<string, string | boolean> {
    return state.pluginSettings[pluginKey] ?? {};
  },

  async updatePluginSetting(
    pluginKey: string,
    key: string,
    value: string | boolean,
  ): Promise<void> {
    await ensurePluginsLoaded();
    const prev = state.pluginSettings[pluginKey] ?? {};
    state.pluginSettings = {
      ...state.pluginSettings,
      [pluginKey]: { ...prev, [key]: value },
    };
    await pluginStorage.saveAllPluginSettings(state.pluginSettings);
    notify();
  },

  async fetchPluginSettingsSchema(
    pluginKey: string,
  ): Promise<NuvioSettingField[]> {
    await ensurePluginsLoaded();
    const target = state.plugins.find((p) => p.pluginKey === pluginKey);
    if (!target || target.kind === "stremio") return [];
    const code = await this.ensurePluginScript(pluginKey);
    return executeNuvioOnSettings(
      target.id,
      code,
      this.getPluginSettings(pluginKey),
    );
  },

  getEnabledPlugins(mediaType?: NuvioMediaType): InstalledPlugin[] {
    return state.plugins.filter((p) => {
      if (!p.enabled || p.compatible === false) return false;
      if (mediaType && !p.supportedTypes.includes(mediaType)) return false;
      return true;
    });
  },

  getPluginByKeyOrId(keyOrId: string): InstalledPlugin | undefined {
    return state.plugins.find(
      (p) => p.pluginKey === keyOrId || p.id === keyOrId,
    );
  },

  /** Convert enabled plugins into UI-ready Server/Provider entries */
  getProviderViews(mediaType?: NuvioMediaType): NuvioProviderView[] {
    return this.getEnabledPlugins(mediaType).map((p) => ({
      id: p.pluginKey,
      pluginKey: p.pluginKey,
      name: p.name,
      displayName: p.name,
      description: p.description,
      version: p.version,
      author: p.author,
      logo: p.logo,
      contentLanguage: p.contentLanguage,
      formats: p.formats,
      supportedTypes: p.supportedTypes,
    }));
  },
};

export function useNuvioPlugins() {
  const [snap, setSnap] = useState<PluginState>(() =>
    pluginManager.getSnapshot(),
  );

  useEffect(() => {
    const sub = () => setSnap(pluginManager.getSnapshot());
    listeners.add(sub);
    void ensurePluginsLoaded();
    return () => {
      listeners.delete(sub);
    };
  }, []);

  return {
    ...snap,
    addRepository: pluginManager.addRepository.bind(pluginManager),
    removeRepository: pluginManager.removeRepository.bind(pluginManager),
    refreshRepository: pluginManager.refreshRepository.bind(pluginManager),
    refreshAllRepositories:
      pluginManager.refreshAllRepositories.bind(pluginManager),
    setPluginEnabled: pluginManager.setPluginEnabled.bind(pluginManager),
    updatePlugin: pluginManager.updatePlugin.bind(pluginManager),
    updateAllPlugins: pluginManager.updateAllPlugins.bind(pluginManager),
    removePlugin: pluginManager.removePlugin.bind(pluginManager),
    getPluginSettings: pluginManager.getPluginSettings.bind(pluginManager),
    updatePluginSetting: pluginManager.updatePluginSetting.bind(pluginManager),
    fetchPluginSettingsSchema:
      pluginManager.fetchPluginSettingsSchema.bind(pluginManager),
    getEnabledPlugins: pluginManager.getEnabledPlugins.bind(pluginManager),
    getProviderViews: pluginManager.getProviderViews.bind(pluginManager),
  };
}
