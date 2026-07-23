import { cloneJson } from "./catalog.js";

function captureField(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? { exists: true, value: cloneJson(object[key]) }
    : { exists: false };
}

function restoreField(object, key, snapshot) {
  if (snapshot?.exists) object[key] = cloneJson(snapshot.value);
  else delete object[key];
}

export function normalizeCodexBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error("baseUrl is required");
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function captureManagedConfig(config = {}) {
  const providers = config.model_providers && typeof config.model_providers === "object"
    ? config.model_providers
    : {};
  return {
    modelProvider: captureField(config, "model_provider"),
    modelCatalogJson: captureField(config, "model_catalog_json"),
    modelProvidersExists: Object.prototype.hasOwnProperty.call(config, "model_providers"),
    openAIProvider: captureField(providers, "OpenAI"),
  };
}

export function applyOfficialPassthroughConfig(config = {}, { baseUrl, apiKey, catalogPath } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("apiKey is required");
  if (typeof catalogPath !== "string" || !catalogPath.trim()) throw new Error("catalogPath is required");

  const next = cloneJson(config || {});
  next.model_provider = "OpenAI";
  next.model_catalog_json = catalogPath;
  if (!next.model_providers || typeof next.model_providers !== "object") next.model_providers = {};
  next.model_providers.OpenAI = {
    name: "OpenAI",
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
    base_url: normalizeCodexBaseUrl(baseUrl),
    experimental_bearer_token: apiKey.trim(),
  };
  return next;
}

export function restoreManagedConfig(config = {}, snapshot = {}) {
  const next = cloneJson(config || {});
  restoreField(next, "model_provider", snapshot.modelProvider);
  restoreField(next, "model_catalog_json", snapshot.modelCatalogJson);

  if (!next.model_providers || typeof next.model_providers !== "object") next.model_providers = {};
  restoreField(next.model_providers, "OpenAI", snapshot.openAIProvider);
  if (!snapshot.modelProvidersExists && Object.keys(next.model_providers).length === 0) {
    delete next.model_providers;
  }
  return next;
}
