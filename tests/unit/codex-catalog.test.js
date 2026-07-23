import { describe, expect, it } from "vitest";

import {
  buildManagedCatalog,
  createCatalogState,
  diffCatalogs,
  getPendingTemplateUpdates,
  materializeCatalogEntry,
  resetCatalogEntry,
  resolveTemplateUpdates,
  selectCatalogModels,
  updateCatalogEntry,
} from "../../src/lib/codex/catalog.js";

const officialSource = () => ({
  fetched_at: "2026-07-22T11:25:35Z",
  client_version: "0.145.0",
  extra_top_level: { preserved: true },
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      context_window: 272000,
      max_context_window: 272000,
      supports_search_tool: true,
      service_tiers: ["priority"],
      input_modalities: ["text", "image"],
      nested: { preserved: true },
    },
    {
      slug: "codex-auto-review",
      display_name: "Codex Auto Review",
      visibility: "hide",
    },
  ],
});

describe("Codex managed catalog", () => {
  it("clones models[0] and changes only slug and display_name", () => {
    const source = officialSource();
    const initial = createCatalogState();
    const state = selectCatalogModels(initial, ["openrouter/anthropic/claude-opus-4.6"], source);

    const catalog = buildManagedCatalog(source, state);

    expect(catalog).toEqual({
      ...source,
      models: [
        ...source.models,
        {
          ...source.models[0],
          slug: "openrouter/anthropic/claude-opus-4.6",
          display_name: "openrouter/anthropic/claude-opus-4.6",
        },
      ],
    });
    expect(source).toEqual(officialSource());
  });

  it("stores metadata edits as overrides while keeping slug immutable", () => {
    const source = officialSource();
    const modelId = "nvidia/z-ai/glm-5.2";
    let state = selectCatalogModels(createCatalogState(), [modelId], source);
    const initialEntry = materializeCatalogEntry(modelId, state.selected[modelId]);
    const editedEntry = {
      ...initialEntry,
      display_name: "GLM 5.2 on NVIDIA",
      context_window: 200000,
      supports_search_tool: false,
    };
    delete editedEntry.description;

    state = updateCatalogEntry(state, modelId, editedEntry);

    expect(state.selected[modelId].entry).toBeUndefined();
    expect(materializeCatalogEntry(modelId, state.selected[modelId])).toEqual(editedEntry);
    expect(() => updateCatalogEntry(state, modelId, { ...editedEntry, slug: "renamed" }))
      .toThrow("slug must match");
    state = resetCatalogEntry(state, modelId);
    expect(materializeCatalogEntry(modelId, state.selected[modelId])).toEqual(initialEntry);
  });

  it("requires a per-model decision when models[0] changes", () => {
    const source = officialSource();
    const modelId = "fallback-primary";
    let state = selectCatalogModels(createCatalogState(), [modelId], source);
    const edited = materializeCatalogEntry(modelId, state.selected[modelId]);
    edited.display_name = "Primary fallback";
    edited.context_window = 128000;
    delete edited.description;
    state = updateCatalogEntry(state, modelId, edited);

    const updatedSource = officialSource();
    updatedSource.models[0] = {
      ...updatedSource.models[0],
      description: "Updated official template",
      supports_search_tool: false,
      new_template_field: "new",
    };

    expect(getPendingTemplateUpdates(state, updatedSource)).toEqual([modelId]);
    expect(() => buildManagedCatalog(updatedSource, state)).toThrow("template update decisions");

    const kept = resolveTemplateUpdates(state, [modelId], "keep", updatedSource);
    expect(getPendingTemplateUpdates(kept, updatedSource)).toEqual([]);
    expect(materializeCatalogEntry(modelId, kept.selected[modelId])).toEqual(edited);

    const refreshed = resolveTemplateUpdates(state, [modelId], "refresh", updatedSource);
    expect(getPendingTemplateUpdates(refreshed, updatedSource)).toEqual([]);
    expect(materializeCatalogEntry(modelId, refreshed.selected[modelId])).toMatchObject({
      slug: modelId,
      display_name: "Primary fallback",
      context_window: 128000,
      supports_search_tool: false,
      new_template_field: "new",
    });
    expect(materializeCatalogEntry(modelId, refreshed.selected[modelId])).not.toHaveProperty("description");
  });

  it("keeps raw v1 model ids and rejects official slug collisions", () => {
    const source = officialSource();
    const ids = ["fallback-primary", "openrouter/anthropic/claude-opus-4.6", "__proto__"];
    const state = selectCatalogModels(createCatalogState(), ids, source, {
      availableModelIds: ids,
    });

    expect(buildManagedCatalog(source, state).models.slice(-3).map((model) => model.slug)).toEqual(ids);
    expect(() => selectCatalogModels(state, [...ids, "gpt-5.6-sol"], source, {
      availableModelIds: [...ids, "gpt-5.6-sol"],
    })).toThrow("conflicts with an official model");
    expect(() => selectCatalogModels(createCatalogState(), ["missing/new-model"], source, {
      availableModelIds: ids,
    })).toThrow("not available");

    const retainedWhileMissing = selectCatalogModels(state, ids, source, {
      availableModelIds: [],
    });
    expect(Object.keys(retainedWhileMissing.selected)).toEqual(ids);
  });

  it("validates editable catalog field types and reasoning defaults", () => {
    const source = officialSource();
    const modelId = "ocg/glm-5.2";
    const state = selectCatalogModels(createCatalogState(), [modelId], source);
    const entry = materializeCatalogEntry(modelId, state.selected[modelId]);

    expect(() => updateCatalogEntry(state, modelId, { ...entry, context_window: "large" }))
      .toThrow("context_window must be a positive number");
    expect(() => updateCatalogEntry(state, modelId, {
      ...entry,
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
    })).toThrow("default_reasoning_level must exist");
  });

  it("summarizes preview changes by slug", () => {
    const before = {
      models: [
        { slug: "official", display_name: "Official" },
        { slug: "removed", display_name: "Removed" },
        { slug: "changed", display_name: "Before" },
      ],
    };
    const after = {
      models: [
        { slug: "official", display_name: "Official" },
        { slug: "changed", display_name: "After" },
        { slug: "added/provider/model", display_name: "Added" },
      ],
    };

    expect(diffCatalogs(before, after)).toEqual({
      added: ["added/provider/model"],
      removed: ["removed"],
      changed: ["changed"],
      changedDetails: [{
        slug: "changed",
        changes: [{
          path: "/display_name",
          beforeExists: true,
          afterExists: true,
          before: "Before",
          after: "After",
        }],
      }],
      unchanged: 1,
    });
  });
});
