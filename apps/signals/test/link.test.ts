/** Signals' address (TIN-621): a link to a post always shows it, and an old ?seed= goes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CROSS_APP, demoMarket } from "../../demo/src/model/demo-world.ts";
import { feedSearch, readFeedLink, shows } from "../src/web/link.ts";

const posts = demoMarket().posts;
const post = posts.find((p) => p.id === CROSS_APP.post)!;

test("a link to a post opens on it", () => {
  assert.deepEqual(readFeedLink(`?post=${CROSS_APP.post}`, posts), { kind: "", month: "", post: CROSS_APP.post });
  assert.deepEqual(readFeedLink("?post=post_999", posts), { kind: "", month: "", post: null });
});

test("a filter that would hide the linked post is dropped, so the post shows", () => {
  // post_013 was posted in Aug 2026 and runs into Sep: a Sep filter alone would hide it.
  assert.equal(post.month, "2026-08");
  const link = readFeedLink(`?month=2026-09&post=${CROSS_APP.post}`, posts);
  assert.deepEqual(link, { kind: "", month: "", post: CROSS_APP.post });
  assert.ok(shows(link, post));
  const wrongKind = readFeedLink(`?kind=our_ad&month=2026-08&post=${CROSS_APP.post}`, posts);
  assert.deepEqual(wrongKind, { kind: "", month: "2026-08", post: CROSS_APP.post });
  assert.ok(shows(wrongKind, post));
});

test("filters the linked post fits are kept, and filters alone apply as given", () => {
  assert.deepEqual(readFeedLink(`?kind=competitor_offer&month=2026-08&post=${CROSS_APP.post}`, posts), { kind: "competitor_offer", month: "2026-08", post: CROSS_APP.post });
  assert.deepEqual(readFeedLink("?kind=our_ad&month=2026-09", posts), { kind: "our_ad", month: "2026-09", post: null });
  assert.deepEqual(readFeedLink("?kind=nope&month=1999-01", posts), { kind: "", month: "", post: null });
});

test("the address keeps other parameters and drops an old dock link's seed", () => {
  assert.equal(feedSearch("?seed=7&connect", { kind: "", month: "", post: CROSS_APP.post }), `?connect=&post=${CROSS_APP.post}`);
  assert.equal(feedSearch("?seed=7", { kind: "", month: "", post: null }), "");
  assert.equal(feedSearch("", { kind: "competitor_offer", month: "2026-08", post: null }), "?kind=competitor_offer&month=2026-08");
});
