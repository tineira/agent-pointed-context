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
import { buttonsOff, CODE_IN_DOCK, codeErrorText, cardInFlight, decisionNotice, inFlightOf, isCodeRetryError, isConnectingAnswer, kindOf, landed, mayAnswer, mergeInFlight, sentOut, typedCode, type Sent } from "../src/web/request-state.ts";

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
  const [{ UnverifiedRequest, DecisionNotice }, { PairingRequest }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
    vite.ssrLoadModule("/src/web/unverified.tsx") as Promise<{ UnverifiedRequest: unknown; DecisionNotice: unknown }>,
    vite.ssrLoadModule("/src/web/pairing-request.tsx") as Promise<{ PairingRequest: unknown }>,
    import("react"),
    import("react-dom/server"),
  ]);
  renderRequest = (props) =>
    renderToStaticMarkup(createElement(PairingRequest as never, { entry: "field", kind: "app", app: "Orders", host: "orders.example", agent: "Claude", says: "Orders at orders.example wants to be read by Claude.", decide: () => {}, ...props } as never));
  render = (props) =>
    renderToStaticMarkup(createElement(UnverifiedRequest as never, { domain: "pulse.apc.tineira.com.evil.example", declared: "Pulse", agent: "Claude", decide: () => {}, ...props } as never));
  renderNotice = (notice) => renderToStaticMarkup(createElement(DecisionNotice as never, { notice, dismiss: () => {} } as never));
});
let renderNotice: (notice: string | null) => string;
let renderRequest: (props: Record<string, unknown>) => string;

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

// ---- The pairing code (APC 0.9, TIN-859) ----

test("the code as typed: forgiving to read, raw to send; only a wrong, malformed or missing code is said on the card", () => {
  assert.equal(typedCode("k7m-4p2"), "K7M4P2", "a pasted code, as written anywhere");
  assert.equal(typedCode(" K7M 4P2 "), "K7M4P2");
  assert.equal(typedCode("K7M-4P"), null, "Allow waits for six characters");
  assert.equal(typedCode(""), null);
  for (const e of ["wrong_pairing_code", "invalid_pairing_code", "pairing_code_required"]) assert.equal(isCodeRetryError(e), true, e);
  for (const e of ["pairing_code_refused", "unknown_pairing", "approval_withdrawn", undefined]) assert.equal(isCodeRetryError(e), false, String(e));
  assert.equal(codeErrorText({ error: "wrong_pairing_code", attempts_left: 3 }), "Wrong code. 3 tries left.");
  assert.equal(codeErrorText({ error: "wrong_pairing_code", attempts_left: 1 }), "Wrong code. 1 try left.");
  assert.match(decisionNotice("pairing_code_refused"), /^Too many wrong codes, so the request was removed\. Drop the agent on the app again\.$/);
  for (const e of ["wrong_pairing_code", "invalid_pairing_code", "pairing_code_required"]) assert.doesNotMatch(decisionNotice(e), /That did not go through/, e);
  // Only a request without a code gets this as a notice (a coded one says it on its card): an app from before 0.9 (TIN-885).
  assert.equal(decisionNotice("pairing_code_required"), "This app uses an older APC version that has no pairing code, so it was not paired. Ask its maker to update it, and Deny this request.");
  assert.doesNotMatch(decisionNotice("pairing_code_required"), /pairing_code_required/, "never the raw code");
});

test("rendered: a request with a code on the dock's page asks for it in one labelled field; Deny first, Allow off until a code is typed, neither the default", () => {
  const html = renderRequest({ code: true });
  assert.equal((html.match(/<input/g) ?? []).length, 1, "one field, not six");
  const label = html.match(/<label for="([^"]+)">Code from Orders<\/label>/);
  assert.ok(label && html.includes(`<input id="${label[1]}"`), "the field has its label");
  assert.match(html, /maxLength="9"/);
  assert.match(html, /autoComplete="off"/);
  assert.match(html, /spellCheck="false"/);
  assert.match(html, /aria-describedby="[^"]+-hint [^"]+-error"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Type the code shown in Orders\./);
  assert.match(html, /It is on Orders&#x27; screen, where you allowed the agent\. If you didn&#x27;t just do that, Deny\./);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /class="primary"/, "no default answer on a card with a code");
  assert.ok(html.indexOf(">Deny<") < html.indexOf(">Allow<"), "Deny first");
  assert.deepEqual(buttons(html), { Deny: false, Allow: true }, "Allow waits for the code");
  assert.deepEqual(buttons(renderRequest({ code: true, inFlight: "deny" })), { Deny: true, Allow: true });
  // The card's own error: said under the field, for the person to try again.
  assert.match(renderRequest({ code: true, error: { error: "wrong_pairing_code", attempts_left: 2, at: 1 } }), /aria-live="polite">Wrong code\. 2 tries left\.</);
});

