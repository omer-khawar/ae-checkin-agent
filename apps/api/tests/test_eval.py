"""The eval harness: every shipped persona must pass through the real service layer."""

from __future__ import annotations

from conftest import DEMO_GATES, DEMO_RESPONSES, login


def test_persona_list_and_full_run_pass_100_percent(client) -> None:
    coord = login(client, "coordinator")
    personas = client.get("/api/v1/eval/personas", headers=coord).json()
    assert len(personas) == 29 and sum(1 for p in personas if p["hidden"]) == 5
    assert {p["category"] for p in personas} == {
        "tier0",
        "tier1",
        "tier2",
        "tier3",
        "edge",
        "judge",
    }

    assert client.get("/api/v1/eval/results", headers=coord).status_code == 404

    res = client.post("/api/v1/eval/run", json={"include_hidden": True}, headers=coord)
    assert res.status_code == 200, res.text
    results = res.json()
    failed = [p for p in results["per_persona"] if not p["pass"]]
    assert not failed, "\n".join(f"{p['persona_id']}: {p['mismatches']}" for p in failed)
    assert results["n_personas"] == 29 and results["n_pass"] == 29 and results["n_fail"] == 0
    for tier, m in results["tier_metrics"].items():
        assert m["precision"] == 1.0 and m["recall"] == 1.0 and m["f1"] == 1.0, tier
    expected_tier3 = sum(1 for p in personas if p["expected_tier"] == 3)
    assert results["tier_metrics"]["3"]["support"] == expected_tier3 >= 4
    matrix = results["grade_confusion"]
    assert all(matrix[i][j] == 0 for i in range(4) for j in range(4) if i != j)
    assert sum(matrix[i][i] for i in range(4)) == 29 * 10
    assert results["dedup_correct"] == {"n": 29, "correct": 29}
    assert results["sae_clock_correct"] == {"n": 29, "correct": 29}
    assert results["conmed_correct"] == {"n": 29, "correct": 29}
    assert results["counterfactuals"] and all(c["pass"] for c in results["counterfactuals"])
    tier3_row = f"| 3 | Urgent | 1.00 | 1.00 | 1.00 | {expected_tier3} | {expected_tier3} |"
    assert tier3_row in results["markdown"]
    assert all(p["session_id"] for p in results["per_persona"])

    # The second section (R2.4): the chart-note scanner against its answer key, and the eight
    # notes through the /notes service (drafts, tier, SAE clock, cross-note follow-ups).
    scanner = results["chartscan"]
    assert scanner["passed"] is True and results["all_passed"] is True
    key = scanner["answer_key"]
    assert key["n_cases"] == 39 and key["passed"] is True and key["misses"] == []
    assert key["ae_terms"]["precision"] == 1.0 and key["ae_terms"]["recall"] == 1.0
    assert key["meds"]["precision"] == 1.0 and key["meds"]["recall"] == 1.0
    assert key["over_escalations"] == 0
    assert key["urgent_or_emergency_caught"] == key["urgent_or_emergency_needed"] >= 2
    assert key["serious_caught"] == key["serious_needed"] >= 1
    via = scanner["via_api"]
    assert via["n_notes"] == 8 and via["n_pass"] == 8
    by_case = {n["case_id"]: n for n in via["per_note"]}
    assert by_case["N6"]["actual"]["sae_clock"] is True and by_case["N6"]["actual"]["tier"] == 2
    assert by_case["N3"]["actual"]["tier"] == 2 and by_case["N3"]["actual"]["sae_clock"] is False
    assert by_case["N7"]["actual"]["dedup_followups"] == 2  # onto N1's AEs, same subject
    assert by_case["N8"]["actual"]["ae_terms"] == [] and by_case["N8"]["actual"]["tier"] == 1
    assert "## Chart-note scanner" in results["markdown"]
    assert "| `N7` | P-001 |" in results["markdown"]
    # Eval notes belong to eval participants: hidden from the Notes page and the queue.
    assert client.get("/api/v1/notes", headers=coord).json()["total"] == 0
    assert client.get("/api/v1/notes?include_eval=true", headers=coord).json()["total"] == 8

    latest = client.get("/api/v1/eval/results", headers=coord).json()
    assert latest["run_id"] == results["run_id"]
    # Eval sessions are hidden from the queue unless asked for.
    assert client.get("/api/v1/queue", headers=coord).json()["total"] == 0
    assert client.get("/api/v1/queue?include_eval=true", headers=coord).json()["total"] >= 29
    # ... and from the Escalations page, the SAE clocks and the pager log: a run must not
    # leave a wall of never-acknowledged EVAL rows and unstoppable clocks behind.
    for path in ("/escalations?acked=false", "/escalations", "/sae-clocks?active=true", "/pages"):
        assert client.get(f"/api/v1{path}", headers=coord).json()["total"] == 0, path
        joiner = "&" if "?" in path else "?"
        shown = client.get(f"/api/v1{path}{joiner}include_eval=true", headers=coord).json()
        assert shown["total"] > 0, path
    shown_esc = client.get("/api/v1/escalations?include_eval=true&limit=100", headers=coord).json()
    assert {e["source"] for e in shown_esc["items"]} == {"check_in", "chart_note"}
    assert all(e["usubjid"].startswith("R2810-ONC-1624-EVAL") for e in shown_esc["items"])
    assert all(
        r["usubjid"].startswith("R2810-ONC-1624-EVAL")
        for r in client.get("/api/v1/sae-clocks?include_eval=true", headers=coord).json()["items"]
    )
    assert client.get("/api/v1/audit/verify", headers=coord).json()["ok"] is True


