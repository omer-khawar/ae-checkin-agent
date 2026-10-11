/**
 * Every word and number on the public landing page, in one place, so the copy
 * can be checked against the docs it quotes without reading JSX.
 *
 * Honesty rules (from the approved brief):
 * - every number carries the link to its source (`source.href`);
 * - the word "simulated" appears wherever data is simulated;
 * - no clinical-utility or diagnosis claims;
 * - the not-a-medical-device sentence is quoted verbatim (DISCLAIMER).
 *
 * Figures were checked against docs/PRD.md §2 and README.md on 2026-10-11; where
 * the brief and the docs differed, the docs' wording and URLs win:
 *   - Mednet figure: PRD cites https://www.clinicaltrialvanguard.com/?p=32325
 *   - Di Maio figure: PRD gives 40.7% to 74.4% and https://doi.org/10.1200/JCO.2014.57.9334
 * Evaluation numbers are copied from docs/eval/results.md (generated
 * 2026-10-11T04:27Z: 36/36 personas, 40/40 scorable chart-note cases) and
 * docs/eval/synthea_results.md (72 notes; symptom P 0.919 / R 0.792; medication
 * R(text) 0.178). Re-check them whenever `make eval` is rerun.
 */

export const DISCLAIMER =
  "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.";

export const TAGLINE = "Rules decide, templates write, people confirm.";

export const REPO_URL = "https://github.com/omer-khawar/ae-checkin-agent";
const DOCS = `${REPO_URL}/blob/interim/docs`;

export const LINKS = {
  repo: REPO_URL,
  license: `${REPO_URL}/blob/interim/LICENSE`,
  readme: `${REPO_URL}/blob/interim/README.md`,
  measuredVsSimulated: `${REPO_URL}/blob/interim/README.md#measured-vs-simulated`,
  evalResults: `${DOCS}/eval/results.md`,
  syntheaResults: `${DOCS}/eval/synthea_results.md`,
  whatItGetsWrong: `${DOCS}/WHAT_IT_GETS_WRONG.md`,
  notBuilt: `${DOCS}/NOT_BUILT.md`,
  decisions: `${DOCS}/DECISIONS.md`,
  protocolPdf: "https://cdn.clinicaltrials.gov/large-docs/40/NCT03088540/Prot_000.pdf",
  registryRecord: "https://clinicaltrials.gov/study/NCT03088540",
} as const;

/** Internal routes the landing page points at. */
export const ROUTES = {
  kiosk: "/kiosk",
  login: "/login",
} as const;

export const NAV = [
  { label: "How it works", href: "#how-it-works" },
  { label: "What you get", href: "#what-you-get" },
  { label: "FAQ", href: "#faq" },
] as const;

export const HERO = {
  headline: "Side effects between visits often reach the trial record late.",
  subhead:
    "Interim catches them from kiosk check-ins, chart notes and phone calls, and hands the study coordinator ready-to-confirm records, 24-hour reports and visit briefs. Rules decide, templates write, people confirm.",
  image: {
    src: "/landing/hero-queue.png",
    width: 1440,
    height: 1060,
    alt: "The coordinator's queue in Interim: check-ins, chart notes and phone calls for synthetic participants P-012, P-007, P-006 and P-003, sorted by urgency, with provisional grades, 24-hour report clocks, a SIMULATED vitals badge and the drafted records for each.",
  },
  caption: "Synthetic participants. Screens from the current build.",
} as const;

export interface Stat {
  value: string;
  label: string;
  source: { text: string; href: string };
}

export const PROBLEM = {
  eyebrow: "The problem",
  title: "Safety data is the most time-pressured part of a coordinator's week.",
  intro:
    "Between visits, participants have symptoms and start or stop other medicines. Most of it surfaces late, from memory or from an outside hospital note, and someone retypes it into the trial database under a deadline.",
  stats: [
    {
      value: "12–15 h / week",
      label:
        "spent by research coordinators, per study, copying data that already exists in the health record into the trial database.",
      source: {
        text: "Mednet, reported by Clinical Trial Vanguard (16 Sep 2026)",
        href: "https://www.clinicaltrialvanguard.com/?p=32325",
      },
    },
    {
      value: "24 h",
      label:
        "to report every serious adverse event to the sponsor, counted from when the site becomes aware of it, regardless of causality.",
      source: {
        text: "EMPOWER-Lung 1 protocol (Amendment 9), §9.4.2, p. 91",
        href: LINKS.protocolPdf,
      },
    },
    {
      value: "40.7–74.4%",
      label:
        "of the time, when patients reported a toxicity, physicians under-reported it (three randomized trials, 1,090 patients).",
      source: {
        text: "Di Maio M, et al. J Clin Oncol 2015;33(8):910–915",
        href: "https://doi.org/10.1200/JCO.2014.57.9334",
      },
    },
  ] satisfies Stat[],
} as const;

