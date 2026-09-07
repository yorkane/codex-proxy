/**
 * Shadow-call intercept settings routes (fork addition).
 *
 * Kept in its own module so the shared config-routes.ts stays a one-line
 * delegation; upstream edits to that file never intersect this block again.
 */
import { saveConfigPreservingClaudeCode } from "../../config";
import {
  DEFAULT_PHANTOM_TOOL_ALLOWLIST,
  shadowPhantomToolList,
  shadowSourceModels,
} from "../../lib/shadow-call";
import { jsonResponse } from "../auth-cors";
import { isPlainRecord } from "./shared";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { shadowCallModelMapErrors, shadowCallTargetError } from "./shadow-call-validation";

/**
 * Handle GET/PUT `/api/shadow-call-settings`, or null when the request is for
 * a different endpoint (config-routes keeps the normal fall-through).
 */
export async function handleShadowCallRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
if (url.pathname === "/api/shadow-call-settings" && req.method === "GET") {
  const sci = config.shadowCallIntercept ?? {};
  return jsonResponse({
    enabled: sci.enabled === true,
    model: sci.model ?? "",
    modelMap: sci.modelMap ?? {},
    sourceModels: shadowSourceModels(sci.sourceModels),
     phantomToolAllowlistEnabled: sci.phantomToolAllowlistEnabled !== false,
     phantomToolAllowlist: shadowPhantomToolList(sci),
     phantomToolDefaults: [...DEFAULT_PHANTOM_TOOL_ALLOWLIST],
     phantomToolFeedbackMax: sci.phantomToolFeedbackMax ?? 2,
  });
}

 if (url.pathname === "/api/shadow-call-settings" && req.method === "PUT") {
   let raw: unknown;
   try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
   if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
   const body = raw as { enabled?: unknown; model?: unknown; modelMap?: unknown; sourceModels?: unknown; phantomToolAllowlist?: unknown; phantomToolAllowlistEnabled?: unknown; phantomToolFeedbackMax?: unknown };
   if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
     return jsonResponse({ error: "enabled must be a boolean" }, 400);
   }
  if (body.model !== undefined && typeof body.model !== "string") {
    return jsonResponse({ error: "model must be a string" }, 400);
  }
   if (body.modelMap !== undefined && (typeof body.modelMap !== "object" || body.modelMap === null || Array.isArray(body.modelMap))) {
     return jsonResponse({ error: "modelMap must be an object" }, 400);
   }
  if (body.modelMap !== undefined) {
    for (const [k, v] of Object.entries(body.modelMap as Record<string, unknown>)) {
      if (typeof k !== "string" || k.trim() === "") return jsonResponse({ error: "modelMap keys must be non-empty strings" }, 400);
      if (typeof v !== "string") return jsonResponse({ error: `modelMap[${k}] must be a string` }, 400);
    }
  }
   if (body.sourceModels !== undefined && (!Array.isArray(body.sourceModels) || body.sourceModels.some(v => typeof v !== "string" || v.trim() === ""))) {
     return jsonResponse({ error: "sourceModels must be an array of non-empty strings" }, 400);
   }
   if (body.phantomToolAllowlist !== undefined && (!Array.isArray(body.phantomToolAllowlist) || body.phantomToolAllowlist.some(v => typeof v !== "string" || v.trim() === ""))) {
     return jsonResponse({ error: "phantomToolAllowlist must be an array of non-empty strings" }, 400);
   }
   if (body.phantomToolAllowlistEnabled !== undefined && typeof body.phantomToolAllowlistEnabled !== "boolean") {
     return jsonResponse({ error: "phantomToolAllowlistEnabled must be a boolean" }, 400);
   }
   if (body.phantomToolFeedbackMax !== undefined
     && (typeof body.phantomToolFeedbackMax !== "number" || !Number.isInteger(body.phantomToolFeedbackMax)
       || body.phantomToolFeedbackMax < 0 || body.phantomToolFeedbackMax > 10)) {
     return jsonResponse({ error: "phantomToolFeedbackMax must be an integer 0-10" }, 400);
   }
  const candidateModel = typeof body.model === "string"
    ? body.model
    : body.enabled === true
      ? config.shadowCallIntercept?.model
      : undefined;
   // Validate every replacement target: the shared `model` fallback and each modelMap value.
   const candidateModels: string[] = [];
   if (candidateModel) candidateModels.push(candidateModel);
   if (body.modelMap && typeof body.modelMap === "object") {
     for (const v of Object.values(body.modelMap as Record<string, unknown>)) {
       if (typeof v === "string" && v.trim() !== "") candidateModels.push(v);
     }
   }
  for (const candidate of candidateModels) {
    const targetError = shadowCallTargetError(config, candidate);
    if (targetError) return jsonResponse({ error: targetError }, 400);
  }
   const modelMapError = shadowCallModelMapErrors(config, body.modelMap as Record<string, string> | undefined);
   if (modelMapError) return jsonResponse({ error: modelMapError }, 400);
  config.shadowCallIntercept = { ...config.shadowCallIntercept };
  if (typeof body.enabled === "boolean") config.shadowCallIntercept.enabled = body.enabled;
  if (typeof body.model === "string") {
    if (body.model === "") delete config.shadowCallIntercept.model;
    else config.shadowCallIntercept.model = body.model;
  }
  if (body.modelMap && typeof body.modelMap === "object") {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.modelMap as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() !== "") next[k] = v;
    }
    config.shadowCallIntercept.modelMap = Object.keys(next).length > 0 ? next : undefined;
  }
   if (Array.isArray(body.sourceModels)) {
     const cleaned = [...new Set((body.sourceModels as unknown[]).map(v => String(v).trim()).filter(v => v !== ""))];
     config.shadowCallIntercept.sourceModels = cleaned.length > 0 ? cleaned : undefined;
   }
   if (typeof body.phantomToolAllowlistEnabled === "boolean") {
     config.shadowCallIntercept.phantomToolAllowlistEnabled = body.phantomToolAllowlistEnabled;
   }
   if (Array.isArray(body.phantomToolAllowlist)) {
     // An explicit list (including empty) is stored verbatim; absence keeps the built-in defaults.
     config.shadowCallIntercept.phantomToolAllowlist = [...new Set((body.phantomToolAllowlist as unknown[]).map(v => String(v).trim()).filter(v => v !== ""))];
   }
   if (typeof body.phantomToolFeedbackMax === "number") {
     config.shadowCallIntercept.phantomToolFeedbackMax = body.phantomToolFeedbackMax;
   }
  saveConfigPreservingClaudeCode(config);
  const sci = config.shadowCallIntercept;
  return jsonResponse({
    ok: true,
    enabled: sci.enabled === true,
    model: sci.model ?? "",
     modelMap: sci.modelMap ?? {},
    sourceModels: shadowSourceModels(sci.sourceModels),
    phantomToolAllowlistEnabled: sci.phantomToolAllowlistEnabled !== false,
    phantomToolAllowlist: shadowPhantomToolList(sci),
    phantomToolFeedbackMax: sci.phantomToolFeedbackMax ?? 2,
  });
}
  return null;
}
