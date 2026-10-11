/**
 * The problem: three sourced numbers.
 *
 * Adapted from "Stats Section" (stats-05) by shadcnui-blocks on 21st.dev
 * (https://21st.dev/shadcnui-blocks/stats-05). Changes: decorative coloured
 * icons removed; each stat carries its source link; muted cards became glass;
 * Tailwind 3.4 with our palette.
 */
import { PROBLEM } from "../content";
import { ExternalLink, GlassPanel, SectionHeading } from "../primitives";

export function Problem() {
  return (
    <section aria-labelledby="problem-title" className="px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          id="problem-title"
          eyebrow={PROBLEM.eyebrow}
          title={PROBLEM.title}
          intro={PROBLEM.intro}
        />
        <ul className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {PROBLEM.stats.map((s) => (
            <li key={s.value}>
              <GlassPanel className="flex h-full flex-col p-6 sm:p-7">
                <p className="text-4xl font-semibold tracking-tight text-foreground tabular-nums md:text-[2rem] xl:text-[2.75rem]">
                  {s.value}
                </p>
                <p className="mt-4 flex-1 text-base leading-relaxed text-muted-foreground">
                  {s.label}
                </p>
                <p className="mt-6 border-t border-border pt-4 text-sm text-muted-foreground">
                  Source: <ExternalLink href={s.source.href}>{s.source.text}</ExternalLink>
                </p>
              </GlassPanel>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
