"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Modal, SegmentedControl } from "@/shared/components";

const EDITOR_TABS = [
  { value: "form", label: "Common fields", icon: "tune" },
  { value: "json", label: "Advanced JSON", icon: "data_object" },
];

function parsePositiveNumber(value, field, max = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (max != null && parsed > max)) {
    throw new Error(`${field} must be a positive number${max != null ? ` no greater than ${max}` : ""}`);
  }
  return parsed;
}

function Field({ label, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold text-text-main">{label}</span>
      {children}
    </label>
  );
}

export default function CodexMetadataEditorModal({ model, isOpen, onClose, onSave, onReset }) {
  const [tab, setTab] = useState("form");
  const [draft, setDraft] = useState(null);
  const [jsonText, setJsonText] = useState("");
  const [reasoningText, setReasoningText] = useState("[]");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen || !model?.entry) return;
    const next = structuredClone(model.entry);
    setDraft(next);
    setJsonText(JSON.stringify(next, null, 2));
    setReasoningText(JSON.stringify(next.supported_reasoning_levels || [], null, 2));
    setTab("form");
    setError("");
  }, [isOpen, model]);

  const reasoningEfforts = useMemo(
    () => (draft?.supported_reasoning_levels || []).map((level) => level?.effort).filter(Boolean),
    [draft?.supported_reasoning_levels]
  );

  if (!model || !draft) return null;

  const setField = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError("");
  };

  const switchTab = (nextTab) => {
    try {
      if (tab === "json" && nextTab === "form") {
        const parsed = JSON.parse(jsonText);
        if (parsed.slug !== model.id) throw new Error("slug must match the original /v1/models id");
        setDraft(parsed);
        setReasoningText(JSON.stringify(parsed.supported_reasoning_levels || [], null, 2));
      } else if (nextTab === "json") {
        setJsonText(JSON.stringify(draft, null, 2));
      }
      setTab(nextTab);
      setError("");
    } catch (switchError) {
      setError(switchError.message);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      let entry;
      if (tab === "json") {
        entry = JSON.parse(jsonText);
      } else {
        const levels = JSON.parse(reasoningText);
        if (!Array.isArray(levels)) throw new Error("Supported reasoning levels must be a JSON array");
        entry = { ...draft, supported_reasoning_levels: levels };
      }
      if (entry.slug !== model.id) throw new Error("slug must match the original /v1/models id");
      await onSave(entry);
      onClose();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError("");
    try {
      await onReset();
      onClose();
    } catch (resetError) {
      setError(resetError.message);
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full min-w-0 rounded border border-border bg-bg px-2.5 py-2 text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Edit ${model.id}`}
      size="full"
      footer={
        <>
          <Button variant="ghost" onClick={reset} disabled={saving}>Reset to template</Button>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>Save metadata</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl options={EDITOR_TABS} value={tab} onChange={switchTab} size="sm" />
          <code className="max-w-full truncate rounded bg-surface-2 px-2 py-1 text-xs text-text-muted" title={model.id}>
            slug: {model.id}
          </code>
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span>{error}</span>
          </div>
        ) : null}

        {tab === "form" ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Display name">
              <input className={inputClass} value={draft.display_name || ""} onChange={(event) => setField("display_name", event.target.value)} />
            </Field>
            <Field label="Visibility">
              <input className={inputClass} value={draft.visibility || ""} onChange={(event) => setField("visibility", event.target.value)} />
            </Field>
            <Field label="Context window">
              <input className={inputClass} type="number" min="1" value={draft.context_window ?? ""} onChange={(event) => {
                try { setField("context_window", parsePositiveNumber(event.target.value, "context_window")); } catch { setField("context_window", event.target.value); }
              }} />
            </Field>
            <Field label="Max context window">
              <input className={inputClass} type="number" min="1" value={draft.max_context_window ?? ""} onChange={(event) => {
                try { setField("max_context_window", parsePositiveNumber(event.target.value, "max_context_window")); } catch { setField("max_context_window", event.target.value); }
              }} />
            </Field>
            <Field label="Effective context percent">
              <input className={inputClass} type="number" min="1" max="100" value={draft.effective_context_window_percent ?? ""} onChange={(event) => {
                try { setField("effective_context_window_percent", parsePositiveNumber(event.target.value, "effective_context_window_percent", 100)); } catch { setField("effective_context_window_percent", event.target.value); }
              }} />
            </Field>
            <Field label="Priority">
              <input className={inputClass} type="number" value={draft.priority ?? ""} onChange={(event) => setField("priority", Number(event.target.value))} />
            </Field>
            <Field label="Input modalities (comma separated)">
              <input className={inputClass} value={(draft.input_modalities || []).join(", ")} onChange={(event) => setField("input_modalities", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} />
            </Field>
            <Field label="Default reasoning level">
              <select className={inputClass} value={draft.default_reasoning_level || ""} onChange={(event) => setField("default_reasoning_level", event.target.value || null)}>
                <option value="">None</option>
                {reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </Field>
            <Field label="Description">
              <textarea className={`${inputClass} min-h-24 resize-y`} value={draft.description || ""} onChange={(event) => setField("description", event.target.value)} />
            </Field>
            <Field label="Supported reasoning levels (JSON)">
              <textarea className={`${inputClass} min-h-24 resize-y font-mono text-xs`} value={reasoningText} onChange={(event) => {
                setReasoningText(event.target.value);
                try {
                  const levels = JSON.parse(event.target.value);
                  if (Array.isArray(levels)) setField("supported_reasoning_levels", levels);
                } catch {}
              }} />
            </Field>
            <div className="flex flex-wrap items-center gap-5 md:col-span-2">
              <label className="inline-flex items-center gap-2 text-sm text-text-main">
                <input type="checkbox" checked={draft.supports_search_tool === true} onChange={(event) => setField("supports_search_tool", event.target.checked)} />
                Supports search tool
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-text-main">
                <input type="checkbox" checked={draft.supports_parallel_tool_calls === true} onChange={(event) => setField("supports_parallel_tool_calls", event.target.checked)} />
                Supports parallel tool calls
              </label>
            </div>
          </div>
        ) : (
          <textarea
            className="min-h-[52vh] w-full resize-y rounded border border-border bg-black/5 p-3 font-mono text-xs leading-5 text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50 dark:bg-white/5"
            value={jsonText}
            onChange={(event) => {
              const nextText = event.target.value;
              setJsonText(nextText);
              try {
                const parsed = JSON.parse(nextText);
                setError(parsed.slug === model.id ? "" : "slug must match the original /v1/models id");
              } catch (parseError) {
                setError(`Invalid JSON: ${parseError.message}`);
              }
            }}
            spellCheck={false}
          />
        )}
      </div>
    </Modal>
  );
}
