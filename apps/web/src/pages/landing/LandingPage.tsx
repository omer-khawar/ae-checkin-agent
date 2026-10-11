/**
 * Public landing page at "/" (the staff sign-in moved to "/login").
 *
 * Sections, top to bottom: glass header, hero with the real queue screenshot,
 * the problem (three sourced numbers), how it works (eight steps, one screen
 * each), what you get (bento), proof and honesty (generated eval numbers), FAQ,
 * footer with the not-a-medical-device sentence verbatim.
 *
 * All copy lives in ./content.ts. 21st.dev sources are credited in each section
 * file and in src/ui/CREDITS.md.
 */
import "./landing.css";

import { Faq } from "./sections/Faq";
import { Hero } from "./sections/Hero";
import { HowItWorks } from "./sections/HowItWorks";
import { Problem } from "./sections/Problem";
import { Proof } from "./sections/Proof";
import { SiteFooter } from "./sections/SiteFooter";
import { SiteHeader } from "./sections/SiteHeader";
import { WhatYouGet } from "./sections/WhatYouGet";

export function LandingPage() {
  return (
    <div data-surface="console" className="landing min-h-screen bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-foreground focus:shadow"
      >
        Skip to content
      </a>
      <div className="landing-wash">
        <SiteHeader />
        <main id="main">
          <Hero />
          <Problem />
          <HowItWorks />
          <WhatYouGet />
          <Proof />
          <Faq />
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}

export default LandingPage;
