/**
 * The landing of apc.tineira.com (TIN-1067): the hero (with its stage, HeroStage), Works with, the two paths, Inside a
 * point, Your agent. Your permission., Free, open and versioned, and the closing call. One component file per section.
 */
import { AccessSection } from "./landing/AccessSection.tsx";
import { ClosingSection } from "./landing/ClosingSection.tsx";
import { HeroSection } from "./landing/HeroSection.tsx";
import { HowItWorksSection } from "./landing/HowItWorksSection.tsx";
import { PathsSection } from "./landing/PathsSection.tsx";
import { STANDARD_LINKS, StandardSection } from "./landing/StandardSection.tsx";
import { WorksWithSection } from "./landing/WorksWithSection.tsx";
import { useScrollReveals } from "./reveal.ts";
import { SiteBackdrop, SiteFooter, SiteHeader } from "./site.tsx";

export function Landing() {
  useScrollReveals();
  return (
    <div className="site-shell">
      <SiteBackdrop />
      <div className="site-page">
        <SiteHeader page="landing" />
        <main className="landing landing-home">
          <HeroSection />
          <WorksWithSection />
          <PathsSection />
          <HowItWorksSection />
          <AccessSection />
          <StandardSection />
          <ClosingSection />
        </main>
        <SiteFooter onPage={STANDARD_LINKS} />
      </div>
    </div>
  );
}
