/**
 * Isolated Nuvio Plugin JavaScript Runtime.
 *
 * Implements the authoritative Nuvio plugin execution contract inside a
 * restricted sandbox hardened for React Native / Hermes:
 * - Entry points: `getStreams(tmdbId, mediaType, season, episode)` (Promise, sync, or callback)
 *   and optional `onSettings()`
 * - External CommonJS modules: `cheerio-without-node-native` (`cheerio`, `react-native-cheerio`),
 *   `crypto-js`, `axios` (with `interceptors`, `isAxiosError`, `all`, `spread`, `CancelToken`),
 *   `buffer`, `url`, `querystring`, `events`, `crypto`
 * - Globals: `fetch` (HTTP/HTTPS only), `XMLHttpRequest` shim, `Headers`, `FormData`,
 *   `TextDecoder`/`TextEncoder`, `AbortController`/`AbortSignal` (+ `.timeout`),
 *   tracked `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`, `console`, `SCRAPER_SETTINGS`
 * - Guards all optional methods, non-string coercions, and missing exports so third-party
 *   bundles never crash with `TypeError: undefined is not a function`
 */

// CommonJS requires preserve direct function+property exports (e.g. cheerio.load)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cheerioModule = require("cheerio-without-node-native");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CryptoJS = require("crypto-js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cryptoShim = require("./shims/cryptoShim");
import { Buffer as BufferPolyfill } from "buffer";
import { getApiBaseUrl } from "../api";
import { redactSensitiveText } from "./diagnostics";
import type {
  NuvioMediaType,
  NuvioSettingField,
  NuvioStream,
  PluginErrorCategory,
  PluginExecutionResult,
} from "./types";

const PLUGIN_EXEC_TIMEOUT_MS = 20_000;
const PLUGIN_HTTP_TIMEOUT_MS = 12_000;

const BLOCKED_MODULES = new Set([
  "fs",
  "path",
  "os",
  "child_process",
  "net",
  "tls",
  "dgram",
  "dns",
  "http",
  "http2",
  "https",
  "zlib",
  "util",
  "util/types",
  "assert",
  "async_hooks",
  "diagnostics_channel",
  "cluster",
  "worker_threads",
  "ws",
  "react-native",
  "expo-file-system",
  "expo-file-system/legacy",
  "@react-native-async-storage/async-storage",
  "expo-modules-core",
]);

const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

class SimpleEventEmitter {
  private map = new Map<string, Set<(...args: any[]) => void>>();
  on(event: string, fn: (...args: any[]) => void) {
    if (typeof fn !== "function") return this;
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event)!.add(fn);
    return this;
  }
  addListener(event: string, fn: (...args: any[]) => void) {
    return this.on(event, fn);
  }
  once(event: string, fn: (...args: any[]) => void) {
    if (typeof fn !== "function") return this;
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string, fn: (...args: any[]) => void) {
    this.map.get(event)?.delete(fn);
    return this;
  }
  removeListener(event: string, fn: (...args: any[]) => void) {
    return this.off(event, fn);
  }
  emit(event: string, ...args: any[]) {
    const listeners = this.map.get(event);
    if (!listeners || listeners.size === 0) return false;
    for (const fn of Array.from(listeners)) {
      try {
        fn(...args);
      } catch {}
    }
    return true;
  }
}

function getSafeTextDecoder(): typeof TextDecoder {
  if (typeof globalThis.TextDecoder === "function") {
    return globalThis.TextDecoder;
  }
  return class FallbackTextDecoder {
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return "";
      const view =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return BufferPolyfill.from(view).toString("utf8");
    }
  } as unknown as typeof TextDecoder;
}

function getSafeTextEncoder(): typeof TextEncoder {
  if (typeof globalThis.TextEncoder === "function") {
    return globalThis.TextEncoder;
  }
  return class FallbackTextEncoder {
    encode(str = ""): Uint8Array {
      return new Uint8Array(BufferPolyfill.from(String(str), "utf8"));
    }
  } as unknown as typeof TextEncoder;
}

function ensureAbortSignalCompat() {
  const BaseSignal = globalThis.AbortSignal as any;
  if (!BaseSignal) return BaseSignal;
  if (typeof BaseSignal.timeout === "function") return BaseSignal;
  const wrapped = Object.create(BaseSignal);
  wrapped.timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), Math.max(0, Number(ms) || 0));
    return c.signal;
  };
  return wrapped;
}

function safeAddAbortListener(
  signal: AbortSignal | undefined | null,
  cb: () => void,
): (() => void) | null {
  if (!signal || typeof signal.addEventListener !== "function") return null;
  if (signal.aborted) {
    cb();
    return null;
  }
  signal.addEventListener("abort", cb, { once: true });
  return () => {
    if (typeof signal.removeEventListener === "function") {
      try {
        signal.removeEventListener("abort", cb);
      } catch {}
    }
  };
}

