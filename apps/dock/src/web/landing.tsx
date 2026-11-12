/**
 * The landing of apc.tineira.com (TIN-420, TIN-605, TIN-620, TIN-627): what APC is, from the hero alone (a line
 * and a short silent clip of the drag), the agents it works with, then one decision: Try it (/try, for people
 * using an AI agent) or Build it (/build, for people building an app). "What your agent can and cannot see" closes
 * it. Everyone sees it (TIN-610); a visitor who already has a dock also gets "Your dock" in the top bar.
 */
import { useEffect, useState } from "react";
import { AgentIcon } from "../../../demo/src/web/agent-icon.tsx";
import { clipFallback, type ClipError } from "./clip-fallback.ts";
import { SiteFooter, SiteHeader } from "./site.tsx";
import { SITE_PAGES, VIDEO } from "./site-pages.ts";

/**
 * The hero clip: rendered from the November 2026 promo's own Remotion scene (the media repo), silent, without
 * captions; served from the dock's assets (public/media) with their usual headers. Never a YouTube embed: its
 * cookies would break the one-cookie promise.
 */
const CLIP = { webm: "/media/apc-hero.webm", mp4: "/media/apc-hero.mp4", poster: "/media/apc-hero-poster.jpg", width: 1280, height: 640 };
const CLIP_ALT = "An agent is dragged onto the March bar of a revenue chart. Asked what is behind the bar, it reads every customer in it and answers: $41,200 from 38 customers.";

/** The agents named under the hero, by their logos (products.ts). */
const AGENTS = [
  { brand: "claude", name: "Claude" },
  { brand: "openai", name: "ChatGPT" },
  { brand: "cursor", name: "Cursor" },
  { brand: "grok", name: "Grok" },
];

/** Whether the visitor asks for less motion, kept current. */
function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const on = () => setReduce(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, []);
  return reduce;
}

/** The muted loop of the drag; under reduced motion, its poster frame and no video at all. */
function HeroClip() {
  const reduce = useReducedMotion();
  // The button follows the video itself: a blocked autoplay leaves it paused, and the button then says Play.
  const [paused, setPaused] = useState(true);
  const [failed, setFailed] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!video) return;
    // React sets `muted` as a property only; some browsers autoplay only with the attribute.
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    setPaused(video.paused);
    if (video.paused) void video.play().catch(() => undefined);
  }, [video]);
  const fallBack = (error: ClipError) => {
    const next = clipFallback(error);
    if (next === "poster") setFailed(true);
    else if (next === "mp4" && video) {
      video.src = CLIP.mp4;
      void video.play().catch(() => undefined);
    }
  };
  return (
    <figure className="landing-stage">
      {reduce || failed ? (
        <img src={CLIP.poster} width={CLIP.width} height={CLIP.height} alt={CLIP_ALT} />
      ) : (
        <>
          <video
            ref={setVideo}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster={CLIP.poster}
            width={CLIP.width}
            height={CLIP.height}
            aria-label={CLIP_ALT}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
            // React bubbles a <source>'s error up to here, unlike the DOM: only the video's own error counts.
            onError={(e) => e.target === e.currentTarget && fallBack({ on: "video", currentSrc: e.currentTarget.currentSrc })}
          >
            <source src={CLIP.webm} type="video/webm" onError={() => fallBack({ on: "source", last: false })} />
            <source src={CLIP.mp4} type="video/mp4" onError={() => fallBack({ on: "source", last: true })} />
          </video>
          <button type="button" className="landing-stage-toggle" onClick={() => (video?.paused ? void video.play().catch(() => undefined) : video?.pause())}>
            {paused ? "Play animation" : "Pause animation"}
          </button>
        </>
      )}
    </figure>
  );
}

export function Landing() {
  return (
    <main className="landing">
      <SiteHeader page="landing" />

      <section className="landing-hero">
        <h1>Point your AI agent at what you see</h1>
        <p className="landing-lede">
          Drag your agent onto a chart, a row or a paragraph and ask about "this". It reads the data underneath, through access it already has. No screen sharing.
        </p>
        <HeroClip />
        <a className="landing-watch" href={VIDEO}>
          <span aria-hidden="true">▶</span> Watch the full video
        </a>
        <ul className="landing-agents" aria-label="Works with">
          {AGENTS.map((a) => (
            <li key={a.brand}>
              <span aria-hidden="true">
                <AgentIcon clientName={null} brandId={a.brand} size={16} />
              </span>
              {a.name}
            </li>
          ))}
          <li>any agent that takes an MCP server</li>
        </ul>
      </section>

      <div className="landing-paths">
        <div className="landing-path">
          <span className="landing-who">For people using an AI agent</span>
          <h3>Try it</h3>
          <p>Use your own agent on two demo apps. A few minutes, made-up data, no account.</p>
          <div className="row">
            <a className="landing-cta" href={SITE_PAGES.try.path}>Try the demo →</a>
          </div>
        </div>
        <div className="landing-path">
          <span className="landing-who">For people building an app</span>
          <h3>Build it</h3>
          <p>Make your app pointable. It serves its own MCP endpoint, and what the person points at goes from your app to their agent.</p>
          <div className="row">
            <a className="landing-cta ghost" href={SITE_PAGES.build.path}>Add APC to your app →</a>
          </div>
        </div>
      </div>

      <section>
        <h2 className="landing-title">What your agent can and cannot see</h2>
        <ul className="landing-see">
          <li>Only what you pointed at, in apps you paired, after you allowed it in the app and in the dock.</li>
          <li>No screenshots and no screen sharing: each app answers with its own data, through its own tools.</li>
          <li>Each app keeps its data. The agent does the joining, in your conversation.</li>
          <li>You can remove an agent, an app or a computer from the dock at any time, and start over on every site.</li>
        </ul>
      </section>

      <SiteFooter />
    </main>
  );
}
