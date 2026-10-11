/**
 * What you get: six tiles in a bento grid.
 *
 * Adapted from "Feature Section with Bento Grid" by tommyjepsen on 21st.dev
 * (https://21st.dev/tommyjepsen/feature-section-with-bento-grid). Changes:
 * hover effects removed (approved), muted tiles became glass, one icon per
 * tile, a sixth row added so the 2+1 / 1+2 rhythm closes; shadcn Badge swapped
 * for an inline label; Tailwind 3.4 with our palette.
 */
import {
  CalendarClock,
  ClipboardList,
  FileCheck2,
  type LucideIcon,
  MessagesSquare,
  ScrollText,
  Timer,
} from "lucide-react";
import { cn } from "@/lib/cn";

import { FEATURES, TAGLINE } from "../content";
import { ExternalLink, GlassPanel, SectionHeading } from "../primitives";

const ICONS: Record<string, LucideIcon> = {
  packets: CalendarClock,
  protocol: ScrollText,
  evidence: FileCheck2,
  queries: MessagesSquare,
  briefs: ClipboardList,
  time: Timer,
};

export function WhatYouGet() {
  return (
    <section
      id="what-you-get"
      aria-labelledby="get-title"
      className="scroll-mt-24 px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          id="get-title"
          eyebrow="What you get"
          title={TAGLINE}
          intro="Interim does the typing and the remembering. People make every decision that matters, and every output shows where it came from."
        />
        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = ICONS[f.id] ?? FileCheck2;
            return (
              <li key={f.id} className={cn(f.wide && "lg:col-span-2")}>
                <GlassPanel className="flex h-full min-h-[13rem] flex-col justify-between gap-8 p-6 sm:p-7">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-primary ring-1 ring-inset ring-primary/15">
                    <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                  <div className="flex flex-col gap-2">
                    <h3 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
                      {f.title}
                      {/* Space keeps the accessible name "… on screen estimate", not "…screenestimate". */}
                      {f.label && " "}
                      {f.label && (
                        <span className="rounded-full border border-border-strong bg-surface px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          {f.label}
                        </span>
                      )}
                    </h3>
                    <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
                      {f.body}
                    </p>
                    {f.link && (
                      <p className="text-sm">
                        <ExternalLink href={f.link.href} className="inline-block py-1">
                          {f.link.text}
                        </ExternalLink>
                      </p>
                    )}
                  </div>
                </GlassPanel>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