function isAllowedNetworkUrl(rawUrl: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        ok: false,
        reason: `Blocked disallowed scheme "${parsed.protocol}"`,
      };
    }
    const host = parsed.hostname.toLowerCase();
    // Protect Movie Hub's backend auth/storage while allowing public metadata APIs like TMDB
    if (host.endsWith("supabase.co")) {
      return {
        ok: false,
        reason: `Plugin network access to restricted host "${host}" is blocked`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
}

function buildSafeHeaders(initHeaders?: HeadersInit): Headers {
  const headers = new Headers();
  if (initHeaders) {
    try {
      if (initHeaders instanceof Headers && typeof initHeaders.forEach === "function") {
        initHeaders.forEach((v, k) => headers.set(k, String(v)));
      } else if (Array.isArray(initHeaders)) {
        for (const pair of initHeaders) {
          if (Array.isArray(pair) && pair.length >= 2 && pair[0] != null && pair[1] != null) {
            headers.set(String(pair[0]), String(pair[1]));
          }
        }
      } else if (typeof initHeaders === "object") {
        for (const [k, v] of Object.entries(initHeaders as Record<string, unknown>)) {
          if (v !== undefined && v !== null) {
            headers.set(k, String(v));
          }
        }
      }
    } catch {
      // Ignore malformed custom header shapes rather than throwing
    }
  }
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", DEFAULT_BROWSER_UA);
  }
  return headers;
}

function extractResponseHeaders(resHeaders: Headers | Record<string, any> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!resHeaders) return out;
  if (typeof (resHeaders as Headers).forEach === "function") {
    (resHeaders as Headers).forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  if (typeof (resHeaders as any).entries === "function") {
    for (const [k, v] of (resHeaders as any).entries()) {
      out[String(k).toLowerCase()] = String(v);
    }
    return out;
  }
  if (typeof resHeaders === "object") {
    for (const [k, v] of Object.entries(resHeaders)) {
      if (v !== undefined && v !== null) {
        out[k.toLowerCase()] = String(v);
      }
    }
  }
  return out;
}

function buildTmdbProxyUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== "api.themoviedb.org") return null;
    if (!parsed.pathname.startsWith("/3/")) return null;
    const apiBase = getApiBaseUrl();
    if (!apiBase || /localhost|127\.0\.0\.1/i.test(apiBase)) return null;
    const tmdbPath = parsed.pathname.replace(/^\/3/, "");
    const params = new URLSearchParams(parsed.search);
    params.delete("api_key");
    const qs = params.toString();
    return `${apiBase.replace(/\/+$/, "")}/api/tmdb${tmdbPath}${qs ? `?${qs}` : ""}`;
  } catch {
    return null;
  }
}

function createSandboxedFetch(
  pluginId: string,
  parentSignal: AbortSignal,
  registerTimer: (id: ReturnType<typeof setTimeout>) => void,
) {
  return async function sandboxedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (parentSignal.aborted) {
      throw new Error("Plugin execution aborted");
    }

    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input === "object" && "url" in input
            ? String((input as Request).url)
            : String(input ?? "");

    const check = isAllowedNetworkUrl(rawUrl);
    if (!check.ok) {
      throw new Error(`[Nuvio:${pluginId}] ${check.reason}`);
    }

    const reqController = new AbortController();
    const timeoutId = setTimeout(
      () => reqController.abort(),
      PLUGIN_HTTP_TIMEOUT_MS,
    );
    registerTimer(timeoutId);

    const detachParent = safeAddAbortListener(parentSignal, () =>
      reqController.abort(),
    );
    const detachCaller = safeAddAbortListener(init?.signal, () =>
      reqController.abort(),
    );

    const headers = buildSafeHeaders(init?.headers);

    try {
      const tmdbProxyUrl =
        (!init?.method || init.method.toUpperCase() === "GET")
          ? buildTmdbProxyUrl(rawUrl)
          : null;

      if (tmdbProxyUrl) {
        try {
          const proxyRes = await fetch(tmdbProxyUrl, {
            method: "GET",
            headers,
            signal: reqController.signal,
          });
          if (proxyRes.ok) return proxyRes;
        } catch {
          // Fall back to direct TMDB request below if proxy unavailable
        }
      }

      return await fetch(rawUrl, {
        ...init,
        headers,
        signal: reqController.signal,
      });
    } finally {
      clearTimeout(timeoutId);
      detachParent?.();
      detachCaller?.();
    }
  };
}

