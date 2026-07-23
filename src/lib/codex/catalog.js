import { createHash } from "node:crypto";

const STATE_VERSION = 1;

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])])
  );
}

function stableStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

export function hashJson(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function createCatalogState() {
  return {
    version: STATE_VERSION,
    selected: {},
  };
}

function requireTemplate(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Codex models cache must be a JSON object");
  }
  if (!Array.isArray(source.models) || source.models.length === 0) {
    throw new Error("Codex models cache does not contain any models");
  }
  const template = source.models[0];
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new Error("Codex models cache models[0] is invalid");
  }
  return template;
}

function createBaseEntry(template, modelId) {
  return {
    ...cloneJson(template),
    slug: modelId,
    display_name: modelId,
  };
}

function selectedRecord(state, modelId) {
  const selected = state?.selected;
  return selected && Object.prototype.hasOwnProperty.call(selected, modelId)
    ? selected[modelId]
    : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && valuesEqual(left[key], right[key]));
}

function diffEntry(base, next, path = [], patch = { set: [], remove: [] }) {
  if (valuesEqual(base, next)) return patch;
  if (!isPlainObject(base) || !isPlainObject(next)) {
    patch.set.push({ path, value: cloneJson(next) });
    return patch;
  }

  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  for (const key of keys) {
    const childPath = [...path, key];
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      patch.remove.push(childPath);
    } else if (!Object.prototype.hasOwnProperty.call(base, key)) {
      patch.set.push({ path: childPath, value: cloneJson(next[key]) });
    } else {
      diffEntry(base[key], next[key], childPath, patch);
    }
  }
  return patch;
}

function deleteAtPath(target, path) {
  if (path.length === 0) return;
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = cursor?.[path[index]];
    if (!isPlainObject(cursor)) return;
  }
  delete cursor[path[path.length - 1]];
}

