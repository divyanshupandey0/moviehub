import { requireNativeModule } from "expo-modules-core";

let nativeModule: any = null;
try {
  nativeModule = requireNativeModule("SubtitleSync");
} catch (e) {
  console.warn("[SubtitleSync] Native module 'SubtitleSync' not available, using safe stub fallback");
}

const stub = {
  addListener: () => ({ remove: () => {} }),
  removeListeners: () => {},
  extractAsync: async () => ({ ok: false, code: "busy", message: "Native module not available" }),
  scanAsync: async () => ({ ok: false, code: "busy", message: "Native module not available" }),
  scanStatus: () => ({ phase: "idle", progress: 0, trace: [] }),
  cancelScan: () => false,
  setPlayerStruggling: () => {},
  tapProbe: () => ({
    pcmBytes: 0,
    chunkCount: 0,
    energySum: 0,
    peakSample: 0,
    clippedSamples: 0,
    activeMs: 0,
    silentMs: 0,
    sampleRate: 0,
    channelCount: 0,
    encoding: 0,
    flushes: 0,
    segmentResets: 0,
    listening: false,
    monotonicMs: 0,
  }),
  playerThroughputMbps: () => -1,
  resetPlayerTraffic: () => {},
  tapProbeReset: () => {},
  activateWatchSync: async () => ({ ok: false, active: false, anchorSec: 0, windowSec: 0 }),
  watchAnchor: () => false,
  stopWatchSync: () => false,
  watchSyncStatus: () => ({ active: false }),
  probeAsync: async () => ({ ok: false, code: "network", message: "Native module not available" }),
};

export default nativeModule ?? stub;
