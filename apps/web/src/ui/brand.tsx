/**
 * Interim brand identity (DECISIONS.md D-044): the symbol, the wordmark lockup, the
 * tagline and the flowing "interval" pattern. Colours come from the --brand-* tokens.
 *
 * Symbol: two pillars joined by an arch (the visits, and the interval between them) with
 * an apricot dot above (the participant). Apricot is a highlight only, never text.
 */
import { cn } from "@/lib/cn";

export const BRAND_NAME = "Interim";
export const BRAND_TAGLINE = "Between visits. Every detail matters.";
export const BRAND_DESCRIPTOR = "The clinical trial safety-data desk";

export interface BrandSymbolProps {
  /** `color`: deep teal on light; `reversed`: ivory on deep teal. The dot stays apricot. */
  tone?: "color" | "reversed";
  className?: string;
  /** Accessible name; omit when a visible wordmark sits next to the symbol. */
  title?: string;
}

/** The standalone symbol, drawn on a 100 x 100 grid. Decorative unless `title` is set. */
export function BrandSymbol({ tone = "color", className, title }: BrandSymbolProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      data-slot="brand-symbol"
    >
      <circle cx="50" cy="22.6" r="11.8" className="fill-brand-apricot" />
      <g className={tone === "reversed" ? "fill-brand-ivory" : "fill-brand-teal"}>
        <path d="M27 57H30A23.7 23.7 0 0 1 70 57H73V67.8H70A22.8 22.8 0 0 0 30 67.8H27Z" />
        <path d="M9 24.5A2.5 2.5 0 0 1 11.5 22H14A16 16 0 0 1 30 38V89.5A2.5 2.5 0 0 1 27.5 92H11.5A2.5 2.5 0 0 1 9 89.5Z" />
        <path d="M91 24.5A2.5 2.5 0 0 0 88.5 22H86A16 16 0 0 0 70 38V89.5A2.5 2.5 0 0 0 72.5 92H88.5A2.5 2.5 0 0 0 91 89.5Z" />
      </g>
    </svg>
  );
}

export interface BrandLockupProps {
  tone?: "color" | "reversed";
  size?: "sm" | "md" | "lg";
  /** Text after the wordmark in the same line (e.g. "check-in" on the kiosk). */
  suffix?: string;
  className?: string;
}

const LOCKUP_SIZE = {
  sm: { symbol: "size-6", text: "text-[17px]", gap: "gap-1.5" },
  md: { symbol: "size-8", text: "text-[22px]", gap: "gap-2" },
  lg: { symbol: "size-11", text: "text-[30px]", gap: "gap-2.5" },
} as const;

/** Symbol + "Interim" wordmark (Manrope, extra bold, tight). */
export function BrandLockup({ tone = "color", size = "md", suffix, className }: BrandLockupProps) {
  const s = LOCKUP_SIZE[size];
  return (
    <span className={cn("inline-flex items-center", s.gap, className)} data-slot="brand-lockup">
      <BrandSymbol tone={tone} className={s.symbol} />
      <span
        className={cn(
          "font-brand font-extrabold leading-none tracking-tight",
          s.text,
          tone === "reversed" ? "text-brand-ivory" : "text-brand-ink",
        )}
      >
        {BRAND_NAME}
        {suffix ? <span className="font-semibold text-primary"> {suffix}</span> : null}
      </span>
    </span>
  );
}

/** Spaced small-caps line under the tagline ("THE CLINICAL TRIAL SAFETY-DATA DESK"). */
export function BrandDescriptor({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "m-0 text-[11px] font-medium uppercase tracking-[0.28em] text-muted-foreground",
        className,
      )}
    >
      {BRAND_DESCRIPTOR}
    </p>
  );
}

/**
 * The flowing graphic pattern ("inspired by the interval"): sage hills, a deep-teal
 * shoulder and three thin lines, one apricot. Decorative; place it in a positioned parent.
 */
export function BrandWaves({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1200 400"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={cn("pointer-events-none block", className)}
      data-slot="brand-waves"
    >
      <path
        d="M0 400C260 390 470 300 700 262S1060 150 1200 96V400Z"
        className="fill-brand-sage"
        opacity="0.35"
      />
      <path
        d="M260 400C560 392 740 318 900 270S1110 196 1200 176V400Z"
        className="fill-brand-sage"
        opacity="0.75"
      />
      <path
        d="M690 400C880 392 1010 340 1090 292S1170 238 1200 226V400Z"
        className="fill-brand-teal"
      />
      <g fill="none" strokeLinecap="round" vectorEffect="non-scaling-stroke">
        <path
          d="M0 172C300 160 450 248 700 222S1050 104 1200 80"
          className="stroke-brand-sage"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M0 210C300 198 450 290 700 262S1050 146 1200 122"
          className="stroke-brand-apricot"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M0 250C300 238 450 330 700 302S1050 186 1200 162"
          className="stroke-brand-teal"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}
