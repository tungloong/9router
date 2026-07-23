import { NextResponse } from "next/server";

import { createCodexCatalogManager } from "@/lib/codex/catalogManager";
import { getApiKeys, getSettings, updateSettings } from "@/lib/localDb";
import { buildModelsList, LLM_KIND } from "@/lib/models/buildModelsList";

export const dynamic = "force-dynamic";

const manager = createCodexCatalogManager({
  loadState: async () => (await getSettings()).codexCatalog || null,
  saveState: async (state) => {
    await updateSettings({ codexCatalog: state });
  },
  listModels: async () => buildModelsList([LLM_KIND]),
  listApiKeys: getApiKeys,
});

function errorResponse(error, status = 400) {
  console.log("Codex catalog error:", error);
  return NextResponse.json({ error: error?.message || "Codex catalog operation failed" }, { status });
}

export async function GET() {
  try {
    return NextResponse.json(await manager.getStatus());
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function PATCH(request) {
  try {
    const command = await request.json();
    return NextResponse.json(await manager.patch(command));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (body?.action === "preview") {
      return NextResponse.json(await manager.preview());
    }
    if (body?.action === "apply") {
      return NextResponse.json(await manager.apply({
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
      }));
    }
    return NextResponse.json({ error: "action must be preview or apply" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE() {
  try {
    return NextResponse.json(await manager.disable());
  } catch (error) {
    return errorResponse(error);
  }
}
