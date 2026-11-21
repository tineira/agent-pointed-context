import { VIDEO } from "../site-pages.ts";
import { HeroStage } from "./HeroStage.tsx";

export function HeroSection() {
  return (
    <section className="landing-hero">
      <h1>Point your AI agent at what you see</h1>
      <p className="landing-lede">
        Drag your agent onto a chart, a row or a paragraph and ask about "this". It reads the data underneath, through access it already has. No screen sharing.
      </p>
      <HeroStage />
      <a className="landing-watch" href={VIDEO}>
        <span aria-hidden="true">▶</span> Watch the full video
      </a>
    </section>
  );
}
