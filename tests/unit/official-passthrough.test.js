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

  it("does not match when disabled", async () => {
    writeConfig(configPath, {
      enabled: false,
      models: ["gpt-5.5", "gpt-5.6"],
    });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();
    expect(mod.isOfficialPassthroughModel("gpt-5.5")).toBe(false);
  });

  it("matches configured model IDs case-insensitively", async () => {
    writeConfig(configPath, {
      enabled: true,
      models: ["gpt-5.5", "GPT-5.6"],
    });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();
    expect(mod.isOfficialPassthroughModel("gpt-5.5")).toBe(true);
    expect(mod.isOfficialPassthroughModel("GPT-5.5")).toBe(true);
    expect(mod.isOfficialPassthroughModel("gpt-5.6")).toBe(true);
    expect(mod.isOfficialPassthroughModel("gpt-5.4")).toBe(false);
  });

  it("does not match provider-prefixed models unless explicitly listed", async () => {
    writeConfig(configPath, {
      enabled: true,
      models: ["gpt-5.5"],
    });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();
    expect(mod.isOfficialPassthroughModel("gpt-5.5")).toBe(true);
    expect(mod.isOfficialPassthroughModel("cx/gpt-5.5")).toBe(false);
  });

  it("matches full prefixed string only when listed", async () => {
    writeConfig(configPath, {
      enabled: true,
      models: ["cx/gpt-5.5"],
    });
    const mod = await loadModule(configPath);
    mod._resetOfficialPassthroughCache();
    expect(mod.isOfficialPassthroughModel("cx/gpt-5.5")).toBe(true);
    expect(mod.isOfficialPassthroughModel("gpt-5.5")).toBe(false);
  });

  it("resolves ChatGPT subscription URL when account is present", async () => {
    const mod = await loadModule(configPath);
    expect(mod.resolveOfficialPassthroughUrl("/v1/responses", { hasChatGptAccount: true }))
      .toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(mod.resolveOfficialPassthroughUrl("/api/v1/responses", { hasChatGptAccount: true }))
      .toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(mod.resolveOfficialPassthroughUrl("/v1/responses/compact", { hasChatGptAccount: true }))
      .toBe("https://chatgpt.com/backend-api/codex/responses/compact");
  });

  it("resolves api.openai.com when no ChatGPT account", async () => {
    const mod = await loadModule(configPath);
    expect(mod.resolveOfficialPassthroughUrl("/v1/responses", { hasChatGptAccount: false }))
      .toBe("https://api.openai.com/v1/responses");
    expect(mod.resolveOfficialPassthroughUrl("/v1/chat/completions", { hasChatGptAccount: false }))
      .toBe("https://api.openai.com/v1/chat/completions");
  });

  it("forwards request body to official backend and streams status", async () => {
    writeConfig(configPath, {
      enabled: true,
      models: ["gpt-5.5"],
      preferClientAuth: true,
      fallbackCodexAuthJson: false,
    });

    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("gpt-5.5");
      expect(options.headers.Authorization).toMatch(/Bearer\s+sk-real/i);
      expect(options.headers["ChatGPT-Account-ID"] || options.headers["chatgpt-account-id"]).toBeTruthy();
      return new Response(JSON.stringify({ id: "resp_1", status: "completed" }), {
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
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
      }),
    });

    const res = await mod.handleOfficialPassthrough(request, {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe("resp_1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns 401 when no usable auth is available", async () => {
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
    const json = await res.json();
    expect(json.error.code).toBe("passthrough_auth_missing");
  });

  it("falls back to ~/.codex/auth.json style token when client auth is dummy", async () => {
    const authPath = path.join(tempDir, "auth.json");
    writeConfig(authPath, {
      tokens: { access_token: "from-codex-auth", account_id: "acct-from-file" },
    });
    // reuse writeConfig for auth.json shape
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
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dummy",
      },
      body: JSON.stringify({ model: "gpt-5.5" }),
    });

    const res = await mod.handleOfficialPassthrough(request, { model: "gpt-5.5" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
