/**
 * Wdev services — management page for the components the wdev manager supervises.
 *
 * The page is a thin, honest client of the three management routes. A 202 from the
 * submit route proves only that the manager fsynced its ledger, never that the work
 * ran, so the state an operator reads is always the polled detail record; the list
 * row is the seed for that poll. The manager has no cancel verb, so the page offers
 * none — a busy component reports the manager's own error text and the operator acts
 * on that.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createBoundedFetch } from "../bounded-fetch";
import { IconRefresh } from "../icons";
import { useT, type TFn } from "../i18n/shared";
import { Notice } from "../ui";
import { newClientId } from "./claude-code-types";
import {
  WDEV_MAX_WAIT_CEILING,
  WDEV_POLL_DEADLINE_MS,
  WDEV_POLL_MS,
  actionLabelKey,
  buildOperationBody,
  draftValidationKey,
  isTerminalState,
  rawProgressLabel,
  stateBadgeClass,
  stateLabelKey,
  statusBadgeClass,
  statusDotClass,
  statusLabelKey,
  type WdevAction,
  type WdevComponent,
  type WdevDraft,
  type WdevInventory,
  type WdevManifest,
  type WdevOperationDetail,
  type WdevOperationRow,
} from "./wdev-shared";

export default function Wdev({ apiBase }: { apiBase: string }): ReactElement {
  const t = useT();
  const [inventory, setInventory] = useState<WdevInventory | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [rows, setRows] = useState<WdevOperationRow[]>([]);
  const [details, setDetails] = useState<Record<string, WdevOperationDetail>>({});
  const [now, setNow] = useState<number>(() => Date.now());
  const [draft, setDraft] = useState<WdevDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  const detailsRef = useRef(details);
  useEffect(() => { detailsRef.current = details; }, [details]);
  /** Operations whose terminal transition already refreshed the inventory: fires once each. */
  const refreshedRef = useRef<Set<string>>(new Set());

  const loadInventory = useCallback(async (): Promise<void> => {
    const bounded = createBoundedFetch(15_000);
    try {
      const res = await fetch(`${apiBase}/api/wdev/components`, { signal: bounded.signal });
      if (res.status === 404) {
        setDisabled(true);
        setInventory(null);
        return;
      }
      const data = await res.json().catch(() => null) as WdevInventory | null;
      if (!data || data.enabled !== true) { setDisabled(true); setInventory(null); return; }
      setDisabled(false);
      setInventory(data);
    } catch {
      /* unreachable manager: keep the last inventory on screen */
    } finally {
      bounded.clear();
    }
  }, [apiBase]);

  const loadOperations = useCallback(async (): Promise<void> => {
    const bounded = createBoundedFetch(15_000);
    try {
      const res = await fetch(`${apiBase}/api/wdev/operations`, { signal: bounded.signal });
      if (!res.ok) return;
      const data = await res.json().catch(() => null) as { operations?: WdevOperationRow[] } | null;
      if (data && Array.isArray(data.operations)) setRows(data.operations);
    } catch { /* transient: keep the rows already on screen */ }
    finally { bounded.clear(); }
  }, [apiBase]);

  useEffect(() => {
    // Deferred by a microtask: the loads set state, and an effect body that does that is the
    // cascading-render pattern the lint gate rejects. A microtask keeps them off the body while
    // still firing on mount, before any timer the page arms can need the rows.
    void Promise.resolve().then(() => {
      void loadInventory();
      void loadOperations();
    });
  }, [loadInventory, loadOperations]);

  /**
   * One 2s tick drives every live row. Rows are read through refs so the interval is
   * created once per apiBase: a key derived from the row list would re-create the timer
   * on every poll, resetting the 2s clock the rows are supposed to share.
   */
  useEffect(() => {
    const tick = async (): Promise<void> => {
      const stamp = Date.now();
      const live = rowsRef.current.filter(row => {
        const state = detailsRef.current[row.operationId]?.state ?? row.state;
        return !isTerminalState(state) && stamp - row.submittedAt <= WDEV_POLL_DEADLINE_MS;
      });
      for (const row of live) {
        const bounded = createBoundedFetch(10_000);
        try {
          const res = await fetch(`${apiBase}/api/wdev/operations/${encodeURIComponent(row.operationId)}`, { signal: bounded.signal });
          if (!res.ok) continue;
          const detail = await res.json().catch(() => null) as WdevOperationDetail | null;
          if (!detail) continue;
          setDetails(current => ({ ...current, [detail.operationId]: detail }));
          if (isTerminalState(detail.state) && !refreshedRef.current.has(detail.operationId)) {
            refreshedRef.current.add(detail.operationId);
            void loadInventory();
            void loadOperations();
          }
        } catch { /* a failed poll leaves the row at its last known state */ }
        finally { bounded.clear(); }
      }
      setNow(stamp);
    };
    const timer = setInterval(() => { void tick(); }, WDEV_POLL_MS);
    return () => clearInterval(timer);
  }, [apiBase, loadInventory, loadOperations]);

  const openDraft = useCallback((component: WdevComponent, action: WdevAction): void => {
    setDraftError("");
    setDraft({
      componentId: component.id,
      action,
      idempotencyKey: newClientId(),
      manifestPath: action === "upgrade" ? (inventory?.manifests[0]?.path ?? "") : "",
      configPatchText: action === "configure" ? "{}" : "",
      expectedRevision: action === "restart" ? "" : (component.revision ?? ""),
      maxWaitText: "",
    });
  }, [inventory]);

  const submitDraft = useCallback(async (): Promise<void> => {
    if (!draft || submitting) return;
    const invalid = draftValidationKey(draft);
    if (invalid) {
      setDraftError(t(invalid));
      return;
    }
    setSubmitting(true);
    setDraftError("");
    const body = buildOperationBody(draft);
    const bounded = createBoundedFetch(30_000);
    try {
      const res = await fetch(`${apiBase}/api/wdev/operations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: bounded.signal,
      });
      if (!res.ok) {
        // The Notice carries the machine code and the HTTP status - the operator-facing
        // reason class (manager_exit, wdev_idempotency_conflict, ...) - and never the
        // transport text: the proxy's own body is fixed copy, and any deeper manager
        // detail (stderr, helper paths) lives in the manager ledger, not the UI.
        const data = await res.json().catch(() => null) as { code?: string } | null;
        const code = typeof data?.code === "string" ? ` ${data.code}` : "";
        setDraftError(`${t("wdev.submitFailed")} HTTP ${res.status}${code}`);
        return;
      }
      const accepted = await res.json().catch(() => null) as { operationId?: string; state?: string; submittedAt?: number } | null;
      const operationId = typeof accepted?.operationId === "string" ? accepted.operationId : "";
      const state = typeof accepted?.state === "string" ? accepted.state : "queued";
      const submittedAt = typeof accepted?.submittedAt === "number" ? accepted.submittedAt : Date.now();
      if (operationId) {
        setRows(current => [{
          operationId,
          componentId: draft.componentId,
          action: draft.action,
          state,
          submittedAt,
          updatedAt: submittedAt,
        }, ...current.filter(row => row.operationId !== operationId)]);
      }
      setDraft(null);
      void loadOperations();
    } catch {
      // Transport failures get the fixed network line; the raw Error text (abort
      // wording, undici internals) stays in the console below the notice.
      setDraftError(t("wdev.submitFailedNetwork"));
    } finally {
      setSubmitting(false);
      bounded.clear();
    }
  }, [apiBase, draft, loadOperations, submitting, t]);

  const closeDraft = useCallback((): void => {
    setDraft(null);
    setDraftError("");
  }, []);

  const title = inventory?.brand ? inventory.brand : t("nav.wdev");

  return (
    <>
      <div className="page-head">
        <h2>{title}</h2>
        <div className="wdev-head-actions">
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => { void loadInventory(); void loadOperations(); }}>
            <IconRefresh /> {t("wdev.refresh")}
          </button>
        </div>
      </div>
      <p className="page-sub">{t("wdev.subtitle")}</p>

      {disabled && <Notice tone="warn">{t("wdev.disabledNotice")}</Notice>}

      {inventory && (
        <>
          <section className="panel">
            <div className="panel-head"><h3 className="panel-title">{t("wdev.components")}</h3></div>
            <div className="tbl-wrap">
              <table className="tbl wdev-table">
                <thead>
                  <tr>
                    <th scope="col">{t("wdev.components")}</th>
                    <th scope="col">{t("wdev.status")}</th>
                    <th scope="col">{t("wdev.unit")}</th>
                    <th scope="col">{t("wdev.url")}</th>
                    <th scope="col">{t("wdev.release")}</th>
                    <th scope="col">{t("wdev.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.components.map(component => (
                    <tr key={component.id}>
                      <td className="wdev-cell-id">{component.id}</td>
                      <td>
                        <span className={statusBadgeClass(component.status)}>
                          <span className={statusDotClass(component.status)} aria-hidden="true" />
                          {t(statusLabelKey(component.status))}
                        </span>
                      </td>
                      <td className="wdev-cell-meta">{component.unit}</td>
                      <td className="wdev-cell-meta">{component.url}</td>
                      <td className="wdev-cell-meta">
                        <div>{component.releaseId}</div>
                        <div>{t("wdev.revision")}: {component.revision ?? "-"}</div>
                      </td>
                      <td>
                        <div className="wdev-actions-cell">
                          <button type="button" className="btn btn-ghost btn-sm"
                            onClick={() => openDraft(component, "restart")}>
                            {t("wdev.action.restart")}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm"
                            onClick={() => openDraft(component, "upgrade")}>
                            {t("wdev.action.upgrade")}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm"
                            onClick={() => openDraft(component, "configure")}>
                            {t("wdev.action.configure")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h3 className="panel-title">{t("wdev.manifests")}</h3></div>
            {inventory.manifests.length === 0 ? (
              <p className="muted">{t("wdev.noManifests")}</p>
            ) : (
              <ul className="wdev-manifest-list">
                {inventory.manifests.map(manifest => (
                  <li key={manifest.path}>
                    <span>{manifest.name}</span>
                    <span className="wdev-cell-meta">{manifest.version}</span>
                    <code className="mono">{manifest.path}</code>
                    {typeof manifest.sizeBytes === "number" && (
                      <span className="wdev-cell-meta">{manifest.sizeBytes.toLocaleString()}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="panel">
        <div className="panel-head"><h3 className="panel-title">{t("wdev.operations")}</h3></div>
        {rows.length === 0 ? (
          <p className="muted">{t("wdev.noOperations")}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl wdev-table">
              <thead>
                <tr>
                  <th scope="col">{t("wdev.operations")}</th>
                  <th scope="col">{t("wdev.submittedAt")}</th>
                  <th scope="col">{t("wdev.lastError")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const detail = details[row.operationId];
                  const state = detail?.state ?? row.state;
                  const terminal = isTerminalState(state);
                  const stale = !terminal && now - row.submittedAt > WDEV_POLL_DEADLINE_MS;
                  // Live badge text: a translated state label, plus the RAW ledger
                  // phase beside it when the ledger is mid-flight on a step whose name
                  // the shared label does not carry (Running · verify). Terminal phases
                  // are final and read as such; an unknown phase from a newer manager
                  // shows "Running · <raw>" and keeps polling - it never reads as
                  // cancelled, because the terminal set is a closed whitelist.
                  const rawHint = terminal ? "" : rawProgressLabel(state);
                  const stateLabel = t(stateLabelKey(state));
                  const stateText = rawHint === "" || rawHint === stateLabel.toLowerCase()
                    ? stateLabel
                    : `${stateLabel} · ${rawHint}`;
                  const error = detail?.error ?? row.lastError ?? "";
                  return (
                    <tr key={row.operationId}>
                      <td>
                        <span className="wdev-cell-id">{row.componentId}</span>
                        <span className="wdev-cell-meta"> · {t(actionLabelKey(row.action))}</span>
                        <div className="wdev-state-row">
                          <span className={stateBadgeClass(state)}>{stateText}</span>
                          {!terminal && !stale && <span className="wdev-cell-meta">{t("wdev.polling")}</span>}
                          {stale && <span className="badge badge-amber">{t("wdev.pollStale")}</span>}
                          {detail?.newRevision && (
                            <span className="wdev-cell-meta">{t("wdev.revision")}: {detail.newRevision}</span>
                          )}
                        </div>
                      </td>
                      <td className="wdev-cell-meta">{new Date(row.submittedAt).toLocaleString()}</td>
                      <td className="wdev-cell-meta">{error}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {draft && (
        <WdevOperationDialog
          draft={draft}
          manifests={inventory?.manifests ?? []}
          error={draftError}
          submitting={submitting}
          t={t}
          onChange={patch => setDraft(current => (current ? { ...current, ...patch } : current))}
          onSubmit={() => { void submitDraft(); }}
          onClose={closeDraft}
        />
      )}
    </>
  );
}

function WdevOperationDialog({
  draft, manifests, error, submitting, t, onChange, onSubmit, onClose,
}: {
  draft: WdevDraft;
  manifests: WdevManifest[];
  error: string;
  submitting: boolean;
  t: TFn;
  onChange: (patch: Partial<WdevDraft>) => void;
  onSubmit: () => void;
  onClose: () => void;
}): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = "wdev-operation-dialog-title";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    // showModal() focuses the first focusable descendant, the full-screen backdrop button;
    // start on Close so Space cannot dismiss the dialog unseen.
    closeRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        if (!submitting) onClose();
      }}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("wdev.cancel")} tabIndex={-1}
        onClick={() => { if (!submitting) onClose(); }} />
      <div className="modal-card" role="document">
        <div className="modal-head">
          <h3 id={titleId}>{t(actionLabelKey(draft.action))}: {draft.componentId}</h3>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={submitting}>
            {t("wdev.cancel")}
          </button>
        </div>
        <form onSubmit={event => {
          event.preventDefault();
          onSubmit();
        }}>
          {draft.action === "upgrade" && (
            <div className="wdev-form-row">
              <label className="field-label" htmlFor="wdev-manifest">{t("wdev.manifest")}</label>
              <select id="wdev-manifest" className="input" value={draft.manifestPath} disabled={submitting}
                onChange={event => onChange({ manifestPath: event.target.value })}>
                {manifests.length === 0 && <option value="">{"-"}</option>}
                {manifests.map(manifest => (
                  <option key={manifest.path} value={manifest.path}>{manifest.name} · {manifest.version}</option>
                ))}
              </select>
            </div>
          )}
          {draft.action === "configure" && (
            <div className="wdev-form-row">
              <label className="field-label" htmlFor="wdev-config-patch">{t("wdev.configPatch")}</label>
              <textarea id="wdev-config-patch" className="input" rows={6} disabled={submitting}
                value={draft.configPatchText} placeholder='{"key":"value"}'
                onChange={event => onChange({ configPatchText: event.target.value })} />
            </div>
          )}
          <div className="wdev-grid-2">
            {draft.action !== "restart" && (
              <div className="wdev-form-row">
                <label className="field-label" htmlFor="wdev-expected-revision">{t("wdev.expectedRevision")}</label>
                <input id="wdev-expected-revision" className="input mono" disabled={submitting}
                  value={draft.expectedRevision}
                  onChange={event => onChange({ expectedRevision: event.target.value })} />
              </div>
            )}
            <div className="wdev-form-row">
              <label className="field-label" htmlFor="wdev-max-wait">{t("wdev.maxWait")}</label>
              <input id="wdev-max-wait" className="input" type="number" min={1} max={WDEV_MAX_WAIT_CEILING}
                disabled={submitting} value={draft.maxWaitText}
                onChange={event => onChange({ maxWaitText: event.target.value })} />
            </div>
          </div>
          {error && <Notice tone="err">{error}</Notice>}
          <div className="modal-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>{t("wdev.submit")}</button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
