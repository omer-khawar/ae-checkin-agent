"""Queue rows say when an item is a follow-up of an already-open AE (intake e2e, step 3).

Regression: the seeded overnight urgent-care note for P-002 links both of its AE
drafts to P-002's open rash/itching AEs, but the queue row gave no hint of that; the
coordinator only saw "Chart note". ``followup_count`` now carries it to the queue chip.
"""

from __future__ import annotations

from conftest import login
from fastapi.testclient import TestClient


def test_queue_rows_carry_followup_count(seeded_client: TestClient) -> None:
    headers = login(seeded_client, "coordinator")
    rows = seeded_client.get("/api/v1/queue?limit=200", headers=headers).json()["items"]
    assert rows and all(isinstance(r["followup_count"], int) for r in rows)
    urgent = [
        r
        for r in rows
        if r["source"] == "chart_note"
        and r["note_type"] == "outside_record"
        and r["display_label"] == "P-002"
    ]
    assert urgent, "seed should include the overnight urgent-care note for P-002"
    assert max(r["followup_count"] for r in urgent) >= 1
    # A follow-up count never exceeds the item's AE drafts.
    for r in rows:
        assert 0 <= r["followup_count"] <= r["draft_counts"]["AE"]
