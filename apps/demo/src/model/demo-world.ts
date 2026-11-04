/**
 * The demo's one shared world (TIN-621): every visitor's Pulse and Signals show the data of DEMO_SEED,
 * already linked (the same customers and ids in both), so each app opens on its own, by its own link, in
 * any order. All the demo's tools only read, so a shared dataset is safe; what stays per person is in
 * each app's sandbox (agents, consent, pairings, pins, view).
 */
import { DEMO_SEED, generateDataset, type Dataset } from "./seed.ts";
import { buildMarket, type Market } from "./market.ts";

let dataset: Dataset | null = null;
let market: Market | null = null;

/** Pulse's data in the demo world. Shared: never mutate it. */
export function demoDataset(): Dataset {
  return (dataset ??= generateDataset(DEMO_SEED));
}

/** Signals' posts (and the signup codes Pulse shows) in the demo world. Shared: never mutate it. */
export function demoMarket(): Market {
  return (market ??= buildMarket(demoDataset()));
}

/**
 * The question across both apps that works every time (TIN-621), written in the apps' how-to: a
 * competitor's offer in Signals and the Pulse customers it took. Tallyfin's post targets Team teams in
 * North America in Aug and Sep 2026; in Sep 2026 five of Pulse's eight churned customers are Team teams
 * in North America, Deep Harbor Logistics the largest. A test checks it holds (demo-world.test.ts).
 */
export const CROSS_APP = {
  /** Signals: the competitor's post, and its author. */
  post: "post_013",
  competitor: "Tallyfin",
  offer: "your first 10 seats free",
  /** Who it targets, and the month the churn shows in Pulse. */
  region: "na",
  plan: "team",
  month: "2026-09",
  /** Pulse: the largest customer it took. */
  customer: "cus_0048",
  customerName: "Deep Harbor Logistics",
  /** The Team customers in North America that churned that month. */
  churned: ["cus_0048", "cus_0138", "cus_0144", "cus_0150", "cus_0162"],
  question: "Which of our customers did this offer take?",
} as const;

/** The deep links to share (TIN-621): a customer in Pulse, a post in Signals. Stable: the world never changes. */
export const pulseCustomerPath = (id: string) => `/customers/${id}`;
export const signalsPostPath = (id: string) => `/?post=${id}`;
