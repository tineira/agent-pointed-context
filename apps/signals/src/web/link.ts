/**
 * Signals' address (TIN-621): ?post= opens the feed on one post, ?kind= and ?month= set the filters. No
 * browser APIs here, so the tests run it.
 */
import { MONTHS } from "../../../demo/src/model/seed.ts";
import type { Post } from "../../../demo/src/model/market.ts";

export const KIND_TABS = ["competitor_offer", "our_ad"] as const;

export interface FeedLink {
  kind: "" | Post["kind"];
  month: string;
  post: string | null;
}

/** Whether the filters show this post. */
export function shows(link: Pick<FeedLink, "kind" | "month">, post: Post): boolean {
  return (!link.kind || post.kind === link.kind) && (!link.month || post.month === link.month);
}

/**
 * What a link opens. A post the link names is always shown: a filter that would hide it is dropped, so the
 * person sees what was shared and the view the agents read says the same.
 */
export function readFeedLink(search: string, posts: readonly Post[]): FeedLink {
  const q = new URLSearchParams(search);
  const kind = q.get("kind");
  const month = q.get("month");
  const id = q.get("post");
  const link: FeedLink = {
    kind: (KIND_TABS as readonly (string | null)[]).includes(kind) ? (kind as Post["kind"]) : "",
    month: month && MONTHS.includes(month) ? month : "",
    post: null,
  };
  const post = id ? posts.find((p) => p.id === id) : undefined;
  if (!post) return link;
  return {
    kind: !link.kind || post.kind === link.kind ? link.kind : "",
    month: !link.month || post.month === link.month ? link.month : "",
    post: post.id,
  };
}

/** The address for a feed link, keeping any other parameter (?connect) and dropping an old ?seed= (TIN-621). */
export function feedSearch(search: string, link: FeedLink): string {
  const q = new URLSearchParams(search);
  for (const key of ["seed", "kind", "month", "post"]) q.delete(key);
  if (link.kind) q.set("kind", link.kind);
  if (link.month) q.set("month", link.month);
  if (link.post) q.set("post", link.post);
  return q.size ? `?${q}` : "";
}
