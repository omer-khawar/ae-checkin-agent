/**
 * How it works: the life of one side effect, in eight steps, each naming the
 * screen that handles it and showing a thumbnail of that screen.
 *
 * Adapted from "Vertical How It Works Timeline" (how-it-works-02) by ln-dev7 on
 * 21st.dev (https://21st.dev/ln-dev7/how-it-works-02). Changes: four steps
 * extended to eight; per-step icons replaced by the screen name and a cropped
 * screenshot from docs/screenshots/v2; dashed rail and numbered nodes kept;
 * Tailwind 3.4 with our palette.
 */
import { STEPS } from "../content";
import { SectionHeading } from "../primitives";

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-title"
      className="scroll-mt-24 px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="The life of one side effect, and the screen that handles each step"
          intro="A side effect at a trial site goes through eight steps. Interim covers all eight, and a person confirms at every one."
        />

        <ol className="relative ml-[1.125rem] mt-14 flex flex-col gap-6 border-l border-dashed border-border-strong pl-8 sm:ml-0 sm:pl-12">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[3.15rem] top-4 grid h-9 w-9 place-items-center rounded-full border border-border bg-surface text-sm font-semibold tabular-nums text-foreground shadow-sm sm:-left-[4.15rem]"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <article className="grid gap-5 rounded-2xl border border-border bg-surface p-5 sm:p-6 md:grid-cols-[minmax(0,1fr)_16rem] lg:grid-cols-[minmax(0,1fr)_22rem] md:items-start">
                <div className="flex flex-col gap-2">
                  <h3 className="text-lg font-semibold tracking-tight text-foreground">
                    <span className="sr-only">Step {i + 1}: </span>
                    {s.title}
                  </h3>
                  <p className="text-base leading-relaxed text-muted-foreground">{s.body}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span className="font-medium">Screen:</span>
                    <span className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-primary ring-1 ring-inset ring-primary/15">
                      {s.screen}
                    </span>
                    <code className="font-mono text-xs text-muted-foreground">{s.route}</code>
                  </p>
                </div>
                {s.image && (
                  <img
                    src={s.image.src}
                    alt={s.image.alt}
                    width={640}
                    height={400}
                    loading="lazy"
                    decoding="async"
                    className="aspect-[16/10] h-auto w-full max-w-full rounded-xl border border-border bg-surface object-cover object-top shadow-sm"
                  />
                )}
              </article>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