test("rendered: while the hub is approving, every surface says connecting and takes no code: no field, no Allow, Deny on (APC 0.10)", () => {
  const unverified = { declared: "Pulse", warning: false };
  for (const props of [{ entry: "field" }, { entry: "field", code: true }, { entry: "dock", code: true }, { entry: "field", unverified, host: "evil.example", app: "evil.example" }]) {
    const html = renderRequest({ ...props, approving: true });
    assert.doesNotMatch(html, /<input/, "no field to type a code in");
    assert.deepEqual(buttons(html), { Deny: false }, "Deny only, and on");
    assert.match(html, /role="status"[^>]*>Connecting to (Orders|evil\.example)…</);
    assert.doesNotMatch(html, /Type the code/);
  }
  assert.match(renderRequest({ approving: true, unverified, host: "evil.example", app: "evil.example" }), /Not verified/, "an unverified app keeps its badge");
  assert.deepEqual(buttons(renderRequest({ code: true, approving: true, inFlight: "deny" })), { Deny: true });
  // A reader has no introduction: its card is unchanged.
  assert.deepEqual(buttons(renderRequest({ kind: "reader" })), { Allow: false, Deny: false });
  // The hub's answer to a code typed in that window is not a wrong code and not a failure to show.
  assert.equal(isCodeRetryError("approving"), false);
  assert.equal(isConnectingAnswer("approving"), true);
  assert.equal(isConnectingAnswer("wrong_pairing_code"), false);
  assert.doesNotMatch(decisionNotice("approving"), /That did not go through|Wrong code/);
  assert.match(decisionNotice("pairing_ended"), /Drop your agent on the app again\.$/);
});

test("rendered: Float, the strip and the pets show no field and no Allow for a request with a code, and today's buttons without one", () => {
  const coded = renderRequest({ entry: "dock", code: true });
  assert.doesNotMatch(coded, /<input/);
  assert.equal(buttons(coded).Allow, undefined, "no Allow");
  assert.deepEqual(buttons(coded), { Deny: false });
  assert.ok(coded.includes(CODE_IN_DOCK), "where to type it");
  assert.match(renderRequest({ entry: "dock", code: true, openDock: () => {} }), /class="primary open-dock"[^>]*>Open the dock</, "the pets open the dock, with a button that is hard to miss");
  const legacy = renderRequest({ entry: "dock" });
  assert.deepEqual(buttons(legacy), { Allow: false, Deny: false }, "a request without a code keeps its buttons");
  assert.match(legacy, /class="primary"[^>]*>Allow</);
  assert.equal(renderRequest({ entry: "field" }), legacy, "the same on every surface");
  // A reader never has a code.
  assert.doesNotMatch(renderRequest({ kind: "reader", code: true }), /<input/);
});

test("rendered: an unverified app's warning keeps Deny first, then the field; on Float its Approve gives way to the note", () => {
  const unverified = { declared: "Pulse", warning: true };
  const field = renderRequest({ code: true, unverified, host: "evil.example", app: "evil.example" });
  assert.ok(field.indexOf("<input") > field.indexOf("Not verified"), "the warning first");
  assert.deepEqual(buttons(field), { Deny: false, Approve: true }, "Approve waits for the code");
  assert.match(field, /class="primary"[^>]*>Deny</, "Deny stays the default");
  const dock = renderRequest({ entry: "dock", code: true, unverified, host: "evil.example", app: "evil.example" });
  assert.deepEqual(buttons(dock), { Deny: false });
  assert.ok(dock.includes(CODE_IN_DOCK));
  // Approved before in this dock: the short card, with the field.
  assert.deepEqual(buttons(renderRequest({ code: true, unverified: { declared: null, warning: false }, host: "evil.example", app: "evil.example" })), { Deny: false, Allow: true });
});
