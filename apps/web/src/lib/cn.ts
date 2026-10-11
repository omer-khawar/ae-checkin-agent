/**
 * `cn()`: join class names (clsx) and resolve Tailwind conflicts (tailwind-merge),
 * the shadcn convention used by every component in src/ui.
 *
 * tailwind-merge is taught our custom theme keys (tailwind.config.js). Without this
 * it would read `text-caption` as a text COLOUR and silently drop it when a colour
 * class such as `text-muted-foreground` follows. Keep these lists in sync with
 * theme.extend.fontSize / borderRadius / boxShadow / spacing (SIZE_KEYS).
 */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

export const FONT_SIZES = [
  "caption",
  "table",
  "body",
  "title",
  "page",
  "display",
  "k-disclaimer",
  "k-helper",
  "k-body",
  "k-answer",
  "k-lead",
  "k-question",
  "k-title",
] as const;

/** theme.extend.spacing keys used as heights (h-row, min-h-k-option, ...). */
export const SIZE_KEYS = [
  "row",
  "row-comfy",
  "appbar",
  "k-option",
  "k-gap",
  "k-actionbar",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZES] }],
      rounded: [{ rounded: ["control", "panel", "sheet"] }],
      shadow: [{ shadow: ["card", "glass", "elev-1", "elev-2", "elev-3"] }],
      // Named sizes (theme.extend.spacing / minHeight). Without these, `min-h-k-option`
      // and `min-h-[72px]` would both survive and the cascade, not the caller, would win.
      h: [{ h: [...SIZE_KEYS] }],
      "min-h": [{ "min-h": [...SIZE_KEYS, "tap", "tap-lg"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
