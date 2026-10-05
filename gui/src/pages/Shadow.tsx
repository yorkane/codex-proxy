/**
 * Shadow Call Intercept — standalone page (fork-owned).
 *
 * Fork refactor 2026-09: this UI moved out of Models.tsx so upstream merges touch
 * one file less. It is self-contained: it fetches the model catalog, selection,
 * and shadow settings by itself. All copy is intentionally hardcoded English —
 * the page is not part of the i18n catalog (see AGENTS.md).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { createBoundedFetch } from "../bounded-fetch";
import { modelVisible, fetchSelectedModels, type ProviderModelMap } from "../model-visibility";
import { Switch, Select, Tooltip, ToastNotice } from "../ui";
import {
  shadowCallModelOptions,
  type ModelInfo,
  type ShadowCallData,
  type ShadowDiagnosticsData,
} from "./dashboard-shared";
import {
  DEFAULT_SOURCE_MODELS,
  shadowSourceModelLabel,
} from "./shadow-call-source";
import { type ModelRow } from "./models-shared";

export default function Shadow({ apiBase }: { apiBase: string }) {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [selectedModels, setSelectedModels] = useState<ProviderModelMap>({});
  const [modelsLoading, setModelsLoading] = useState(true);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [customSourceDraft, setCustomSourceDraft] = useState("");
  const [customTargetDraft, setCustomTargetDraft] = useState("");
  const [phantomNameDraft, setPhantomNameDraft] = useState("");
  const [showPhantomList, setShowPhantomList] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ShadowDiagnosticsData | null>(null);
  const [diagnosticsKind, setDiagnosticsKind] = useState("");
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  const loadDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    const bounded = createBoundedFetch(15_000);
    try {
      const query = diagnosticsKind ? `?kind=${encodeURIComponent(diagnosticsKind)}&limit=50` : "?limit=50";
      const r = await fetch(`${apiBase}/api/shadow-diagnostics${query}`, { signal: bounded.signal });
      const data = await readJsonIfOk<ShadowDiagnosticsData>(r);
      if (data) setDiagnostics(data);
    } catch { /* older server without the route: keep the section empty rather than erroring */ }
    finally {
      setDiagnosticsLoading(false);
      bounded.clear();
    }
  }, [apiBase, diagnosticsKind]);

  useEffect(() => { void loadDiagnostics(); }, [loadDiagnostics]);

  // Action feedback as a fixed toast (same convention as the Models page).
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), feedback.ok ? 6000 : 8000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const loadModels = useCallback(async () => {
    const bounded = createBoundedFetch(15_000);
    try {
      const [modelsRes, selectionData] = await Promise.all([
        fetch(`${apiBase}/api/models`, { signal: bounded.signal }),
        fetchSelectedModels(apiBase, fetch, bounded.signal),
      ]);
      const data = await readJsonOrThrow<ModelRow[]>(modelsRes);
      if (data) setModels(data);
      setSelectedModels(selectionData);
    } catch { /* keep the last good catalog; the page still renders */ }
    finally {
      setModelsLoading(false);
      bounded.clear();
    }
  }, [apiBase]);

  const loadShadowCall = useCallback(async () => {
    const bounded = createBoundedFetch(15_000);
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`, { signal: bounded.signal });
      const data = await readJsonIfOk<ShadowCallData>(r);
      if (data) setShadowCall(data);
    } catch { /* old server / network: keep the section disabled */ }
    finally { bounded.clear(); }
  }, [apiBase]);

  useEffect(() => {
    void loadModels();
    void loadShadowCall();
  }, [loadModels, loadShadowCall]);

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || saving) return;
    setSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        // Surface the server's reason (e.g. "modelMap[gpt-5.4] must resolve to a
        // configured provider") instead of silently reverting.
        let msg = "Save failed";
        try { const d = await r.json(); if (d && typeof d.error === "string" && d.error) msg = d.error; } catch { /* non-JSON error body */ }
        setFeedback({ ok: false, message: msg });
        void loadShadowCall();
      }
    } finally {
      setSaving(false);
    }
  };

  // Active (not-disabled, selected) models, as the canonical routing id.
  const activeModels = useMemo<ModelInfo[]>(
    () => models
      .filter(m => modelVisible(selectedModels, m.provider, m.id, m.native === true, m.disabled))
      .map(m => ({ id: m.id, provider: m.provider, namespaced: m.namespaced })),
    [models, selectedModels],
  );

  const customTargetOptions = useMemo(() => {
    const activeNamespaced = new Set(activeModels.map(m => m.namespaced));
    return shadowCallModelOptions(
      activeModels.filter(m => activeNamespaced.has(m.namespaced)),
      shadowCall?.model,
      shadowCall?.sourceModels,
    );
  }, [activeModels, shadowCall?.model, shadowCall?.sourceModels]);

  const customSources = (shadowCall?.sourceModels ?? []).filter(s => !DEFAULT_SOURCE_MODELS.includes(s));

  const addCustomSource = () => {
    const src = customSourceDraft.trim();
    if (!src || !shadowCall) return;
    if (DEFAULT_SOURCE_MODELS.includes(src)) return;
    const nextMap = { ...(shadowCall.modelMap ?? {}) };
    if (customTargetDraft) nextMap[src] = customTargetDraft;
    else delete nextMap[src];
    // A source without a target uses the shared fallback model, so it still has
    // to land in sourceModels even when modelMap stays unchanged.
    const knownCustoms = (shadowCall.sourceModels ?? DEFAULT_SOURCE_MODELS).filter(s => !DEFAULT_SOURCE_MODELS.includes(s));
    const customs = Array.from(new Set([...knownCustoms, ...Object.keys(nextMap).filter(k => !DEFAULT_SOURCE_MODELS.includes(k)), ...(!customTargetDraft ? [src] : [])]));
    const nextSources = [...DEFAULT_SOURCE_MODELS, ...customs];
    setShadowCall({ ...shadowCall, modelMap: nextMap, sourceModels: nextSources });
    setCustomSourceDraft("");
    setCustomTargetDraft("");
    void saveShadowCall({ modelMap: nextMap, sourceModels: nextSources });
  };

  const removeCustomSource = (src: string) => {
    if (!shadowCall) return;
    const nextMap = { ...(shadowCall.modelMap ?? {}) };
    delete nextMap[src];
    const nextSources = (shadowCall.sourceModels ?? []).filter(x => x !== src);
    setShadowCall({ ...shadowCall, modelMap: nextMap, sourceModels: nextSources });
    void saveShadowCall({ modelMap: nextMap, sourceModels: nextSources });
  };

  const phantomEnabled = shadowCall?.phantomToolAllowlistEnabled !== false;
  // The empty-completion guard is a TOP-LEVEL config field, independent of whether shadow
  // interception is on, so its section renders whether or not the intercept is enabled.
  const emptyCompletionRetryOn = shadowCall?.emptyCompletionRetry === true;
  // The budget comes from the server's resolved value, so it may already reflect the environment
  // override rather than config.json. Clamped to the bounds the server reported; an older server
  // that reports neither bound still gets the historical 1..3 window.
  const replayMaxMin = shadowCall?.emptyCompletionRetryMaxMin ?? 0;
  const replayMaxLimit = shadowCall?.emptyCompletionRetryMaxLimit ?? 3;
  const replayMax = Math.min(
    replayMaxLimit,
    Math.max(replayMaxMin, Math.trunc(shadowCall?.emptyCompletionRetryMax ?? 1)),
  );
  // Draft while the field has focus. A controlled number input that refuses to accept the empty
  // string can never be cleared - React immediately re-renders the last value, so backspace does
  // nothing and the box is impossible to edit. The draft is committed on blur/Enter and reverted
  // when invalid, which keeps the guard without making the field read-only.
  const [replayMaxDraft, setReplayMaxDraft] = useState<string | null>(null);
  const replayMaxField = replayMaxDraft ?? String(replayMax);
  const writeReplayMax = (raw: string): void => {
    if (raw.trim() === "") return;
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < replayMaxMin || value > replayMaxLimit) return;
    if (value === replayMax) return;
    // Functional update: this section renders before the settings have loaded, so shadowCall may
    // still be null here (unlike the phantom block, which is guarded).
    setShadowCall(prev => (prev ? { ...prev, emptyCompletionRetryMax: value } : prev));
    void saveShadowCall({ emptyCompletionRetryMax: value });
  };
  // On blur an unfinished draft is discarded, which is the only honest reading of a cleared or
  // out-of-range field: snap back to what the server actually holds instead of leaving a number on
  // screen that was never saved.
  const settleReplayMax = (): void => {
    if (replayMaxDraft === null) return;
    const raw = replayMaxDraft.trim();
    setReplayMaxDraft(null);
    if (raw !== "") {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < replayMaxMin || value > replayMaxLimit) {
        setFeedback({
          ok: false,
          message: `Replays must be a whole number between ${replayMaxMin} and ${replayMaxLimit}; kept ${replayMax}.`,
        });
      }
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Shadow Call Intercept</h2>
      </div>
      <div className="shadow-page" aria-busy={modelsLoading || !shadowCall || undefined}>
        <div className="shadow-page-section">
          <div className="models-shadow-row row muted text-control">
            <span className="models-shadow-label">
              Shadow Call Intercept{" "}
              <Tooltip
                content={`Intercepts Codex App's background helper calls (${shadowSourceModelLabel(shadowCall?.sourceModels)}) for titles and commit messages and redirects them to your chosen model. Each source model maps independently below; a source with no mapping uses the global fallback (none — the call passes through).`}
                side="top"
                maxWidth={320}
              >
                <span style={{ cursor: "help" }} aria-label="Shadow Call Intercept help">ⓘ</span>
              </Tooltip>
            </span>
            <Switch
              on={shadowCall?.enabled ?? false}
              onClick={() => void saveShadowCall({ enabled: !shadowCall?.enabled })}
              disabled={!shadowCall || saving}
              label="Enable"
            />
          </div>
        </div>

        {shadowCall?.enabled && (
          <>
            <div className="shadow-page-section">
              <h3 className="shadow-page-heading">Source model mapping</h3>
              <p className="muted text-control">
                Intercepted Codex helper models on the left; the replacement target on the right. "—" leaves the call unrouted (passes through).
              </p>
              {DEFAULT_SOURCE_MODELS.map(sourceModel => {
                const current = shadowCall.modelMap?.[sourceModel] ?? "";
                const perSourceOptions = shadowCallModelOptions(activeModels, current || undefined, [sourceModel]);
                return (
                  <div key={sourceModel} className="models-shadow-row row muted text-control">
                    <code className="models-shadow-source-label models-shadow-source-name">{sourceModel} →</code>
                    <div className="models-shadow-model-slot">
                      <Select
                        value={current}
                        options={perSourceOptions}
                        onChange={v => {
                          const next = { ...(shadowCall?.modelMap ?? {}) };
                          if (v === "") delete next[sourceModel];
                          else next[sourceModel] = v;
                          setShadowCall(c => c ? { ...c, modelMap: next } : c);
                          void saveShadowCall({ modelMap: next });
                        }}
                        disabled={!shadowCall || saving}
                        label={sourceModel}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="shadow-page-section">
              <h3 className="shadow-page-heading">Custom source models</h3>
              <p className="muted text-control">
                Add a source model id your Codex build calls (e.g. a future gpt-5.6 variant). A custom source with no target passes through.
              </p>
              <div className="models-shadow-row models-shadow-row-full row muted text-control">
                <code className="models-shadow-source-label models-shadow-fallback-label">Custom source model</code>
                <input
                  type="text"
                  className="input text-control"
                  style={{ minWidth: "14rem" }}
                  placeholder="source model id"
                  value={customSourceDraft}
                  onChange={e => setCustomSourceDraft(e.target.value)}
                  disabled={saving}
                />
                <span className="models-shadow-source-name">→</span>
                <div className="models-shadow-model-slot">
                  <Select
                    value={customTargetDraft}
                    options={customTargetOptions}
                    onChange={v => setCustomTargetDraft(v)}
                    disabled={saving}
                    label="Custom source model target"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!customSourceDraft.trim() || saving}
                  onClick={addCustomSource}
                >
                  Add
                </button>
              </div>
              {customSources.map(src => {
                const mapped = shadowCall.modelMap?.[src] ?? "";
                const customOptions = shadowCallModelOptions(activeModels, mapped || undefined, [src]);
                return (
                  <div key={src} className="models-shadow-row models-shadow-row-full row muted text-control">
                    <code className="models-shadow-source-label models-shadow-source-name">{src} →</code>
                    <div className="models-shadow-model-slot">
                      <Select
                        value={mapped}
                        options={customOptions}
                        onChange={v => {
                          if (!shadowCall) return;
                          const nextMap = { ...(shadowCall.modelMap ?? {}) };
                          if (v === "") delete nextMap[src];
                          else nextMap[src] = v;
                          setShadowCall({ ...shadowCall, modelMap: nextMap });
                          void saveShadowCall({ modelMap: nextMap, sourceModels: shadowCall.sourceModels });
                        }}
                        disabled={!shadowCall || saving}
                        label={src}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={saving}
                      onClick={() => removeCustomSource(src)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="models-phantom-section shadow-page-section">
              <h3 className="shadow-page-heading">Phantom tools</h3>
              <div className="models-shadow-row row muted text-control">
                <span className="models-shadow-label">
                  Phantom tools{" "}
                  <Tooltip
                    content="When the replacement model calls a tool the request never declared, the model first gets a directive error teaching it the declared tools (up to the per-request correction limit). After the limit, listed names drop silently and unknown names fail the turn. Applies only to shadow-replaced requests."
                    side="top"
                    maxWidth={320}
                  >
                    <span style={{ cursor: "help" }} aria-label="Phantom tool tolerance">ⓘ</span>
                  </Tooltip>
                </span>
                <Switch
                  on={phantomEnabled}
                  onClick={() => void saveShadowCall({ phantomToolAllowlistEnabled: !phantomEnabled })}
                  disabled={!shadowCall || saving}
                  label="Enable"
                />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPhantomList(v => !v)}>
                  {showPhantomList ? "Hide list" : "Edit list"}
                </button>
              </div>
              {showPhantomList && phantomEnabled && shadowCall && (
                <div className="models-shadow-row row muted text-control" style={{ flexWrap: "wrap", gap: "0.4rem" }}>
                  {(shadowCall.phantomToolAllowlist ?? []).map(name => (
                    <span key={name} className="row" style={{ gap: "0.25rem" }}>
                      <code className="models-shadow-source-name">{name}</code>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={saving}
                        aria-label={`remove ${name}`}
                        onClick={() => {
                          const next = (shadowCall.phantomToolAllowlist ?? []).filter(x => x !== name);
                          setShadowCall({ ...shadowCall, phantomToolAllowlist: next });
                          void saveShadowCall({ phantomToolAllowlist: next });
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    className="input text-control"
                    style={{ minWidth: "10rem" }}
                    placeholder="tool name"
                    value={phantomNameDraft}
                    onChange={e => setPhantomNameDraft(e.target.value)}
                    disabled={saving}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!phantomNameDraft.trim() || saving}
                    onClick={() => {
                      const name = phantomNameDraft.trim();
                      if (!name) return;
                      const next = [...new Set([...(shadowCall.phantomToolAllowlist ?? []), name])];
                      setShadowCall({ ...shadowCall, phantomToolAllowlist: next });
                      setPhantomNameDraft("");
                      void saveShadowCall({ phantomToolAllowlist: next });
                    }}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={saving}
                    onClick={() => {
                      const next = shadowCall.phantomToolDefaults ?? [];
                      setShadowCall({ ...shadowCall, phantomToolAllowlist: next });
                      void saveShadowCall({ phantomToolAllowlist: next });
                    }}
                  >
                    Reset to defaults
                  </button>
                  <label className="row" style={{ gap: "0.35rem", marginLeft: "auto" }}>
                    Corrections/request
                    <input
                      type="number"
                      className="input text-control"
                      style={{ width: "4.5rem" }}
                      min={0}
                      max={10}
                      step={1}
                      value={shadowCall.phantomToolFeedbackMax ?? 2}
                      disabled={saving}
                      onChange={e => {
                        const value = Number(e.target.value);
                        if (!Number.isInteger(value) || value < 0 || value > 10) return;
                        setShadowCall({ ...shadowCall, phantomToolFeedbackMax: value });
                        void saveShadowCall({ phantomToolFeedbackMax: value });
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          </>
        )}
        <div className="models-phantom-section shadow-page-section">
          <h3 className="shadow-page-heading">Empty completion replay</h3>
          <div className="models-shadow-row row muted text-control">
            <span className="models-shadow-label">
              Replay an empty completion{" "}
              <Tooltip
                content="When the upstream answers 200 and the turn ends with reasoning but no output text and no tool call, the proxy suppresses that silent stop and replays the identical request. Every replay re-issues the whole turn and may be billable, so the budget beside the switch is capped. A turn still empty after the budget is spent surfaces as a stated failure. Applies to every routed Responses turn, not only shadow-intercepted ones."
                side="top"
                maxWidth={320}
              >
                <span style={{ cursor: "help" }} aria-label="Empty completion replay help">ⓘ</span>
              </Tooltip>
            </span>
            <label className="row" style={{ gap: "0.35rem", marginLeft: "auto" }}>
              Replays
              <input
                type="number"
                className="input text-control"
                style={{ width: "4.5rem" }}
                min={replayMaxMin}
                max={replayMaxLimit}
                step={1}
                value={replayMaxField}
                disabled={saving}
                aria-label="Empty completion replays"
                onFocus={() => setReplayMaxDraft(String(replayMax))}
                onChange={e => { setReplayMaxDraft(e.target.value); writeReplayMax(e.target.value); }}
                onBlur={settleReplayMax}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); if (replayMaxDraft !== null) writeReplayMax(replayMaxDraft); setReplayMaxDraft(null); }
                  if (e.key === "Escape") setReplayMaxDraft(null);
                }}
              />
            </label>
            <Switch
              on={emptyCompletionRetryOn}
              onClick={() => void saveShadowCall({ emptyCompletionRetry: !emptyCompletionRetryOn })}
              disabled={!shadowCall || saving}
              label="Enable"
            />
          </div>
          <p className="muted text-control">
            A model that answers with only reasoning and no text or tool call used to look like a random stop;
            the user had to type "please continue". With this on the proxy replays that turn
            {replayMax === 1 ? " once" : ` up to ${replayMax} times`} instead.
          </p>
          {replayMax === 0 && (
            <p className="muted text-control">
              Replays set to 0: the switch stays on but nothing is replayed, so an empty turn passes
              through as a silent success — the same result as turning the switch off. Set at least 1 to
              recover those turns.
            </p>
          )}
          {replayMax > 1 && (
            <p className="muted text-control">
              Each replay re-issues the whole turn, so up to {replayMax} generations may be billed before
              the turn is reported as failed.
            </p>
          )}
          {shadowCall?.emptyCompletionRetryEnvOverride && (
            <p className="muted text-control">
              Forced off: OCX_EMPTY_COMPLETION_RETRY=0 is set in the service environment, so this switch has no
              effect until the variable is removed.
            </p>
          )}
          {shadowCall?.emptyCompletionRetryMaxEnvOverride && (
            <p className="muted text-control">
              Controlled by the service environment: OCX_EMPTY_COMPLETION_RETRY_MAX is set, so it overrides
              this number until the variable is removed.
            </p>
          )}
        </div>
      </div>
      {feedback && (
        <ToastNotice
          tone={feedback.ok ? "ok" : "err"}
          onDismiss={() => setFeedback(null)}
          dismissLabel="Close"
        >
          {feedback.message}
        </ToastNotice>
      )}
      <div className="models-phantom-section shadow-page-section">
        <h3 className="shadow-page-heading">Diagnostics</h3>
        <div className="models-shadow-row row muted text-control">
          <span className="models-shadow-label">
            Diagnostics{" "}
            <Tooltip
              content="Recent tool-call dispositions and empty-completion replays from the in-memory request log. This is where a turn that stopped for no visible reason becomes attributable: a removed call, a directive correction, a replay, or a fail-closed undeclared call."
              side="top"
              maxWidth={320}
            >
              <span style={{ cursor: "help" }} aria-label="Diagnostics feed">ⓘ</span>
            </Tooltip>
          </span>
          <select
            className="text-control"
            value={diagnosticsKind}
            onChange={e => setDiagnosticsKind(e.target.value)}
            aria-label="Filter diagnostics by kind"
          >
            <option value="">All kinds</option>
            {(diagnostics?.kinds ?? []).map(kind => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void loadDiagnostics()}
            disabled={diagnosticsLoading}
          >
            {diagnosticsLoading ? "Refreshing…" : "Refresh"}
          </button>
          {diagnostics && <span className="muted">{diagnostics.total} event(s)</span>}
        </div>
        {diagnostics && diagnostics.events.length === 0 && !diagnosticsLoading && (
          <p className="muted text-control">No events in the current request-log window.</p>
        )}
        {diagnostics && diagnostics.events.length > 0 && (
          <div className="models-shadow-row models-shadow-row-full muted text-control" style={{ flexDirection: "column", gap: "0.3rem" }}>
            {diagnostics.events.map((event, index) => (
              <div
                key={`${event.requestId}-${event.kind}-${event.names.join(",")}-${index}`}
                className="row"
                style={{ gap: "0.5rem", flexWrap: "wrap" }}
              >
                <code className="models-shadow-source-name">{event.kind}</code>
                <span>{new Date(event.ts).toLocaleTimeString()}</span>
                <span className="muted">{event.model}</span>
                {event.names.map(name => (
                  <code key={name} className="models-shadow-source-name">{name}</code>
                ))}
                {event.count > 1 && <span className="muted">×{event.count}</span>}
                <span>{event.detail}</span>
                <code
                  className="models-shadow-source-label"
                  title="Click to copy the request id"
                  style={{ cursor: "pointer" }}
                  onClick={() => void navigator.clipboard?.writeText(event.requestId)}
                >
                  {event.requestId}
                </code>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
