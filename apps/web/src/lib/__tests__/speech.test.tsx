import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSpeechForTests, hashText, speak, stopSpeaking, useReadAloud } from "../speech";

const flush = () => new Promise((r) => setTimeout(r, 30));

function okManifest(m: Record<string, unknown>) {
  return vi.fn(async () => ({ ok: true, json: async () => m }));
}

describe("speech playback", () => {
  const speakSpy = vi.fn();
  const cancelSpy = vi.fn();
  beforeEach(() => {
    _resetSpeechForTests();
    speakSpy.mockReset();
    cancelSpy.mockReset();
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        rate = 1;
        lang = "";
        voice: unknown = null;
        constructor(public text: string) {}
      },
    );
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak: speakSpy, cancel: cancelSpy, getVoices: () => [{ lang: "en-GB" }] },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to speech synthesis when the manifest has no entry", async () => {
    vi.stubGlobal("fetch", okManifest({}));
    speak("Hello there");
    await flush();
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it("plays the manifest mp3 when present", async () => {
    const h = await hashText("Hello there");
    vi.stubGlobal("fetch", okManifest({ [h as string]: { file: "x.mp3" } }));
    const play = vi.fn(async () => undefined);
    const ctor = vi.fn(function (this: { play: typeof play; pause: () => void }) {
      this.play = play;
      this.pause = () => undefined;
    });
    vi.stubGlobal("Audio", ctor);
    speak("Hello there");
    await flush();
    expect(ctor).toHaveBeenCalledWith("/audio/en/x.mp3");
    expect(play).toHaveBeenCalled();
    expect(speakSpy).not.toHaveBeenCalled();
  });

  it("falls back to synthesis when play() fails, and never throws", async () => {
    const h = await hashText("Hi");
    vi.stubGlobal("fetch", okManifest({ [h as string]: { file: "x.mp3" } }));
    vi.stubGlobal(
      "Audio",
      vi.fn(function (this: { play: () => Promise<void> }) {
        this.play = async () => {
          throw new Error("blocked");
        };
      }),
    );
    expect(() => speak("Hi")).not.toThrow();
    await flush();
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it("stopSpeaking cancels synthesis", () => {
    stopSpeaking();
    expect(cancelSpy).toHaveBeenCalled();
  });
});

function Probe({ id }: { id: string }) {
  const { on, setOn } = useReadAloud();
  return (
    <button data-testid={id} onClick={() => setOn(!on)}>
      {on ? "on" : "off"}
    </button>
  );
}

describe("useReadAloud shared store", () => {
  beforeEach(() => {
    sessionStorage.clear();
    _resetSpeechForTests();
  });
  it("keeps two consumers and sessionStorage in agreement", () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    expect(screen.getByTestId("a").textContent).toBe("off");
    act(() => screen.getByTestId("a").click());
    expect(screen.getByTestId("b").textContent).toBe("on");
    expect(sessionStorage.getItem("interim.kiosk.readAloud")).toBe("1");
  });
});
