import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTOML, stringifyTOML } from "confbox";

import {
  buildManagedCatalog,
  cloneJson,
  createCatalogState,
  diffCatalogs,
  getPendingTemplateUpdates,
  hashJson,
  materializeCatalogEntry,
  resetCatalogEntry,
  resolveTemplateUpdates,
  selectCatalogModels,
  updateCatalogEntry,
} from "./catalog.js";
import {
  applyOfficialPassthroughConfig,
  captureManagedConfig,
  restoreManagedConfig,
} from "./config.js";

function normalizeState(value) {
  return {
    ...createCatalogState(),
    ...(value && typeof value === "object" ? cloneJson(value) : {}),
    selected: value?.selected && typeof value.selected === "object"
      ? cloneJson(value.selected)
      : {},
  };
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:.]/g, "");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readTomlIfExists(filePath) {
  try {
    return parseTOML(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Unable to read Codex config: ${error.message}`);
  }
}

function tempPathFor(filePath) {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

async function stageWrite(filePath, content, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  try {
    await fs.writeFile(tempPath, content, { mode });
    return tempPath;
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function atomicWrite(filePath, content, mode = 0o600) {
  const tempPath = await stageWrite(filePath, content, mode);
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readFileSnapshot(filePath) {
  try {
    const [content, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return { exists: true, content, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

export async function atomicWriteBatch(writes, { rename = fs.rename } = {}) {
  const snapshots = await Promise.all(writes.map((write) => readFileSnapshot(write.filePath)));
  const staged = [];
  const renamedIndexes = [];

  try {
    for (const write of writes) {
      staged.push(await stageWrite(write.filePath, write.content, write.mode));
    }
    for (let index = 0; index < writes.length; index += 1) {
      await rename(staged[index], writes[index].filePath);
      renamedIndexes.push(index);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const index of renamedIndexes.reverse()) {
      const snapshot = snapshots[index];
      try {
        if (snapshot.exists) {
          await atomicWrite(writes[index].filePath, snapshot.content, snapshot.mode);
        } else {
          await fs.unlink(writes[index].filePath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    await Promise.all(staged.map((tempPath) => fs.unlink(tempPath).catch(() => {})));
    if (rollbackErrors.length > 0) {
      error.rollbackFailed = true;
      error.rollbackErrors = rollbackErrors;
    }
    throw error;
  }
}

function catalogPaths(homeDir) {
  const codexDir = path.join(homeDir, ".codex");
  return {
    codexDir,
    sourcePath: path.join(codexDir, "models_cache.json"),
    configPath: path.join(codexDir, "config.toml"),
    authPath: path.join(codexDir, "auth.json"),
    catalogPath: path.join(codexDir, "model-catalogs", "9router-catalog.json"),
    backupsDir: path.join(codexDir, "backups", "9router-catalog"),
  };
}

function validateSource(source, sourcePath) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`Codex models cache must be an object: ${sourcePath}`);
  }
  if (!Array.isArray(source.models) || source.models.length === 0) {
    throw new Error(`Codex models cache has no models: ${sourcePath}`);
  }
  if (!source.models[0] || typeof source.models[0] !== "object" || Array.isArray(source.models[0])) {
    throw new Error(`Codex models cache models[0] is invalid: ${sourcePath}`);
  }
  return source;
}

async function createBackup(paths, now) {
  const backupDir = path.join(paths.backupsDir, timestampForPath(now));
  await fs.mkdir(backupDir, { recursive: true });
  if (await pathExists(paths.configPath)) {
    const backupConfigPath = path.join(backupDir, "config.toml");
    await fs.copyFile(paths.configPath, backupConfigPath);
    await fs.chmod(backupConfigPath, 0o600);
  }
  if (await pathExists(paths.catalogPath)) {
    const backupCatalogPath = path.join(backupDir, "9router-catalog.json");
    await fs.copyFile(paths.catalogPath, backupCatalogPath);
    await fs.chmod(backupCatalogPath, 0o600);
  }
  return backupDir;
}

function detectMode(config, managedCatalogPath) {
  const openAI = config?.model_providers?.OpenAI;
  if (
    config?.model_provider === "OpenAI"
    && config?.model_catalog_json === managedCatalogPath
    && openAI?.name === "OpenAI"
    && openAI?.wire_api === "responses"
    && openAI?.requires_openai_auth === true
  ) {
    return "official-passthrough";
  }
  if (config?.model_provider === "9router" || config?.model_providers?.["9router"]) {
    return "router-api-key";
  }
  return Object.keys(config || {}).length === 0 ? "unconfigured" : "other";
}

export function createCodexCatalogManager({
  homeDir = os.homedir(),
  loadState,
  saveState,
  listModels,
  listApiKeys,
  now = () => new Date(),
} = {}) {
  if (typeof loadState !== "function" || typeof saveState !== "function") {
    throw new Error("Codex catalog manager requires loadState and saveState");
  }
  if (typeof listModels !== "function" || typeof listApiKeys !== "function") {
    throw new Error("Codex catalog manager requires model and API key providers");
  }
  const paths = catalogPaths(homeDir);
  let mutationTail = Promise.resolve();

  function serializeMutation(operation) {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.catch(() => {});
    return result;
  }

  const loadSource = async () => validateSource(await readJson(paths.sourcePath), paths.sourcePath);
  const loadNormalizedState = async () => normalizeState(await loadState());

  async function patch(command) {
    const state = await loadNormalizedState();
    let next;
    switch (command?.operation) {
      case "set-selection": {
        const [source, models] = await Promise.all([loadSource(), listModels()]);
        next = selectCatalogModels(state, command.selectedModelIds || [], source, {
          availableModelIds: models.map((model) => model.id),
        });
        break;
      }
      case "update-model":
        next = updateCatalogEntry(state, command.modelId, command.entry);
        break;
      case "reset-model":
        next = resetCatalogEntry(state, command.modelId);
        break;
      case "resolve-template": {
        const source = await loadSource();
        next = resolveTemplateUpdates(state, command.modelIds || [], command.decision, source);
        break;
      }
      default:
        throw new Error("Unknown catalog patch operation");
    }
    await saveState(next);
    return { success: true };
  }

  async function preview() {
    const [source, state, previous] = await Promise.all([
      loadSource(),
      loadNormalizedState(),
      readJsonIfExists(paths.catalogPath),
    ]);
    const catalog = buildManagedCatalog(source, state);
    return {
      diff: diffCatalogs(previous || { models: [] }, catalog),
      catalog,
      catalogHash: hashJson(catalog),
      modelCount: catalog.models.length,
    };
  }

  async function apply({ baseUrl, apiKey } = {}) {
    const [source, state, keys, config] = await Promise.all([
      loadSource(),
      loadNormalizedState(),
      listApiKeys(),
      readTomlIfExists(paths.configPath),
    ]);
    if (state.recoveryRequired) {
      throw new Error("Disable and restore the previous Codex configuration before applying again");
    }
    const selectedKey = (keys || []).find((key) => key?.key === apiKey && key?.isActive !== false);
    if (!selectedKey) throw new Error("Select an active Dashboard API key");

    const catalog = buildManagedCatalog(source, state);
    const currentTime = now();
    const firstApply = !state.previousConfig;
    const originalState = cloneJson(state);
    let nextState = cloneJson(state);
    const nextConfig = applyOfficialPassthroughConfig(config, {
      baseUrl,
      apiKey,
      catalogPath: paths.catalogPath,
    });
    const catalogContent = `${JSON.stringify(catalog, null, 2)}\n`;
    const configContent = stringifyTOML(nextConfig);

    if (firstApply) {
      nextState.previousConfig = captureManagedConfig(config);
      nextState.lastBackupDir = await createBackup(paths, currentTime);
    }
    nextState = {
      ...nextState,
      managed: true,
      recoveryRequired: "A Codex apply did not finish cleanly. Restore before applying again.",
    };
    await saveState(nextState);

    try {
      await atomicWriteBatch([
        { filePath: paths.catalogPath, content: catalogContent },
        { filePath: paths.configPath, content: configContent },
      ]);
    } catch (error) {
      if (error.rollbackFailed) {
        nextState = {
          ...nextState,
          managed: true,
          recoveryRequired: error.message,
        };
        await saveState(nextState).catch(() => {});
      } else {
        await saveState(originalState).catch(() => {});
      }
      throw error;
    }

    nextState = {
      ...nextState,
      managed: true,
      recoveryRequired: null,
      lastGeneratedHash: hashJson(catalog),
      lastAppliedAt: currentTime.toISOString(),
    };
    await saveState(nextState);
    return {
      success: true,
      catalogPath: paths.catalogPath,
      modelCount: catalog.models.length,
      restartRequired: true,
    };
  }

  async function disable() {
    const [state, config] = await Promise.all([loadNormalizedState(), readTomlIfExists(paths.configPath)]);
    if (state.previousConfig) {
      const restored = restoreManagedConfig(config, state.previousConfig);
      await atomicWrite(paths.configPath, stringifyTOML(restored));
    }
    const nextState = {
      ...state,
      managed: false,
      recoveryRequired: null,
      previousConfig: null,
      lastGeneratedHash: null,
      lastAppliedAt: null,
    };
    await saveState(nextState);
    return { success: true, restartRequired: true };
  }

  async function getStatus() {
    const [state, models, keys, config, managedCatalog, sourceResult] = await Promise.all([
      loadNormalizedState(),
      listModels(),
      listApiKeys(),
      readTomlIfExists(paths.configPath),
      readJsonIfExists(paths.catalogPath).catch(() => null),
      loadSource().then((source) => ({ source })).catch((error) => ({ error })),
    ]);
    const source = sourceResult.source || null;
    const sourceError = sourceResult.error?.message || null;
    const modelById = new Map((models || []).map((model) => [model.id, model]));
    const officialSlugs = new Set((source?.models || []).map((model) => model?.slug).filter(Boolean));
    const pendingTemplateUpdates = source ? getPendingTemplateUpdates(state, source) : [];
    const selectedModels = Object.entries(state.selected).map(([modelId, record]) => ({
      id: modelId,
      owned_by: modelById.get(modelId)?.owned_by || "unavailable",
      available: modelById.has(modelId),
      conflict: officialSlugs.has(modelId),
      entry: materializeCatalogEntry(modelId, record),
      baseTemplateHash: record.baseTemplateHash,
      pendingTemplateUpdate: pendingTemplateUpdates.includes(modelId),
    }));
    const provider = config?.model_providers?.OpenAI || {};
    const matchingKey = (keys || []).find((key) => key.key === provider.experimental_bearer_token);

    let expectedHash = null;
    let dirty = true;
    let generationError = null;
    if (source && pendingTemplateUpdates.length === 0) {
      try {
        const expected = buildManagedCatalog(source, state);
        expectedHash = hashJson(expected);
        dirty = !managedCatalog || hashJson(managedCatalog) !== expectedHash;
      } catch (error) {
        generationError = error.message;
      }
    }

    return {
      paths: {
        sourcePath: paths.sourcePath,
        configPath: paths.configPath,
        catalogPath: paths.catalogPath,
      },
      source: source ? {
        valid: true,
        fetchedAt: source.fetched_at || null,
        clientVersion: source.client_version || null,
        officialModelCount: source.models.length,
        template: {
          slug: source.models[0]?.slug || null,
          displayName: source.models[0]?.display_name || source.models[0]?.slug || null,
          hash: hashJson(source.models[0]),
        },
      } : { valid: false, error: sourceError },
      mode: detectMode(config, paths.catalogPath),
      config: {
        baseUrl: provider.base_url || "",
        catalogPath: config?.model_catalog_json || "",
        configuredApiKeyId: matchingKey?.id || null,
        hasUnmatchedBearerToken: Boolean(provider.experimental_bearer_token && !matchingKey),
      },
      models: (models || []).map((model) => ({
        id: model.id,
        owned_by: model.owned_by || "unknown",
        conflict: officialSlugs.has(model.id),
      })),
      selectedModels,
      selectedModelIds: Object.keys(state.selected),
      pendingTemplateUpdates,
      dirty,
      expectedHash,
      generationError,
      managed: state.managed === true,
      recoveryRequired: state.recoveryRequired || null,
      lastAppliedAt: state.lastAppliedAt || null,
      catalogExists: Boolean(managedCatalog),
      restartRequired: state.managed === true && config?.model_catalog_json === paths.catalogPath,
    };
  }

  return {
    getStatus,
    patch: (command) => serializeMutation(() => patch(command)),
    preview: () => serializeMutation(preview),
    apply: (options) => serializeMutation(() => apply(options)),
    disable: () => serializeMutation(disable),
    paths,
  };
}
