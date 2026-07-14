/**
 * Official OpenAI / ChatGPT model passthrough.
 *
 * When body.model matches a configured ID (e.g. "gpt-5.5"), forward the request
 * almost as-is to the official backend — without 9Router provider routing,
 * OAuth connection selection, or format translation.
 *
 * Prefixed models (cx/gpt-5.5) never match unless explicitly listed, so the
 * existing Codex OAuth routing layer stays intact.
 *
 * Config file (created on first use if missing):
 *   ~/.9router/official-passthrough.json
 *   or $DATA_DIR/official-passthrough.json
 *   or $OFFICIAL_PASSTHROUGH_CONFIG
 *
 * {
 *   "enabled": true,
 *   "models": ["gpt-5.5", "gpt-5.6", "gpt-5.4-mini"],
 *   "preferClientAuth": true,
 *   "fallbackCodexAuthJson": true
 * }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proxyAwareFetch } from "./proxyFetch.js";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

const DUMMY_AUTH_MARKERS = ["dummy", "opencodex", "9router", "placeholder"];

const DEFAULT_CONFIG = {
  enabled: false,
  models: ["gpt-5.5", "gpt-5.6"],
  preferClientAuth: true,
  fallbackCodexAuthJson: true,
  /** Optional absolute path to Codex auth.json (default: ~/.codex/auth.json) */
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
  if (process.env.OFFICIAL_PASSTHROUGH_CONFIG) {
    return process.env.OFFICIAL_PASSTHROUGH_CONFIG;
  }
  return path.join(resolveDataDir(), "official-passthrough.json");
}

function ensureConfigFile(configPath) {
  try {
    if (fs.existsSync(configPath)) return;
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
  } catch {
    // fail-open: missing/unwritable config simply disables passthrough
  }
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  for (const entry of models) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id) continue;
    out.push(id);
  }
  return out;
}