export interface Step {
  title: string;
  body: string;
  screen: string;
  route: string;
  /** Cropped from docs/screenshots/v2; omitted rather than invented. */
  image?: { src: string; alt: string };
}

export const STEPS: Step[] = [
  {
    title: "The participant feels something",
    body: "Between visits, a participant answers a short check-in in plain words: one question per screen, about the last 7 days. The camera is optional; the check-in is the same without it.",
    screen: "Kiosk",
    route: "/kiosk",
    image: {
      src: "/landing/step-1-kiosk.png",
      alt: "Kiosk welcome screen asking for a study ID, with a choice not to use the camera.",
    },
  },
  {
    title: "It gets mentioned",
    body: "Three ways in: a kiosk check-in, a chart note pasted in (clinic, urgent-care or ER record), or a phone call the coordinator logs. A deterministic scanner reads notes and calls and quotes the exact words.",
    screen: "Notes",
    route: "/dashboard/notes",
    image: {
      src: "/landing/step-2-notes.png",
      alt: "Chart notes screen with a phone note pasted in and a confirmation that three drafts were created.",
    },
  },
  {
    title: "Interim finds it",
    body: "One worklist for every source, most urgent first, with 24-hour clock chips and repeat reports merged into the side effect that is already open.",
    screen: "Queue",
    route: "/dashboard",
    image: {
      src: "/landing/step-3-queue.png",
      alt: "Queue screen listing check-ins, notes and calls by urgency, with a 'since you were last here' summary.",
    },
  },
  {
    title: "It drafts the trial records",
    body: "Side-effect, vital-sign and medication records in CDISC SDTM shape. Every field is linked to the answer, note words or rule it came from. The coordinator confirms, edits or rejects each one.",
    screen: "Check-in detail",
    route: "/dashboard/checkins/:id",
    image: {
      src: "/landing/step-4-detail.png",
      alt: "Check-in detail: answers on the left, a drafted side-effect record in the middle with one field's evidence highlighted, and the rules that fired on the right.",
    },
  },
  {
    title: "The 24-hour report is pre-filled",
    body: "When a serious or special-interest event must reach the sponsor within 24 hours, the report packet is filled from evidence, carries a drafted narrative, lists what is still missing, and shows what changed in each follow-up.",
    screen: "Report packet",
    route: "/dashboard/packets/:id",
    image: {
      src: "/landing/step-5-packet.png",
      alt: "Serious event report packet with a countdown to the sponsor deadline, pre-filled fields with evidence chips, and a list of information still needed.",
    },
  },
  {
    title: "The investigator decides",
    body: "Only the investigator records seriousness, causality and whether the event is immune-related, and signs the report. Interim never makes those calls.",
    screen: "Investigator assessment",
    route: "/dashboard/checkins/:id",
    image: {
      src: "/landing/step-6-attribution.png",
      alt: "Check-in detail with the investigator assessment recorded: seriousness no, relationship to the study drug not related.",
    },
  },
  {
    title: "Sponsor queries are answered from evidence",
    body: "When the sponsor asks about a record, each query arrives with a suggested answer that cites its evidence. The coordinator answers with the suggestion or in their own words.",
    screen: "Queries",
    route: "/dashboard/queries",
    image: {
      src: "/landing/step-7-queries.png",
      alt: "Sponsor queries screen showing a query about a missing medication dose, the evidence behind it, and an answered status.",
    },
  },
  {
    title: "A visit brief for the doctor",
    body: "One printable page per participant: everything since the last visit, open side effects, medication changes with protocol flags, and questions to ask, each line linked to its evidence.",
    screen: "Visit brief",
    route: "/dashboard/participants/:usubjid/brief",
    image: {
      src: "/landing/step-8-brief.png",
      alt: "Visit brief for participant P-003 listing new side effects since the last visit and questions to ask at the visit.",
    },
  },
];

export interface Feature {
  id: string;
  title: string;
  body: string;
  /** Wide tiles span two columns on large screens. */
  wide?: boolean;
  label?: string;
  link?: { text: string; href: string };
}

