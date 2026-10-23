/**
 * Shadow-call intercept settings routes (fork addition).
 *
 * Kept in its own module so the shared config-routes.ts stays a one-line
 * delegation; upstream edits to that file never intersect this block again.
 */
import { deleteConfigTopLevelKey, saveConfigPreservingClaudeCode } from "../../config";
import { captureConfigTopLevelRollback } from "../../config/rebase-provenance";
import {
  DEFAULT_PHANTOM_TOOL_ALLOWLIST,
  shadowPhantomToolList,
  shadowSourceModels,
} from "../../lib/shadow-call";
import {
  EMPTY_COMPLETION_RETRY_MAX_ENV,
  EMPTY_COMPLETION_RETRY_MAX_LIMIT,
  emptyCompletionRetryMax,
} from "../../lib/empty-completion-budget";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_ENV,
  MODEL_REQUEST_MAX_RETRIES_LIMIT,
  MODEL_REQUEST_MAX_RETRIES_MIN,
  modelRequestMaxRetries,
  modelRequestRetryEnvOverride,
} from "../../lib/model-request-retry";
import { EMPTY_COMPLETION_RETRY_ENV } from "../responses/empty-completion-guard";
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
  const { req, url, config, deps } = ctx;
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
    // Top-level empty-completion replay switch. The guard lives outside the intercept
    // block, so it is projected here too: the Shadow page owns its only edit surface.
    emptyCompletionRetry: config.emptyCompletionRetry === true,
    // The disable-only emergency override: while it is set, the persisted switch has no effect.
    emptyCompletionRetryEnvOverride: process.env[EMPTY_COMPLETION_RETRY_ENV] === "0",
    // The replay budget behind that switch, resolved exactly as the pipeline resolves it, plus the
    // bounds the UI clamps to. The env field is a hint, not the resolved value: an override that
    // the UI could not see would leave the operator editing a number that has no effect.
    emptyCompletionRetryMax: emptyCompletionRetryMax(config),
    emptyCompletionRetryMaxMin: 0,
    emptyCompletionRetryMaxLimit: EMPTY_COMPLETION_RETRY_MAX_LIMIT,
    emptyCompletionRetryMaxEnvOverride: process.env[EMPTY_COMPLETION_RETRY_MAX_ENV] !== undefined
      && process.env[EMPTY_COMPLETION_RETRY_MAX_ENV] !== "",
    // 全局明文 V2 协作消息总闸。与 provider 级同名字段是两层门：本页只编辑全局总闸，
    // provider 级 opt-in 仍由各自的 provider 配置面负责，故此处不投影 provider 字段。
    plaintextV2AgentMessages: config.plaintextV2AgentMessages === true,
    // 全局模型请求重试预算（同一份 config.modelRequestMaxRetries，不是 Shadow 私有副本）：
    // Shadow 页提供编辑面，解析口径与 GET /api/settings、/api/config 完全一致（env > config
    // > 默认 3，0=关闭代理内模型 HTTP 错误重试）。EnvOverride 只在 env 是非空白有限数时为
    // true；只回变量名，不带任何 secret。
    modelRequestMaxRetries: modelRequestMaxRetries(config.modelRequestMaxRetries),
    modelRequestMaxRetriesConfigured: config.modelRequestMaxRetries,
    modelRequestMaxRetriesMin: MODEL_REQUEST_MAX_RETRIES_MIN,
    modelRequestMaxRetriesLimit: MODEL_REQUEST_MAX_RETRIES_LIMIT,
    modelRequestMaxRetriesDefault: DEFAULT_MODEL_REQUEST_MAX_RETRIES,
    modelRequestMaxRetriesEnvOverride: modelRequestRetryEnvOverride(),
    modelRequestMaxRetriesEnvName: MODEL_REQUEST_MAX_RETRIES_ENV,
  });
}

 if (url.pathname === "/api/shadow-call-settings" && req.method === "PUT") {
   let raw: unknown;
   try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
   if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
   const body = raw as { enabled?: unknown; model?: unknown; modelMap?: unknown; sourceModels?: unknown; phantomToolAllowlist?: unknown; phantomToolAllowlistEnabled?: unknown; phantomToolFeedbackMax?: unknown; emptyCompletionRetry?: unknown; emptyCompletionRetryMax?: unknown; plaintextV2AgentMessages?: unknown; modelRequestMaxRetries?: unknown };
   if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
     return jsonResponse({ error: "enabled must be a boolean" }, 400);
   }
   // Strictly boolean-or-absent, mirroring src/config/diagnostics.ts. A "true" string is a
   // client bug: reject it with 400 instead of coercing it into the persisted config.
   if (body.emptyCompletionRetry !== undefined && typeof body.emptyCompletionRetry !== "boolean") {
     return jsonResponse({ error: "emptyCompletionRetry must be a boolean" }, 400);
   }
  // 与 emptyCompletionRetry 同样的严格布尔：字符串 "true" 是客户端 bug，400 拒绝而不是强制转换落盘。
  if (body.plaintextV2AgentMessages !== undefined && typeof body.plaintextV2AgentMessages !== "boolean") {
    return jsonResponse({ error: "plaintextV2AgentMessages must be a boolean" }, 400);
  }
   // Strictly integer-or-absent, mirroring src/config/diagnostics.ts. A "2" string or a 1.5 is a
   // client bug: reject it with 400 rather than letting the number reach the persisted config,
   // where the schema's catch would leave a value that the pipeline silently ignores.
   if (body.emptyCompletionRetryMax !== undefined
     && (typeof body.emptyCompletionRetryMax !== "number" || !Number.isInteger(body.emptyCompletionRetryMax)
       || body.emptyCompletionRetryMax < 0 || body.emptyCompletionRetryMax > EMPTY_COMPLETION_RETRY_MAX_LIMIT)) {
     return jsonResponse({ error: `emptyCompletionRetryMax must be an integer 0-${EMPTY_COMPLETION_RETRY_MAX_LIMIT}` }, 400);
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
  // 全局模型重试预算的写边界与 PUT /api/settings 完全一致：严格 0..5 整数（0 合法=关闭），
  // null 清键回落默认 3；越界（含旧 10）、小数、字符串 400 拒绝且不改 config。
  if (body.modelRequestMaxRetries !== undefined && body.modelRequestMaxRetries !== null && !(
    typeof body.modelRequestMaxRetries === "number"
    && Number.isInteger(body.modelRequestMaxRetries)
    && body.modelRequestMaxRetries >= MODEL_REQUEST_MAX_RETRIES_MIN
    && body.modelRequestMaxRetries <= MODEL_REQUEST_MAX_RETRIES_LIMIT
  )) {
    return jsonResponse({ error: `modelRequestMaxRetries must be an integer from ${MODEL_REQUEST_MAX_RETRIES_MIN} to ${MODEL_REQUEST_MAX_RETRIES_LIMIT}` }, 400);
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
  // Assigned on the LIVE config object -- the same reference the request pipeline reads --
  // so the guard flips for the next turn without a restart, exactly like the phantom list.
  if (typeof body.emptyCompletionRetry === "boolean") {
    config.emptyCompletionRetry = body.emptyCompletionRetry;
  }
  if (typeof body.emptyCompletionRetryMax === "number") {
    // Same live-object assignment as the switch: the next turn reads the new budget without a
    // restart, because the request pipeline reads this very reference.
    config.emptyCompletionRetryMax = body.emptyCompletionRetryMax;
  }
  // 与 emptyCompletionRetry 相同的 live 对象赋值：下一请求即生效，无需重启。
  if (typeof body.plaintextV2AgentMessages === "boolean") {
    config.plaintextV2AgentMessages = body.plaintextV2AgentMessages;
  }
  // 与 emptyCompletionRetryMax 相同的 live 对象赋值：下一请求即生效，无需重启。null 清键
  // 走 deleteConfigTopLevelKey（登记 rebase-provenance 删除意图，与 PUT /api/settings 同机制）。
  // 保存失败用 captureConfigTopLevelRollback 回滚：字段值/存在性与 pending 删除意图一起还原，
  // 不留失败保存的 tombstone 污染，也不让 UI 宣称成功而 live 配置漂移。
  const restoreModelRetries = captureConfigTopLevelRollback(config, ["modelRequestMaxRetries"]);
  if (typeof body.modelRequestMaxRetries === "number") {
    config.modelRequestMaxRetries = body.modelRequestMaxRetries;
  } else if (body.modelRequestMaxRetries === null) {
    deleteConfigTopLevelKey(config, "modelRequestMaxRetries");
  }
  try {
    // deps seam（与 config-routes 同模式）：测试注入失败保存，生产走真实 writer。
    (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
  } catch (error) {
    restoreModelRetries();
    throw error;
  }
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
    emptyCompletionRetry: config.emptyCompletionRetry === true,
    emptyCompletionRetryEnvOverride: process.env[EMPTY_COMPLETION_RETRY_ENV] === "0",
    emptyCompletionRetryMax: emptyCompletionRetryMax(config),
    emptyCompletionRetryMaxMin: 0,
    emptyCompletionRetryMaxLimit: EMPTY_COMPLETION_RETRY_MAX_LIMIT,
    emptyCompletionRetryMaxEnvOverride: process.env[EMPTY_COMPLETION_RETRY_MAX_ENV] !== undefined
      && process.env[EMPTY_COMPLETION_RETRY_MAX_ENV] !== "",
    plaintextV2AgentMessages: config.plaintextV2AgentMessages === true,
    // PUT 回包与 GET 字段一致（含 bounds/env-override/变量名），UI 保存后直接重渲染。
    modelRequestMaxRetries: modelRequestMaxRetries(config.modelRequestMaxRetries),
    modelRequestMaxRetriesConfigured: config.modelRequestMaxRetries,
    modelRequestMaxRetriesMin: MODEL_REQUEST_MAX_RETRIES_MIN,
    modelRequestMaxRetriesLimit: MODEL_REQUEST_MAX_RETRIES_LIMIT,
    modelRequestMaxRetriesDefault: DEFAULT_MODEL_REQUEST_MAX_RETRIES,
    modelRequestMaxRetriesEnvOverride: modelRequestRetryEnvOverride(),
    modelRequestMaxRetriesEnvName: MODEL_REQUEST_MAX_RETRIES_ENV,
  });
}
  return null;
}