/**
 * Load and cache config. Re-reads when the file mtime changes.
 * @returns {{ enabled: boolean, models: string[], modelSet: Set<string>, preferClientAuth: boolean, fallbackCodexAuthJson: boolean, codexAuthPath: string|null, path: string }}
 */
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
      const raw = fs.readFileSync(configPath, "utf-8");
      const json = JSON.parse(raw);
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
  const modelSet = new Set(models.map((m) => m.toLowerCase()));

  cachedConfig = {
    enabled: parsed.enabled !== false && models.length > 0,
    models,
    modelSet,
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

/**
 * True when body.model is an exact (case-insensitive) match of a configured passthrough ID.
 * Prefixed models like "cx/gpt-5.5" only match if that full string is listed.
 */
export function isOfficialPassthroughModel(modelStr, config = null) {
  if (!modelStr || typeof modelStr !== "string") return false;
  const cfg = config || loadOfficialPassthroughConfig();
  if (!cfg.enabled) return false;
  return cfg.modelSet.has(modelStr.trim().toLowerCase());
}

function headerMap(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function") {
    return Object.fromEntries(headers.entries());
  }
  if (typeof headers === "object") return { ...headers };
  return {};
}

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function isUsableAuthHeader(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (DUMMY_AUTH_MARKERS.some((m) => lower.includes(m))) return false;
  // Bare "Bearer" with empty token
  if (/^bearer\s*$/i.test(trimmed)) return false;
  return true;
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
      path: authPath,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve target official URL from the incoming path + ChatGPT account signal.
 */
export function resolveOfficialPassthroughUrl(pathname, { hasChatGptAccount } = {}) {
  const raw = String(pathname || "");
  // Strip Next rewrite prefix /api
  let p = raw.startsWith("/api/") ? raw.slice(4) : raw;
  if (!p.startsWith("/")) p = `/${p}`;

  // Normalize: ensure /v1 prefix for OpenAI API path matching
  const isCompact = /\/responses\/compact\/?$/.test(p) || p.endsWith("/compact");
  const isResponses = p.includes("/responses") || p === "/codex" || p.startsWith("/codex/");
  const isChatCompletions = p.includes("/chat/completions");

  if (hasChatGptAccount) {
    if (isCompact) return "https://chatgpt.com/backend-api/codex/responses/compact";
    if (isResponses || !isChatCompletions) {
      // Codex Desktop Responses is the primary path; unknown → codex/responses
      return "https://chatgpt.com/backend-api/codex/responses";
    }
    // Chat Completions with ChatGPT account is uncommon; still prefer backend-api
    return "https://chatgpt.com/backend-api/codex/responses";
  }

  if (isCompact) return "https://api.openai.com/v1/responses/compact";
  if (isResponses) return "https://api.openai.com/v1/responses";
  if (isChatCompletions) return "https://api.openai.com/v1/chat/completions";
  return "https://api.openai.com/v1/responses";
}

function buildForwardHeaders(clientHeaders, { authHeader, accountId }) {
  const out = {};
  for (const [key, val] of Object.entries(clientHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // Drop gateway-only headers
    if (lower.startsWith("x-9r-")) continue;
    if (lower === "x-forwarded-for" || lower === "x-forwarded-host" || lower === "x-forwarded-proto") continue;
    const value = Array.isArray(val) ? val[0] : val;
    if (value == null || value === "") continue;
    out[key] = value;
  }

  if (authHeader) {
    out.Authorization = authHeader.startsWith("Bearer ") || authHeader.startsWith("bearer ")
      ? authHeader
      : `Bearer ${authHeader}`;
    // Normalize casing
    for (const k of Object.keys(out)) {
      if (k.toLowerCase() === "authorization" && k !== "Authorization") delete out[k];
    }
  }

  if (accountId) {
    // Official header name used by Codex backend
    let hasAccount = false;
    for (const k of Object.keys(out)) {
      if (k.toLowerCase() === "chatgpt-account-id") {
        hasAccount = true;
        break;
      }
    }
    if (!hasAccount) {
      out["ChatGPT-Account-ID"] = accountId;
    }
  }

  if (!out["Content-Type"] && !out["content-type"]) {
    out["Content-Type"] = "application/json";
  }

  return out;
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra,
  };
}

/**
 * Transparent reverse-proxy of the current request to the official OpenAI/ChatGPT backend.
 * @param {Request} request
 * @param {object} body - already-parsed JSON body
 * @param {object} [options]
 * @param {object} [options.log]
 * @returns {Promise<Response>}
 */
export async function handleOfficialPassthrough(request, body, options = {}) {
  const log = options.log || null;
  const cfg = loadOfficialPassthroughConfig();
  const clientHeaders = headerMap(request.headers);

  const clientAuth = getHeader(clientHeaders, "authorization");
  const clientAccountId = getHeader(clientHeaders, "chatgpt-account-id");

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
      if (!accountId && codexAuth.accountId) {
        accountId = codexAuth.accountId;
      }
    }
  }

  // If client sent chatgpt-account-id, treat as ChatGPT/Codex subscription path
  const hasChatGptAccount = Boolean(accountId || clientAccountId);

  let pathname = "/v1/responses";
  try {
    pathname = new URL(request.url).pathname || pathname;
  } catch {
    // keep default
  }

  const targetUrl = resolveOfficialPassthroughUrl(pathname, { hasChatGptAccount });
  const forwardHeaders = buildForwardHeaders(clientHeaders, {
    authHeader,
    accountId: accountId || clientAccountId || null,
  });

  const model = body?.model || "";
  log?.info?.(
    "PASSTHROUGH",
    `Official passthrough model=${model} → ${targetUrl} (auth=${authSource}, account=${accountId ? "yes" : "no"})`
  );

  if (!authHeader) {
    return new Response(JSON.stringify({
      error: {
        message: "Official passthrough: no usable Authorization. Sign in to Codex Desktop, or ensure ~/.codex/auth.json has tokens.access_token, or set preferClientAuth with a real Bearer token.",
        type: "invalid_request_error",
        code: "passthrough_auth_missing",
      }
    }), {
      status: 401,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });
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
    return new Response(JSON.stringify({
      error: {
        message: `Official passthrough upstream error: ${message}`,
        type: "server_error",
        code: "passthrough_upstream_error",
      }
    }), {
      status: 502,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });
  }

  // Pipe status + body; preserve content-type for SSE vs JSON
  const responseHeaders = corsHeaders();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders["Content-Type"] = contentType;
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) responseHeaders["Cache-Control"] = cacheControl;

  // For SSE, avoid buffering
  if (contentType?.includes("text/event-stream")) {
    responseHeaders["Cache-Control"] = "no-cache";
    responseHeaders["Connection"] = "keep-alive";
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