function setAtPath(target, path, value) {
  if (path.length === 0) return cloneJson(value);
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!Object.prototype.hasOwnProperty.call(cursor, key) || !isPlainObject(cursor[key])) {
      Object.defineProperty(cursor, key, {
        value: {},
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    cursor = cursor[key];
  }
  Object.defineProperty(cursor, path[path.length - 1], {
    value: cloneJson(value),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return target;
}

function applyOverrides(base, overrides) {
  let next = cloneJson(base);
  for (const path of overrides?.remove || []) deleteAtPath(next, path);
  for (const operation of overrides?.set || []) {
    next = setAtPath(next, operation.path, operation.value);
  }
  return next;
}

export function selectCatalogModels(state, modelIds, source, options = {}) {
  const template = requireTemplate(source);
  const current = state?.selected || {};
  const nextSelected = Object.create(null);
  const officialSlugs = new Set(source.models.map((model) => model?.slug).filter(Boolean));
  const availableModelIds = Array.isArray(options.availableModelIds)
    ? new Set(options.availableModelIds)
    : null;

  for (const modelId of new Set(modelIds)) {
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error("Selected model id must be a non-empty string");
    }
    if (officialSlugs.has(modelId)) {
      throw new Error(`Model id conflicts with an official model: ${modelId}`);
    }
    const existing = Object.prototype.hasOwnProperty.call(current, modelId)
      ? current[modelId]
      : null;
    if (existing) {
      nextSelected[modelId] = cloneJson(existing);
      continue;
    }
    if (availableModelIds && !availableModelIds.has(modelId)) {
      throw new Error(`Model is not available from /v1/models: ${modelId}`);
    }
    nextSelected[modelId] = {
      baseTemplate: cloneJson(template),
      baseTemplateHash: hashJson(template),
      acknowledgedTemplateHash: hashJson(template),
      overrides: { set: [], remove: [] },
    };
  }

  return {
    ...createCatalogState(),
    ...cloneJson(state || {}),
    selected: nextSelected,
  };
}

export function materializeCatalogEntry(modelId, record) {
  const entry = applyOverrides(createBaseEntry(record.baseTemplate, modelId), record.overrides);
  entry.slug = modelId;
  return entry;
}

function assertOptionalString(entry, field) {
  const value = entry[field];
  if (value != null && typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
}

function assertOptionalBoolean(entry, field) {
  const value = entry[field];
  if (value != null && typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
}

function assertPositiveNumber(entry, field, { max = null } = {}) {
  const value = entry[field];
  if (value == null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (max != null && value > max)) {
    throw new Error(`${field} must be a positive number${max != null ? ` no greater than ${max}` : ""}`);
  }
}

export function validateCatalogEntry(entry, modelId) {
  if (!isPlainObject(entry)) throw new Error("Catalog model entry must be an object");
  if (entry.slug !== modelId) throw new Error(`Catalog slug must match model id: ${modelId}`);
  if (typeof entry.display_name !== "string" || !entry.display_name.trim()) {
    throw new Error("display_name must be a non-empty string");
  }

  for (const field of ["description", "visibility", "default_reasoning_level"]) {
    assertOptionalString(entry, field);
  }
  for (const field of ["supports_search_tool", "supports_parallel_tool_calls"]) {
    assertOptionalBoolean(entry, field);
  }
  assertPositiveNumber(entry, "context_window");
  assertPositiveNumber(entry, "max_context_window");
  assertPositiveNumber(entry, "effective_context_window_percent", { max: 100 });
  if (entry.priority != null && (typeof entry.priority !== "number" || !Number.isFinite(entry.priority))) {
    throw new Error("priority must be a number");
  }

  if (entry.input_modalities != null && (
    !Array.isArray(entry.input_modalities)
    || entry.input_modalities.some((value) => typeof value !== "string")
  )) {
    throw new Error("input_modalities must be an array of strings");
  }

  if (entry.supported_reasoning_levels != null) {
    if (!Array.isArray(entry.supported_reasoning_levels) || entry.supported_reasoning_levels.some((level) => (
      !isPlainObject(level)
      || typeof level.effort !== "string"
      || !level.effort.trim()
      || (level.description != null && typeof level.description !== "string")
    ))) {
      throw new Error("supported_reasoning_levels must contain effort objects");
    }
  }

  if (entry.default_reasoning_level != null) {
    const efforts = new Set((entry.supported_reasoning_levels || []).map((level) => level.effort));
    if (!efforts.has(entry.default_reasoning_level)) {
      throw new Error("default_reasoning_level must exist in supported_reasoning_levels");
    }
  }
  return entry;
}

export function updateCatalogEntry(state, modelId, entry) {
  const record = selectedRecord(state, modelId);
  if (!record) throw new Error(`Model is not selected: ${modelId}`);
  validateCatalogEntry(entry, modelId);

  const baseEntry = createBaseEntry(record.baseTemplate, modelId);
  const nextState = cloneJson(state);
  nextState.selected[modelId] = {
    ...cloneJson(record),
    overrides: diffEntry(baseEntry, entry),
  };
  return nextState;
}

export function resetCatalogEntry(state, modelId) {
  const record = selectedRecord(state, modelId);
  if (!record) throw new Error(`Model is not selected: ${modelId}`);
  const nextState = cloneJson(state);
  nextState.selected[modelId].overrides = { set: [], remove: [] };
  return nextState;
}

export function getPendingTemplateUpdates(state, source) {
  const template = requireTemplate(source);
  const currentHash = hashJson(template);
  return Object.entries(state?.selected || {})
    .filter(([, record]) => (
      record.baseTemplateHash !== currentHash
      && record.acknowledgedTemplateHash !== currentHash
    ))
    .map(([modelId]) => modelId);
}

export function resolveTemplateUpdates(state, modelIds, decision, source) {
  if (decision !== "keep" && decision !== "refresh") {
    throw new Error("Template decision must be keep or refresh");
  }
  const template = requireTemplate(source);
  const templateHash = hashJson(template);
  const nextState = cloneJson(state);

  for (const modelId of modelIds) {
    const record = selectedRecord(nextState, modelId);
    if (!record) throw new Error(`Model is not selected: ${modelId}`);
    if (decision === "refresh") {
      record.baseTemplate = cloneJson(template);
      record.baseTemplateHash = templateHash;
    }
    record.acknowledgedTemplateHash = templateHash;
  }
  return nextState;
}

export function buildManagedCatalog(source, state) {
  requireTemplate(source);
  const pending = getPendingTemplateUpdates(state, source);
  if (pending.length > 0) {
    throw new Error(`Resolve template update decisions before generating: ${pending.join(", ")}`);
  }
  const official = cloneJson(source);
  const officialSlugs = new Set(official.models.map((model) => model?.slug).filter(Boolean));
  const selected = Object.entries(state?.selected || {}).map(([modelId, record]) => {
    if (officialSlugs.has(modelId)) {
      throw new Error(`Model id conflicts with an official model: ${modelId}`);
    }
    return validateCatalogEntry(materializeCatalogEntry(modelId, record), modelId);
  });
  official.models.push(...selected);
  return official;
}

function jsonPointer(path) {
  if (path.length === 0) return "/";
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function collectEntryChanges(before, after, path = [], changes = [], beforeExists = true, afterExists = true) {
  if (beforeExists && afterExists && valuesEqual(before, after)) return changes;
  if (beforeExists && afterExists && isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      collectEntryChanges(before[key], after[key], [...path, key], changes, hasBefore, hasAfter);
    }
    return changes;
  }

  changes.push({
    path: jsonPointer(path),
    beforeExists,
    afterExists,
    ...(beforeExists ? { before: cloneJson(before) } : {}),
    ...(afterExists ? { after: cloneJson(after) } : {}),
  });
  return changes;
}

export function diffCatalogs(previous, next) {
  const previousBySlug = new Map((previous?.models || []).map((entry) => [entry?.slug, entry]));
  const nextBySlug = new Map((next?.models || []).map((entry) => [entry?.slug, entry]));
  const added = [];
  const removed = [];
  const changed = [];
  const changedDetails = [];
  let unchanged = 0;

  for (const [slug, entry] of nextBySlug) {
    if (!previousBySlug.has(slug)) added.push(slug);
    else if (stableStringify(previousBySlug.get(slug)) !== stableStringify(entry)) {
      changed.push(slug);
      changedDetails.push({
        slug,
        changes: collectEntryChanges(previousBySlug.get(slug), entry),
      });
    }
    else unchanged += 1;
  }
  for (const slug of previousBySlug.keys()) {
    if (!nextBySlug.has(slug)) removed.push(slug);
  }
  return { added, removed, changed, changedDetails, unchanged };
}
