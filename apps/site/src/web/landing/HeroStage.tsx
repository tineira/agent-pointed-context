/**
 * HeroStage placeholder: keeps the silent self-hosted hero clip (and reduced-motion poster
 * fallback) until the interactive Pulse hero stage replaces it.
 */
import { useEffect, useState } from "react";
import { clipFallback, type ClipError } from "../clip-fallback.ts";

/**
 * The hero clip: rendered from the November 2026 promo's own Remotion scene, silent, without
 * captions; served from the site's assets (public/media) with their usual headers. Never a YouTube
 * embed: its cookies would break the one-cookie promise.
 */
const CLIP = { webm: "/media/apc-hero.webm", mp4: "/media/apc-hero.mp4", poster: "/media/apc-hero-poster.jpg", width: 1280, height: 640 };
const CLIP_ALT = "An agent is dragged onto the March bar of a revenue chart. Asked what is behind the bar, it reads every customer in it and answers: $41,200 from 38 customers.";

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
export function HeroStage() {
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
