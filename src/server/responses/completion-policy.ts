import type { ResponsesRequestContext } from "./core-options";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import { emptyCompletionRetryEnabled } from "./empty-completion-guard";
import { emptyCompletionRetryMax } from "../../lib/empty-completion-budget";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export function createResponsesCompletionPolicy(
  requestContext: Pick<ResponsesRequestContext, "config" | "options">,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction">,
) {
  const { config, options } = requestContext;
  const { routedCompaction } = sidecarState;


  // Empty-completion guard (codex-router PR #145 port): a 200 that completes with no output
  // text and no tool call is a failure the client cannot see — it silently records the turn as
  // done. The guard holds pre-content adapter events, suppresses the terminal of an empty
  // turn, replays the IDENTICAL request, and surfaces a stated error when the replay is
  // empty or fails. This is a top-level config opt-in; OCX_EMPTY_COMPLETION_RETRY=0 is a
  // disable-only emergency override. Compaction turns and combo attempts keep their own
  // machinery (the combo preflight already handles empty streams). Native Chat-to-Chat
  // requests return from handleChatCompletions before entering Responses core, so they are
  // intentionally outside this guard and retain their existing one-send wire behavior.
  //
  // The replay BUDGET is resolved once per request, here, so every guard the pipeline runs spends
  // the same number of replays — the two adapter-delivery wraps, both run-turn wraps, and the
  // web-search loop's inner wrap all read this one value rather than defaulting independently.
  // It is resolved even when the switch is off: the run-turn transport logs the guard-off notice
  // with this figure, and a budget that silently differed between the two paths would make the
  // log describe a policy the request never had.
  const emptyCompletionGuardMaxRetries = emptyCompletionRetryMax(config);
  // A zero budget means "do not replay", and the observable end state the operator wants for that
  // is the pre-guard RELAY — the empty turn passes through and the client records it as done — not
  // a `response.failed` for a turn the model genuinely chose to end. So the budget joins the
  // switch here instead of being forwarded to a guard running with maxRetries: 0, which is the
  // guard's own distinct shape (an immediate stated failure) and stays a guard-level option.
  const emptyCompletionGuardEnabled =
    emptyCompletionRetryEnabled(config)
    && emptyCompletionGuardMaxRetries > 0
    && !options.comboAttempt
    && !routedCompaction;

  return {
    emptyCompletionGuardEnabled,
    emptyCompletionGuardMaxRetries,
  };
}

export type ResponsesCompletionPolicy = Exclude<ReturnType<typeof createResponsesCompletionPolicy>, Response>;
