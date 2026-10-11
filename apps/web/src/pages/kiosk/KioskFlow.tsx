/**
 * The kiosk state machine (CLAUDE.md §3.8 as amended by §00, CONTRACTS.md §4 + R3.3):
 *
 *   welcome ─▶ urgent ─▶ items (×N) ─▶ gates (×3) ─▶ review ─▶ submitting ─▶ thankyou
 *                 │         │                                          └─▶ stop (Tier 3)
 *                 └─────────┴─▶ stop at once (R5.1: urgent_now = Yes, or a Severe /
 *                                Very severe shortness-of-breath answer; POST /urgent)
 *
 * There is no per-session camera consent screen any more (D-026): camera use
 * is covered by the informed consent form signed at enrollment, and the API
 * records `consent_basis: "enrollment_icf"`. The Welcome screen keeps the
 * "no video is stored" sentence and an optional "Use the camera" box
 * (camera OFF by default, R5.6), whose value is sent as `consent_camera`.
 *
 * API calls, in order:
 *   GET /items, GET /study             on mount
 *   POST /sessions                     on "Start check-in", with consent_camera from
 *                                      the Welcome opt-out toggle;
 *                                      usubjid = "{study_id}-{typed label}", retried
 *                                      with the bare label on 404 (lib/participant.ts)
 *   POST /sessions/{id}/answers        on every option tap (idempotent per item+attribute);
 *                                      failures are tracked per (item, attribute) and
 *                                      "Try again" resends every one of them
 *   POST /sessions/{id}/urgent         at once when urgent_now = Yes or the shortness-of-breath
 *                                      severity answer is Severe / Very severe (no more questions)
 *   POST /sessions/{id}/gates          once, when "Send my answers" is pressed on the
 *                                      review screen (verbatim text; urgent_now:false, conmeds[])
 *   POST /sessions/{id}/answers        again for any answer the API never acknowledged
 *   POST /sessions/{id}/complete       after the bridge's post-flush idle (≤ 2.5 s)
 *
 * Bridge: `start` right after the session exists when the camera box was ticked (re-sent by the
 * client on reconnect), `stop` before `/complete`. The participant never sees a
 * tier, a grade, or any rule output.
 *
 * UI phase 2: the numbers card shows only with `?presenter=1`; patients see a quiet
 * "Camera on" / "Camera off" line ("simulated" appears only in presenter mode, where
 * the numbers are shown). After 60 s of no input an "Are you still there?"
 * prompt appears for 30 s, then the unsent check-in is discarded and the kiosk
 * returns to Welcome (the API session simply stays incomplete).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { VitalsPanel } from "../../components/VitalsPanel";
import { answerKey, missingAnswers, type AnswerMap } from "../../lib/answers";
import {
  completeSession,
  createSession,
  getItems,
  getPublicSettings,
  getStudy,
  isApiError,
  nowIso,
  postAnswer,
  postGates,
  postUrgent,
} from "../../lib/api";
import { useBridge } from "../../lib/bridge";
import { parseTemperature, temperatureField } from "../../lib/format";
import {
  buildGatesBody,
  FALLBACK_SITE_PHONE,
  GATE_ORDER,
  INITIAL_GATE_STATE,
  isSevereDyspnea,
  urgentLabel,
  type GateState,
} from "../../lib/gates";
import { resolveUsubjid } from "../../lib/participant";
import type {
  AnswerRequest,
  Attribute,
  CompleteResponse,
  ItemsResponse,
  Session,
  Study,
  UrgentTrigger,
} from "../../lib/types";
import { GateScreen } from "./GateScreen";
import { ItemScreen } from "./ItemScreen";
import { KioskShell } from "./KioskShell";
import { IdlePrompt } from "./IdlePrompt";
import { ReviewScreen } from "./ReviewScreen";
import { Stop } from "./Stop";
import { Submitting } from "./Submitting";
import { ThankYou } from "./ThankYou";
import { UrgentScreen } from "./UrgentScreen";
import { useIdleTimeout } from "./useIdleTimeout";
import { Welcome } from "./Welcome";

type Step =
  | "welcome"
  | "urgent"
  | "items"
  | "gates"
  | "review"
  | "submitting"
  | "thankyou"
  | "stop";

/** How long we give the bridge to flush its buffer after `stop` (CONTRACTS.md §4). */
export const BRIDGE_FLUSH_TIMEOUT_MS = 2500;

