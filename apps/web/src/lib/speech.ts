/**
 * Kiosk read-aloud (docs/CONTRACTS.md R5.4).
 *
 * Plays a pre-rendered MP3 for a fixed kiosk string when the build-time manifest has one
 * (scripts/build_kiosk_audio.py, ElevenLabs), else the browser's speech synthesis, else
 * nothing. Nothing calls a speech service while the app runs. Never throws.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "interim.kiosk.readAloud";
const MANIFEST_URL = "/audio/en/manifest.json";

type Manifest = Record<string, { text?: string; file: string }>;

// ---- shared on/off store ------------------------------------------------------------------
const listeners = new Set<() => void>();
let current: boolean | null = null;

function readStored(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
function getSnapshot(): boolean {
  if (current === null) current = readStored();
  return current;
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function setReadAloud(next: boolean): void {
  current = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* storage unavailable: keep it in memory */
  }
  if (!next) stopSpeaking();
  listeners.forEach((l) => l());
}

// ---- playback -----------------------------------------------------------------------------
let manifestPromise: Promise<Manifest> | null = null;
let audioEl: HTMLAudioElement | null = null;
let token = 0;

/** Test hook: forget the cached value and manifest. */
export function _resetSpeechForTests(): void {
  current = null;
  manifestPromise = null;
  audioEl = null;
  token++;
}

function loadManifest(): Promise<Manifest> {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL)
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : {}))
      .catch(() => ({}));
  }
  return manifestPromise;
}

/** First 16 hex chars of sha256(text), matching scripts/build_kiosk_audio.py. */
export async function hashText(text: string): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  } catch {
    return null;
  }
}

function synth(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      u.lang = "en-US";
      const voice = window.speechSynthesis.getVoices?.().find((v) => /^en/i.test(v.lang));
      if (voice) u.voice = voice;
      const done = () => resolve();
      u.onend = done;
      u.onerror = done;
      window.setTimeout(done, text.length * 120 + 2000);
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

function playFile(file: string, mine: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const a = new Audio(`/audio/en/${file}`);
      audioEl = a;
      a.onended = () => resolve(true);
      a.onerror = () => resolve(false);
      void Promise.resolve(a.play()).catch(() => {
        if (audioEl === a) audioEl = null;
        resolve(false);
      });
    } catch {
      resolve(false);
    }
    void mine;
  });
}

export function stopSpeaking(): void {
  token++;
  try {
    if (audioEl) {
      audioEl.pause();
      audioEl = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  } catch {
    /* silent */
  }
}

async function run(texts: readonly string[], mine: number): Promise<void> {
  try {
    const manifest = await loadManifest();
    for (const text of texts) {
      if (mine !== token) return;
      const hash = await hashText(text);
      if (mine !== token) return;
      const entry = hash ? manifest[hash] : undefined;
      if (entry?.file && (await playFile(entry.file, mine))) continue;
      if (mine !== token) return;
      await synth(text);
    }
  } catch {
    /* never throws */
  }
}

/** Speak one or more fixed strings in order; each is looked up in the manifest on its own. */
export function speak(text: string | readonly string[]): void {
  stopSpeaking();
  const texts = (typeof text === "string" ? [text] : [...text]).filter((t) => t.trim());
  if (!texts.length) return;
  void run(texts, token);
}

/** On/off for this kiosk session (sessionStorage), shared by the toggle and the screens. */
export function useReadAloud(): { on: boolean; setOn: (on: boolean) => void } {
  const on = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const setOn = useCallback((next: boolean) => setReadAloud(next), []);
  return { on, setOn };
}

/** Speak `texts` in order when a screen shows, if read-aloud is on. */
export function useSpeakOnShow(texts: readonly string[], enabled: boolean): void {
  const joined = texts.join("\n");
  useEffect(() => {
    if (!enabled || !joined) return;
    speak(joined.split(String.fromCharCode(10)).filter((t) => t));
    return () => stopSpeaking();
  }, [joined, enabled]);
}
