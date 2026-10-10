"""Check-in question set.

Symptom items follow the NCI PRO-CTCAE structure: each symptom is asked about along one or more
attributes (frequency, severity, interference, presence) with the standard 5-point response scales
and a "past 7 days" recall period. Item wording follows the public NCI PRO-CTCAE item library:
https://healthcaredelivery.cancer.gov/pro-ctcae/

This is a deliberately small subset (10 of the 78 PRO-CTCAE symptom terms) chosen for the demo
personas. Add more by appending to SYMPTOMS.
"""

from dataclasses import dataclass, field

SCALES: dict[str, list[str]] = {
    "frequency": ["Never", "Rarely", "Occasionally", "Frequently", "Almost constantly"],
    "severity": ["None", "Mild", "Moderate", "Severe", "Very severe"],
    "interference": ["Not at all", "A little bit", "Somewhat", "Quite a bit", "Very much"],
    "presence": ["No", "Yes"],
    "yes_no": ["No", "Yes"],
}

# Spoken / typed phrases that map onto each scale value. Checked longest-phrase-first so
# "very severe" beats "severe" and "not at all" beats "at all".
SCALE_SYNONYMS: dict[str, dict[int, list[str]]] = {
    "frequency": {
        0: ["never", "not at all", "none", "no", "zero"],
        1: ["rarely", "once", "one time", "hardly", "barely", "a little"],
        2: ["occasionally", "sometimes", "a few times", "now and then", "some"],
        3: ["frequently", "often", "a lot", "most days", "every day", "daily"],
        4: ["almost constantly", "constantly", "all the time", "nonstop", "non-stop", "always"],
    },
    "severity": {
        0: ["none", "no", "not at all", "nothing"],
        1: ["mild", "a little", "slight", "slightly", "minor", "not bad"],
        2: ["moderate", "medium", "kind of bad", "pretty noticeable", "some"],
        3: ["severe", "bad", "really bad", "pretty bad", "strong"],
        4: ["very severe", "extremely", "worst", "unbearable", "terrible", "horrible"],
    },
    "interference": {
        0: ["not at all", "no", "none", "didn't", "did not"],
        1: ["a little bit", "a little", "slightly", "barely"],
        2: ["somewhat", "some", "moderately"],
        3: ["quite a bit", "a lot", "a good amount"],
        4: ["very much", "completely", "couldn't do anything", "totally", "extremely"],
    },
    "presence": {0: ["no", "nope", "none", "i didn't", "i did not"], 1: ["yes", "yeah", "yep", "i did", "i have", "some"]},
    "yes_no": {0: ["no", "nope", "none", "nothing", "i didn't", "i did not", "i haven't"], 1: ["yes", "yeah", "yep", "i did", "i have"]},
}


@dataclass(frozen=True)
class Symptom:
    key: str
    label: str  # wording used in the question
    ctcae_term: str  # CTCAE v5 term this maps to
    attributes: tuple[str, ...]


SYMPTOMS: list[Symptom] = [
    Symptom("nausea", "NAUSEA", "Nausea", ("frequency", "severity")),
    Symptom("vomiting", "VOMITING", "Vomiting", ("frequency", "severity")),
    Symptom("diarrhea", "LOOSE OR WATERY STOOLS (DIARRHEA/DIARRHOEA)", "Diarrhea", ("frequency",)),
    Symptom("rash", "RASH", "Rash maculo-papular", ("presence",)),
    Symptom("shortness_of_breath", "SHORTNESS OF BREATH", "Dyspnea", ("severity", "interference")),
    Symptom("fatigue", "FATIGUE, TIREDNESS, OR LACK OF ENERGY", "Fatigue", ("severity", "interference")),
    Symptom("cough", "COUGH", "Cough", ("severity", "interference")),
    Symptom("decreased_appetite", "DECREASED APPETITE", "Anorexia", ("severity", "interference")),
    Symptom("headache", "HEADACHE", "Headache", ("frequency", "severity", "interference")),
    Symptom("chills", "SHAKING CHILLS", "Chills", ("frequency", "severity")),
]
SYMPTOM_BY_KEY = {s.key: s for s in SYMPTOMS}