const EMPTY_KEYS: ReadonlySet<string> = new Set();

function withKey(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  next.add(key);
  return next;
}

function withoutKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

export function KioskFlow() {
  const [searchParams] = useSearchParams();
  /** CLAUDE.md §7.2: `?scenario=` overrides the mock scenario for this kiosk. */
  const scenarioOverride = searchParams.get("scenario") ?? undefined;
  /** `?presenter=1` shows the numbers card; patients only get the quiet status line. */
  const presenter = searchParams.get("presenter") === "1";

  // ---- reference data ------------------------------------------------------
  const [catalog, setCatalog] = useState<ItemsResponse | null>(null);
  const [study, setStudy] = useState<Study | null>(null);
  /** The study team's phone line; falls back to the fictional default if settings are unreachable. */
  const [sitePhone, setSitePhone] = useState(FALLBACK_SITE_PHONE);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([getItems(), getStudy().catch(() => null), getPublicSettings().catch(() => null)])
      .then(([items, s, settings]) => {
        setCatalog({ ...items, items: [...items.items].sort((a, b) => a.order - b.order) });
        setStudy(s);
        if (settings?.site_phone) setSitePhone(settings.site_phone);
      })
      .catch((e: unknown) => setLoadError(e))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => catalog?.items ?? [], [catalog]);
  const gateQuestions = useMemo(() => catalog?.gates ?? [], [catalog]);
  const urgentQuestion = useMemo(() => urgentLabel(gateQuestions), [gateQuestions]);
  const recallWindow = catalog?.recall_window ?? "the last 7 days";
  /** The item carrying the optional typed temperature (fever_or_chills), if any. */
  const tempItem = useMemo(() => items.find((i) => temperatureField(i) !== null) ?? null, [items]);
  const tempField = useMemo(() => (tempItem ? temperatureField(tempItem) : null), [tempItem]);

  // ---- flow state ----------------------------------------------------------
  const [step, setStep] = useState<Step>("welcome");
  /** Bumped by every reset so UI that must not carry over to the next person (help line) clears. */
  const [runId, setRunId] = useState(0);
  /** The label the participant typed (e.g. "P-007"); the USUBJID is composed on start. */
  const [typedId, setTypedId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  /** Camera on for this session (the participant ticked the Welcome box). Sent as `consent_camera`. */
  const [cameraOn, setCameraOn] = useState(false);
  /** Unknown study ID (404 / 422): a "check your ID" message, no retry. */
  const [startError, setStartError] = useState<unknown>(null);
  /** Anything else (network, 5xx): a generic message with "Try again". */
  const [startFailure, setStartFailure] = useState<unknown>(null);
  const [startBusy, setStartBusy] = useState(false);
  /** Guards against a double submit before `startBusy` re-renders. */
  const startingRef = useRef(false);

  const [itemIndex, setItemIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [tempC, setTempC] = useState("");
  /** `item:attribute` keys with a POST in flight. */
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  /** `item:attribute` → the request whose last POST failed (all are resent on retry). */
  const [failed, setFailed] = useState<Record<string, AnswerRequest>>({});
  /** `item:attribute` keys whose latest value the API acknowledged. */
  const [ackedKeys, setAckedKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const [answerError, setAnswerError] = useState<unknown>(null);
  /** Per-key send sequence + promise chain: later taps win, and POSTs for one key stay ordered. */
  const sendSeqRef = useRef(new Map<string, number>());
  const sendChainRef = useRef(new Map<string, Promise<unknown>>());

  /** True while a screen was opened from "Edit" on the review screen: Next returns there. */
  const [editing, setEditing] = useState(false);
  const [gateIndex, setGateIndex] = useState(0);
  const [gates, setGates] = useState<GateState>(INITIAL_GATE_STATE);
  /** The urgent_now answer on screen: only "no" can be shown again (Yes ends the check-in). */
  const [urgentAnswer, setUrgentAnswer] = useState<"yes" | "no" | null>(null);
  /** Set once the check-in was ended early; the stop screen shows while /urgent is in flight. */
  const endingRef = useRef(false);
  const [urgentFailed, setUrgentFailed] = useState(false);
  const [gatesBusy, setGatesBusy] = useState(false);
  const [gatesError, setGatesError] = useState<unknown>(null);

  const [completeError, setCompleteError] = useState<unknown>(null);
  const [complete, setComplete] = useState<CompleteResponse | null>(null);
  const submittingRef = useRef(false);

  // ---- bridge --------------------------------------------------------------
  // Connect as soon as the kiosk loads so the socket is warm by the time the
  // participant presses Start. `start` is only sent when the camera is left on.
  // The card is hidden once capture has been stopped (submitting onward).
  const bridge = useBridge();
  const showVitals =
    cameraOn && session !== null && (step === "urgent" || step === "items" || step === "gates");

  const bridgeStop = bridge.stop;
  const reset = useCallback(() => {
    // A session abandoned mid-flow must not keep the bridge capturing.
    bridgeStop();
    setRunId((n) => n + 1);
    setStep("welcome");
    setTypedId("");
    setSession(null);
    setCameraOn(false);
    setStartError(null);
    setStartFailure(null);
    setStartBusy(false);
    startingRef.current = false;
    setItemIndex(0);
    setAnswers({});
    setTempC("");
    setPendingKeys(EMPTY_KEYS);
    setFailed({});
    setAckedKeys(EMPTY_KEYS);
    setAnswerError(null);
    sendSeqRef.current = new Map();
    sendChainRef.current = new Map();
    setEditing(false);
    setGateIndex(0);
    setGates(INITIAL_GATE_STATE);
    setUrgentAnswer(null);
    setUrgentFailed(false);
    endingRef.current = false;
    setGatesBusy(false);
    setGatesError(null);
    setCompleteError(null);
    setComplete(null);
    submittingRef.current = false;
  }, [bridgeStop]);

  // ---- welcome → session → items -------------------------------------------
  const startSession = useCallback(
    async (id: string, useCamera: boolean) => {
      if (startingRef.current) return;
      startingRef.current = true;
      setTypedId(id);
      setCameraOn(useCamera);
      setStartBusy(true);
      setStartError(null);
      setStartFailure(null);
      try {
        // CONTRACTS.md §5: USUBJID = "{study_id}-P-xxx". Compose it from the loaded
        // study; if the API resolves display labels instead, the 404 retry covers it.
        const { primary, fallback } = resolveUsubjid(id, study?.study_id);
        let s: Session;
        try {
          s = await createSession({ usubjid: primary, consent_camera: useCamera });
        } catch (e) {
          if (fallback && isApiError(e) && e.isNotFound) {
            s = await createSession({ usubjid: fallback, consent_camera: useCamera });
          } else {
            throw e;
          }
        }
        setSession(s);
        if (useCamera) bridge.start(s.id, scenarioOverride);
        setItemIndex(0);
        setUrgentAnswer(null);
        setStep("urgent");
      } catch (e) {
        // Unknown study ID → stay on Welcome with a friendly "check your ID" message;
        // anything else → a generic message with "Try again".
        if (isApiError(e) && (e.isNotFound || e.isValidation)) setStartError(e);
        else setStartFailure(e);
      } finally {
        startingRef.current = false;
        setStartBusy(false);
      }
    },
    [study, bridge, scenarioOverride],
  );

  // ---- items ---------------------------------------------------------------
  /**
   * POST one answer. Returns whether the API acknowledged it. A newer tap on the
   * same (item, attribute) supersedes an older in-flight one: the older result
   * no longer touches state, and POSTs for one key are chained so the server
   * sees them in tap order.
   */
  const sendAnswer = useCallback(
    async (req: AnswerRequest): Promise<boolean> => {
      if (!session) return false;
      const key = answerKey(req.item_id, req.attribute);
      const seq = (sendSeqRef.current.get(key) ?? 0) + 1;
      sendSeqRef.current.set(key, seq);
      const isCurrent = () => sendSeqRef.current.get(key) === seq;

      setPendingKeys((prev) => withKey(prev, key));
      setAckedKeys((prev) => withoutKey(prev, key));
      setFailed((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });

      const previous = sendChainRef.current.get(key) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => postAnswer(session.id, req));
      sendChainRef.current.set(key, run);
      try {
        await run;
        if (isCurrent()) setAckedKeys((prev) => withKey(prev, key));
        return true;
      } catch (e) {
        if (isCurrent()) {
          setFailed((prev) => ({ ...prev, [key]: req }));
          setAnswerError(e);
        }
        return false;
      } finally {
        if (isCurrent()) setPendingKeys((prev) => withoutKey(prev, key));
      }
    },
    [session],
  );

  /**
   * R5.1: stop the check-in now. The stop screen shows immediately (the safety text must not
   * wait on the network); the API call follows, after any answer still in flight so the
   * severity the participant just gave is on the record. A failed call is shown honestly:
   * the text stops claiming the answers were saved.
   */
  const endEarly = useCallback(
    async (trigger: UrgentTrigger, afterAnswer?: Promise<unknown>) => {
      if (!session || endingRef.current) return;
      endingRef.current = true;
      if (cameraOn) bridgeStop();
      setUrgentFailed(false);
      setComplete(null);
      setStep("stop");
      try {
        await afterAnswer;
        const res = await postUrgent(session.id, { trigger, ts_client: nowIso() });
        setComplete(res);
      } catch {
        setUrgentFailed(true);
      }
    },
    [session, cameraOn, bridgeStop],
  );

  function onSelect(itemId: string, attribute: Attribute, value: number) {
    setAnswers((prev) => ({ ...prev, [itemId]: { ...prev[itemId], [attribute]: value } }));
    // Fever answered "No": a previously typed temperature no longer belongs to the record.
    if (tempItem && itemId === tempItem.id && attribute === "presence" && value === 0) {
      setTempC("");
    }
    const sent = sendAnswer({ item_id: itemId, attribute, value, ts_client: nowIso() });
    // R5.1: Severe / Very severe shortness of breath ends the check-in right here.
    if (isSevereDyspnea(itemId, attribute, value)) void endEarly("severe_dyspnea", sent);
  }

  function onUrgentAnswer(v: "yes" | "no") {
    setUrgentAnswer(v);
    // Yes: no more questions. The screen changes at once; there is no Next to press.
    if (v === "yes") void endEarly("urgent_now");
  }

  /** Resend every failed answer (with a fresh client timestamp). */
  const retryFailed = useCallback(() => {
    for (const req of Object.values(failed)) {
      void sendAnswer({ ...req, ts_client: nowIso() });
    }
  }, [failed, sendAnswer]);

  const currentItem = items[itemIndex];
  const currentValues = currentItem ? (answers[currentItem.id] ?? {}) : {};
  const itemAnswered = currentItem
    ? currentItem.attributes.every((a) => currentValues[a] !== undefined)
    : false;

  const feverPresent = tempItem ? answers[tempItem.id]?.presence === 1 : false;
  const tempParsed = parseTemperature(tempC, tempField);
  /** The temperature to send: only when fever is present and the value is inside the table's bounds. */
  const tempValue = feverPresent && tempParsed.kind === "ok" ? tempParsed.value : null;
  const tempBlocksNext =
    currentItem !== undefined &&
    tempItem !== null &&
    currentItem.id === tempItem.id &&
    feverPresent &&
    (tempParsed.kind === "invalid" || tempParsed.kind === "out_of_range");

  const failedCount = Object.keys(failed).length;
  const canNext = itemAnswered && pendingKeys.size === 0 && failedCount === 0 && !tempBlocksNext;

  function nextItem() {
    if (editing) {
      setEditing(false);
      setStep("review");
    } else if (itemIndex + 1 < items.length) setItemIndex(itemIndex + 1);
    else {
      setGateIndex(0);
      setStep("gates");
    }
  }

  function backItem() {
    setEditing(false);
    if (itemIndex > 0) setItemIndex(itemIndex - 1);
    else setStep("urgent");
  }

  // ---- gates ---------------------------------------------------------------
  const submitGates = useCallback(async () => {
    if (!session) return;
    setGatesBusy(true);
    setGatesError(null);
    try {
      await postGates(session.id, buildGatesBody(gates, tempValue, nowIso()));
      setStep("submitting");
    } catch (e) {
      setGatesError(e);
    } finally {
      setGatesBusy(false);
    }
  }, [session, gates, tempValue]);

  function nextGate() {
    if (editing || gateIndex + 1 >= GATE_ORDER.length) {
      setEditing(false);
      setStep("review");
    } else setGateIndex(gateIndex + 1);
  }

  function backGate() {
    setEditing(false);
    if (gateIndex > 0) setGateIndex(gateIndex - 1);
    else {
      setItemIndex(Math.max(0, items.length - 1));
      setStep("items");
    }
  }

  // ---- review --------------------------------------------------------------
  function editItem(i: number) {
    setItemIndex(i);
    setEditing(true);
    setStep("items");
  }

  function editGate(i: number) {
    setGateIndex(i);
    setEditing(true);
    setStep("gates");
  }

  // ---- idle ----------------------------------------------------------------
  const idle = useIdleTimeout({
    enabled: step === "urgent" || step === "items" || step === "gates" || step === "review",
    onTimeout: reset,
  });

  // ---- submitting ----------------------------------------------------------
  const runComplete = useCallback(async () => {
    if (!session || submittingRef.current) return;
    submittingRef.current = true;
    setCompleteError(null);
    try {
      // Belt and braces: every answer the participant saw as selected must be on
      // the server before the rules run. Resend anything not acknowledged.
      const gaps = missingAnswers(answers, ackedKeys, pendingKeys);
      if (gaps.length > 0) {
        const results = await Promise.all(
          gaps.map((g) => sendAnswer({ ...g, ts_client: nowIso() })),
        );
        if (results.some((ok) => !ok)) {
          throw new Error("Some answers could not be saved. Please try again.");
        }
      }
      // Tell the bridge to stop and wait for its post-flush idle (≤ 2.5 s), then complete regardless.
      if (cameraOn) await bridge.stopAndFlush(BRIDGE_FLUSH_TIMEOUT_MS);
      const res = await completeSession(session.id, { ts_client: nowIso() });
      setComplete(res);
      setStep(res.stop_screen ? "stop" : "thankyou");
    } catch (e) {
      setCompleteError(e);
    } finally {
      submittingRef.current = false;
    }
  }, [session, cameraOn, bridge, answers, ackedKeys, pendingKeys, sendAnswer]);

  useEffect(() => {
    if (step === "submitting" && !completeError) void runComplete();
    // runComplete is stable per session/camera choice; we deliberately run once per entry into "submitting".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ---- render --------------------------------------------------------------
  // One counter over the whole check-in: the urgent question, every symptom, then the gates.
  const totalScreens = 1 + items.length + GATE_ORDER.length;
  const measured = bridge.sample?.isMeasured ?? bridge.hello?.isMeasured ?? false;
  const statusLine = session
    ? cameraOn
      ? presenter
        ? `Camera on · ${measured ? "measured" : "simulated"}`
        : "Camera on"
      : "Camera off"
    : undefined;

  const side = presenter && showVitals ? <VitalsPanel bridge={bridge} /> : undefined;

  return (
    <KioskShell
      statusLine={statusLine}
      side={side}
      hasActionBar={step === "urgent" || step === "items" || step === "gates" || step === "review"}
      sitePhone={sitePhone}
      helpResetKey={`${runId}-${step === "welcome" || step === "thankyou" || step === "stop" ? step : "active"}`}
    >
      {step === "welcome" && (
        <Welcome
          loading={loading}
          loadError={loadError}
          onRetryLoad={load}
          busy={startBusy}
          startError={startError}
          startFailure={startFailure}
          initialId={typedId}
          onStart={(id, useCamera) => void startSession(id, useCamera)}
        />
      )}

      {step === "urgent" && (
        <UrgentScreen
          label={urgentQuestion}
          screenTotal={totalScreens}
          value={urgentAnswer}
          onAnswer={onUrgentAnswer}
          onNext={() => {
            setItemIndex(0);
            setStep("items");
          }}
        />
      )}

      {step === "items" && currentItem && (
        <ItemScreen
          key={currentItem.id}
          item={currentItem}
          index={itemIndex}
          total={items.length}
          screenTotal={totalScreens}
          progressOffset={1}
          recallWindow={recallWindow}
          values={currentValues}
          onSelect={(attr, value) => onSelect(currentItem.id, attr, value)}
          tempC={tempC}
          onTempChange={setTempC}
          nextLabel={editing ? "Back to my answers" : undefined}
          canBack={itemIndex > 0}
          onBack={backItem}
          canNext={canNext}
          nextBusy={pendingKeys.size > 0}
          onNext={nextItem}
          error={failedCount > 0 ? answerError : null}
          onRetry={retryFailed}
        />
      )}

      {step === "items" && !currentItem && (
        <div className="glass mx-auto max-w-k-content rounded-sheet p-8 text-k-body">
          No questions are configured. Please ask the study team.
        </div>
      )}

      {step === "gates" && (
        <GateScreen
          key={gateIndex}
          index={gateIndex}
          questions={gateQuestions}
          itemCount={items.length + 1}
          state={gates}
          onChange={(patch) => setGates((g) => ({ ...g, ...patch }))}
          onBack={backGate}
          onNext={nextGate}
          nextLabel={editing ? "Back to my answers" : undefined}
        />
      )}

      {step === "review" && (
        <ReviewScreen
          items={items}
          answers={answers}
          gateQuestions={gateQuestions}
          gates={gates}
          tempC={tempValue !== null ? tempC : ""}
          onEditItem={editItem}
          onEditGate={editGate}
          onBack={() => {
            setGateIndex(GATE_ORDER.length - 1);
            setStep("gates");
          }}
          onSend={() => void submitGates()}
          busy={gatesBusy}
          error={gatesError}
        />
      )}

      {step === "submitting" && (
        <Submitting
          error={completeError}
          onRetry={() => {
            setCompleteError(null);
            void runComplete();
          }}
        />
      )}

      {step === "thankyou" && <ThankYou onDone={reset} sitePhone={sitePhone} />}

      {step === "stop" && (
        <Stop
          text={complete?.stop_screen_text}
          sitePhone={sitePhone}
          unsaved={urgentFailed}
          onDone={reset}
        />
      )}

      {idle.warning && <IdlePrompt secondsLeft={idle.secondsLeft} onStay={idle.dismiss} />}
    </KioskShell>
  );
}
