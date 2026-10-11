"""Provisional CTCAE grade from PRO-CTCAE-style answers.

IMPORTANT: this is a transparent triage heuristic, NOT the validated PRO-CTCAE composite grading
algorithm (Basch et al., Clinical Trials 2021) and NOT a clinician-assigned CTCAE grade. Its job is
to sort the coordinator's review queue. The coordinator / investigator sets the final grade.
"""

from app.services.items import SCALES

# attribute value (0-4) -> provisional grade
_SEVERITY_TO_GRADE = {0: 0, 1: 1, 2: 2, 3: 3, 4: 3}
_INTERFERENCE_TO_GRADE = {0: 0, 1: 1, 2: 2, 3: 3, 4: 3}
_FREQUENCY_ONLY_TO_GRADE = {0: 0, 1: 1, 2: 1, 3: 2, 4: 3}


def provisional_grade(attrs: dict[str, int]) -> tuple[int, str]:
    """attrs: {"frequency": 0-4, "severity": 0-4, "interference": 0-4, "presence": 0/1}.

    Returns (grade 0-3, human-readable basis).
    """
    parts: list[str] = []
    grades: list[int] = []

    if "presence" in attrs:
        if attrs["presence"]:
            grades.append(1)
            parts.append("reported as present -> grade 1 (extent/body-surface area needs clinician review)")
        else:
            parts.append("reported as absent")

    sev = attrs.get("severity")
    if sev is not None:
        g = _SEVERITY_TO_GRADE[sev]
        grades.append(g)
        parts.append(f"severity '{SCALES['severity'][sev]}' -> grade {g}")

    intf = attrs.get("interference")
    if intf is not None:
        g = _INTERFERENCE_TO_GRADE[intf]
        grades.append(g)
        parts.append(f"interference '{SCALES['interference'][intf]}' -> grade {g}")

    freq = attrs.get("frequency")
    if freq is not None:
        if sev is None and intf is None:
            g = _FREQUENCY_ONLY_TO_GRADE[freq]
            grades.append(g)
            parts.append(f"frequency '{SCALES['frequency'][freq]}' -> grade {g}")
        else:
            parts.append(f"frequency '{SCALES['frequency'][freq]}'")
            if freq > 0:
                grades.append(1)  # symptom happened at all -> at least grade 1

    grade = max(grades) if grades else 0
    basis = "; ".join(parts) + f". Provisional grade = highest = {grade} (heuristic, for coordinator review)."
    return grade, basis


def grade_to_severity(grade: int | None) -> str | None:
    """CDISC AESEV-style label."""
    if grade is None:
        return None
    if grade <= 1:
        return "MILD"
    if grade == 2:
        return "MODERATE"
    return "SEVERE"
