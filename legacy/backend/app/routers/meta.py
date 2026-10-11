from datetime import date

from fastapi import APIRouter

from app.config import settings
from app.schemas import ScanIn
from app.services.extract import scan_text
from app.services.items import QUESTIONS, SCALES, SYMPTOMS

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/items", summary="The check-in question set (PRO-CTCAE-style)")
def list_items():
    return {
        "recall_period": "the past 7 days",
        "scales": SCALES,
        "symptoms": [{"key": s.key, "label": s.label, "ctcae_term": s.ctcae_term, "attributes": s.attributes}
                     for s in SYMPTOMS],
        "questions": [q.as_dict() for q in QUESTIONS],
        "source": "NCI PRO-CTCAE item library, https://healthcaredelivery.cancer.gov/pro-ctcae/",
    }


@router.post("/scan", summary="Dry-run the text scanner (nothing is saved)")
def scan(body: ScanIn):
    """Paste any check-in transcript or chart note to see what the scanner finds and why."""
    return scan_text(body.text, body.ref_date or date.today(), detect_human_request=True).to_dict()


@router.get("/config", summary="Public settings the frontend may want")
def public_config():
    return {"study_id": settings.study_id, "site_name": settings.site_name,
            "sae_report_hours": settings.sae_report_hours}
