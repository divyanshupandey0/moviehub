/**
 * Provider Diagnostics & Sensitive Credential Redaction.
 *
 * Tracks developer-level telemetry per provider without exposing passwords,
 * API keys, cookies, or private tokens.
 */

import { useEffect, useState } from "react";
import type { ProviderDiagnosticRecord } from "./types";

const SENSITIVE_PARAM_RE =
  /([?&](?:api_key|apikey|token|access_token|auth|authorization|key|secret|password|cookie|session|sig|signature)=)[^&\s"'`]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const SENSITIVE_HEADER_RE =
  /((?:authorization|cookie|set-cookie|x-api-key|password|secret|token)\s*[:=]\s*)[^\r\n,;'"`]+/gi;

export function redactSensitiveText(input: unknown): string {
  const raw = typeof input === "string" ? input : String(input ?? "");
  return raw
    .replace(SENSITIVE_PARAM_RE, "$1[REDACTED]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(SENSITIVE_HEADER_RE, "$1[REDACTED]");
}

const RECORDS = new Map<string, ProviderDiagnosticRecord>();
const LISTENERS = new Set<() => void>();

function notify() {
  for (const fn of LISTENERS) {
    try {
      fn();
    } catch {}
  }
}

export const diagnosticsStore = {
  upsert(
    pluginKey: string,
    patch: Partial<ProviderDiagnosticRecord> & {
      repositoryName: string;
      providerName: string;
    },
  ): void {
    const prev = RECORDS.get(pluginKey);
    const next: ProviderDiagnosticRecord = {
      pluginKey,
      repositoryName: patch.repositoryName,
      providerName: patch.providerName,
      initStatus: patch.initStatus ?? prev?.initStatus ?? "pending",
      requestStatus: patch.requestStatus ?? prev?.requestStatus ?? "idle",
      responseTimeMs:
        patch.responseTimeMs !== undefined
          ? patch.responseTimeMs
          : (prev?.responseTimeMs ?? null),
      sourcesReturned:
        patch.sourcesReturned !== undefined
          ? patch.sourcesReturned
          : (prev?.sourcesReturned ?? 0),
      parsingError:
        patch.parsingError !== undefined
          ? patch.parsingError
            ? redactSensitiveText(patch.parsingError)
            : undefined
          : prev?.parsingError,
      compatibilityError:
        patch.compatibilityError !== undefined
          ? patch.compatibilityError
            ? redactSensitiveText(patch.compatibilityError)
            : undefined
          : prev?.compatibilityError,
      playbackHandoffStatus:
        patch.playbackHandoffStatus ??
        prev?.playbackHandoffStatus ??
        "not_started",
      updatedAt: Date.now(),
    };
    RECORDS.set(pluginKey, next);
    notify();
  },

  remove(pluginKey: string): void {
    if (RECORDS.delete(pluginKey)) notify();
  },

  clear(): void {
    if (RECORDS.size > 0) {
      RECORDS.clear();
      notify();
    }
  },

  list(): ProviderDiagnosticRecord[] {
    return Array.from(RECORDS.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  },

  markPlaybackHandoff(
    pluginKey: string | undefined,
    status: ProviderDiagnosticRecord["playbackHandoffStatus"],
    errorDetail?: string,
  ): void {
    if (!pluginKey) return;
    const prev = RECORDS.get(pluginKey);
    if (!prev) return;
    RECORDS.set(pluginKey, {
      ...prev,
      playbackHandoffStatus: status,
      ...(errorDetail ? { parsingError: redactSensitiveText(errorDetail) } : {}),
      updatedAt: Date.now(),
    });
    notify();
  },
};

export function usePluginDiagnostics(): ProviderDiagnosticRecord[] {
  const [items, setItems] = useState<ProviderDiagnosticRecord[]>(() =>
    diagnosticsStore.list(),
  );

  useEffect(() => {
    const onChange = () => setItems(diagnosticsStore.list());
    LISTENERS.add(onChange);
    return () => {
      LISTENERS.delete(onChange);
    };
  }, []);

  return items;
}
