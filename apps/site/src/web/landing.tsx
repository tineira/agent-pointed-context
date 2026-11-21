/**
 * The landing of apc.tineira.com: split into one component file per section plus a HeroStage
 * placeholder so subsequent redesign steps can edit each area independently.
 */
import { AccessSection } from "./landing/AccessSection.tsx";
import { HeroSection } from "./landing/HeroSection.tsx";
import { HowItWorksSection } from "./landing/HowItWorksSection.tsx";
import { PathsSection } from "./landing/PathsSection.tsx";
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
        <main className="landing">
          <HeroSection />
          <WorksWithSection />
          <PathsSection />
          <HowItWorksSection />
          <AccessSection />
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
