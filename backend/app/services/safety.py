"""Safety rules for the check-in agent.

Rules of the road from the Regeneron starter sheet, enforced here so every frontend gets them for free:
  - say it's automated at the start of every call       -> opening_script()
  - offer a human at any point                          -> human-request detection + escalation
  - never give medical advice                           -> scripted, non-clinical patient messages only
  - send emergencies to 911 immediately                 -> EMERGENCY message returned the moment it's detected
  - only call people who consented                      -> enforced in the check-in router
The investigator decides seriousness and attribution; this module only routes and escalates.
"""

from app.services.items import SCALES, SYMPTOM_BY_KEY

PATIENT_MESSAGES = {
    "emergency": (
        "I'm an automated assistant and I can't help in an emergency. What you described could be serious. "
        "Please hang up and call 911 now. I'm alerting your research team right away."
    ),
    "emergency_self_harm": (
        "I'm an automated assistant and I can't help in an emergency. Please call 911 now, or call or text 988 "
        "to reach the Suicide & Crisis Lifeline. I'm alerting your research team right away."
    ),
    "urgent": (
        "Thank you for telling me. I've flagged this for your research nurse, who will contact you today. "
        "If it gets worse or feels like an emergency, call 911."
    ),
    "human_requested": (
        "Of course. I'm letting the research team know you'd like to talk to a person, and someone will contact "
        "you. You can also call the study team's number at any time. If this is an emergency, call 911."
    ),
}

CLOSING_MESSAGE = (
    "Thank you, that's everything for today. Your answers go to your research team, who will review them. "
    "I can't give medical advice, so if anything gets worse or you're worried, contact your study team, "
    "and call 911 in an emergency."
)


def opening_script(patient_name: str, respondent: str, site_name: str, study_id: str) -> str:
    first = patient_name.split()[0] if patient_name else "there"
    who = (
        f"Thank you for answering on behalf of {first}. Please answer based on what {first} has experienced. "
        if respondent == "caregiver"
        else ""
    )
    return (
        f"Hi, this is an automated check-in assistant calling for the {site_name} research team about the "
        f"{study_id} study. I'm a computer program, not a person, and I can't give medical advice. "
        f"You can ask to talk to a person at any time. Just say 'talk to a person'. "
        f"If you are having a medical emergency, hang up and call 911. {who}"
        f"These questions are about the past 7 days and take about five minutes."
    )


def message_for(level: str, category: str | None = None) -> str:
    if level == "emergency" and category == "self_harm":
        return PATIENT_MESSAGES["emergency_self_harm"]
    return PATIENT_MESSAGES.get(level, PATIENT_MESSAGES["urgent"])


def answer_escalations(question_id: str, value: int | None) -> list[tuple[str, str, str]]:
    """Escalations triggered by a structured answer. Returns [(level, category, reason)]."""
    if value is None or "." not in question_id:
        return []
    key, attr = question_id.split(".", 1)
    out: list[tuple[str, str, str]] = []
    sym = SYMPTOM_BY_KEY.get(key)
    if sym is not None and attr in SCALES:
        label = SCALES[attr][value] if value < len(SCALES[attr]) else str(value)
        name = sym.label.lower()
        if key == "shortness_of_breath":
            if attr == "severity" and value == 4:
                out.append(("emergency", "cannot_breathe", f"Shortness of breath rated '{label}'"))
            elif value >= 3:
                out.append(("urgent", "dyspnea", f"Shortness of breath {attr} rated '{label}'"))
        elif attr == "severity" and value == 4:
            out.append(("urgent", f"{key}_very_severe", f"{name.capitalize()} rated '{label}'"))
        elif key == "diarrhea" and attr == "frequency" and value == 4:
            out.append(("urgent", "diarrhea", "Loose/watery stools 'Almost constantly'"))
        elif key == "chills" and attr == "severity" and value >= 3:
            out.append(("urgent", "fever", f"Shaking chills rated '{label}' (possible infection)"))
        elif key == "vomiting" and attr == "frequency" and value >= 3:
            out.append(("urgent", "dehydration", f"Vomiting '{label}' (dehydration risk)"))
    return out
