import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

const { GET, PATCH } = await import("../../src/app/api/settings/route.js");

describe("private settings fields", () => {
  const storedSettings = {
    requireLogin: false,
    theme: "system",
    password: "password-hash",
    oidcClientSecret: "oidc-secret",
    codexCatalog: {
      previousConfig: {
        openAIProvider: {
          exists: true,
          value: { experimental_bearer_token: "private-codex-token" },
        },
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(structuredClone(storedSettings));
    mocks.updateSettings.mockImplementation(async (patch) => ({
      ...structuredClone(storedSettings),
      ...patch,
    }));
  });

  it("does not expose Codex catalog state through the generic settings API", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body).not.toHaveProperty("codexCatalog");
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("oidcClientSecret");
    expect(body.hasPassword).toBe(true);
  });

  it("does not allow the generic settings API to overwrite Codex catalog state", async () => {
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        theme: "dark",
        codexCatalog: { selected: { injected: true } },
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
    expect(body.theme).toBe("dark");
    expect(body).not.toHaveProperty("codexCatalog");
  });
});
