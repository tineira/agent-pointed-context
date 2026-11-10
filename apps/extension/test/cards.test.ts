import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The consent card and the notes in the page (TIN-786) live in content.ts, which needs a page to run: these read
 * its source for the orders a page cannot see, and the extension e2e (--consent) drives the behaviour.
 */
const source = readFileSync(new URL("../src/content.ts", import.meta.url), "utf8");
/** A function's body, from its name to the first line that closes it at the left margin (or at two spaces, for those inside listen). */
const body = (start: string, indent = ""): string => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `${start} is in content.ts`);
  const end = source.indexOf(`\n${indent}}`, at);
  return source.slice(at, end);
};

test("a sending click checks the outline, then sends the drop's own reading in the same task (TIN-786)", () => {
  const ask = body("function ask(");
  const click = ask.slice(ask.indexOf("const answer = (consent"), ask.indexOf("for (const [consent, label] of choices)"));
  assert.doesNotMatch(click, /\bawait\b|\.then\(|setTimeout|queueMicrotask/, "nothing between the check and sendMessage");
  assert.match(click, /if \(q\.node && !\(shows\(q\.node\) && sameOutline\(q\.node, q\.pointed, q\.reading\)\)\) return q\.end\("changed"\);\s*q\.end\("answered"\);\s*send\(consent\);/);
  // Never sends nothing: it is not checked, and it waits for the service worker with every button off.
  assert.match(click, /if \(consent === "never"\) \{\s*\/\/[^\n]*\n\s*disarmed = true;\s*for \(const b of buttons\) b\.disabled = true;\s*send\("never"\);/);
  // send posts the reading the drop took, synchronously: sendMessage is its first call.
  const send = body("const send = (consent?: Consent): void => {", "    ");
  assert.match(send, /\{\s*chrome\.runtime\s*\.sendMessage<Reply>\(\{ type: "drop", id, drag: [^}]+\}, reading,/);
  assert.doesNotMatch(send, /\bawait\b|readAt|readOutlined/);
});

test("the service worker's answer opens a card only for the open question, and only on an unchanged outline, in one task (TIN-786)", () => {
  const answer = body("const answer = (r: Reply | null) => {", "    ");
  assert.doesNotMatch(answer, /\bawait\b|\.then\(|async/);
  // A card answer for a question a drag closed: nothing shows, and the held reading goes.
  assert.match(answer, /if \(q\.state !== "waiting"\) \{[\s\S]*?if \(q\.state === "closed"\) forgetHeld\(id\);\s*return;\s*\}/);
  assert.match(answer, /if \(q\.node && !\(shows\(q\.node\) && sameOutline\(q\.node, q\.pointed, q\.reading\)\)\) \{[\s\S]*?return q\.end\("changed"\);\s*\}\s*return ask\(q, status, r!, send\);/);
  // Any other answer is that drop's outcome, drawn whatever happened to the question.
  assert.match(answer, /q\.end\("settled"\);\s*if \(status !== "asking"\) pending\.delete\(id\);\s*sent\(r \?\? \{ status \}, target, id\);/);
});

test("a question starts at the drop; an agent's drag or a pin's closes it before the outline moves (TIN-786)", () => {
  const drop = body("const onPageDrop = ", "  ");
  assert.ok(drop.indexOf("openQuestion(") < drop.indexOf("send();"), "the question exists before the service worker is asked");
  const over = body("const onDragover = ", "  ");
  assert.ok(over.indexOf("newDrag();") >= 0 && over.indexOf("newDrag();") < over.indexOf("light(scopeAt("), "dragover closes it before light");
  assert.match(source, /if \(!e\.isTrusted \|\| !carriesAgent\(e\)\) return;\s*\/\/[^\n]*\n\s*newDrag\(\);/, "dragenter, for an agent's trusted drag only");
  assert.match(source, /if \(!down\.isTrusted \|\| down\.button !== 0\) return;\s*\/\/[^\n]*\n\s*closeQuestion\?\.\(\);\s*down\.preventDefault\(\);/, "a pin's drag, before its outline");
  // Until the question ends, nothing else takes the drop's outline away.
  assert.match(source, /if \(!e\.relatedTarget && !holding\(\)\) light\(null\);/);
  // The ring stays for the question; what was found about the charts does not (the e2e's step 12 drags a re-rendered chart).
  assert.match(source, /window\.addEventListener\("dragend", \(\) => \{\s*forgetScopes\(\);\s*if \(holding\(\)\) return;/);
  // Only a card answer forgets the held reading when a drag closed the question first (nothing was sent then).
  // ... and with it the drop's place, since nothing more can come for it (Gemini's review on #155).
  assert.match(source, /if \(how === "dismiss" \|\| how === "changed" \|\| \(how === "drag" && was === "open"\)\) \{\s*\/\/[^\n]*\n\s*forgetHeld\(id\);\s*pending\.delete\(id\);/);
});

test("Include clears only its own timer before it sends, and the Sent word comes only from a sent answer (TIN-786)", () => {
  const offer = body("function offerInclude(");
  assert.match(offer, /yes\.addEventListener\("click", \(ev\) => \{\s*if \(!ev\.isTrusted\) return;\s*\/\/[^\n]*\n\s*clearTimeout\(timer\);\s*end\(\);\s*include\(\);/);
  assert.match(offer, /Math\.max\(0, Math\.min\(30_000, holdUntil - Date\.now\(\)\)\)/);
  assert.match(offer, /shown\.card\?\.kind === "waiting" && shown\.card\.id !== id \? "note" : "card"/, "beside another drop's waiting card, a note");
  const sent = body("function sent(");
  assert.match(sent, /if \(r\.status !== "sent"\) return say\(r\.status, point\);/);
  assert.ok(sent.indexOf("sentWord(") > sent.indexOf('if (r.status !== "sent")'));
  // A word from the service worker about a drop this page does not know draws nothing.
  assert.match(source, /const target = msg\.id \? pending\.get\(msg\.id\) : undefined;\s*if \(!target\) return;/);
});

test("the agent's name is a text node between isolates, never markup (TIN-786)", () => {
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML\s*=/);
  assert.match(body("function sentLine("), /document\.createTextNode\(SENT_TO\), document\.createTextNode\(name \? isolate\(name\) : AGENT_FALLBACK\)/);
});