/**
 * Lightweight XHR wrapper backed by `sandboxedFetch` so plugins or bundled
 * helpers that instantiate `new XMLHttpRequest()` never hit `undefined is not a function`.
 */
function createSandboxedXHR(
  sandboxedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return class SandboxedXMLHttpRequest {
    readyState = 0;
    status = 0;
    statusText = "";
    responseText = "";
    response: any = "";
    responseType = "";
    timeout = 0;
    withCredentials = false;
    onload: (() => void) | null = null;
    onerror: ((err?: any) => void) | null = null;
    onreadystatechange: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    private method = "GET";
    private url = "";
    private reqHeaders: Record<string, string> = {};
    private respHeaders: Record<string, string> = {};
    private controller: AbortController | null = null;
    private listeners = new SimpleEventEmitter();

    addEventListener(evt: string, fn: (...a: any[]) => void) {
      this.listeners.on(evt, fn);
    }
    removeEventListener(evt: string, fn: (...a: any[]) => void) {
      this.listeners.off(evt, fn);
    }
    open(method: string, url: string) {
      this.method = String(method || "GET").toUpperCase();
      this.url = String(url || "");
      this.readyState = 1;
      this.onreadystatechange?.();
    }
    setRequestHeader(k: string, v: string) {
      this.reqHeaders[String(k)] = String(v);
    }
    getAllResponseHeaders(): string {
      return Object.entries(this.respHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
    }
    getResponseHeader(name: string): string | null {
      return this.respHeaders[String(name).toLowerCase()] ?? null;
    }
    abort() {
      this.controller?.abort();
    }
    send(body?: any) {
      this.controller = new AbortController();
      void sandboxedFetch(this.url, {
        method: this.method,
        headers: this.reqHeaders,
        body: body != null && this.method !== "GET" && this.method !== "HEAD" ? body : undefined,
        signal: this.controller.signal,
      })
        .then(async (res) => {
          this.status = res.status;
          this.statusText = res.statusText || "";
          this.respHeaders = extractResponseHeaders(res.headers);
          if (this.responseType === "arraybuffer") {
            this.response = await res.arrayBuffer();
            this.responseText = "";
          } else {
            const txt = await res.text();
            this.responseText = txt;
            this.response =
              this.responseType === "json"
                ? (() => {
                    try {
                      return JSON.parse(txt);
                    } catch {
                      return null;
                    }
                  })()
                : txt;
          }
          this.readyState = 4;
          this.onreadystatechange?.();
          this.onload?.();
          this.listeners.emit("load");
        })
        .catch((err) => {
          this.readyState = 4;
          this.onerror?.(err);
          this.listeners.emit("error", err);
        });
    }
  };
}

interface InterceptorEntry<T> {
  fulfilled?: (val: T) => T | Promise<T>;
  rejected?: (err: any) => any;
}

class InterceptorManager<T> {
  private handlers: Array<InterceptorEntry<T> | null> = [];
  use(fulfilled?: (val: T) => T | Promise<T>, rejected?: (err: any) => any): number {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }
  eject(id: number): void {
    if (this.handlers[id]) this.handlers[id] = null;
  }
  clear(): void {
    this.handlers = [];
  }
  entries(): Array<InterceptorEntry<T>> {
    return this.handlers.filter((h): h is InterceptorEntry<T> => h !== null);
  }
}

/**
 * Axios-compatible wrapper routed strictly through `sandboxedFetch`
 * including interceptors, helpers (`isAxiosError`, `all`, `spread`, `CancelToken`),
 * and defensive header/param parsing.
 */
function createSandboxedAxios(
  sandboxedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  baseDefaults: Record<string, any> = {},
) {
  const reqInterceptors = new InterceptorManager<any>();
  const resInterceptors = new InterceptorManager<any>();

  async function request(configOrUrl: any, maybeConfig?: any) {
    const cfg =
      typeof configOrUrl === "string"
        ? { ...(maybeConfig || {}), url: configOrUrl }
        : { ...(configOrUrl || {}) };

    let merged: Record<string, any> = {
      ...baseDefaults,
      ...cfg,
      headers: {
        ...(baseDefaults.headers || {}),
        ...(cfg.headers || {}),
      },
    };

    for (const ic of reqInterceptors.entries()) {
      if (typeof ic.fulfilled === "function") {
        merged = await ic.fulfilled(merged);
      }
    }

    const method = String(merged.method || "GET").toUpperCase();
    let targetUrl = String(merged.url || "");
    if (
      merged.baseURL &&
      targetUrl &&
      !/^https?:\/\//i.test(targetUrl)
    ) {
      targetUrl = `${String(merged.baseURL).replace(/\/+$/, "")}/${targetUrl.replace(/^\/+/, "")}`;
    }

    if (merged.params) {
      try {
        const u = new URL(targetUrl);
        if (merged.params instanceof URLSearchParams) {
          merged.params.forEach((v, k) => u.searchParams.set(k, v));
        } else if (typeof merged.params === "object") {
          for (const [k, v] of Object.entries(merged.params)) {
            if (v !== undefined && v !== null) {
              u.searchParams.set(k, String(v));
            }
          }
        }
        targetUrl = u.toString();
      } catch {
        // Keep raw targetUrl if URL constructor cannot parse relative base
      }
    }

    let body: any;
    if (merged.data !== undefined && method !== "GET" && method !== "HEAD") {
      if (
        typeof merged.data === "string" ||
        merged.data instanceof URLSearchParams ||
        merged.data instanceof ArrayBuffer ||
        ArrayBuffer.isView(merged.data)
      ) {
        body =
          merged.data instanceof URLSearchParams
            ? merged.data.toString()
            : merged.data;
        if (
          merged.data instanceof URLSearchParams &&
          !merged.headers["Content-Type"] &&
          !merged.headers["content-type"]
        ) {
          merged.headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
      } else {
        body = JSON.stringify(merged.data);
        if (!merged.headers["Content-Type"] && !merged.headers["content-type"]) {
          merged.headers["Content-Type"] = "application/json";
        }
      }
    }

    let responseObj: any;
    try {
      const res = await sandboxedFetch(targetUrl, {
        method,
        headers: merged.headers,
        body,
        signal: merged.signal,
      });

      const responseHeaders = extractResponseHeaders(res.headers);

      let data: any;
      if (merged.responseType === "arraybuffer") {
        data = await res.arrayBuffer();
      } else {
        const rawText = await res.text();
        data = rawText;
        if (merged.responseType === "text") {
          data = rawText;
        } else if (
          merged.responseType === "json" ||
          rawText.trimStart().startsWith("{") ||
          rawText.trimStart().startsWith("[")
        ) {
          try {
            data = JSON.parse(rawText);
          } catch {
            data = rawText;
          }
        }
      }

      responseObj = {
        data,
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        config: merged,
      };

      const validateStatus =
        typeof merged.validateStatus === "function"
          ? merged.validateStatus
          : (s: number) => s >= 200 && s < 300;

      if (!validateStatus(res.status)) {
        const err: any = new Error(`Request failed with status code ${res.status}`);
        err.isAxiosError = true;
        err.response = responseObj;
        err.status = res.status;
        err.config = merged;
        throw err;
      }

      for (const ic of resInterceptors.entries()) {
        if (typeof ic.fulfilled === "function") {
          responseObj = await ic.fulfilled(responseObj);
        }
      }
      return responseObj;
    } catch (err) {
      let currentErr = err;
      for (const ic of resInterceptors.entries()) {
        if (typeof ic.rejected === "function") {
          try {
            return await ic.rejected(currentErr);
          } catch (nextErr) {
            currentErr = nextErr;
          }
        }
      }
      throw currentErr;
    }
  }

  const axiosFn: any = (a: any, b?: any) => request(a, b);
  axiosFn.request = request;
  axiosFn.get = (url: string, cfg?: any) =>
    request({ ...(cfg || {}), method: "GET", url });
  axiosFn.head = (url: string, cfg?: any) =>
    request({ ...(cfg || {}), method: "HEAD", url });
  axiosFn.delete = (url: string, cfg?: any) =>
    request({ ...(cfg || {}), method: "DELETE", url });
  axiosFn.post = (url: string, data?: any, cfg?: any) =>
    request({ ...(cfg || {}), method: "POST", url, data });
  axiosFn.put = (url: string, data?: any, cfg?: any) =>
    request({ ...(cfg || {}), method: "PUT", url, data });
  axiosFn.patch = (url: string, data?: any, cfg?: any) =>
    request({ ...(cfg || {}), method: "PATCH", url, data });
  axiosFn.defaults = baseDefaults;
  axiosFn.interceptors = {
    request: reqInterceptors,
    response: resInterceptors,
  };
  axiosFn.isAxiosError = (err: any) => Boolean(err?.isAxiosError || err?.response);
  axiosFn.isCancel = (err: any) => Boolean(err?.__CANCEL__ || err?.name === "AbortError");
  axiosFn.all = (promises: Promise<any>[]) => Promise.all(promises);
  axiosFn.spread = (cb: (...args: any[]) => any) => (arr: any[]) => cb(...arr);
  axiosFn.CancelToken = {
    source() {
      const c = new AbortController();
      return {
        token: c.signal,
        cancel: () => c.abort(),
      };
    },
  };
  axiosFn.create = (defaults?: Record<string, any>) =>
    createSandboxedAxios(sandboxedFetch, {
      ...baseDefaults,
      ...(defaults || {}),
      headers: {
        ...(baseDefaults.headers || {}),
        ...(defaults?.headers || {}),
      },
    });
  return axiosFn;
}

const b64encode = (str: string): string =>
  BufferPolyfill.from(String(str), "utf8").toString("base64");
const b64decode = (b64: string): string =>
  BufferPolyfill.from(String(b64), "base64").toString("utf8");

function instantiatePluginExports(
  pluginId: string,
  scriptCode: string,
  pluginSettings: Record<string, string | boolean>,
  abortSignal: AbortSignal,
  registerTimer: (id: ReturnType<typeof setTimeout>) => void,
) {
  const sandboxedFetch = createSandboxedFetch(
    pluginId,
    abortSignal,
    registerTimer,
  );
  const sandboxedAxios = createSandboxedAxios(sandboxedFetch);
  const SandboxedXHR = createSandboxedXHR(sandboxedFetch);
  const TextDecoderImpl = getSafeTextDecoder();
  const TextEncoderImpl = getSafeTextEncoder();
  const AbortSignalImpl = ensureAbortSignalCompat();

  const cheerioDefault = cheerioModule?.default ?? cheerioModule;
  const cryptoJsDefault = CryptoJS?.default ?? CryptoJS;

  const sandboxRequire = (modName: string): any => {
    const clean = String(modName || "").trim();
    const baseName = clean.replace(/^node:/, "");
    if (BLOCKED_MODULES.has(clean) || BLOCKED_MODULES.has(baseName)) {
      throw new Error(
        `Unsupported plugin format: module "${clean}" is not permitted on mobile.`,
      );
    }
    switch (baseName) {
      case "cheerio-without-node-native":
      case "react-native-cheerio":
      case "cheerio":
        return cheerioDefault;
      case "crypto-js":
        return cryptoJsDefault;
      case "axios":
        return sandboxedAxios;
      case "buffer":
        return { Buffer: BufferPolyfill };
      case "url":
        return { URL, URLSearchParams };
      case "querystring":
        return {
          parse: (str: string) => Object.fromEntries(new URLSearchParams(String(str || "")).entries()),
          stringify: (obj: Record<string, any>) => {
            const sp = new URLSearchParams();
            if (obj && typeof obj === "object") {
              for (const [k, v] of Object.entries(obj)) {
                if (v !== undefined && v !== null) sp.set(k, String(v));
              }
            }
            return sp.toString();
          },
        };
      case "events":
        return SimpleEventEmitter;
      case "crypto":
        return cryptoShim;
      default:
        throw new Error(
          `Unsupported plugin format: module "${clean}" is not supported on mobile.`,
        );
    }
  };

  const redactArgs = (args: any[]) =>
    args.map((a) => (typeof a === "string" ? redactSensitiveText(a) : a));
  const sandboxConsole = {
    log: (...args: any[]) => console.log(`[Nuvio:${pluginId}]`, ...redactArgs(args)),
    info: (...args: any[]) => console.log(`[Nuvio:${pluginId}]`, ...redactArgs(args)),
    warn: (...args: any[]) => console.warn(`[Nuvio:${pluginId}]`, ...redactArgs(args)),
    error: (...args: any[]) => console.warn(`[Nuvio:${pluginId}]`, ...redactArgs(args)),
    debug: (...args: any[]) => console.log(`[Nuvio:${pluginId}]`, ...redactArgs(args)),
  };

  const trackedSetTimeout = (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
    const id = setTimeout(() => {
      if (!abortSignal.aborted && typeof fn === "function") {
        try {
          fn(...args);
        } catch (err) {
          console.warn(`[Nuvio:${pluginId}] timer error:`, err);
        }
      }
    }, ms);
    registerTimer(id);
    return id;
  };

  const trackedSetInterval = (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
    const id = setInterval(() => {
      if (abortSignal.aborted) {
        clearInterval(id);
        return;
      }
      if (typeof fn === "function") {
        try {
          fn(...args);
        } catch (err) {
          console.warn(`[Nuvio:${pluginId}] interval error:`, err);
        }
      }
    }, ms) as unknown as ReturnType<typeof setTimeout>;
    registerTimer(id);
    return id;
  };

  const trackedSetImmediate = (fn: (...a: any[]) => void, ...args: any[]) =>
    trackedSetTimeout(fn, 0, ...args);

  const safeClearTimer = (id: any) => {
    try {
      clearTimeout(id);
    } catch {}
    try {
      clearInterval(id);
    } catch {}
  };

  const safeQueueMicrotask =
    typeof globalThis.queueMicrotask === "function"
      ? (fn: () => void) => {
          if (typeof fn === "function") {
            globalThis.queueMicrotask(() => {
              if (!abortSignal.aborted) fn();
            });
          }
        }
      : (fn: () => void) => trackedSetTimeout(fn, 0);

  const sandboxProcess = Object.freeze({
    env: Object.freeze({}),
    platform: "android",
    version: "v18.0.0",
    nextTick: (fn: (...a: any[]) => void, ...args: any[]) => {
      if (typeof fn === "function") safeQueueMicrotask(() => fn(...args));
    },
  });

  const sandboxCrypto = {
    getRandomValues: (arr: any) => cryptoShim.getRandomValues(arr),
  };

  const sandboxGlobal: Record<string, any> = {
    SCRAPER_SETTINGS: { ...pluginSettings },
    fetch: sandboxedFetch,
    Headers,
    FormData: typeof FormData !== "undefined" ? FormData : undefined,
    XMLHttpRequest: SandboxedXHR,
    TextDecoder: TextDecoderImpl,
    TextEncoder: TextEncoderImpl,
    AbortController,
    AbortSignal: AbortSignalImpl,
    console: sandboxConsole,
    Buffer: BufferPolyfill,
    URL,
    URLSearchParams,
    atob: b64decode,
    btoa: b64encode,
    setTimeout: trackedSetTimeout,
    clearTimeout: safeClearTimer,
    setInterval: trackedSetInterval,
    clearInterval: safeClearTimer,
    setImmediate: trackedSetImmediate,
    clearImmediate: safeClearTimer,
    queueMicrotask: safeQueueMicrotask,
    process: sandboxProcess,
    crypto: sandboxCrypto,
  };
  sandboxGlobal.global = sandboxGlobal;
  sandboxGlobal.globalThis = sandboxGlobal;
  sandboxGlobal.self = sandboxGlobal;
  sandboxGlobal.window = sandboxGlobal;

  // Keep `Function("return this")()` returning the sandboxed global instead of
  // either leaking host globals OR crashing with `undefined is not a function`.
  function SandboxedFunction(...fnArgs: any[]) {
    const body = fnArgs.length > 0 ? String(fnArgs[fnArgs.length - 1] ?? "").trim() : "";
    if (body === "return this" || body === "return this;") {
      return () => sandboxGlobal;
    }
    return Function(...fnArgs);
  }

  const moduleObj: { exports: any } = { exports: {} };

  const factory = new Function(
    "module",
    "exports",
    "require",
    "global",
    "globalThis",
    "window",
    "self",
    "fetch",
    "Headers",
    "XMLHttpRequest",
    "TextDecoder",
    "TextEncoder",
    "AbortController",
    "AbortSignal",
    "console",
    "Buffer",
    "URL",
    "URLSearchParams",
    "atob",
    "btoa",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "queueMicrotask",
    "process",
    "crypto",
    "__dirname",
    "__filename",
    "Function",
    "WebSocket",
    `"use strict";\n${scriptCode}\n`,
  );

  factory(
    moduleObj,
    moduleObj.exports,
    sandboxRequire,
    sandboxGlobal,
    sandboxGlobal,
    sandboxGlobal,
    sandboxGlobal,
    sandboxedFetch,
    Headers,
    SandboxedXHR,
    TextDecoderImpl,
    TextEncoderImpl,
    AbortController,
    AbortSignalImpl,
    sandboxConsole,
    BufferPolyfill,
    URL,
    URLSearchParams,
    b64decode,
    b64encode,
    trackedSetTimeout,
    safeClearTimer,
    trackedSetInterval,
    safeClearTimer,
    trackedSetImmediate,
    safeClearTimer,
    safeQueueMicrotask,
    sandboxProcess,
    sandboxCrypto,
    "/",
    `/${pluginId}.js`,
    SandboxedFunction,
    undefined,
  );

  const exported = moduleObj.exports?.default ?? moduleObj.exports;
  const resolvedGetStreams =
    typeof exported?.getStreams === "function"
      ? exported.getStreams
      : typeof exported === "function"
        ? exported
        : typeof sandboxGlobal.getStreams === "function"
          ? sandboxGlobal.getStreams
          : null;

  const resolvedOnSettings =
    typeof exported?.onSettings === "function"
      ? exported.onSettings
      : typeof sandboxGlobal.onSettings === "function"
        ? sandboxGlobal.onSettings
        : null;

  return {
    getStreams: resolvedGetStreams,
    onSettings: resolvedOnSettings,
  };
}

function classifyPluginError(message: string, timedOut: boolean): PluginErrorCategory {
  if (timedOut || /timed out/i.test(message)) return "timeout";
  if (/unsupported plugin format|module .* is not supported|missing "getstreams"|missing getstreams/i.test(message)) {
    return "unsupported_format";
  }
  if (/initialization failed|syntaxerror|unexpected token/i.test(message)) {
    return "init_failed";
  }
  if (/network|fetch failed|http \d+|econn|enotfound/i.test(message)) {
    return "repo_unavailable";
  }
  return "runtime_error";
}

function extractStreamArray(rawResult: unknown): NuvioStream[] {
  let candidateList: unknown[] | null = null;
  if (Array.isArray(rawResult)) {
    candidateList = rawResult;
  } else if (rawResult && typeof rawResult === "object") {
    const rec = rawResult as Record<string, unknown>;
    if (Array.isArray(rec.streams)) candidateList = rec.streams;
    else if (Array.isArray(rec.results)) candidateList = rec.results;
    else if (Array.isArray(rec.links)) candidateList = rec.links;
  }
  if (!candidateList) return [];
  return candidateList.filter(
    (item): item is NuvioStream =>
      !!item &&
      typeof item === "object" &&
      typeof (item as any).url === "string" &&
      (item as any).url.trim().length > 0,
  );
}

async function invokeGetStreamsCompat(
  fn: (...args: any[]) => any,
  tmdbId: string,
  mediaType: NuvioMediaType,
  season: number | null,
  episode: number | null,
): Promise<unknown> {
  // Support legacy callback-style plugins declaring (tmdbId, mediaType, season, episode, cb)
  if (fn.length >= 5) {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const cb = (errOrResult: any, maybeStreams?: any) => {
        if (settled) return;
        settled = true;
        if (maybeStreams !== undefined) {
          if (errOrResult) reject(errOrResult);
          else resolve(maybeStreams);
        } else if (errOrResult instanceof Error) {
          reject(errOrResult);
        } else {
          resolve(errOrResult);
        }
      };
      try {
        const ret = fn(tmdbId, mediaType, season, episode, cb);
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          Promise.resolve(ret).then(
            (val) => {
              if (!settled && val !== undefined) {
                settled = true;
                resolve(val);
              }
            },
            (err) => {
              if (!settled) {
                settled = true;
                reject(err);
              }
            },
          );
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  return await fn(tmdbId, mediaType, season, episode);
}

export async function executeNuvioGetStreams(params: {
  pluginKey: string;
  pluginId: string;
  pluginName: string;
  scriptCode: string;
  tmdbId: string;
  mediaType: NuvioMediaType;
  season?: number | null;
  episode?: number | null;
  pluginSettings?: Record<string, string | boolean>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<PluginExecutionResult> {
  const startedAt = Date.now();
  const timeoutMs = params.timeoutMs ?? PLUGIN_EXEC_TIMEOUT_MS;
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const registerTimer = (id: ReturnType<typeof setTimeout>) => {
    timers.add(id);
  };

  let timedOut = false;
  const execTimeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timers.add(execTimeout);

  const detachExternal = safeAddAbortListener(params.signal, () =>
    controller.abort(),
  );
  if (params.signal?.aborted) {
    clearTimeout(execTimeout);
    return {
      pluginKey: params.pluginKey,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      ok: false,
      streams: [],
      durationMs: 0,
      errorCategory: "timeout",
      error: "Cancelled",
    };
  }

  try {
    let exports: {
      getStreams: ((...a: any[]) => any) | null;
      onSettings: ((...a: any[]) => any) | null;
    };
    try {
      exports = instantiatePluginExports(
        params.pluginId,
        params.scriptCode,
        params.pluginSettings ?? {},
        controller.signal,
        registerTimer,
      );
    } catch (initErr) {
      const detail = redactSensitiveText(
        initErr instanceof Error
          ? `${initErr.message}${initErr.stack ? `\n${initErr.stack}` : ""}`
          : String(initErr),
      );
      console.warn(`[Nuvio:${params.pluginId}] init failed:`, detail);
      const rawMsg = redactSensitiveText(
        initErr instanceof Error ? initErr.message : String(initErr),
      );
      const isFormatErr = /unsupported plugin format/i.test(rawMsg);
      return {
        pluginKey: params.pluginKey,
        pluginId: params.pluginId,
        pluginName: params.pluginName,
        ok: false,
        streams: [],
        durationMs: Date.now() - startedAt,
        errorCategory: isFormatErr ? "unsupported_format" : "init_failed",
        error: isFormatErr ? rawMsg : `Provider initialization failed: ${rawMsg}`,
        diagnosticDetail: detail,
      };
    }

    if (typeof exports.getStreams !== "function") {
      return {
        pluginKey: params.pluginKey,
        pluginId: params.pluginId,
        pluginName: params.pluginName,
        ok: false,
        streams: [],
        durationMs: Date.now() - startedAt,
        errorCategory: "unsupported_format",
        error: 'Unsupported plugin format: missing "getStreams" function.',
      };
    }

    const sArg = params.mediaType === "tv" ? (params.season ?? 1) : null;
    const eArg = params.mediaType === "tv" ? (params.episode ?? 1) : null;

    const rawPromise = invokeGetStreamsCompat(
      exports.getStreams,
      String(params.tmdbId),
      params.mediaType,
      sArg,
      eArg,
    );

    const abortPromise = new Promise<never>((_, reject) => {
      safeAddAbortListener(controller.signal, () =>
        reject(
          new Error(
            timedOut
              ? `Plugin timed out after ${Math.round(timeoutMs / 1000)}s`
              : "Cancelled",
          ),
        ),
      );
    });

    const rawResult = await Promise.race([rawPromise, abortPromise]);
    const list = extractStreamArray(rawResult);

    return {
      pluginKey: params.pluginKey,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      ok: true,
      streams: list,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const rawMsg = redactSensitiveText(
      err instanceof Error ? err.message : String(err),
    );
    const detail = redactSensitiveText(
      err instanceof Error
        ? `${err.message}${err.stack ? `\n${err.stack}` : ""}`
        : String(err),
    );
    console.warn(`[Nuvio:${params.pluginId}] runtime failure:`, detail);
    return {
      pluginKey: params.pluginKey,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      ok: false,
      streams: [],
      durationMs: Date.now() - startedAt,
      timedOut,
      errorCategory: classifyPluginError(rawMsg, timedOut),
      error: rawMsg,
      diagnosticDetail: detail,
    };
  } finally {
    controller.abort();
    for (const id of timers) {
      try {
        clearTimeout(id);
        clearInterval(id as any);
      } catch {}
    }
    timers.clear();
    detachExternal?.();
  }
}

export async function executeNuvioOnSettings(
  pluginId: string,
  scriptCode: string,
  currentSettings: Record<string, string | boolean>,
): Promise<NuvioSettingField[]> {
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  timers.add(timeoutId);

  try {
    const exports = instantiatePluginExports(
      pluginId,
      scriptCode,
      currentSettings,
      controller.signal,
      (id) => timers.add(id),
    );
    if (typeof exports.onSettings !== "function") return [];
    const schema = await Promise.resolve(exports.onSettings());
    if (!Array.isArray(schema)) return [];
    return schema.filter(
      (f): f is NuvioSettingField =>
        !!f &&
        typeof f === "object" &&
        typeof f.type === "string" &&
        typeof f.label === "string",
    );
  } catch (err) {
    console.warn(`[Nuvio:${pluginId}] onSettings failed:`, err);
    return [];
  } finally {
    controller.abort();
    for (const id of timers) {
      try {
        clearTimeout(id);
        clearInterval(id as any);
      } catch {}
    }
    timers.clear();
  }
}

export interface PluginCompatibilityAudit {
  compatible: boolean;
  reason?: string;
  unsupportedModules?: string[];
}

/**
 * Inspects a downloaded Nuvio plugin script before installation/activation:
 * - Detects Node-only built-in `require()` imports (`net`, `tls`, `http2`, `util`, `fs`, etc.)
 * - Dry-evaluates top-level module exports inside the sandbox to catch syntax or init failures
 * - Confirms `getStreams` function export is present
 */
export function auditPluginScriptCompatibility(
  pluginId: string,
  scriptCode: string,
): PluginCompatibilityAudit {
  const unsupported = new Set<string>();
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of scriptCode.matchAll(reqRe)) {
    const clean = String(m[1] || "").trim().replace(/^node:/, "");
    if (BLOCKED_MODULES.has(clean)) {
      unsupported.add(clean);
    }
  }
  if (unsupported.size > 0) {
    const mods = Array.from(unsupported);
    return {
      compatible: false,
      unsupportedModules: mods,
      reason: `Requires unsupported Node-only module(s): ${mods.slice(0, 5).join(", ")}`,
    };
  }

  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  try {
    const exports = instantiatePluginExports(
      pluginId,
      scriptCode,
      {},
      controller.signal,
      (id) => timers.add(id),
    );
    if (typeof exports.getStreams !== "function") {
      return {
        compatible: false,
        reason: 'Missing required "getStreams" export function.',
      };
    }
    return { compatible: true };
  } catch (err) {
    return {
      compatible: false,
      reason: redactSensitiveText(
        err instanceof Error ? err.message : String(err),
      ),
    };
  } finally {
    controller.abort();
    for (const id of timers) {
      try {
        clearTimeout(id);
        clearInterval(id as any);
      } catch {}
    }
    timers.clear();
  }
}
