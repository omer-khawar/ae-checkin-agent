/**
 * Keyboard helpers shared by the console components (DataTable row keys, the command
 * menu's "/" shortcut). One definition so every single-key shortcut in Interim steps
 * aside for the same set of "the user is typing" targets.
 *
 * Built for Interim (no third-party source).
 */

/** Input types that do not take text; a shortcut pressed while one is focused still runs. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
]);

/**
 * True while the user is typing: a text-like <input>, a <textarea>, a <select> or a
 * contenteditable element. Single-letter shortcuts (j/k/x, "/") must ignore these.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
