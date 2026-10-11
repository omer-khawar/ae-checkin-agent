/**
 * FAQ accordion.
 *
 * Adapted from "Basic Accordion" (accordion-01) by felipemenezes098 on 21st.dev
 * (https://21st.dev/felipemenezes098/accordion-01). The original wraps
 * @radix-ui/react-accordion, which this app does not depend on; rather than add
 * a dependency for five questions, this is a hand-built disclosure list with the
 * same structure (bordered items, chevron, first item open) following the WAI-ARIA
 * accordion pattern: a button with aria-expanded/aria-controls per item and a
 * labelled region. Panels toggle with the `hidden` attribute (no height
 * animation), so nothing moves for people who prefer reduced motion.
 */
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@/lib/cn";

import { FAQ } from "../content";
import { GlassPanel, SectionHeading } from "../primitives";

export function Faq() {
  const baseId = useId();
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));

  function toggle(i: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <section
      id="faq"
      aria-labelledby="faq-title"
      className="scroll-mt-24 px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto max-w-3xl">
        <SectionHeading id="faq-title" eyebrow="FAQ" title="Questions people ask first" />
        <GlassPanel className="mt-10 px-5 sm:px-7">
          <ul className="divide-y divide-border">
            {FAQ.map((item, i) => {
              const isOpen = open.has(i);
              const buttonId = `${baseId}-q${i}`;
              const panelId = `${baseId}-a${i}`;
              return (
                <li key={item.q}>
                  <h3>
                    <button
                      type="button"
                      id={buttonId}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => toggle(i)}
                      className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 py-5 text-left text-base font-semibold text-foreground sm:text-lg"
                    >
                      {item.q}
                      <ChevronDown
                        aria-hidden="true"
                        className={`h-5 w-5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200 ${isOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                  </h3>
                  <div
                    id={panelId}
                    role="region"
                    aria-labelledby={buttonId}
                    hidden={!isOpen}
                    className={cn(
                      "flex-col gap-3 pb-6 text-base leading-relaxed text-muted-foreground",
                      // `display: flex` would beat the `hidden` attribute, so set it only when open.
                      isOpen ? "flex" : "hidden",
                    )}
                  >
                    {item.a.map((para) => (
                      <p key={para}>{para}</p>
                    ))}
                    {item.code && (
                      <div className="overflow-x-auto rounded-xl bg-slate-900 px-4 py-3">
                        <pre className="font-mono text-sm leading-relaxed text-slate-100">
                          <code>{item.code}</code>
                        </pre>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </GlassPanel>
      </div>
    </section>
  );
}
