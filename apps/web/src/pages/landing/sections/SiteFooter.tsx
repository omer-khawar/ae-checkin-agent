/**
 * Footer: brand + the not-a-medical-device sentence (verbatim) on the left,
 * navigation on the right, credits and license below.
 *
 * Adapted from "Minimal Two-Column Footer" (footer-17) by ln-dev7 on 21st.dev
 * (https://21st.dev/ln-dev7/footer-17). Changes: placeholder logo and links
 * replaced by ours; tagline replaced by the disclaimer; copyright line replaced
 * by credits and the MIT license; Tailwind 3.4 with our palette.
 */
import { Link } from "react-router-dom";

import { CREDITS, DISCLAIMER, LINKS, NAV, ROUTES } from "../content";
import { BrandMark } from "./SiteHeader";

// min-h-6: standalone links get a 24px target (WCAG 2.5.8).
const linkClass =
  "inline-flex min-h-6 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface/70 px-4 sm:px-6">
      <div className="mx-auto max-w-6xl py-14 sm:py-16">
        <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex max-w-md flex-col gap-4">
            <Link
              to="/"
              className="inline-flex w-fit items-center gap-2 font-brand text-lg font-extrabold tracking-tight text-foreground"
            >
              <BrandMark />
              Interim
            </Link>
            <p
              className="text-sm font-medium leading-relaxed text-foreground"
              data-testid="landing-disclaimer"
            >
              {DISCLAIMER}
            </p>
          </div>

          <nav aria-label="Footer" className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Navigate
            </h2>
            <ul className="grid grid-cols-2 gap-x-10 gap-y-2">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className={linkClass}>
                    {item.label}
                  </a>
                </li>
              ))}
              <li>
                <Link to={ROUTES.kiosk} className={linkClass}>
                  Patient kiosk
                </Link>
              </li>
              <li>
                <Link to={ROUTES.login} className={linkClass}>
                  Staff sign in
                </Link>
              </li>
              <li>
                <a
                  href={LINKS.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={linkClass}
                >
                  GitHub<span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-start sm:justify-between sm:gap-10">
          <p className="max-w-2xl">{CREDITS}</p>
          <p className="shrink-0">
            <a href={LINKS.license} target="_blank" rel="noopener noreferrer" className={linkClass}>
              MIT license<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
