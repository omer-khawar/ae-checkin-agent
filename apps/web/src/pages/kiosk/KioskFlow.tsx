/**
 * The kiosk state machine (CLAUDE.md §3.8, CONTRACTS.md §4):
 *
 *   welcome ─▶ consent ─▶ items (×N) ─▶ gates (×3) ─▶ submitting ─▶ thankyou
 *                                                                └─▶ stop (Tier 3)
 *
 * API calls, in order:
 *   GET /items, GET /study             on mount
 *   POST /sessions                     on the consent decision (Yes or No);
 *                                      usubjid = "{study_id}-{typed label}", retried
 *                                      with the bare label on 404 (lib/participant.ts)
 *   POST /sessions/{id}/answers        on every option tap (idempotent per item+attribute);
 *                                      failures are tracked per (item, attribute) and
 *                                      "Try again" resends every one of them
 *   POST /sessions/{id}/gates          once, after the third gate screen (verbatim text)
 *   POST /sessions/{id}/answers        again for any answer the API never acknowledged
 *   POST /sessions/{id}/complete       after the bridge's post-flush idle (≤ 2.5 s)
 *
 * Bridge: `start` right after the session exists (consent = Yes; re-sent by the
 * client on reconnect), `stop` before `/complete`. The participant never sees a
 * tier, a grade, or any rule output.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { VitalsPanel } from "../../components/VitalsPanel";
import { answerKey, missingAnswers, type AnswerMap } from "../../lib/answers";
import {
  completeSession,
  createSession,
  getItems,
  getStudy,
  isApiError,
  nowIso,
  postAnswer,
  postGates,
} from "../../lib/api";
import { useBridge } from "../../lib/bridge";
import { parseTemperature, temperatureField } from "../../lib/format";
import { buildGatesBody, GATE_ORDER, INITIAL_GATE_STATE, type GateState } from "../../lib/gates";
import { resolveUsubjid } from "../../lib/participant";
import type {
  AnswerRequest,
  Attribute,
  CompleteResponse,
  ItemsResponse,
  Session,
  Study,
} from "../../lib/types";
import { Consent } from "./Consent";
import { GateScreen } from "./GateScreen";
import { ItemScreen } from "./ItemScreen";
import { KioskShell } from "./KioskShell";
import { Stop } from "./Stop";
import { Submitting } from "./Submitting";
import { ThankYou } from "./ThankYou";
import { Welcome } from "./Welcome";

type Step = "welcome" | "consent" | "items" | "gates" | "submitting" | "thankyou" | "stop";

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

  // ---- reference data ------------------------------------------------------
  const [catalog, setCatalog] = useState<ItemsResponse | null>(null);
  const [study, setStudy] = useState<Study | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([getItems(), getStudy().catch(() => null)])
      .then(([items, s]) => {
        setCatalog({ ...items, items: [...items.items].sort((a, b) => a.order - b.order) });
        setStudy(s);
      })
      .catch((e: unknown) => setLoadError(e))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => catalog?.items ?? [], [catalog]);
  const gateQuestions = useMemo(() => catalog?.gates ?? [], [catalog]);
  const recallWindow = catalog?.recall_window ?? "the last 7 days";
  /** The item carrying the optional typed temperature (fever_or_chills), if any. */
  const tempItem = useMemo(() => items.find((i) => temperatureField(i) !== null) ?? null, [items]);
  const tempField = useMemo(() => (tempItem ? temperatureField(tempItem) : null), [tempItem]);

  // ---- flow state ----------------------------------------------------------
  const [step, setStep] = useState<Step>("welcome");
  /** The label the participant typed (e.g. "P-007"); the USUBJID is composed on consent. */
  const [typedId, setTypedId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [consentError, setConsentError] = useState<unknown>(null);
  const [consentBusy, setConsentBusy] = useState(false);

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

  const [gateIndex, setGateIndex] = useState(0);
  const [gates, setGates] = useState<GateState>(INITIAL_GATE_STATE);
  const [gatesBusy, setGatesBusy] = useState(false);
  const [gatesError, setGatesError] = useState<unknown>(null);

  const [completeError, setCompleteError] = useState<unknown>(null);
  const [complete, setComplete] = useState<CompleteResponse | null>(null);
  const submittingRef = useRef(false);

  // ---- bridge --------------------------------------------------------------
  // Connect as soon as the kiosk loads so the socket is warm by the time the
  // participant consents. `start` is only sent after consent = Yes. The card is
  // hidden once capture has been stopped (submitting onward).
  const bridge = useBridge();
  const showVitals = consent === true && (step === "items" || step === "gates");

  const bridgeStop = bridge.stop;
  const reset = useCallback(() => {
    // A session abandoned mid-flow must not keep the bridge capturing.
    bridgeStop();
    setStep("welcome");
    setTypedId("");
    setSession(null);
    setConsent(null);
    setStartError(null);
    setConsentError(null);
    setConsentBusy(false);
    setItemIndex(0);
    setAnswers({});
    setTempC("");
    setPendingKeys(EMPTY_KEYS);
    setFailed({});
    setAckedKeys(EMPTY_KEYS);
    setAnswerError(null);
    sendSeqRef.current = new Map();
    sendChainRef.current = new Map();
    setGateIndex(0);
    setGates(INITIAL_GATE_STATE);
    setGatesBusy(false);
    setGatesError(null);
    setCompleteError(null);
    setComplete(null);
    submittingRef.current = false;
  }, [bridgeStop]);

  // ---- welcome → consent ---------------------------------------------------
  function onStart(id: string) {
    setTypedId(id);
    setStartError(null);
    setStep("consent");
  }

  // ---- consent → session → items -------------------------------------------
  const decideConsent = useCallback(
    async (value: boolean) => {
      setConsent(value);
      setConsentBusy(true);
      setConsentError(null);
      try {
        // CONTRACTS.md §5: USUBJID = "{study_id}-P-xxx". Compose it from the loaded
        // study; if the API resolves display labels instead, the 404 retry covers it.
        const { primary, fallback } = resolveUsubjid(typedId, study?.study_id);
        let s: Session;
        try {
          s = await createSession({ usubjid: primary, consent_camera: value });
        } catch (e) {
          if (fallback && isApiError(e) && e.isNotFound) {
            s = await createSession({ usubjid: fallback, consent_camera: value });
          } else {
            throw e;
          }
        }
        setSession(s);
        if (value) bridge.start(s.id, scenarioOverride);
        setStep("items");
      } catch (e) {
        // Unknown study ID → back to Welcome with a friendly message.
        if (isApiError(e) && (e.isNotFound || e.isValidation)) {
          setStartError(e);
          setStep("welcome");
        } else {
          setConsentError(e);
        }
      } finally {
        setConsentBusy(false);
      }
    },
    [typedId, study, bridge, scenarioOverride],
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

  function onSelect(itemId: string, attribute: Attribute, value: number) {
    setAnswers((prev) => ({ ...prev, [itemId]: { ...prev[itemId], [attribute]: value } }));
    // Fever answered "No": a previously typed temperature no longer belongs to the record.
    if (tempItem && itemId === tempItem.id && attribute === "presence" && value === 0) {
      setTempC("");
    }
    void sendAnswer({ item_id: itemId, attribute, value, ts_client: nowIso() });
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
    if (itemIndex + 1 < items.length) setItemIndex(itemIndex + 1);
    else {
      setGateIndex(0);
      setStep("gates");
    }
  }

  function backItem() {
    if (itemIndex > 0) setItemIndex(itemIndex - 1);
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
    if (gateIndex + 1 < GATE_ORDER.length) setGateIndex(gateIndex + 1);
    else void submitGates();
  }

  function backGate() {
    if (gateIndex > 0) setGateIndex(gateIndex - 1);
    else {
      setItemIndex(Math.max(0, items.length - 1));
      setStep("items");
    }
  }

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
      if (consent === true) await bridge.stopAndFlush(BRIDGE_FLUSH_TIMEOUT_MS);
      const res = await completeSession(session.id, { ts_client: nowIso() });
      setComplete(res);
      setStep(res.stop_screen ? "stop" : "thankyou");
    } catch (e) {
      setCompleteError(e);
    } finally {
      submittingRef.current = false;
    }
  }, [session, consent, bridge, answers, ackedKeys, pendingKeys, sendAnswer]);

  useEffect(() => {
    if (step === "submitting" && !completeError) void runComplete();
    // runComplete is stable per session/consent; we deliberately run once per entry into "submitting".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ---- render --------------------------------------------------------------
  const totalScreens = items.length + GATE_ORDER.length;
  const progress =
    step === "items"
      ? { value: itemIndex, max: totalScreens }
      : step === "gates"
        ? { value: items.length + gateIndex, max: totalScreens }
        : step === "submitting" || step === "thankyou" || step === "stop"
          ? { value: totalScreens, max: totalScreens }
          : null;

  const side = showVitals ? <VitalsPanel bridge={bridge} /> : undefined;
  const subtitle = study?.title ? study.title : undefined;

  return (
    <KioskShell subtitle={subtitle} progress={progress} side={side}>
      {step === "welcome" && (
        <Welcome
          study={study}
          loading={loading}
          loadError={loadError}
          onRetryLoad={load}
          startError={startError}
          initialId={typedId}
          onStart={onStart}
        />
      )}

      {step === "consent" && (
        <Consent
          usubjid={typedId}
          busy={consentBusy}
          error={consentError}
          onRetry={() => consent !== null && void decideConsent(consent)}
          onDecide={(v) => void decideConsent(v)}
        />
      )}

      {step === "items" && currentItem && (
        <ItemScreen
          key={currentItem.id}
          item={currentItem}
          index={itemIndex}
          total={items.length}
          recallWindow={recallWindow}
          values={currentValues}
          onSelect={(attr, value) => onSelect(currentItem.id, attr, value)}
          tempC={tempC}
          onTempChange={setTempC}
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
        <div className="text-xl text-slate-700">
          No questions are configured. Please ask the study team.
        </div>
      )}

      {step === "gates" && (
        <GateScreen
          key={gateIndex}
          index={gateIndex}
          questions={gateQuestions}
          itemCount={items.length}
          state={gates}
          onChange={(patch) => setGates((g) => ({ ...g, ...patch }))}
          onBack={backGate}
          onNext={nextGate}
          busy={gatesBusy}
          error={gatesError}
          onRetry={() => void submitGates()}
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

      {step === "thankyou" && <ThankYou onDone={reset} />}

      {step === "stop" && <Stop text={complete?.stop_screen_text} onDone={reset} />}
    </KioskShell>
  );
}
