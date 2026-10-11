"""Rule-based text scanner for check-in transcripts and chart notes.

Finds (1) possible AE symptoms mapped to CTCAE terms, (2) medication changes, (3) red-flag phrases
that need escalation, (4) requests for a human. Every finding keeps the exact quote and character
offsets so the UI can highlight it, plus a plain-English reason.

It handles the common traps in clinical text with a small NegEx-style approach:
  - negation ("denies nausea, vomiting", "no rash noted", "I haven't had any cough")
  - history ("hx of migraines")
  - instructions / hypotheticals ("call if fever > 100.4", "monitor for rash")
Excluded mentions are returned too (with the reason) so reviewers can see what was skipped.

Deliberately deterministic: easy to explain to judges, runs offline, and is scored against the
answer key by scripts/evaluate.py. An LLM extractor can be added later behind the same interface.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta

# ---------------------------------------------------------------------------
# Lexicons
# ---------------------------------------------------------------------------

_P = "(?:my|his|her|their|the)"
# A temperature in fever range, Fahrenheit (100-104.x) or Celsius (38-41.x).
_TEMP_HIGH = (r"(?:temp(?:erature)?|t)\s*(?:of |was |is |to |at |up to |:\s*)?(?:10[0-4](?:\.\d)?|3[89](?:\.\d)?|4[01](?:\.\d)?)"
              r"|10[0-4](?:\.\d)?\s*(?:°\s*f?|degrees?)")

# CTCAE v5 term -> regex patterns. (?-i:...) marks case-sensitive abbreviations.
SYMPTOM_LEXICON: dict[str, list[str]] = {
    "Nausea": [r"nause(?:a|ous|ated)", r"queasy", rf"sick to {_P} stomach", r"(?-i:N/V)", r"nausea/vomiting"],
    "Vomiting": [r"vomit(?:ing|ed|s)?", r"throw(?:ing|s)? up", r"threw up", r"emesis", r"(?-i:N/V)"],
    "Diarrhea": [
        r"diarrh(?:o)?ea",
        r"loose (?:stools?|bowel movements|(?-i:BMs?))",
        r"watery (?:stools?|bowel movements)",
        r"the runs",
    ],
    "Constipation": [r"constipat(?:ed|ion)"],
    "Rash maculo-papular": [r"rash(?:es)?", r"(?:red|itchy) (?:spots|bumps|patches)"],
    "Pruritus": [r"itch(?:y|ing|iness)", r"prurit(?:us|ic)"],
    "Urticaria": [r"hives", r"urticaria"],
    "Dyspnea": [
        r"short(?:ness)? of breath",
        r"(?-i:SOB)",
        r"(?-i:DOE)",
        r"dyspn(?:o)?ea",
        rf"(?:can't|cannot|can not|couldn't) catch {_P} breath",
        r"winded",
        r"breathless(?:ness)?",
        r"(?:trouble|difficulty|hard time) breathing",
        r"hard to breathe",
        r"out of breath",
    ],
    "Fatigue": [
        r"fatigue(?:d)?",
        r"tired(?:ness)?(?!\s+of\b)",  # not "tired of this"
        r"exhaust(?:ed|ion)",
        r"(?:no|low|lack of|zero) energy",
        r"letharg(?:y|ic)",
        r"sleep(?:ing|s)? (?:all|most of) (?:the )?day",
        r"wiped out",
        r"worn out",
    ],
    "Cough": [r"cough(?:ing|s|ed)?"],
    "Headache": [r"headaches?", r"(?-i:HA)", r"migraines?"],
    "Anorexia": [
        rf"(?:decreased|poor|low|no|loss of|lost {_P}) appetite",
        r"not (?:eating|hungry)",
        r"(?:hasn't|haven't|has not|have not) been eating",
    ],
    "Fever": [r"fevers?", r"feverish", r"febrile", _TEMP_HIGH],
    "Chills": [r"chills", r"rigors"],
    "Dizziness": [r"dizz(?:y|iness)", r"light-?headed(?:ness)?", r"vertigo"],
    "Mucositis oral": [r"(?:mouth|oral|aphthous) (?:sores?|ulcers?)", rf"sores? in {_P} mouth", r"stomatitis", r"mucositis"],
    "Chest pain - cardiac": [r"chest (?:pain|pressure|tightness)"],
    "Abdominal pain": [r"(?:abdominal|stomach|belly|abd) (?:pain|cramps?|cramping)", r"stomach ?ache"],
    "Arthralgia": [r"joint (?:pain|aches?)", r"arthralgias?"],
    "Myalgia": [r"muscle (?:aches?|pain)", r"myalgias?"],
    "Insomnia": [r"insomnia", r"(?:can't|cannot|couldn't) sleep", r"trouble sleeping"],
    "Edema limbs": [
        r"(?:leg|ankle|feet|foot) swelling",
        r"swollen (?:legs?|ankles?|feet|foot)",
        r"(?:pedal|peripheral|lower extremity|(?-i:LE)) edema",
    ],
    "Confusion": [
        r"(?:new|increased|increasing|worsening|acute) confusion",
        r"altered mental status",
        r"(?-i:AMS)",
        r"disoriented",
        # "confused" but not "confused about/whether/if" (the patient unsure if a symptom counts)
        r"confused(?!\s+(?:about|whether|if|by|on|as to|why|what))",
    ],
    "Sinusitis": [r"sinusitis", r"sinus infection"],
    "Upper respiratory infection": [r"(?-i:URI)", r"upper respiratory infection", r"head cold", r"chest cold"],
    "Urinary tract infection": [r"(?-i:UTI)", r"urinary tract infection", r"bladder infection"],
    "Pneumonitis": [r"pneumonitis"],
    "Bronchial infection": [r"bronchitis"],
    "Colitis": [r"colitis"],
}

# generic name -> patterns (brands / abbreviations included)
MED_LEXICON: dict[str, list[str]] = {
    "ondansetron": [r"ondansetron", r"zofran"],
    "loperamide": [r"loperamide", r"imodium"],
    "amoxicillin-clavulanate": [r"augmentin", r"amoxicillin[- /]clavulanate", r"amox[- /]clav"],
    "amoxicillin": [r"amoxicillin(?![- /]clav)", r"amoxil"],
    "azithromycin": [r"azithromycin", r"zithromax", r"z-?pac?k"],
    "doxycycline": [r"doxycycline"],
    "cephalexin": [r"cephalexin", r"keflex"],
    "ciprofloxacin": [r"cipro(?:floxacin)?"],
    "levofloxacin": [r"levofloxacin", r"levaquin"],
    "nitrofurantoin": [r"nitrofurantoin", r"macrobid"],
    "prednisone": [r"prednisone"],
    "methylprednisolone": [r"methylprednisolone", r"medrol", r"solu-?medrol"],
    "dexamethasone": [r"dexamethasone", r"decadron"],
    "hydrocortisone": [r"hydrocortisone"],
    "triamcinolone": [r"triamcinolone"],
    "diphenhydramine": [r"diphenhydramine", r"benadryl"],
    "cetirizine": [r"cetirizine", r"zyrtec"],
    "loratadine": [r"loratadine", r"claritin"],
    "acetaminophen": [r"acetaminophen", r"tylenol", r"paracetamol"],
    "ibuprofen": [r"ibuprofen", r"advil", r"motrin"],
    "naproxen": [r"naproxen", r"aleve"],
    "omeprazole": [r"omeprazole", r"prilosec"],
    "famotidine": [r"famotidine", r"pepcid"],
    "metoclopramide": [r"metoclopramide", r"reglan"],
    "prochlorperazine": [r"prochlorperazine", r"compazine"],
    "albuterol": [r"albuterol", r"ventolin", r"proair"],
    "benzonatate": [r"benzonatate", r"tessalon"],
    "guaifenesin": [r"guaifenesin", r"mucinex"],
    "dextromethorphan": [r"dextromethorphan", r"robitussin"],
    "oseltamivir": [r"oseltamivir", r"tamiflu"],
    "fluconazole": [r"fluconazole", r"diflucan"],
    "lorazepam": [r"lorazepam", r"ativan"],
    "melatonin": [r"melatonin"],
    "oxycodone": [r"oxycodone"],
    "docusate": [r"docusate", r"colace"],
    "senna": [r"senna", r"senokot"],
    "polyethylene glycol": [r"polyethylene glycol", r"miralax"],
    "bismuth subsalicylate": [r"bismuth subsalicylate", r"pepto(?:-?bismol)?"],
    "lisinopril": [r"lisinopril"],
    "metformin": [r"metformin"],
    "atorvastatin": [r"atorvastatin", r"lipitor"],
    "levothyroxine": [r"levothyroxine", r"synthroid"],
    "amlodipine": [r"amlodipine", r"norvasc"],
}

# ---------------------------------------------------------------------------
# Context rules
# ---------------------------------------------------------------------------

_NEGATION = re.compile(
    r"\b(?:no|not|never|none|denies|denied|deny|denying|without|negative for|free of|absence of)\b|\w+n't\b",
    re.I,
)
# Phrases that contain a negation word but don't negate the symptom ("I can't stop coughing").
_PSEUDO_NEGATION = re.compile(
    r"\b(?:can't stop|cannot stop|won't stop|couldn't stop|not only|not sure|no change in|not improved|not better|"
    r"no improvement|didn't help|doesn't help|won't go away|not going away|no relief|not gone)\b",
    re.I,
)
_TERMINATOR = re.compile(
    r"\b(?:but|however|although|though|except|aside from|apart from|reports?|reported|reporting|endorses?|"
    r"endorsed|complains?|complained|c/o|presents?|presented|states?|stated|says|said|notes?|noted|now|"
    r"which|who|with|started|starting|began|positive for)\b|[;:]|,\s*(?:and\s+)?(?:has|had|is|was|now)\b",
    re.I,
)
_HISTORICAL = re.compile(r"\b(?:history of|hx of|h/o|previously had|prior history of|in the past had)\b", re.I)
_HYPOTHETICAL = re.compile(
    r"\b(?:call (?:if|for|with)|return (?:if|for)|seek care if|go to the (?:er|ed) if|precautions|monitor(?:ing)? for|"
    r"watch for|educated|education|instructed|warning signs|in case of|risk of|side effects? (?:include|such as|of)|"
    r"counsell?ed|if (?:he|she|they|you|pt|patient) (?:develops?|experiences?|has|have|notices?|gets?))\b",
    re.I,
)
_POST_NEGATION = re.compile(r"^\W{0,3}(?:was |were |is )?(?:ruled out|absent|negative)\b", re.I)
_RESOLVED = re.compile(r"^\W{0,3}(?:has |have |had )?(?:resolved|went away|gone away|is gone|improved)\b", re.I)

_SEVERITY_WORDS = [
    (re.compile(r"\b(?:very severe|severe|significant|intractable|debilitating|unbearable|terrible)\b", re.I), 3),
    (re.compile(r"\bmoderate\b", re.I), 2),
    (re.compile(r"\b(?:mild|slight|minimal|a little|a bit of)\b", re.I), 1),
]
_EXPLICIT_GRADE = re.compile(r"\b(?:grade\s*([1-5])|(?-i:G([1-5])))\b", re.I)
_STOOL_COUNT = re.compile(
    r"(\d+)\s*(?:x|times|episodes|stools|loose stools|(?-i:BMs?)|bowel movements)\s*(?:a|per|/)?\s*(?:day|d)\b",
    re.I,
)
_BSA = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:(?-i:BSA)|body surface area)", re.I)
_WORSENING = re.compile(r"\b(?:worse|worsening|getting worse|increasing|increased|progressive)\b", re.I)
_HOSPITAL = re.compile(
    r"\b(?:admitted|admission|hospitali[sz](?:ed|ation)|(?-i:ED|ER) visit|emergency (?:room|department)|"
    r"went to the (?:(?-i:ER|ED)|er|hospital)|in the hospital|inpatient|(?-i:ER|ED))\b",
    re.I,
)

_NUM_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "a couple of": 2, "a couple": 2, "a few": 3, "several": 4,
}
_DURATION = re.compile(
    r"(?:(?<=x)|\b)(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a couple(?: of)?|a few|several)\s*"
    r"(days?|d|weeks?|wks?)\b",
    re.I,
)
_RELATIVE_DAY = [
    (re.compile(r"\b(?:since yesterday|yesterday|last night)\b", re.I), 1),
    (re.compile(r"\b(?:this morning|today|tonight)\b", re.I), 0),
    (re.compile(r"\b(?:last|past|over the past|over the last) week\b", re.I), 7),
    (re.compile(r"\b(?:last|past) (?:few|couple of|several) days\b", re.I), 3),
    (re.compile(r"\b(?:last|past) (?:two|2) weeks\b", re.I), 14),
    (re.compile(r"\b(?:last|past) month\b", re.I), 30),
]

# Medication action verbs
_MED_STARTED = re.compile(
    r"\b(?:start(?:ed|s|ing)?|began|begun|begin(?:ning)?|initiat(?:ed|e)|prescribed|given|gave me|put (?:him |her |me )?on|"
    r"added|rx'?d|(?-i:Rx)|new prescription|new rx|picked up|got (?:a prescription|prescribed))\b",
    re.I,
)
_MED_STOPPED = re.compile(
    r"\b(?:stop(?:ped|s|ping)?|discontinu(?:ed|e)|d/c'?d|d/c|(?-i:DC'?d)|held|holding|hold|quit|ran out|"
    r"no longer taking|not taking|off of|came off)\b",
    re.I,
)
_MED_CHANGED = re.compile(
    r"\b(?:increas(?:ed|e)|decreas(?:ed|e)|reduc(?:ed|e)|titrat(?:ed|e)|doubled|halved|switched|changed (?:the )?dose)\b",
    re.I,
)
_MED_NEGATED = re.compile(r"\b(?:did not start|didn't start|declined|refused|not prescribed|never started)\b", re.I)
_ALLERGY = re.compile(r"\ballerg", re.I)
_INDICATION = re.compile(
    r"\bfor\s+(?:(?:the|his|her|my|a|an|possible|presumed|suspected|likely)\s+)*([a-z][a-z /-]{2,40}?)"
    r"(?=[,.;)]|\s+(?:and|with|since|started|starting|today|yesterday|x\s*\d|\d)\b|$)",
    re.I,
)

# Red flags: (level, category, pattern, reason). Emergency = tell the patient to call 911 now.
RED_FLAGS: list[tuple[str, str, str, str]] = [
    ("emergency", "chest_pain", r"chest (?:pain|pressure|tightness)", "Chest pain/pressure reported"),
    ("emergency", "cannot_breathe", r"(?:can't|cannot|can not|couldn't|unable to) breathe|struggling to breathe|gasping|"
     r"(?:lips|face) (?:turning |are |is )?blue", "Severe breathing difficulty reported"),
    ("emergency", "syncope", r"passed out|fainted|blacked out|unconscious|unresponsive|lost consciousness",
     "Loss of consciousness reported"),
    ("emergency", "seizure", r"seizures?|convulsions?", "Seizure reported"),
    ("emergency", "anaphylaxis", r"(?:throat|tongue|lips?|face) (?:is |are |was |were )?(?:swelling|swollen|closing)|"
     r"swelling (?:of|in) (?:my|his|her|the) (?:throat|tongue|lips|face)|anaphyla\w*", "Possible allergic reaction (swelling of face/throat)"),
    ("emergency", "bleeding", r"(?:coughing|vomiting|throwing) up blood|won't stop bleeding|heavy bleeding",
     "Serious bleeding reported"),
    ("emergency", "stroke_signs", r"slurred speech|face (?:is )?droop\w*|can't (?:move|feel) (?:my|his|her) (?:arm|leg|face)",
     "Possible stroke signs reported"),
    ("emergency", "self_harm", r"suicid\w*|kill (?:my|him|her)self|end (?:my|his|her) life|want to die|hurt (?:my|him|her)self",
     "Possible self-harm risk"),
    ("urgent", "dyspnea", r"(?:breath\w*|(?-i:SOB)|dyspn\w*)[^.;]{0,40}\b(?:worse|worsening|getting worse)\b|"
     r"\b(?:worse|worsening|increasing)\b[^.;]{0,25}(?:short(?:ness)? of breath|(?-i:SOB)|dyspn\w*|breathing)",
     "Worsening shortness of breath"),
    ("urgent", "fever", r"fevers?\b|febrile|" + _TEMP_HIGH,
     "Fever reported (oncology trials: possible infection / neutropenic fever)"),
    ("urgent", "confusion", r"(?:new|increased|increasing|worsening|acute) confusion|altered mental status|disoriented|"
     r"(?:he|she|they)(?:'s| is| has been| seems| seemed)? (?:very |really |more |so )?confused(?!\s+(?:about|whether|if|by))",
     "New confusion reported"),
    ("urgent", "gi_bleed", r"(?:black|tarry|bloody) stools?|blood in (?:my |his |her |the )?(?:stool|urine|poop)",
     "Possible GI/urinary bleeding"),
    ("urgent", "dehydration", r"(?:can't|cannot|couldn't|unable to) keep (?:anything|food|fluids|water|liquids|"
     r"(?:my |his |her )?(?:pills|meds|medicines?|medications?))\s+down",
     "Unable to keep fluids down"),
    ("urgent", "jaundice", r"yellow(?:ing)? (?:of )?(?:my |his |her |the )?(?:skin|eyes)|jaundice\w*",
     "Yellowing of skin/eyes (possible liver toxicity)"),
    ("urgent", "skin_blistering", r"blister\w*|peeling skin|skin (?:is )?peeling", "Blistering/peeling skin (possible severe skin reaction)"),
    ("urgent", "hospitalization", _HOSPITAL.pattern, "Hospitalization or ER visit (possible serious AE)"),
]
_RED_FLAGS = [(lvl, cat, re.compile(rf"(?<!\w)(?:{p})", re.I), reason) for lvl, cat, p, reason in RED_FLAGS]

_HUMAN_REQUEST = re.compile(
    r"\b(?:speak|talk|connect me|transfer me)\s+(?:to|with)\s+(?:a |an |the |my )?(?:real |actual |live )?"
    r"(?:person|human|nurse|doctor|someone|somebody|representative|coordinator)\b|"
    r"\breal person\b|\bhuman\b|\brepresentative\b|\boperator\b",
    re.I,
)

_SYMPTOM_RX = [(term, re.compile(rf"\b(?:{p})\b", re.I)) for term, pats in SYMPTOM_LEXICON.items() for p in pats]
_MED_RX = [(drug, re.compile(rf"\b(?:{p})\b", re.I)) for drug, pats in MED_LEXICON.items() for p in pats]

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class SymptomFinding:
    term: str
    quote: str  # the matched words
    sentence: str
    span_start: int
    span_end: int
    grade: int = 1
    grade_basis: str = "mentioned without a severity word -> provisional grade 1"
    onset_days_ago: int | None = None
    onset_date: date | None = None
    worsening: bool = False
    resolved: bool = False
    serious_cue: str | None = None
    excluded: str | None = None  # negated | historical | hypothetical (None = counts)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["onset_date"] = self.onset_date.isoformat() if self.onset_date else None
        return d


@dataclass
class MedFinding:
    drug: str
    mentioned_as: str
    action: str
    sentence: str
    span_start: int
    span_end: int
    reasoning: str
    indication: str | None = None
    excluded: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RedFlag:
    level: str
    category: str
    reason: str
    quote: str
    span_start: int
    span_end: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ScanResult:
    symptoms: list[SymptomFinding] = field(default_factory=list)
    meds: list[MedFinding] = field(default_factory=list)
    red_flags: list[RedFlag] = field(default_factory=list)
    human_requested: bool = False
    excluded_symptoms: list[SymptomFinding] = field(default_factory=list)
    excluded_meds: list[MedFinding] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "symptoms": [s.to_dict() for s in self.symptoms],
            "meds": [m.to_dict() for m in self.meds],
            "red_flags": [r.to_dict() for r in self.red_flags],
            "human_requested": self.human_requested,
            "excluded_symptoms": [s.to_dict() for s in self.excluded_symptoms],
            "excluded_meds": [m.to_dict() for m in self.excluded_meds],
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sentences(text: str) -> list[tuple[int, int]]:
    """(start, end) offsets of sentences. Splits on . ! ? newline, but not on decimals like 100.4."""
    spans, start = [], 0
    for m in re.finditer(r"(?<!\d)[.!?](?!\d)|\n+", text):
        end = m.end()
        if text[start:end].strip():
            spans.append((start, end))
        start = end
    if text[start:].strip():
        spans.append((start, len(text)))
    return spans


def _sentence_for(spans: list[tuple[int, int]], pos: int) -> tuple[int, int]:
    for s, e in spans:
        if s <= pos < e:
            return s, e
    return (spans[0][0], spans[-1][1]) if spans else (0, pos + 1)


def _scope_before(text: str, sent_start: int, pos: int, max_words: int = 8) -> str:
    """Words before `pos` in the same sentence, cut at the last terminator, at most max_words."""
    pre = text[sent_start:pos]
    terminators = list(_TERMINATOR.finditer(pre))
    if terminators:
        pre = pre[terminators[-1].end():]
    words = pre.split()
    return " ".join(words[-max_words:])


def _context_exclusion(text: str, sent_start: int, sent_end: int, start: int, end: int) -> str | None:
    scope = _PSEUDO_NEGATION.sub(" ", _scope_before(text, sent_start, start))
    if _NEGATION.search(scope):
        return "negated"
    if _POST_NEGATION.search(text[end:sent_end]):
        return "negated"
    if _HISTORICAL.search(scope):
        return "historical"
    if _HYPOTHETICAL.search(text[sent_start:start]):
        return "hypothetical"
    return None


def _days_from_phrase(num: str, unit: str) -> int:
    n = int(num) if num.isdigit() else _NUM_WORDS.get(num.lower(), 1)
    return n * 7 if unit.lower().startswith("w") else n


def _onset_days(window: str) -> int | None:
    m = _DURATION.search(window)
    if m:
        return _days_from_phrase(m.group(1), m.group(2))
    for rx, days in _RELATIVE_DAY:
        if rx.search(window):
            return days
    return None


def _grade_from_context(term: str, pre: str, post: str, window: str, sentence: str) -> tuple[int, str]:
    """Nearest severity cue wins: explicit grade > stool count > severity word just before > just after."""
    m = _EXPLICIT_GRADE.search(window)
    if m:
        g = int(m.group(1) or m.group(2))
        return g, f"explicit 'grade {g}' written in the text"
    if term == "Rash maculo-papular":
        m = _BSA.search(sentence)
        if m:
            pct = float(m.group(1))
            g = 1 if pct < 10 else 2 if pct <= 30 else 3
            return g, f"{m.group(0)} -> CTCAE v5 maculo-papular rash grade {g} (<10% G1, 10-30% G2, >30% G3)"
    if term == "Diarrhea":
        m = _STOOL_COUNT.search(sentence)
        if m:
            n = int(m.group(1))
            g = 1 if n < 4 else 2 if n <= 6 else 3
            return g, f"{n} stools/day -> CTCAE v5 diarrhea grade {g} (assumes baseline ~0 over usual)"
    best = None  # (distance, grade, word)
    for rx, g in _SEVERITY_WORDS:
        for mm in rx.finditer(pre):
            d = len(pre) - mm.end()
            if best is None or d < best[0]:
                best = (d, g, mm.group(0))
        mm = rx.search(post)
        if mm and (best is None or mm.start() < best[0]):
            best = (mm.start(), g, mm.group(0))
    if best:
        return best[1], f"severity word '{best[2]}' next to the symptom -> provisional grade {best[1]}"
    return 1, "mentioned without a severity word -> provisional grade 1"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def find_symptoms(text: str, ref_date: date | None = None) -> tuple[list[SymptomFinding], list[SymptomFinding]]:
    ref_date = ref_date or date.today()
    spans = _sentences(text)
    hits: dict[tuple[str, int], SymptomFinding] = {}
    taken: dict[str, list[tuple[int, int]]] = {}  # avoid overlapping matches for the same term

    for term, rx in _SYMPTOM_RX:
        for m in rx.finditer(text):
            start, end = m.span()
            if any(not (end <= s or start >= e) for s, e in taken.get(term, [])):
                continue
            ss, se = _sentence_for(spans, start)
            sentence = text[ss:se].strip()
            window = text[max(ss, start - 60):min(se, end + 60)]
            f = SymptomFinding(term=term, quote=m.group(0), sentence=sentence, span_start=start, span_end=end)
            f.excluded = _context_exclusion(text, ss, se, start, end)
            f.grade, f.grade_basis = _grade_from_context(
                term, text[max(ss, start - 30):start], text[end:min(se, end + 25)], window, sentence
            )
            f.onset_days_ago = _onset_days(text[max(ss, start - 30):min(se, end + 35)])
            if f.onset_days_ago is not None:
                f.onset_date = ref_date - timedelta(days=f.onset_days_ago)
            f.worsening = bool(_WORSENING.search(window))
            f.resolved = bool(_RESOLVED.search(text[end:se]))
            hm = _HOSPITAL.search(sentence)
            if hm and not f.excluded:
                f.serious_cue = f"'{hm.group(0)}' in the same sentence (possible hospitalization)"
                if f.grade < 3:
                    f.grade, f.grade_basis = 3, f.grade_basis + "; raised to 3 because hospitalization/ER is mentioned"
            hits[(term, start)] = f
            taken.setdefault(term, []).append((start, end))

    kept, excluded = [], []
    # One finding per term (keep the highest grade; merge onset/serious cues).
    by_term: dict[str, SymptomFinding] = {}
    for f in sorted(hits.values(), key=lambda x: x.span_start):
        if f.excluded:
            excluded.append(f)
            continue
        cur = by_term.get(f.term)
        if cur is None or f.grade > cur.grade:
            if cur is not None:
                f.onset_date = f.onset_date or cur.onset_date
                f.serious_cue = f.serious_cue or cur.serious_cue
            by_term[f.term] = f
        else:
            cur.onset_date = cur.onset_date or f.onset_date
            cur.serious_cue = cur.serious_cue or f.serious_cue
            cur.worsening = cur.worsening or f.worsening
    kept = list(by_term.values())
    # A term that is both mentioned and negated elsewhere counts as mentioned; drop its exclusions.
    excluded = [f for f in excluded if f.term not in by_term]
    return kept, excluded


def find_meds(text: str, ref_date: date | None = None) -> tuple[list[MedFinding], list[MedFinding]]:
    ref_date = ref_date or date.today()
    spans = _sentences(text)
    kept: dict[str, MedFinding] = {}
    excluded: list[MedFinding] = []
    covered: list[tuple[int, int]] = []

    for drug, rx in _MED_RX:
        for m in rx.finditer(text):
            start, end = m.span()
            if any(not (end <= s or start >= e) for s, e in covered):
                continue  # e.g. "amoxicillin" inside "amoxicillin-clavulanate"
            covered.append((start, end))
            ss, se = _sentence_for(spans, start)
            sentence = text[ss:se].strip()
            # clause = sentence segment bounded by commas / semicolons around the drug
            cs = max(text.rfind(",", ss, start), text.rfind(";", ss, start), ss - 1) + 1
            ce_candidates = [i for i in (text.find(",", end, se), text.find(";", end, se)) if i != -1]
            ce = min(ce_candidates) if ce_candidates else se
            before, after = text[cs:start], text[end:ce]

            f = MedFinding(drug=drug, mentioned_as=m.group(0), action="taking", sentence=sentence,
                           span_start=start, span_end=end, reasoning="")

            if _ALLERGY.search(text[max(ss, start - 40):start]) or sentence.lower().startswith("allerg"):
                f.excluded, f.reasoning = "allergy", "listed as an allergy, not a medication taken"
                excluded.append(f)
                continue
            if _MED_NEGATED.search(before + " " + after[:30]):
                f.excluded, f.reasoning = "negated", "medication was declined / not started"
                excluded.append(f)
                continue

            # nearest action verb: last one before the drug, else first one shortly after it
            best = None
            for rx_act, action in ((_MED_STARTED, "started"), (_MED_STOPPED, "stopped"), (_MED_CHANGED, "dose_changed")):
                for am in rx_act.finditer(before):
                    dist = len(before) - am.end()
                    if best is None or dist < best[0]:
                        best = (dist, action, am.group(0), "before")
                am = rx_act.search(after[:40])
                if am:
                    dist = am.start()
                    if best is None or dist < best[0]:
                        best = (dist, action, am.group(0), "after")
            if best:
                f.action = best[1]
                f.reasoning = f"'{best[2]}' appears {best[3]} '{f.mentioned_as}' in the same clause -> {best[1]}"
            else:
                f.reasoning = f"'{f.mentioned_as}' mentioned with no start/stop verb -> currently taking"

            # Indication: "X for <reason>" right after the drug (stopping at the next action verb), else a
            # "for <reason>" earlier in the same sentence ("for a sinus infection, they put me on X").
            region = text[end:ce]
            cut = [m2.start() for m2 in (r.search(region) for r in (_MED_STARTED, _MED_STOPPED, _MED_CHANGED)) if m2]
            region = region[: min(cut)] if cut else region
            im = _INDICATION.search(region)
            if not im and not any(r.search(text[ss:start]) for _, r in _MED_RX):
                before_hits = list(_INDICATION.finditer(text[ss:start]))
                im = before_hits[-1] if before_hits else None
            if im:
                raw = im.group(1).strip()
                syms, _ = find_symptoms(raw, ref_date)
                f.indication = syms[0].term if syms else raw

            prev = kept.get(drug)
            if prev is None or (prev.action == "taking" and f.action != "taking"):
                kept[drug] = f
    return list(kept.values()), excluded


def find_red_flags(text: str) -> list[RedFlag]:
    spans = _sentences(text)
    out: list[RedFlag] = []
    seen: set[str] = set()
    for level, cat, rx, reason in _RED_FLAGS:
        for m in rx.finditer(text):
            ss, se = _sentence_for(spans, m.start())
            if cat in seen or _context_exclusion(text, ss, se, m.start(), m.end()):
                continue
            seen.add(cat)
            out.append(RedFlag(level, cat, reason, text[ss:se].strip(), m.start(), m.end()))
            break
    return out


def scan_text(text: str, ref_date: date | None = None, *, detect_human_request: bool = False) -> ScanResult:
    symptoms, excl_sym = find_symptoms(text, ref_date)
    meds, excl_meds = find_meds(text, ref_date)
    return ScanResult(
        symptoms=symptoms,
        meds=meds,
        red_flags=find_red_flags(text),
        human_requested=bool(detect_human_request and _HUMAN_REQUEST.search(text)),
        excluded_symptoms=excl_sym,
        excluded_meds=excl_meds,
    )