def test_run_subset_without_hidden(client) -> None:
    coord = login(client, "coordinator")
    res = client.post(
        "/api/v1/eval/run",
        json={"persona_ids": ["T1-dyspnea-moderate", "E-dedup-cough-followup"]},
        headers=coord,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["n_personas"] == 2 and body["n_pass"] == 2
    support = {tier: m["support"] for tier, m in body["tier_metrics"].items()}
    assert sum(support.values()) == 2 and support["1"] >= 1  # the demo persona is Tier 1
    dedup = next(p for p in body["per_persona"] if p["persona_id"] == "E-dedup-cough-followup")
    assert dedup["actual"]["dedup_followups"] == 1
    default = client.post("/api/v1/eval/run", json={}, headers=coord).json()
    assert default["n_personas"] == 24 and default["n_fail"] == 0
    assert (
        client.post("/api/v1/eval/run", json={"persona_ids": ["nope"]}, headers=coord).status_code
        == 404
    )


def test_run_custom_changes_output_when_input_changes(client) -> None:
    inv = login(client, "investigator")
    persona = {
        "id": "custom-demo",
        "name": "demo persona, severity raised",
        "consent_camera": True,
        "settings": {"simulated_as_measured": False},
        "responses": {**DEMO_RESPONSES, "shortness_of_breath": {"severity": 3, "interference": 2}},
        "gates": DEMO_GATES,
        "vitals_samples": [
            {
                "tsOffsetS": 30,
                "source": "mock",
                "isMeasured": False,
                "pulseBpm": 72,
                "pulseConf": 0.9,
                "breathingBpm": 14,
                "breathingConf": 0.85,
                "windowS": 30,
                "qualityFlags": [],
            }
        ],
        "expected": {
            "tier": 3,
            "grades": {**{k: 0 for k in DEMO_RESPONSES}, "shortness_of_breath": 2, "cough": 1},
        },
    }
    res = client.post("/api/v1/eval/run-custom", json={"persona": persona}, headers=inv)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["pass"] is True and body["mismatches"] == []
    assert body["result"]["escalation_tier"] == 3 and body["result"]["stop_screen"] is True
    assert "redflag.severe_dyspnea" in [r["rule_id"] for r in body["result"]["rules_fired"]]
    grade = next(i for i in body["result"]["items"] if i["item_id"] == "shortness_of_breath")
    assert grade["provisional_grade"] == 2  # the red flag moved the tier, not the grade
    assert body["session_id"] and body["checkin_url"].endswith(body["session_id"])
    detail = client.get(f"/api/v1/checkins/{body['session_id']}", headers=inv).json()
    assert detail["session"]["is_eval"] is True
    bad = client.post("/api/v1/eval/run-custom", json={"persona": {"responses": []}}, headers=inv)
    assert bad.status_code == 422
