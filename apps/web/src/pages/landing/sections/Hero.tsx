/**
 * Hero: headline, subhead, two calls to action and a real product screenshot.
 *
 * Adapted from "Hero with Product Mockup" by vaib215 on 21st.dev
 * (https://21st.dev/vaib215/hero-with-product-mockup). Changes: the drawn
 * desktop/phone mockups, rotated stacked windows, gradient background and hover
 * rotations are replaced by the real queue screenshot in a still glass frame;
 * shadcn Button swapped for our ButtonLink; Tailwind 3.4 with our palette.
 */
import { ArrowRight } from "lucide-react";

import { BrandDescriptor, BrandWaves } from "@/ui/brand";

import { HERO, ROUTES } from "../content";
import { ButtonLink, GlassPanel } from "../primitives";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative isolate px-4 pb-36 pt-12 sm:px-6 sm:pb-48 sm:pt-20 lg:pb-56"
    >
      <BrandWaves className="absolute inset-x-0 bottom-0 -z-10 h-36 w-full sm:h-48 lg:h-56" />
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,7fr)] lg:gap-12">
        <div className="flex flex-col gap-6">
          <BrandDescriptor className="text-primary" />
          <h1
            id="hero-title"
            className="text-balance text-4xl font-bold leading-[1.06] tracking-tight text-foreground sm:text-5xl lg:text-[3.25rem]"
          >
            {HERO.headline.split(". ").map((line, i, all) => (
              <span key={line} className="block">
                {i < all.length - 1 ? `${line}. ` : line}
              </span>
            ))}
          </h1>
          <span aria-hidden="true" className="h-0.5 w-12 rounded-full bg-brand-apricot" />
          <p className="text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl">
            <strong className="font-semibold text-foreground">{HERO.problem}</strong> {HERO.subhead}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <ButtonLink to={ROUTES.login}>
              Open the coordinator desk
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink to={ROUTES.kiosk} variant="secondary">
              Try the patient kiosk
            </ButtonLink>
          </div>
        </div>

        <figure className="flex flex-col gap-3">
          <GlassPanel className="overflow-hidden p-1.5 sm:p-2">
            <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-border-strong/50" />
              <span className="h-2.5 w-2.5 rounded-full bg-border-strong/50" />
              <span className="h-2.5 w-2.5 rounded-full bg-border-strong/50" />
              <span className="ml-3 truncate rounded-full bg-surface-subtle px-3 py-0.5 text-xs text-muted-foreground">
                Coordinator queue
              </span>
            </div>
            <img
              src={HERO.image.src}
              width={HERO.image.width}
              height={HERO.image.height}
              alt={HERO.image.alt}
              className="h-auto w-full rounded-xl border border-border bg-surface"
              decoding="async"
            />
          </GlassPanel>
          <figcaption className="px-1 text-sm text-muted-foreground">{HERO.caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}
