/**
 * Official OpenAI / ChatGPT Responses passthrough.
 *
 * Only applies to Responses endpoints (/v1/responses, /codex/*, /responses).
 * Chat Completions and Messages never passthrough.
 *
 * When body.model matches a configured ID (e.g. "gpt-5.5"), reverse-proxy the
 * request to the official backend — no provider routing or translation.
 * Prefixed models (cx/gpt-5.5) only match if that full string is listed.
 *
 * Config (~/.9router/official-passthrough.json, or $OFFICIAL_PASSTHROUGH_CONFIG):
 * {
 *   "enabled": true,
 *   "models": ["gpt-5.5", "gpt-5.6"],
 *   "preferClientAuth": true,
 *   "fallbackCodexAuthJson": true
 * }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proxyAwareFetch } from "./proxyFetch.js";

const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "content-length", "accept-encoding",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
]);

const DUMMY_AUTH_MARKERS = ["dummy", "opencodex", "9router", "placeholder"];

const DEFAULT_CONFIG = {
  enabled: false,
  models: ["gpt-5.5", "gpt-5.6"],
  preferClientAuth: true,
  fallbackCodexAuthJson: true,
  codexAuthPath: null,
};

let cachedConfig = null;
let cachedConfigMtimeMs = null;
let cachedConfigPath = null;

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

export function getOfficialPassthroughConfigPath() {
  if (process.env.OFFICIAL_PASSTHROUGH_CONFIG) return process.env.OFFICIAL_PASSTHROUGH_CONFIG;
  return path.join(resolveDataDir(), "official-passthrough.json");
}

function ensureConfigFile(configPath) {
  try {
    if (fs.existsSync(configPath)) return;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
  } catch {
    // fail-open
  }
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => typeof m === "string" && m.trim())
    .map((m) => m.trim());
}

/**
 * Normalize request path (strip /api prefix from Next rewrites).
 */
export function normalizeRequestPath(pathname) {
  let p = String(pathname || "");
  if (p.startsWith("/api/")) p = p.slice(4);
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

/**
 * True for Responses-family endpoints used by Codex Desktop / CLI.
 * Does NOT match chat/completions or messages.
 */
export function isResponsesEndpoint(pathname) {
  const p = normalizeRequestPath(pathname);
  if (p.includes("/chat/completions") || p.includes("/messages")) return false;
  return (
    p.includes("/responses")
    || p === "/codex"
    || p.startsWith("/codex/")
  );
}

export function loadOfficialPassthroughConfig({ forceReload = false } = {}) {
  const configPath = getOfficialPassthroughConfigPath();
  ensureConfigFile(configPath);

  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(configPath).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  if (
    !forceReload
    && cachedConfig
    && cachedConfigPath === configPath
    && cachedConfigMtimeMs === mtimeMs
  ) {
    return cachedConfig;
  }

  let parsed = { ...DEFAULT_CONFIG };
  try {
    if (mtimeMs != null) {
      const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = {
          ...DEFAULT_CONFIG,
          ...json,
          models: normalizeModels(json.models ?? DEFAULT_CONFIG.models),
        };
      }
    }
  } catch {
    parsed = { ...DEFAULT_CONFIG, models: [...DEFAULT_CONFIG.models] };
  }

  const models = normalizeModels(parsed.models);
  cachedConfig = {
    enabled: parsed.enabled === true && models.length > 0,
    models,
    modelSet: new Set(models.map((m) => m.toLowerCase())),
    preferClientAuth: parsed.preferClientAuth !== false,
    fallbackCodexAuthJson: parsed.fallbackCodexAuthJson !== false,
    codexAuthPath: typeof parsed.codexAuthPath === "string" && parsed.codexAuthPath.trim()
      ? parsed.codexAuthPath.trim()
      : null,
    path: configPath,
  };
  cachedConfigPath = configPath;
  cachedConfigMtimeMs = mtimeMs;
  return cachedConfig;
}

/** @internal test helper */
export function _resetOfficialPassthroughCache() {
  cachedConfig = null;
  cachedConfigMtimeMs = null;
  cachedConfigPath = null;
}

export function isOfficialPassthroughModel(modelStr, config = null) {
  if (!modelStr || typeof modelStr !== "string") return false;
  const cfg = config || loadOfficialPassthroughConfig();
  if (!cfg.enabled) return false;
  return cfg.modelSet.has(modelStr.trim().toLowerCase());
}

/**
 * Gate: Responses endpoint + model in config list.
 */
