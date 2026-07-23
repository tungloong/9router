"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/shared/components";
import CodexMetadataEditorModal from "./CodexMetadataEditorModal";

function ensureV1(url) {
  const trimmed = (url || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function StatusPill({ tone = "neutral", children }) {
  const tones = {
    neutral: "bg-surface-2 text-text-muted",
    success: "bg-green-500/10 text-green-600 dark:text-green-400",
    warning: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
    info: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  };
  return <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function DiffList({ label, values, tone }) {
  if (!values?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text-main">{label}</span>
        <StatusPill tone={tone}>{values.length}</StatusPill>
      </div>
      <div className="max-h-36 overflow-y-auto rounded border border-border bg-bg p-2 font-mono text-xs text-text-muted">
        {values.map((value) => <div key={value} className="break-all py-0.5">{value}</div>)}
      </div>
    </div>
  );
}

function previewValue(value, exists) {
  if (!exists) return "(missing)";
  const serialized = JSON.stringify(value);
  if (serialized == null) return String(value);
  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

function MetadataChanges({ details = [] }) {
  if (details.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold text-text-main">Metadata / template changes</h4>
      <div className="max-h-64 overflow-y-auto rounded border border-border bg-bg p-2">
        {details.map((detail) => (
          <div key={detail.slug} className="border-b border-border/60 py-2 last:border-b-0">
            <code className="break-all text-xs font-semibold text-text-main">{detail.slug}</code>
            <div className="mt-1 flex flex-col gap-1">
              {detail.changes.map((change) => (
                <div key={change.path} className="grid min-w-0 grid-cols-1 gap-0.5 text-[11px] text-text-muted sm:grid-cols-[10rem_1fr] sm:gap-2">
                  <code className="break-all text-text-main">{change.path}</code>
                  <span className="min-w-0 break-all font-mono">
                    {previewValue(change.before, change.beforeExists)} → {previewValue(change.after, change.afterExists)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CodexCatalogPanel({ status, onRefresh, baseUrl, apiKeys = [] }) {
  const [endpoint, setEndpoint] = useState("");
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [editingModel, setEditingModel] = useState(null);

  const activeApiKeys = useMemo(
    () => apiKeys.filter((key) => key.isActive !== false),
    [apiKeys]
  );

  useEffect(() => {
    if (!status) return;
    const managedEndpoint = status.mode === "official-passthrough" ? status.config?.baseUrl : "";
    setEndpoint((current) => current || managedEndpoint || ensureV1(baseUrl));
    setSelectedApiKey((current) => {
      if (current && activeApiKeys.some((key) => key.key === current)) return current;
      const configured = activeApiKeys.find((key) => key.id === status.config?.configuredApiKeyId);
      return configured?.key || activeApiKeys[0]?.key || "";
    });
  }, [status, baseUrl, activeApiKeys]);

  const selectedById = useMemo(
    () => new Map((status?.selectedModels || []).map((model) => [model.id, model])),
    [status?.selectedModels]
  );

  const groupedModels = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const groups = new Map();
    for (const model of status?.models || []) {
      if (needle && !model.id.toLowerCase().includes(needle) && !model.owned_by.toLowerCase().includes(needle)) continue;
      const group = groups.get(model.owned_by) || [];
      group.push(model);
      groups.set(model.owned_by, group);
    }
    return Array.from(groups.entries())
      .map(([provider, models]) => [provider, models.sort((left, right) => left.id.localeCompare(right.id))])
      .sort(([left], [right]) => left.localeCompare(right));
  }, [status?.models, search]);

  const request = async (method, body) => {
    const response = await fetch("/api/cli-tools/codex-catalog", {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Codex catalog request failed");
    return data;
  };

  const runPatch = async (command, busyKey = "saving") => {
    setBusy(busyKey);
    setMessage(null);
    try {
      await request("PATCH", command);
      await onRefresh();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
      await onRefresh().catch(() => {});
      throw error;
    } finally {
      setBusy("");
    }
  };

  const toggleModel = async (modelId, checked) => {
    const selected = new Set(status.selectedModelIds || []);
    if (checked) selected.add(modelId);
    else selected.delete(modelId);
    await runPatch({ operation: "set-selection", selectedModelIds: Array.from(selected) }, `select:${modelId}`)
      .catch(() => {});
  };

  const resolveTemplates = async (modelIds, decision) => {
    await runPatch({ operation: "resolve-template", modelIds, decision }, `template:${decision}`)
      .catch(() => {});
  };

  const showPreview = async () => {
    setBusy("preview");
    setMessage(null);
    try {
      setPreview(await request("POST", { action: "preview" }));
    } catch (error) {
      setMessage({ type: "error", text: error.message });
      await onRefresh().catch(() => {});
    } finally {
      setBusy("");
    }
  };

  const apply = async () => {
    setBusy("apply");
    setMessage(null);
    try {
      const result = await request("POST", {
        action: "apply",
        baseUrl: ensureV1(endpoint),
        apiKey: selectedApiKey,
      });
      setMessage({
        type: "success",
        text: `Catalog applied with ${result.modelCount} models. Restart Codex to load it.`,
      });
      await onRefresh();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
      await onRefresh().catch(() => {});
    } finally {
      setBusy("");
    }
  };

  const disable = async () => {
    setBusy("disable");
    setMessage(null);
    try {
      await request("DELETE");
      setMessage({ type: "success", text: "Managed fields restored. Restart Codex to reload its catalog." });
      await onRefresh();
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setBusy("");
    }
  };

  const saveMetadata = async (entry) => {
    await runPatch({ operation: "update-model", modelId: editingModel.id, entry }, `edit:${editingModel.id}`);
  };

  const resetMetadata = async () => {
    await runPatch({ operation: "reset-model", modelId: editingModel.id }, `reset:${editingModel.id}`);
  };

  if (!status) return null;

  const pending = status.pendingTemplateUpdates || [];
  const missing = (status.selectedModels || []).filter((model) => !model.available);
  const isBusy = Boolean(busy);
  const applyDisabled = isBusy || Boolean(status.recoveryRequired) || Boolean(status.generationError) || !status.source?.valid || !endpoint.trim() || !selectedApiKey || pending.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 border-b border-border pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-text-main">Official catalog source</h4>
            <p className="mt-1 break-all font-mono text-xs text-text-muted">{status.paths?.sourcePath}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status.source?.valid ? <StatusPill tone="success">Valid</StatusPill> : <StatusPill tone="danger">Invalid</StatusPill>}
            {status.dirty ? <StatusPill tone="warning">Changes detected</StatusPill> : <StatusPill tone="success">Catalog current</StatusPill>}
            {status.managed ? <StatusPill tone="info">Managed</StatusPill> : null}
          </div>
        </div>

        {status.source?.valid ? (
          <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <div><span className="block text-text-muted">Template</span><span className="font-medium text-text-main">{status.source.template?.displayName}</span></div>
            <div><span className="block text-text-muted">Official models</span><span className="font-medium text-text-main">{status.source.officialModelCount}</span></div>
            <div><span className="block text-text-muted">Client version</span><span className="font-medium text-text-main">{status.source.clientVersion || "Unknown"}</span></div>
            <div><span className="block text-text-muted">Fetched</span><span className="font-medium text-text-main">{status.source.fetchedAt ? new Date(status.source.fetchedAt).toLocaleString() : "Unknown"}</span></div>
          </div>
        ) : (
          <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">{status.source?.error || "models_cache.json is unavailable"}</div>
        )}
      </section>

      {status.recoveryRequired ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          A previous apply could not be fully rolled back. Use Disable &amp; Restore before applying again. {status.recoveryRequired}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-3 border-b border-border pb-5 sm:grid-cols-[8rem_1fr] sm:items-center">
        <label className="text-xs font-semibold text-text-main sm:text-right">9router endpoint</label>
        <input
          className="w-full min-w-0 rounded border border-border bg-surface px-2.5 py-2 text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="http://localhost:20128/v1"
          disabled={isBusy}
        />
        <label className="text-xs font-semibold text-text-main sm:text-right">Dashboard API key</label>
        <select
          className="w-full min-w-0 rounded border border-border bg-surface px-2.5 py-2 text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50"
          value={selectedApiKey}
          onChange={(event) => setSelectedApiKey(event.target.value)}
          disabled={isBusy || activeApiKeys.length === 0}
        >
          <option value="">{activeApiKeys.length === 0 ? "No active Dashboard keys" : "Select a Dashboard key"}</option>
          {activeApiKeys.map((key) => <option key={key.id} value={key.key}>{key.name || `Key …${key.key.slice(-6)}`}</option>)}
        </select>
        <span />
        <p className="text-xs text-text-muted">Apply writes this key to <code>experimental_bearer_token</code>. It never changes <code>auth.json</code> or your default model.</p>
      </section>

      {pending.length > 0 ? (
        <section className="flex flex-col gap-3 rounded border border-yellow-500/30 bg-yellow-500/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-yellow-700 dark:text-yellow-300">Template update decisions required</p>
              <p className="text-xs text-text-muted">The first official model changed. Resolve every selected model before applying.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => resolveTemplates(pending, "keep")} loading={busy === "template:keep"} disabled={isBusy}>Keep all</Button>
              <Button variant="primary" size="sm" onClick={() => resolveTemplates(pending, "refresh")} loading={busy === "template:refresh"} disabled={isBusy}>Refresh all</Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {pending.map((modelId) => (
              <div key={modelId} className="flex flex-col gap-2 rounded bg-surface/70 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <code className="break-all text-xs text-text-main">{modelId}</code>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => resolveTemplates([modelId], "keep")} disabled={isBusy}>Keep current</Button>
                  <Button variant="outline" size="sm" onClick={() => resolveTemplates([modelId], "refresh")} disabled={isBusy}>Refresh template</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {status.generationError ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          Catalog cannot be generated until this is resolved: {status.generationError}
        </div>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-text-main">9router models</h4>
            <p className="text-xs text-text-muted">{status.selectedModelIds.length} selected. IDs are copied exactly from <code>/v1/models</code>.</p>
          </div>
          <div className="relative w-full sm:w-72">
            <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[17px] text-text-muted">search</span>
            <input className="w-full rounded border border-border bg-surface py-2 pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search model or provider" />
          </div>
        </div>

        {missing.length > 0 ? (
          <div className="rounded border border-yellow-500/30 bg-yellow-500/5 p-3">
            <p className="mb-2 text-xs font-semibold text-yellow-700 dark:text-yellow-300">Unavailable but retained</p>
            {missing.map((model) => (
              <div key={model.id} className="flex items-center justify-between gap-3 py-1.5">
                <code className="min-w-0 break-all text-xs text-text-main">{model.id}</code>
                <div className="flex shrink-0 gap-1">
                  {model.conflict ? <StatusPill tone="danger">Official conflict</StatusPill> : null}
                  <Button variant="ghost" size="sm" onClick={() => setEditingModel(model)} disabled={isBusy}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => toggleModel(model.id, false)} disabled={isBusy}>Remove</Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="max-h-[32rem] overflow-y-auto rounded border border-border">
          {groupedModels.length === 0 ? (
            <p className="p-4 text-center text-sm text-text-muted">No matching models.</p>
          ) : groupedModels.map(([provider, models]) => (
            <details key={provider} open className="border-b border-border last:border-b-0">
              <summary className="sticky top-0 z-10 flex cursor-pointer items-center justify-between bg-surface-2 px-3 py-2 text-xs font-semibold text-text-main">
                <span>{provider}</span>
                <span className="text-text-muted">{models.length}</span>
              </summary>
              <div>
                {models.map((model) => {
                  const selected = selectedById.get(model.id);
                  return (
                    <div
                      key={model.id}
                      className="flex min-h-12 items-center gap-3 border-t border-border/60 px-3 py-2 first:border-t-0 hover:bg-surface-2/40"
                      style={{ contentVisibility: "auto", containIntrinsicSize: "0 48px" }}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(selected)}
                        disabled={(model.conflict && !selected) || Boolean(busy)}
                        onChange={(event) => toggleModel(model.id, event.target.checked)}
                        aria-label={`Select ${model.id}`}
                      />
                      <div className="min-w-0 flex-1">
                        <code className="block break-all text-xs text-text-main">{model.id}</code>
                        {selected && selected.entry?.display_name !== model.id ? <span className="text-[11px] text-text-muted">{selected.entry.display_name}</span> : null}
                      </div>
                      {model.conflict ? <StatusPill tone="danger">Official conflict</StatusPill> : null}
                      {selected ? (
                        <button className="shrink-0 rounded p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50" onClick={() => setEditingModel(selected)} title="Edit metadata" aria-label={`Edit ${model.id}`} disabled={isBusy}>
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      </section>

      {message ? (
        <div className={`flex items-center gap-2 rounded px-3 py-2 text-sm ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
          <span className="material-symbols-outlined text-[18px]">{message.type === "success" ? "check_circle" : "error"}</span>
          <span>{message.text}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button variant="outline" size="sm" onClick={showPreview} loading={busy === "preview"} disabled={isBusy || !status.source?.valid || pending.length > 0}>Preview</Button>
        <Button variant="primary" size="sm" onClick={apply} loading={busy === "apply"} disabled={applyDisabled}>Generate & Apply</Button>
        {status.managed ? <Button variant="ghost" size="sm" onClick={disable} loading={busy === "disable"} disabled={isBusy}>Disable & Restore</Button> : null}
        <span className="ml-auto break-all text-right font-mono text-[10px] text-text-muted">{status.paths?.catalogPath}</span>
      </div>

      <CodexMetadataEditorModal
        model={editingModel}
        isOpen={Boolean(editingModel)}
        onClose={() => setEditingModel(null)}
        onSave={saveMetadata}
        onReset={resetMetadata}
      />

      <Modal isOpen={Boolean(preview)} onClose={() => setPreview(null)} title="Catalog preview" size="full">
        {preview ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone="info">{preview.modelCount} total models</StatusPill>
              <StatusPill tone="success">{preview.diff.added.length} added</StatusPill>
              <StatusPill tone="warning">{preview.diff.changed.length} changed</StatusPill>
              <StatusPill tone="danger">{preview.diff.removed.length} removed</StatusPill>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <DiffList label="Added" values={preview.diff.added} tone="success" />
              <DiffList label="Changed" values={preview.diff.changed} tone="warning" />
              <DiffList label="Removed" values={preview.diff.removed} tone="danger" />
            </div>
            <MetadataChanges details={preview.diff.changedDetails} />
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-text-main">Generated JSON</summary>
              <pre className="mt-2 max-h-[48vh] overflow-auto rounded border border-border bg-black/5 p-3 font-mono text-xs text-text-main dark:bg-white/5">{JSON.stringify(preview.catalog, null, 2)}</pre>
            </details>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
