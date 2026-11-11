/**
 * Last-used Nuvio plugin provider per title.
 *
 * Persists the pluginKey (or `__all__`) that successfully served playback so
 * Continue Watching resumes quickly while validating that the plugin is still
 * installed and enabled.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ensurePluginsLoaded, pluginManager } from "./nuvio/pluginManager";
import { ALL_NUVIO_PLUGINS_ID } from "./nuvio/sourceDiscovery";

const KEY = "@moviehub/nuvio/lastProviderByTitle/v1";

type Store = Record<string, string>;

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(store: Store): Promise<void> {
  cache = store;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(store));
  } catch {}
}

export async function getLastProvider(
  mediaType: "movie" | "tv",
  tmdbId: number | string,
): Promise<string | null> {
  await ensurePluginsLoaded();
  const store = await load();
  const id = store[`${mediaType}:${tmdbId}`];
  if (!id) return null;
  if (id === ALL_NUVIO_PLUGINS_ID) return id;

  const enabled = pluginManager.getEnabledPlugins(mediaType);
  const match = enabled.find((p) => p.pluginKey === id || p.id === id);
  return match ? match.pluginKey : null;
}

export async function saveLastProvider(
  mediaType: "movie" | "tv",
  tmdbId: number | string,
  providerId: string,
): Promise<void> {
  if (!providerId) return;
  const store = await load();
  store[`${mediaType}:${tmdbId}`] = providerId;
  await persist(store);
}
