import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTOML } from "confbox";

import { atomicWriteBatch, createCodexCatalogManager } from "../../src/lib/codex/catalogManager.js";

const tempDirs = [];

async function makeFixture(options = {}) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-codex-catalog-"));
  tempDirs.push(homeDir);
  const codexDir = path.join(homeDir, ".codex");
  await fs.mkdir(codexDir, { recursive: true });
  const source = {
    fetched_at: "2026-07-22T11:25:35Z",
    client_version: "0.145.0",
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        context_window: 272000,
        supports_search_tool: true,
      },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
    ],
  };
  await fs.writeFile(path.join(codexDir, "models_cache.json"), JSON.stringify(source));
  await fs.writeFile(path.join(codexDir, "config.toml"), [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    'model_provider = "Previous"',
    'model_catalog_json = "/tmp/previous.json"',
    "",
    "[model_providers.Previous]",
    'name = "Previous"',
    'base_url = "https://previous.test/v1"',
    "",
  ].join("\n"));
  const authContent = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "secret" } });
  await fs.writeFile(path.join(codexDir, "auth.json"), authContent);

  let state = null;
  const manager = createCodexCatalogManager({
    homeDir,
    loadState: async () => state,
    saveState: async (next) => {
      if (options.beforeSaveState) await options.beforeSaveState(next);
      state = structuredClone(next);
    },
    listModels: options.listModels || (async () => [
      { id: "fallback-primary", object: "model", owned_by: "combo" },
      { id: "openrouter/anthropic/claude-opus-4.6", object: "model", owned_by: "openrouter" },
    ]),
    listApiKeys: options.listApiKeys || (async () => [{ id: "key-1", key: "sk-dashboard", isActive: true }]),
    now: () => new Date("2026-07-23T10:00:00Z"),
  });
  return { homeDir, codexDir, source, authContent, manager, getState: () => state };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Codex catalog manager", () => {
  it("applies the managed catalog without changing model or auth and restores managed config", async () => {
    const { codexDir, source, authContent, manager, getState } = await makeFixture();
    await manager.patch({
      operation: "set-selection",
      selectedModelIds: ["fallback-primary", "openrouter/anthropic/claude-opus-4.6"],
    });

    const preview = await manager.preview();
    expect(preview.diff.added).toEqual(expect.arrayContaining([
      "gpt-5.6-sol",
      "codex-auto-review",
      "fallback-primary",
      "openrouter/anthropic/claude-opus-4.6",
    ]));

    const applied = await manager.apply({
      baseUrl: "http://localhost:20128",
      apiKey: "sk-dashboard",
    });
    expect(applied.restartRequired).toBe(true);

    const catalogPath = path.join(codexDir, "model-catalogs", "9router-catalog.json");
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    expect(catalog.models.slice(0, 2)).toEqual(source.models);
    expect(catalog.models.slice(2).map((model) => model.slug)).toEqual([
      "fallback-primary",
      "openrouter/anthropic/claude-opus-4.6",
    ]);

    const appliedConfig = parseTOML(await fs.readFile(path.join(codexDir, "config.toml"), "utf8"));
    expect(appliedConfig.model).toBe("gpt-5.6-sol");
    expect(appliedConfig.model_reasoning_effort).toBe("max");
    expect(appliedConfig.model_provider).toBe("OpenAI");
    expect(appliedConfig.model_catalog_json).toBe(catalogPath);
    expect(appliedConfig.model_providers.OpenAI).toMatchObject({
      requires_openai_auth: true,
      base_url: "http://localhost:20128/v1",
      experimental_bearer_token: "sk-dashboard",
    });
    expect((await manager.getStatus()).mode).toBe("official-passthrough");
    expect(await fs.readFile(path.join(codexDir, "auth.json"), "utf8")).toBe(authContent);
    expect(getState().previousConfig).toBeTruthy();
    expect((await fs.stat(catalogPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(codexDir, "config.toml"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(getState().lastBackupDir, "config.toml"), "utf8"))
      .toContain('model_provider = "Previous"');
    expect((await fs.stat(path.join(getState().lastBackupDir, "config.toml"))).mode & 0o777)
      .toBe(0o600);

    await manager.disable();
    const restored = parseTOML(await fs.readFile(path.join(codexDir, "config.toml"), "utf8"));
    expect(restored.model).toBe("gpt-5.6-sol");
    expect(restored.model_reasoning_effort).toBe("max");
    expect(restored.model_provider).toBe("Previous");
    expect(restored.model_catalog_json).toBe("/tmp/previous.json");
    expect(restored.model_providers.OpenAI).toBeUndefined();
    expect(restored.model_providers.Previous.base_url).toBe("https://previous.test/v1");
    expect(await fs.readFile(path.join(codexDir, "auth.json"), "utf8")).toBe(authContent);
  });

  it("leaves the active catalog and config untouched when models_cache.json is invalid", async () => {
    const { codexDir, manager } = await makeFixture();
    await manager.patch({ operation: "set-selection", selectedModelIds: ["fallback-primary"] });
    await manager.apply({ baseUrl: "http://localhost:20128", apiKey: "sk-dashboard" });

    const catalogPath = path.join(codexDir, "model-catalogs", "9router-catalog.json");
    const configPath = path.join(codexDir, "config.toml");
    const catalogBefore = await fs.readFile(catalogPath, "utf8");
    const configBefore = await fs.readFile(configPath, "utf8");
    await fs.writeFile(path.join(codexDir, "models_cache.json"), "{broken");

    await expect(manager.apply({ baseUrl: "http://localhost:20128", apiKey: "sk-dashboard" }))
      .rejects.toThrow("Invalid JSON");
    expect(await fs.readFile(catalogPath, "utf8")).toBe(catalogBefore);
    expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);
  });

  it("does not write Codex files when no active Dashboard key is selected", async () => {
    const { codexDir, manager } = await makeFixture();
    const configPath = path.join(codexDir, "config.toml");
    const configBefore = await fs.readFile(configPath, "utf8");

    await expect(manager.apply({ baseUrl: "http://localhost:20128", apiKey: "missing" }))
      .rejects.toThrow("Select an active Dashboard API key");
    await expect(fs.access(path.join(codexDir, "model-catalogs", "9router-catalog.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);
  });

  it("validates the endpoint before creating backup or recovery state", async () => {
    const { codexDir, manager, getState } = await makeFixture();

    await expect(manager.apply({ baseUrl: "", apiKey: "sk-dashboard" }))
      .rejects.toThrow("baseUrl is required");
    expect(getState()).toBeNull();
    await expect(fs.access(path.join(codexDir, "backups", "9router-catalog")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not misidentify an unrelated OpenAI provider as managed passthrough", async () => {
    const { codexDir, manager } = await makeFixture();
    await fs.writeFile(path.join(codexDir, "config.toml"), [
      'model_provider = "OpenAI"',
      'model_catalog_json = "/tmp/unrelated-catalog.json"',
      "",
      "[model_providers.OpenAI]",
      'name = "OpenAI"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'base_url = "https://example.test/v1"',
    ].join("\n"));

    expect((await manager.getStatus()).mode).toBe("other");
  });

  it("reports a collision introduced by a later official cache without breaking status", async () => {
    const { codexDir, manager, source } = await makeFixture();
    await manager.patch({ operation: "set-selection", selectedModelIds: ["fallback-primary"] });
    await fs.writeFile(path.join(codexDir, "models_cache.json"), JSON.stringify({
      ...source,
      models: [
        ...source.models,
        { slug: "fallback-primary", display_name: "New official model" },
      ],
    }));

    const conflicted = await manager.getStatus();
    expect(conflicted.generationError).toContain("conflicts with an official model");
    expect(conflicted.selectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fallback-primary", conflict: true }),
    ]));

    await manager.patch({ operation: "set-selection", selectedModelIds: [] });
    expect((await manager.getStatus()).generationError).toBeNull();
  });

  it("serializes draft updates ahead of apply", async () => {
    let releaseModels;
    const models = new Promise((resolve) => { releaseModels = resolve; });
    const { codexDir, manager } = await makeFixture({ listModels: async () => models });

    const patchPromise = manager.patch({
      operation: "set-selection",
      selectedModelIds: ["fallback-primary"],
    });
    await Promise.resolve();
    const applyPromise = manager.apply({
      baseUrl: "http://localhost:20128",
      apiKey: "sk-dashboard",
    });
    releaseModels([{ id: "fallback-primary", object: "model", owned_by: "combo" }]);

    await Promise.all([patchPromise, applyPromise]);
    const catalog = JSON.parse(await fs.readFile(
      path.join(codexDir, "model-catalogs", "9router-catalog.json"),
      "utf8",
    ));
    expect(catalog.models.at(-1).slug).toBe("fallback-primary");
  });

  it("rolls back earlier files when a later atomic rename fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-codex-batch-"));
    tempDirs.push(dir);
    const firstPath = path.join(dir, "first.json");
    const secondPath = path.join(dir, "second.toml");
    await fs.writeFile(firstPath, "first-before");
    await fs.writeFile(secondPath, "second-before");
    let renameCount = 0;

    await expect(atomicWriteBatch([
      { filePath: firstPath, content: "first-after" },
      { filePath: secondPath, content: "second-after" },
    ], {
      rename: async (from, to) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error("simulated second rename failure");
        await fs.rename(from, to);
      },
    })).rejects.toThrow("simulated second rename failure");

    expect(await fs.readFile(firstPath, "utf8")).toBe("first-before");
    expect(await fs.readFile(secondPath, "utf8")).toBe("second-before");
  });

  it("leaves a recoverable journal if final state persistence fails after file commit", async () => {
    let saveCount = 0;
    const { codexDir, manager, getState } = await makeFixture({
      beforeSaveState: async () => {
        saveCount += 1;
        if (saveCount === 2) throw new Error("simulated final state failure");
      },
    });

    await expect(manager.apply({
      baseUrl: "http://localhost:20128",
      apiKey: "sk-dashboard",
    })).rejects.toThrow("simulated final state failure");

    expect(getState()).toMatchObject({ managed: true });
    expect(getState().recoveryRequired).toContain("did not finish cleanly");
    const config = parseTOML(await fs.readFile(path.join(codexDir, "config.toml"), "utf8"));
    expect(config.model_provider).toBe("OpenAI");
  });
});
