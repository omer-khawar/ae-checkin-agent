/**
 * Sticky glass header for the public landing page.
 * Original work (no 21st.dev source): brand, in-page anchors, the two entry
 * points (kiosk, staff sign in) and the GitHub link.
 */
import { Github } from "lucide-react";
import { Link } from "react-router-dom";

import { LINKS, NAV, ROUTES } from "../content";
import { ButtonLink } from "../primitives";

export function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-[13px] font-bold text-primary-foreground"
    >
      I
    </span>
  );
}

export function SiteHeader() {
  return (
    <header
      className="sticky z-40 px-3 pt-3 sm:px-4"
      style={{ top: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="glass mx-auto flex max-w-6xl items-center gap-3 rounded-full py-2 pl-4 pr-2 sm:gap-6">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-full text-base font-semibold tracking-tight text-foreground"
        >
          <BrandMark />
          Interim
        </Link>

        <nav aria-label="Landing page sections" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noopener noreferrer"
            className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Github aria-hidden="true" className="h-[18px] w-[18px]" />
            <span className="sr-only">Interim on GitHub (opens in a new tab)</span>
          </a>
          <ButtonLink to={ROUTES.kiosk} variant="secondary" size="sm" className="hidden sm:inline-flex">
            Try the patient kiosk
          </ButtonLink>
          <ButtonLink to={ROUTES.login} size="sm">
            Staff sign in
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}
