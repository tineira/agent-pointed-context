import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarket } from "../../demo/src/model/market.ts";
import { generateDataset } from "../../demo/src/model/seed.ts";
import { checkPin, focusPayload, listPosts, postAnswer, sanitizeView, viewPayload } from "../src/worker/logic.ts";

const posts = buildMarket(generateDataset(42)).posts;
const ad = posts.find((p) => p.kind === "our_ad")!;
const offer = posts.find((p) => p.kind === "competitor_offer")!;

test("a pin is a post or one of its parts; a code only on our ads (TIN-384)", () => {
  assert.ok("target" in checkPin({ kind: "post", id: offer.id }, posts));
  assert.ok("target" in checkPin({ kind: "post", id: offer.id, part: "audience" }, posts));
  assert.ok("target" in checkPin({ kind: "post", id: ad.id, part: "code" }, posts));
  assert.deepEqual(checkPin({ kind: "post", id: offer.id, part: "code" }, posts), { error: "invalid_target" });
  assert.deepEqual(checkPin({ kind: "post", id: "post_999" }, posts), { error: "not_found" });
  assert.deepEqual(checkPin({ kind: "post", id: ad.id, params: { note: "x" } }, posts), { error: "invalid_target" }, "a post pin keeps no params");
  assert.deepEqual(checkPin({ kind: "customer", id: "cus_0001" }, posts), { error: "invalid_target" });
});

test("the focus reads with get_post and says which part", () => {
  const row = { grant_id: "g", kind: "post", id: ad.id, part: "code", params: null, pinned_at: "2026-10-25T00:00:00.000Z", seen_at: null };
  const f = focusPayload(row, posts, "https://s");
  assert.equal(f?.next, "get_post");
  assert.deepEqual(f?.next_args, { id: ad.id });
  assert.match(f?.part_note ?? "", /promo code/);
  assert.equal(focusPayload({ ...row, id: "post_999" }, posts, "https://s")?.gone, true);
});

test("the view keeps only known filters and posts", () => {
  const v = sanitizeView({ screen: "feed", params: { kind: "our_ad", month: "2026-03", note: "x" }, selection: { kind: "post", id: ad.id } }, posts, new Date(0));
  assert.deepEqual(v?.params, { kind: "our_ad", month: "2026-03" });
  assert.equal(sanitizeView({ screen: "admin" }, posts), null);
  assert.equal(sanitizeView({ screen: "feed", selection: { kind: "post", id: "post_999" } }, posts)?.selection, null);
  assert.equal(viewPayload(v, "https://s", 0)?.next, "get_post");
});

test("posts read back whole, and list by kind and month", () => {
  const a = postAnswer(posts, ad.id, "https://s");
  assert.ok(!("error" in a) && a.post.kind === "our_ad" && ad.kind === "our_ad" && a.post.code === ad.code);
  assert.equal(listPosts(posts, { kind: "our_ad" }).rows.every((r) => r.kind === "our_ad"), true);
  assert.equal(listPosts(posts, { month: ad.month }).rows.some((r) => r.id === ad.id), true);
});
