import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarket, churnBySegment } from "../src/model/market.ts";
import { generateDataset } from "../src/model/seed.ts";

test("the market is deterministic from the seed and leaves the dataset alone (TIN-384)", () => {
  const data = generateDataset(42);
  const before = JSON.stringify(data);
  const a = buildMarket(data);
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(buildMarket(generateDataset(42)).posts, a.posts);
  assert.notDeepEqual(buildMarket(generateDataset(43)).posts, a.posts);
  assert.ok(a.posts.every((p, i) => p.id === `post_${String(i + 1).padStart(3, "0")}`));
});

test("competitor offers come the month before real churn in their segment, with some noise", () => {
  for (const seed of [1, 42, 123456]) {
    const data = generateDataset(seed);
    const churn = churnBySegment(data);
    const offers = buildMarket(data).posts.filter((p) => p.kind === "competitor_offer");
    const explained = offers.filter((o) => (churn.get(`${o.audience.region}|${o.audience.plan}|${o.ends_month}`) ?? 0) >= 2);
    assert.ok(explained.length >= 3, `seed ${seed}: offers before a churn spike`);
    assert.ok(offers.length > explained.length, `seed ${seed}: and some that explain nothing`);
  }
});

test("a signup code belongs to a customer who signed up in that ad's month and region", () => {
  const data = generateDataset(7);
  const market = buildMarket(data);
  assert.ok(market.signupCodes.size > 5);
  for (const [id, code] of market.signupCodes) {
    const ad = market.posts.find((p) => p.kind === "our_ad" && p.code === code);
    const customer = data.customers.find((c) => c.id === id)!;
    assert.ok(ad && ad.kind === "our_ad");
    assert.equal(customer.signup_month, ad.month);
    if (ad.audience.region) assert.equal(customer.region, ad.audience.region);
  }
});
