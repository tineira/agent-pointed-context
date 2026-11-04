/**
 * A pairing request's buttons while an answer is on its way (TIN-581, Fix check 2 on #120): an Approve
 * on its way, or the hub still introducing itself after one, turns Approve off and leaves Deny on, on the
 * surface that sent it too; a Deny on its way turns both off. The rules (request-state.ts) alone, then the
 * warning as the dock renders it (unverified.tsx through Vite's SSR loader and react-dom/server), and the
 * page's gate on what it sends.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buttonsOff, cardInFlight, decisionNotice, inFlightOf, kindOf, landed, mayAnswer, mergeInFlight, sentOut, type Sent } from "../src/web/request-state.ts";

test("the rules: a Deny goes while an Approve is on its way or the hub is approving; a second yes never does", () => {
  assert.deepEqual(buttonsOff({}), { deny: false, approve: false });
  assert.deepEqual(buttonsOff({ inFlight: "approve" }), { deny: false, approve: true }, "Approve sent here: Deny stays on");
  assert.deepEqual(buttonsOff({ approving: true }), { deny: false, approve: true }, "the hub introducing itself: Deny stays on");
  assert.deepEqual(buttonsOff({ inFlight: "deny" }), { deny: true, approve: true });
  assert.deepEqual(buttonsOff({ inFlight: "deny", approving: true }), { deny: true, approve: true });

  assert.equal(mayAnswer("deny", { inFlight: "approve" }), true, "the misclick can be undone");
  assert.equal(mayAnswer("deny", { approving: true }), true);
  assert.equal(mayAnswer("approve_unverified", { inFlight: "approve" }), false, "only a second Approve is suppressed");
  assert.equal(mayAnswer("approve", { approving: true }), false);
  assert.equal(mayAnswer("deny", { inFlight: "deny" }), false);
  assert.equal(mayAnswer("unpair", { inFlight: "deny" }), false);
  assert.equal(mayAnswer("approve_unverified", {}), true);

  assert.equal(kindOf("deny"), "deny");
  assert.equal(kindOf("unpair"), "deny");
  assert.equal(kindOf("approve_unverified"), "approve");
  assert.equal(inFlightOf({ approve: true, deny: true }), "deny", "a Deny counts over an Approve");
  assert.equal(inFlightOf({ approve: true, deny: false }), "approve");
  assert.equal(inFlightOf(undefined), undefined);
  assert.equal(mergeInFlight("approve", "deny"), "deny");
  assert.equal(mergeInFlight(undefined, "approve"), "approve");
});

test("a failed Deny can be sent again while an Approve is still on its way (Fix check 3 on #120)", () => {
  const id = "pr_1";
  // The page sends Approve, then Deny; the Deny's request is rejected (decide fails), the Approve still on its way.
  let page: Sent = sentOut(new Map(), id, "approve");
  page = sentOut(page, id, kindOf("deny"));
  assert.deepEqual(buttonsOff({ inFlight: inFlightOf(page.get(id)) }), { deny: true, approve: true }, "while the Deny is on its way");
  page = landed(page, id, "deny");
  assert.equal(inFlightOf(page.get(id)), "approve", "only the Deny cleared");
  assert.equal(mayAnswer("deny", { inFlight: inFlightOf(page.get(id)), approving: true }), true, "the page lets it go again");
  // The card that sent the Approve: its own click never holds a Deny, so it follows the page.
  const card = cardInFlight(inFlightOf(page.get(id)), true);
  assert.deepEqual(buttonsOff({ inFlight: card, approving: true }), { deny: false, approve: true });
  assert.equal(mayAnswer("deny", { inFlight: card, approving: true }), true);
  assert.equal(cardInFlight(undefined, false), undefined);
  assert.equal(cardInFlight("deny", true), "deny", "a Deny the page has on its way still turns both off");
  // Both landed: the request is clean again.
  page = landed(page, id, "approve");
  assert.equal(page.has(id), false);
});

// ---- The warning as rendered ----

type Vite = { ssrLoadModule(url: string): Promise<Record<string, unknown>>; close(): Promise<void> };
let vite: Vite;
let render: (props: Record<string, unknown>) => string;

before(async () => {
  const { createServer } = await import("vite");
  // The dock's own root, without its config (no Cloudflare runtime): Vite only transforms the TSX for Node.
  vite = (await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    oxc: { jsx: { runtime: "automatic" } },
  } as Parameters<typeof createServer>[0])) as unknown as Vite;
  const [{ UnverifiedRequest, DecisionNotice }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
    vite.ssrLoadModule("/src/web/unverified.tsx") as Promise<{ UnverifiedRequest: unknown; DecisionNotice: unknown }>,
    import("react"),
    import("react-dom/server"),
  ]);
  render = (props) =>
    renderToStaticMarkup(createElement(UnverifiedRequest as never, { domain: "pulse.apc.tineira.com.evil.example", declared: "Pulse", agent: "Claude", decide: () => {}, ...props } as never));
  renderNotice = (notice) => renderToStaticMarkup(createElement(DecisionNotice as never, { notice, dismiss: () => {} } as never));
});
let renderNotice: (notice: string | null) => string;

test("a refused answer is said, not dropped: the hub's 400 becomes a visible notice (Fix check 4 on #120)", () => {
  const html = renderNotice(decisionNotice("approval_withdrawn"));
  assert.match(html, /^<div class="decision-notice" role="alert"><p>Approval was withdrawn; ask again\./);
  assert.match(html, /aria-label="Close"/);
  assert.equal(renderNotice(null), "", "nothing when there is nothing to say");
  for (const error of ["unknown_pairing", "warning_required", "app_blocked", "revoked", "invalid_action", "unreachable"]) {
    assert.ok(decisionNotice(error).length > 20, error);
  }
  assert.match(decisionNotice("<script>"), /That did not go through \(<script>\)/, "an unknown code is shown as text (React escapes it)");
  assert.match(renderNotice(decisionNotice("<script>")), /\(&lt;script&gt;\)/);
});
after(async () => {
  await vite?.close();
});

/** Each button in the markup, by its label: whether it is disabled. */
const buttons = (html: string) => Object.fromEntries([...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], / disabled=""/.test(m[1]!)]));

test("rendered: on the page that sent Approve, and while the hub is approving, Deny stays on and only Approve is off", () => {
  for (const warning of [true, false]) {
    const yes = warning ? "Approve" : "Allow";
    assert.deepEqual(buttons(render({ warning })), { Deny: false, [yes]: false }, `nothing on its way (warning ${warning})`);
    assert.deepEqual(buttons(render({ warning, inFlight: "approve" })), { Deny: false, [yes]: true }, `Approve on its way (warning ${warning})`);
    assert.deepEqual(buttons(render({ warning, approving: true })), { Deny: false, [yes]: true }, `the hub approving (warning ${warning})`);
    assert.deepEqual(buttons(render({ warning, inFlight: "deny" })), { Deny: true, [yes]: true }, `Deny on its way (warning ${warning})`);
  }
});

test("rendered: the warning keeps its words and its order, Deny first, and the host on one line with its registered domain whole", () => {
  const html = render({ warning: true });
  assert.ok(html.indexOf(">Deny<") < html.indexOf(">Approve<"), "Deny first");
  assert.match(html, /<button type="button" class="primary"[^>]*>Deny</);
  assert.match(html, /<span class="host-head">pulse\.apc\.tineira\.com<\/span><span class="host-site">\.evil\.example<\/span>/);
  assert.match(html, /title="pulse\.apc\.tineira\.com\.evil\.example"/);
  assert.match(html, /Not verified/);
});
