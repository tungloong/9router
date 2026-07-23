import { describe, expect, it } from "vitest";

import {
  applyOfficialPassthroughConfig,
  captureManagedConfig,
  restoreManagedConfig,
} from "../../src/lib/codex/config.js";

describe("Codex official passthrough config", () => {
  it("changes only managed fields and restores their previous values", () => {
    const original = {
      model: "gpt-5.6-sol",
      model_reasoning_effort: "max",
      model_provider: "PreviousProvider",
      model_catalog_json: "/tmp/previous.json",
      model_providers: {
        OpenAI: { name: "Previous OpenAI", base_url: "https://example.test/v1" },
        custom: { name: "Keep me", base_url: "https://custom.test/v1" },
      },
      agents: { subagent: { model: "ocg/glm-5.2" } },
    };
    const snapshot = captureManagedConfig(original);

    const applied = applyOfficialPassthroughConfig(original, {
      baseUrl: "http://localhost:20128",
      apiKey: "sk-dashboard",
      catalogPath: "/Users/test/.codex/model-catalogs/9router-catalog.json",
    });

    expect(applied).toMatchObject({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "max",
      model_provider: "OpenAI",
      model_catalog_json: "/Users/test/.codex/model-catalogs/9router-catalog.json",
      agents: { subagent: { model: "ocg/glm-5.2" } },
      model_providers: {
        OpenAI: {
          name: "OpenAI",
          wire_api: "responses",
          requires_openai_auth: true,
          supports_websockets: false,
          base_url: "http://localhost:20128/v1",
          experimental_bearer_token: "sk-dashboard",
        },
        custom: { name: "Keep me", base_url: "https://custom.test/v1" },
      },
    });
    expect(restoreManagedConfig(applied, snapshot)).toEqual(original);
  });

  it("removes managed fields on restore when they did not previously exist", () => {
    const original = { model: "gpt-5.6-sol", model_providers: { custom: { name: "Custom" } } };
    const snapshot = captureManagedConfig(original);
    const applied = applyOfficialPassthroughConfig(original, {
      baseUrl: "http://127.0.0.1:20128/v1/",
      apiKey: "sk-dashboard",
      catalogPath: "/tmp/9router-catalog.json",
    });

    expect(restoreManagedConfig(applied, snapshot)).toEqual(original);
  });
});