_TEMPLATES = {
    "frequency": "In the last 7 days, how OFTEN did you have {label}?",
    "severity": "In the last 7 days, what was the SEVERITY of your {label} at its WORST?",
    "interference": "In the last 7 days, how much did {label} INTERFERE with your usual or daily activities?",
    "presence": "In the last 7 days, did you have any {label}?",
}


@dataclass
class Question:
    id: str
    text: str
    attribute: str  # frequency | severity | interference | presence | yes_no
    options: list[str]
    symptom: str | None = None
    ctcae_term: str | None = None
    asks_for_details: bool = False
    details_prompt: str | None = None
    tags: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "attribute": self.attribute,
            "options": [{"value": i, "label": label} for i, label in enumerate(self.options)],
            "symptom": self.symptom,
            "ctcae_term": self.ctcae_term,
            "asks_for_details": self.asks_for_details,
            "details_prompt": self.details_prompt,
        }


def _build_questions() -> list[Question]:
    qs: list[Question] = []
    for s in SYMPTOMS:
        for attr in s.attributes:
            qs.append(
                Question(
                    id=f"{s.key}.{attr}",
                    text=_TEMPLATES[attr].format(label=s.label),
                    attribute=attr,
                    options=SCALES[attr],
                    symptom=s.key,
                    ctcae_term=s.ctcae_term,
                )
            )
    qs += [
        Question(
            id="meds.changes",
            text=(
                "Since your last check-in, have you STARTED, STOPPED, or CHANGED any medicines? This includes "
                "over-the-counter medicines, vitamins, and anything another doctor or urgent care gave you."
            ),
            attribute="yes_no",
            options=SCALES["yes_no"],
            asks_for_details=True,
            details_prompt="Which medicine, and did you start it, stop it, or change the dose? What was it for?",
            tags=["conmed"],
        ),
        Question(
            id="care.visits",
            text=(
                "Since your last check-in, have you gone to an EMERGENCY ROOM or URGENT CARE, or stayed overnight "
                "in a HOSPITAL?"
            ),
            attribute="yes_no",
            options=SCALES["yes_no"],
            asks_for_details=True,
            details_prompt="Where did you go, when, and what was it for?",
            tags=["sae"],
        ),
        Question(
            id="other.text",
            text=(
                "Is there anything else about how you've been feeling that you want the research team to know? "
                "It's okay if you're not sure whether it counts. The team would rather hear about it."
            ),
            attribute="text",
            options=[],
            asks_for_details=True,
            tags=["free_text"],
        ),
    ]
    return qs


QUESTIONS: list[Question] = _build_questions()
QUESTION_BY_ID = {q.id: q for q in QUESTIONS}


def parse_spoken_answer(attribute: str, text: str) -> int | None:
    """Map a free-text / speech-to-text answer onto a scale value. Returns None if unclear."""
    import re

    synonyms = SCALE_SYNONYMS.get(attribute)
    if not synonyms or not text:
        return None
    t = " " + re.sub(r"[^a-z0-9' -]", " ", text.lower()) + " "
    # Exact option label match first (e.g. "Quite a bit"), longest label first so "Very severe"
    # is not read as "Severe".
    labels = sorted(enumerate(SCALES.get(attribute, [])), key=lambda vl: -len(vl[1]))
    for value, label in labels:
        if f" {label.lower()} " in t:
            return value
    # Bare digit 0-4.
    m = re.fullmatch(r"\s*([0-4])\s*", t)
    if m:
        return int(m.group(1))
    candidates = sorted(
        ((phrase, value) for value, phrases in synonyms.items() for phrase in phrases),
        key=lambda pv: -len(pv[0]),
    )
    for phrase, value in candidates:
        if f" {phrase} " in t:
            return value
    return None
