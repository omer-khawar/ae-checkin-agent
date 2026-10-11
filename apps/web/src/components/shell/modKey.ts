const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
/** The platform's command modifier as printed on a key cap. */
export const MOD_KEY = isMac ? "⌘" : "Ctrl";
