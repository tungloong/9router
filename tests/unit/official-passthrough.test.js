import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  OFFICIAL_PASSTHROUGH_CONFIG: process.env.OFFICIAL_PASSTHROUGH_CONFIG,
};

async function loadModule(configPath) {
  process.env.OFFICIAL_PASSTHROUGH_CONFIG = configPath;
  vi.resetModules();
  return import("open-sse/utils/officialPassthrough.js");
}

function writeConfig(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

describe("official passthrough", () => {
  let tempDir;
  let configPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-passthrough-"));
    configPath = path.join(tempDir, "official-passthrough.json");
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalEnv.DATA_DIR;
    if (originalEnv.OFFICIAL_PASSTHROUGH_CONFIG === undefined) {
      delete process.env.OFFICIAL_PASSTHROUGH_CONFIG;
    } else {
      process.env.OFFICIAL_PASSTHROUGH_CONFIG = originalEnv.OFFICIAL_PASSTHROUGH_CONFIG;
    }
  });

  it("requires enabled: true (default disabled)", async () => {
    writeConfig(configPath, {
      enabled: false,
      models: ["gpt-5.5"],
    });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();
    expect(mod.shouldOfficialPassthrough("gpt-5.5", "/v1/responses")).toBe(false);
  });

  it("matches model on Responses endpoints only", async () => {
    writeConfig(configPath, {
      enabled: true,
      models: ["gpt-5.5", "GPT-5.6"],
    });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();

    expect(mod.shouldOfficialPassthrough("gpt-5.5", "/v1/responses")).toBe(true);
    expect(mod.shouldOfficialPassthrough("GPT-5.5", "/api/v1/responses")).toBe(true);
    expect(mod.shouldOfficialPassthrough("gpt-5.6", "/v1/responses/compact")).toBe(true);
    expect(mod.shouldOfficialPassthrough("gpt-5.5", "/codex/foo")).toBe(true);
    expect(mod.shouldOfficialPassthrough("gpt-5.5", "/responses")).toBe(true);

    // Not Responses
    expect(mod.shouldOfficialPassthrough("gpt-5.5", "/v1/chat/completions")).toBe(false);
    expect(mod.shouldOfficialPassthrough("gpt-5.5", "/v1/messages")).toBe(false);

    // Unlisted model
    expect(mod.shouldOfficialPassthrough("gpt-5.4", "/v1/responses")).toBe(false);
  });

  it("does not match provider-prefixed models unless listed", async () => {
    writeConfig(configPath, { enabled: true, models: ["gpt-5.5"] });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();
    expect(mod.shouldOfficialPassthrough("gpt-5.5", "/v1/responses")).toBe(true);
    expect(mod.shouldOfficialPassthrough("cx/gpt-5.5", "/v1/responses")).toBe(false);
  });

  it("resolves only Responses upstream URLs", async () => {
    const mod = await loadModule(configPath);
    expect(mod.resolveOfficialPassthroughUrl("/v1/responses", { hasChatGptAccount: true }))
      .toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(mod.resolveOfficialPassthroughUrl("/api/v1/responses/compact", { hasChatGptAccount: true }))
      .toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(mod.resolveOfficialPassthroughUrl("/v1/responses", { hasChatGptAccount: false }))
      .toBe("https://api.openai.com/v1/responses");
    expect(mod.resolveOfficialPassthroughUrl("/codex", { hasChatGptAccount: false }))
      .toBe("https://api.openai.com/v1/responses");
  });

  it("forwards Responses body to official backend", async () => {
    writeConfig(configPath, {
      enabled: true,
      models: ["gpt-5.5"],
      preferClientAuth: true,
      fallbackCodexAuthJson: false,
    });

    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(JSON.parse(options.body).model).toBe("gpt-5.5");
      expect(options.headers.Authorization).toMatch(/Bearer\s+sk-real/i);
      return new Response(JSON.stringify({ id: "resp_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();

    const request = new Request("http://localhost:20128/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-real-token",
        "ChatGPT-Account-ID": "acct-123",
      },
      body: JSON.stringify({ model: "gpt-5.5", input: [], stream: true }),
    });

    const res = await mod.handleOfficialPassthrough(request, { model: "gpt-5.5", input: [], stream: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "resp_1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns 401 when no usable auth", async () => {
    writeConfig(configPath, {
      enabled: true,
      models: ["gpt-5.5"],
      preferClientAuth: true,
      fallbackCodexAuthJson: false,
    });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();

    const request = new Request("http://localhost:20128/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });

    const res = await mod.handleOfficialPassthrough(request, { model: "gpt-5.5" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("passthrough_auth_missing");
  });

  it("falls back to codex auth.json when client auth is dummy", async () => {
    const authPath = path.join(tempDir, "auth.json");
    writeConfig(authPath, {
      tokens: { access_token: "from-codex-auth", account_id: "acct-from-file" },
    });
    writeConfig(configPath, {
      enabled: true,
      models: ["gpt-5.5"],
      preferClientAuth: true,
      fallbackCodexAuthJson: true,
      codexAuthPath: authPath,
    });

    const fetchMock = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe("Bearer from-codex-auth");
      expect(options.headers["ChatGPT-Account-ID"]).toBe("acct-from-file");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();

    const request = new Request("http://localhost:20128/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });

    const res = await mod.handleOfficialPassthrough(request, { model: "gpt-5.5" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
