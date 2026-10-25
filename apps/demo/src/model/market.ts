/**
 * The market around Pulse's fictional SaaS (TIN-384), for Signals, the second APC app: competitor
 * offers and our own ads, deterministic from the sandbox's seed so they line up with that
 * sandbox's churn and signups. Pulse's v2 deploy and Signals both build it from the same Dataset.
 *
 * Nothing here ties a person to an ad they saw: nobody can know that. A competitor offer names
 * the segment it targets (region, plan) and when it ran; the join with churn is by segment and
 * month. Our ads carry a promo code, and a customer who signed up with one has it as signup_code:
 * that join is customer by customer, as with a real attribution code.
 */
import { MONTHS, PLANS, prng, REGIONS, type Dataset, type Plan, type Region } from "./seed.ts";

export const COMPETITORS = ["Tallybird", "Northbeam Metrics", "Usagely"] as const;
export const CHANNELS = ["search", "social", "newsletter", "podcast"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Where each post's parts are, for pointing: the offer, its audience, a code, or the text. */
export const POST_PARTS = ["offer", "audience", "code", "text"] as const;
export type PostPart = (typeof POST_PARTS)[number];

export interface CompetitorOffer {
  id: string;
  kind: "competitor_offer";
  author: string;
  /** The month it was posted; it runs from that month to ends_month. */
  month: string;
  ends_month: string;
  audience: { region: Region; plan: Plan };
  offer: string;
  text: string;
}

export interface OurAd {
  id: string;
  kind: "our_ad";
  author: "Pulse";
  month: string;
  channel: Channel;
  code: string;
  audience: { region: Region | null };
  offer: string;
  text: string;
}

export type Post = CompetitorOffer | OurAd;

export interface Market {
  posts: Post[];
  /** A customer's promo code at signup, when they used one. Only customers who signed up inside the window. */
  signupCodes: Map<string, string>;
}

const REGION_NAME: Record<Region, string> = { latam: "Latin America", na: "North America", emea: "Europe" };
const PLAN_NAME: Record<Plan, string> = { starter: "Starter", team: "Team", business: "Business" };
const OFFERS = ["50% off for 6 months", "3 months free", "free migration and 40% off the first year", "your first 10 seats free"];
const AD_OFFERS = ["20% off the first 3 months", "a free onboarding call", "30 days free on Team", "double the seats for 2 months"];
const MONTH_CODE = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Churned customers per segment and month: active the month before, not active that month. */
export function churnBySegment(data: Dataset): Map<string, number> {
  const status = new Map(data.activity.map((a) => [`${a.customer_id}|${a.month}`, a.active]));
  const out = new Map<string, number>();
  for (const c of data.customers) {
    for (let m = 1; m < MONTHS.length; m++) {
      if (status.get(`${c.id}|${MONTHS[m - 1]}`) === true && status.get(`${c.id}|${MONTHS[m]}`) === false) {
        const key = `${c.region}|${c.plan}|${MONTHS[m]}`;
        out.set(key, (out.get(key) ?? 0) + 1);
      }
    }
  }
  return out;
}

export function buildMarket(data: Dataset): Market {
  // A stream of its own: the dataset's numbers never move.
  const rand = prng((data.seed ^ 0x51a7) >>> 0);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const posts: Post[] = [];

  // Competitor offers: one before each of the worst churn spikes (posted the month before), plus noise.
  const churn = churnBySegment(data);
  const spikes = [...churn.entries()]
    .map(([key, n]) => ({ key, n, month: key.split("|")[2]! }))
    .filter((s) => s.n >= 2 && MONTHS.indexOf(s.month) >= 2)
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
    .slice(0, 5);
  const offerAt = (region: Region, plan: Plan, monthIndex: number) => {
    const author = pick(COMPETITORS);
    const offer = pick(OFFERS);
    posts.push({
      id: "",
      kind: "competitor_offer",
      author,
      month: MONTHS[monthIndex]!,
      ends_month: MONTHS[Math.min(MONTHS.length - 1, monthIndex + 1)]!,
      audience: { region, plan },
      offer,
      text: `Still on Pulse? ${PLAN_NAME[plan]} teams in ${REGION_NAME[region]}: switch to ${author} and get ${offer}. We move your history for you.`,
    });
  };
  for (const s of spikes) {
    const [region, plan] = s.key.split("|") as [Region, Plan];
    offerAt(region, plan, MONTHS.indexOf(s.month) - 1);
  }
  for (let i = 0; i < 4; i++) offerAt(pick(REGIONS), pick(PLANS), 1 + Math.floor(rand() * (MONTHS.length - 2)));

  // Our ads: in the months with the most signups, each with its code; some of those signups used it.
  const signups = new Map<string, string[]>();
  for (const c of data.customers) if (c.signup_month !== MONTHS[0]) signups.set(c.signup_month, [...(signups.get(c.signup_month) ?? []), c.id]);
  const adMonths = [...signups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 5);
  const signupCodes = new Map<string, string>();
  for (const [month, ids] of adMonths) {
    const channel = pick(CHANNELS);
    const code = `${channel.slice(0, 3).toUpperCase()}${MONTH_CODE[Number(month.slice(5)) - 1]}${month.slice(2, 4)}`;
    const offer = pick(AD_OFFERS);
    const region = rand() < 0.5 ? pick(REGIONS) : null;
    posts.push({
      id: "",
      kind: "our_ad",
      author: "Pulse",
      month,
      channel,
      code,
      audience: { region },
      offer,
      text: `Know who is really using your product. Pulse shows active customers, seats and churn${region ? ` for teams in ${REGION_NAME[region]}` : ""}. Use ${code} for ${offer}.`,
    });
    for (const id of ids) {
      const c = data.customers.find((x) => x.id === id)!;
      if ((!region || c.region === region) && rand() < 0.6) signupCodes.set(id, code);
    }
  }

  posts.sort((a, b) => a.month.localeCompare(b.month) || a.kind.localeCompare(b.kind));
  posts.forEach((p, i) => (p.id = `post_${String(i + 1).padStart(3, "0")}`));
  return { posts, signupCodes };
}