export function shouldOfficialPassthrough(modelStr, pathname, config = null) {
  if (!isResponsesEndpoint(pathname)) return false;
  return isOfficialPassthroughModel(modelStr, config);
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(lower) || undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function isUsableAuthHeader(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || /^bearer\s*$/i.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return !DUMMY_AUTH_MARKERS.some((m) => lower.includes(m));
}

function extractAccountIdFromJwt(token) {
  if (!token || typeof token !== "string" || token.split(".").length < 2) return null;
  try {
    const payloadB64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (payloadB64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(payloadB64 + "=".repeat(pad), "base64").toString("utf-8"));
    const auth = payload?.["https://api.openai.com/auth"] || {};
    return auth.chatgpt_account_id || payload.chatgpt_account_id || payload.account_id || null;
  } catch {
    return null;
  }
}

function readCodexAuthJson(codexAuthPath) {
  const authPath = codexAuthPath || path.join(os.homedir(), ".codex", "auth.json");
  try {
    if (!fs.existsSync(authPath)) return null;
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const accessToken =
      data?.tokens?.access_token
      || data?.access_token
      || data?.accessToken
      || null;
    let accountId =
      data?.tokens?.account_id
      || data?.account_id
      || data?.chatgpt_account_id
      || data?.tokens?.chatgpt_account_id
      || null;
    if (!accountId && typeof accessToken === "string") {
      accountId = extractAccountIdFromJwt(accessToken);
    }
    return {
      accessToken: typeof accessToken === "string" ? accessToken : null,
      accountId: typeof accountId === "string" ? accountId : null,
    };
  } catch {
    return null;
  }
}

/**
 * Map incoming Responses path → official upstream URL.
 */
export function resolveOfficialPassthroughUrl(pathname, { hasChatGptAccount } = {}) {
  const p = normalizeRequestPath(pathname);
  const isCompact = /\/responses\/compact\/?$/.test(p) || p.endsWith("/compact");

  if (hasChatGptAccount) {
    return isCompact
      ? "https://chatgpt.com/backend-api/codex/responses/compact"
      : "https://chatgpt.com/backend-api/codex/responses";
  }
  return isCompact
    ? "https://api.openai.com/v1/responses/compact"
    : "https://api.openai.com/v1/responses";
}

function buildForwardHeaders(request, { authHeader, accountId }) {
  const out = {};
  if (request?.headers && typeof request.headers.forEach === "function") {
    request.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower.startsWith("x-9r-")) return;
      if (value != null && value !== "") out[key] = value;
    });
  }

  if (authHeader) {
    // Drop any existing authorization keys (any casing)
    for (const k of Object.keys(out)) {
      if (k.toLowerCase() === "authorization") delete out[k];
    }
    out.Authorization = /^bearer\s+/i.test(authHeader) ? authHeader : `Bearer ${authHeader}`;
  }

  if (accountId) {
    const hasAccount = Object.keys(out).some((k) => k.toLowerCase() === "chatgpt-account-id");
    if (!hasAccount) out["ChatGPT-Account-ID"] = accountId;
  }

  if (!Object.keys(out).some((k) => k.toLowerCase() === "content-type")) {
    out["Content-Type"] = "application/json";
  }

  return out;
}

function jsonError(status, message, code, type = "invalid_request_error") {
  return new Response(JSON.stringify({
    error: { message, type, code },
  }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Transparent reverse-proxy to official OpenAI / ChatGPT Responses backend.
 */
export async function handleOfficialPassthrough(request, body, options = {}) {
  const log = options.log || null;
  const cfg = loadOfficialPassthroughConfig();

  const clientAuth = getHeader(request.headers, "authorization");
  const clientAccountId = getHeader(request.headers, "chatgpt-account-id");

  let authHeader = null;
  let accountId = clientAccountId || null;
  let authSource = "none";

  if (cfg.preferClientAuth && isUsableAuthHeader(clientAuth)) {
    authHeader = clientAuth;
    authSource = "client";
  }

  if ((!authHeader || !accountId) && cfg.fallbackCodexAuthJson) {
    const codexAuth = readCodexAuthJson(cfg.codexAuthPath);
    if (codexAuth?.accessToken) {
      if (!authHeader) {
        authHeader = `Bearer ${codexAuth.accessToken}`;
        authSource = "codex-auth.json";
      }
      if (!accountId && codexAuth.accountId) accountId = codexAuth.accountId;
    }
  }

  let pathname = "/v1/responses";
  try {
    pathname = new URL(request.url).pathname || pathname;
  } catch {
    // keep default
  }

  const hasChatGptAccount = Boolean(accountId);
  const targetUrl = resolveOfficialPassthroughUrl(pathname, { hasChatGptAccount });
  const forwardHeaders = buildForwardHeaders(request, {
    authHeader,
    accountId,
  });

  log?.info?.(
    "PASSTHROUGH",
    `Responses passthrough model=${body?.model || ""} → ${targetUrl} (auth=${authSource}, account=${accountId ? "yes" : "no"})`
  );

  if (!authHeader) {
    return jsonError(
      401,
      "Official passthrough: no usable Authorization. Sign in to Codex Desktop, or ensure ~/.codex/auth.json has tokens.access_token.",
      "passthrough_auth_missing"
    );
  }

  let upstream;
  try {
    upstream = await proxyAwareFetch(targetUrl, {
      method: request.method || "POST",
      headers: forwardHeaders,
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (err) {
    const message = err?.message || String(err);
    log?.error?.("PASSTHROUGH", `Upstream fetch failed: ${message}`);
    return jsonError(502, `Official passthrough upstream error: ${message}`, "passthrough_upstream_error", "server_error");
  }

  const responseHeaders = {
    "Access-Control-Allow-Origin": "*",
  };
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders["Content-Type"] = contentType;
  if (contentType?.includes("text/event-stream")) {
    responseHeaders["Cache-Control"] = "no-cache";
    responseHeaders["Connection"] = "keep-alive";
  } else {
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) responseHeaders["Cache-Control"] = cacheControl;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
