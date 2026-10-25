/**
 * How each author looks in the feed (TIN-386): a brand avatar, a handle, a domain on .example and a
 * call to action. All fictional; Pulse is the demo's own product.
 */
import type { Post } from "../../../demo/src/model/market.ts";

interface Brand {
  handle: string;
  domain: string;
  color: string;
  cta: string;
  glyph: React.ReactNode;
}

const BRANDS: Record<string, Brand> = {
  Pulse: {
    handle: "pulse",
    domain: "pulse.example",
    color: "#b85209",
    cta: "Start free",
    glyph: (
      <>
        <rect x="9" y="11" width="22" height="22" rx="6" fill="none" stroke="#fff" strokeWidth="3" />
        <circle cx="30" cy="12" r="5" fill="#fff" />
      </>
    ),
  },
  Tallyfin: {
    handle: "tallyfin",
    domain: "tallyfin.example",
    color: "#0f766e",
    cta: "Switch now",
    glyph: (
      <g stroke="#fff" strokeWidth="3" strokeLinecap="round">
        <path d="M12 11v18M18 11v18M24 11v18M30 11v18M9 27l24-14" />
      </g>
    ),
  },
  Northloop: {
    handle: "northloop",
    domain: "northloop.example",
    color: "#1e3a8a",
    cta: "Claim offer",
    glyph: (
      <>
        <circle cx="20" cy="20" r="11" fill="none" stroke="#fff" strokeWidth="2.5" />
        <path d="M20 11.5l4 10h-8z" fill="#fff" />
      </>
    ),
  },
  Usagewise: {
    handle: "usagewise",
    domain: "usagewise.example",
    color: "#7c3aed",
    cta: "Get the deal",
    glyph: (
      <g fill="#fff">
        <rect x="10" y="20" width="5" height="10" rx="1.5" />
        <rect x="17.5" y="14" width="5" height="16" rx="1.5" />
        <rect x="25" y="9" width="5" height="21" rx="1.5" />
      </g>
    ),
  },
};

export function brandOf(author: string): Brand {
  return BRANDS[author] ?? { handle: author.toLowerCase().replace(/\W/g, ""), domain: `${author.toLowerCase().replace(/\W/g, "")}.example`, color: "#475569", cta: "Learn more", glyph: null };
}

export function Avatar({ author, size = 40 }: { author: string; size?: number }) {
  const b = brandOf(author);
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={author} className="avatar">
      <circle cx="20" cy="20" r="20" fill={b.color} />
      {b.glyph}
    </svg>
  );
}

export function Verified() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-label="Verified business" className="verified">
      <path fill="currentColor" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.33-2.19c1.4.46 2.91.2 3.92-.81s1.26-2.52.8-3.91c1.32-.67 2.2-1.91 2.2-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z" />
    </svg>
  );
}

/** Small deterministic numbers per post, so the counts are the same on every visit. */
export function stats(post: Post, seed: number) {
  let h = seed >>> 0;
  for (const ch of post.id) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0;
  const r = (n: number) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    return h % n;
  };
  const views = 4_000 + r(180_000);
  return { views, likes: Math.round(views * (0.004 + r(20) / 1000)), reposts: Math.round(views * (0.0006 + r(4) / 1000)), replies: Math.round(views * (0.0003 + r(3) / 1000)), day: 1 + r(27) };
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** Line icons for the engagement row. */
const ICON: Record<string, string> = {
  reply: "M8 10h8M8 14h5M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z",
  repost: "M7 7h10l-3-3M17 17H7l3 3M17 7v6M7 17v-6",
  like: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  views: "M5 20V11M10 20V5M15 20v-7M20 20V9",
};
export function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON[name]} />
    </svg>
  );
}
