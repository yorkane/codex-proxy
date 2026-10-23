import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { runModelRetryScope } from "../../src/lib/model-retry-scope";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { getValidAccessSnapshotForAccount } from "../../src/oauth";
import { getAccountSet, saveCredential, setActiveAccount, setAccountPaused } from "../../src/oauth/store";
import type { OAuthAccessSnapshot } from "../../src/oauth";
import type { OcxConfig } from "../../src/types";

// Auto-pause deferral across one logical model request: the observation samples every physical
// refusal, but the persistence commit and the auto-pause marker queue behind the model-retry
// scope, so an in-scope streak can never self-truncate the send budget of its own request. The
// scope is driven directly here: runModelRetryScope is the exact seam fetchWithTransientRetry
// mounts under modelRetryMode, which keeps this the observer contract, not a transport harness.
const orgMessage = "OAuth authentication is currently not allowed for this organization";
const refusal = () => Response.json({ error: { type: "permission_error", message: orgMessage } }, { status: 401 });
const oldHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-pause-defer-")); process.env.OPENCODEX_HOME = home; });
afterEach(() => {
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
async function oauthFixture(threshold = 2) {
  const config = getDefaultConfig();
  config.providers = { "command-code": { adapter: "openai-chat", baseUrl: "https://example.test/v1",
    authMode: "oauth", accountAutoPause: { enabled: true, consecutiveFailures: threshold } } };
  config.defaultProvider = "command-code";
  saveConfig(config);
  for (let n = 0; n < 2; n++) await saveCredential("command-code", {
    access: `synthetic-access-${n}`, refresh: `synthetic-refresh-${n}`,
    expires: Date.now() + 3_600_000, accountId: `synthetic-${n}`, source: "oauth",
  });
  const ids = getAccountSet("command-code")!.accounts.map(a => a.id);
  await setActiveAccount("command-code", ids[0]!);
  const snapshot = await getValidAccessSnapshotForAccount("command-code", ids[0]!);
  const capture = () => captureAccountAutoPauseAttempt("command-code", config.providers["command-code"]!,
    { config, oauth: snapshot }, new Headers({ authorization: `Bearer ${snapshot.accessToken}` }))!;
  return { config, snapshot, capture };
}

describe("model-retry scope defers automatic account pause", () => {
  test("threshold 2 with eleven physical 401s: eleven samples, then exactly one pause after the scope", async () => {
    const f = await oauthFixture(2);
    let pausedMidScope: boolean | undefined;
    const responses: Response[] = [];
    await runModelRetryScope(async () => {
      for (let attempt = 0; attempt < 11; attempt++) {
        responses.push(await f.capture()(refusal()));
        if (attempt === 3) pausedMidScope = getAccountSet("command-code")!.accounts[0]!.paused === true;
      }
    });
    expect(pausedMidScope).toBe(false); // sends 3-11 stayed admissible: the budget was not self-truncated
    expect(responses.length).toBe(11);
    expect(getAccountSet("command-code")!.accounts[0]!.paused).toBe(true);
    expect(getAccountSet("command-code")!.accounts[0]!.pauseDetails?.reason).toBe("oauth_organization_disabled");
    // Provenance-accurate marker (root ruling): the label settles on the refusal whose queued
    // commit tripped the threshold — the second sample — never on a response of a concurrent
    // request, and never retroactively on the response the request happened to end on.
    expect(responses.map(entry => wasAccountAutoPaused(entry))).toEqual([false, true, ...Array(9).fill(false)]);
    expect(getAccountSet("command-code")!.activeAccountId).not.toBe(getAccountSet("command-code")!.accounts[0]!.id);
  });

  test("a mid-scope success retires queued refusals: no pause and the streak is reset", async () => {
    const f = await oauthFixture(2);
    let midScopePaused: boolean | undefined;
    await runModelRetryScope(async () => {
      await f.capture()(refusal());
      await f.capture()(refusal());
      midScopePaused = getAccountSet("command-code")!.accounts[0]!.paused === true;
      await f.capture()(new Response("ok"));
    });
    expect(midScopePaused).toBe(false);
    expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
    // The success reset the shared streak: a later request pair outside any scope pauses at 2.
    await f.capture()(refusal());
    expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
    await f.capture()(refusal());
    expect(getAccountSet("command-code")!.accounts[0]!.paused).toBe(true);
  });

  test("an explicit user pause during an open scope blocks the next capture immediately", async () => {
    const f = await oauthFixture(2);
    const first = await f.capture()(refusal());
    expect(wasAccountAutoPaused(first)).toBe(false);
    await setAccountPaused("command-code", f.snapshot.accountId, true);
    expect(f.capture()).toBeUndefined(); // the manual pause fences the observation at capture time
    await setAccountPaused("command-code", f.snapshot.accountId, false);
    expect(f.capture()).toBeDefined();
  });

  test("an abort exit flushes the sampled refusals once, with no extra sends", async () => {
    const f = await oauthFixture(2);
    let sends = 0;
    let settle: "aborted" | "value" = "value";
    try {
      await runModelRetryScope(async () => {
        for (let attempt = 0; attempt < 4; attempt++) { sends++; await f.capture()(refusal()); }
        throw new DOMException("aborted", "AbortError");
      });
    } catch (err) {
      settle = (err as DOMException).name === "AbortError" ? "aborted" : "value";
    }
    expect(settle).toBe("aborted");
    expect(sends).toBe(4); // the scope adds no sends of its own, before or after the abort
    expect(getAccountSet("command-code")!.accounts[0]!.paused).toBe(true); // the terminal flush committed
  });

  test("a credential generation change fences the queued refusal: the rotated row is not paused", async () => {
    const f = await oauthFixture(1);
    // A capture whose bearer is a token the store no longer holds fences at capture time.
    const stale: OAuthAccessSnapshot = { ...f.snapshot, accessToken: "access-token-rotated", generation: "rotated" };
    expect(captureAccountAutoPauseAttempt("command-code", f.config.providers["command-code"]!,
      { config: f.config, oauth: stale }, new Headers({ authorization: "Bearer access-token-rotated" }))).toBeUndefined();
    // The live capture queues its commit; rotating the stored credential before the flush fences it out.
    const queued = f.capture();
    let midScopePaused: boolean | undefined;
    await runModelRetryScope(async () => {
      await queued(refusal());
      midScopePaused = getAccountSet("command-code")!.accounts[0]!.paused === true;
      await saveCredential("command-code", { access: "synthetic-access-new", refresh: "synthetic-refresh-0",
        expires: Date.now() + 3_600_000, accountId: "synthetic-0", source: "oauth" });
    });
    expect(midScopePaused).toBe(false);
    expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
  });

  test("a policy opt-out during an open scope fences the queued refusal at commit", async () => {
    const f = await oauthFixture(1);
    const queued = f.capture();
    await runModelRetryScope(async () => {
      queued(refusal()); // no await: the deferral lands at the flush, after the opt-out below
      await new Promise(r => setTimeout(r, 0));
      f.config.providers["command-code"]!.accountAutoPause = undefined;
    });
    expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
  });

  test("an external config rewrite that disables the policy rejects the queued commit at the disk fence", async () => {
    const f = await oauthFixture(1);
    const queued = f.capture();
    await runModelRetryScope(async () => {
      queued(refusal());
      await new Promise(r => setTimeout(r, 0));
      const disk = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
      disk.providers["command-code"]!.accountAutoPause = { enabled: false };
      saveConfig(disk);
    });
    expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
  });

  test("outside any scope the commit is immediate: threshold 1 pauses on the spot, marked", async () => {
    const f = await oauthFixture(1);
    const response = await f.capture()(refusal());
    expect(getAccountSet("command-code")!.accounts[0]!.paused).toBe(true);
    expect(wasAccountAutoPaused(response)).toBe(true);
  });
});