export const FEATURES: Feature[] = [
  {
    id: "packets",
    title: "24-hour report packets",
    body: "A serious or special-interest event starts a 24-hour clock when the site becomes aware. The packet arrives pre-filled from evidence, with a narrative drafted by template, a list of what is still missing, and follow-up reports that show what changed. The investigator signs.",
    wide: true,
  },
  {
    id: "protocol",
    title: "Rules that quote the real protocol",
    body: "Special-interest criteria and prohibited or discouraged medicines are JSON tables quoting the public EMPOWER-Lung 1 protocol, page by page.",
    link: { text: "The protocol (public PDF)", href: LINKS.protocolPdf },
  },
  {
    id: "evidence",
    title: "Every field shows its evidence",
    body: "Click any drafted field to see the answer, note words or rule behind it. Every action lands in a hash-chained audit log, verified with one click.",
  },
  {
    id: "queries",
    title: "Sponsor queries with suggested answers",
    body: "Each query comes with a suggested answer whose every sentence cites a stored record. Answer from the suggestion or in your own words, and correct the field if needed: the change becomes a new record version, never an overwrite.",
    wide: true,
  },
  {
    id: "briefs",
    title: "One-page visit briefs",
    body: "Everything since the last visit for one participant, printable, with questions to ask the participant.",
  },
  {
    id: "time",
    title: "Time saved, shown on screen",
    label: "estimate",
    body: "Every dashboard page shows an estimate of the coordinator minutes Interim pre-filled, with its basis on hover. One per-field rate is measured; every other minute is a labeled assumption.",
    wide: true,
  },
];

export interface ProofItem {
  headline: string;
  body: string;
  link: { text: string; href: string };
}

export const PROOF: ProofItem[] = [
  {
    headline: "36 of 36 test patients pass",
    body: "Scripted check-ins with an answer key, replayed over HTTP against the running API: urgency tier, provisional grade per symptom, 24-hour clocks, merged repeat reports and medication matches all agree.",
    link: { text: "Evaluation results", href: LINKS.evalResults },
  },
  {
    headline: "40 of 40 chart-note cases exact",
    body: "The chart-note scanner matches its answer key exactly. That key was written alongside the scanner, so this is a regression test, not an accuracy estimate.",
    link: { text: "Evaluation results", href: LINKS.evalResults },
  },
  {
    headline: "Medication recall 0.18 on notes it was not tuned on",
    body: "On 72 Synthea synthetic notes (simulated, not a clinical validation) the scanner found symptoms with precision 0.92 and recall 0.79, but only 18% of the medications visible in the note text. We show that number because it is the weak one.",
    link: { text: "Synthea evaluation", href: LINKS.syntheaResults },
  },
  {
    headline: "Measured vs simulated: every vital is labeled",
    body: 'Demo vitals come from a mock source and carry the word SIMULATED on screen and VSMETHOD = "Simulated" in exports. The API refuses a mock sample that claims to be measured.',
    link: { text: "How values are labeled", href: LINKS.measuredVsSimulated },
  },
];

export interface FaqItem {
  q: string;
  /** Paragraphs; plain text. */
  a: string[];
  code?: string;
}

export const FAQ: FaqItem[] = [
  {
    q: "Is Interim a medical device?",
    a: [
      `No. ${DISCLAIMER}`,
      'Grades are provisional and labeled "investigator to confirm". Interim never gives a participant clinical advice; an urgent check-in ends on one fixed, pre-approved screen.',
    ],
  },
  {
    q: "Does it use AI?",
    a: [
      "Gemini reads, rules decide, people confirm. Nothing is accepted without a word-for-word quote. Gemini is an optional second reader of chart notes and call summaries: it can only add findings that carry a quote our code finds in the source, and it never sets a grade, tier, seriousness or causality. Without a key, recorded answers replay; with neither, the rules-only scanner runs.",
      "Grades, urgency tiers, 24-hour clocks and protocol flags come from deterministic rules kept in JSON tables, each with its source.",
      "Generated text (report narratives, visit briefs, suggested query answers) is template-based, and every sentence cites the evidence it came from. An optional Claude writer can be switched on with an API key; its text is accepted only if every cited record exists and every quote matches, otherwise the template text is used. It is off by default.",
    ],
  },
  {
    q: "What data does it use?",
    a: [
      "Synthetic participants only (P-001 to P-012), with background charts generated by Synthea and labeled simulated. Public sources: the ClinicalTrials.gov record NCT03088540, the public EMPOWER-Lung 1 protocol, openFDA drug labels and CTCAE v5.0 term names.",
    ],
  },
  {
    q: "How do I run it?",
    a: [
      "With Docker installed, clone the repository and start it. The dashboard sign-in is at /login and the patient kiosk at /kiosk on localhost:5173. Sign in as coordinator, investigator or admin with the shared demo password (interim-demo by default, set by DEMO_PASSWORD). This is demo authentication, not production sign-on.",
    ],
    code: "git clone -b interim https://github.com/omer-khawar/ae-checkin-agent.git interim\ncd interim\ndocker compose up --build",
  },
  {
    q: "Does the camera store video?",
    a: [
      "No. Camera frames are never stored; only pulse and breathing numbers, with their confidence, are kept. In the demo those numbers come from a mock source and are labeled SIMULATED wherever they appear. The camera is optional, and the check-in works the same without it.",
    ],
  },
];

export const CREDITS =
  "Built at HackRU 2026 for the Regeneron challenge. Original AE Capture Desk by Omer Khawar. Synthetic patients from Synthea (MITRE). Vitals SDK by Presage.";
