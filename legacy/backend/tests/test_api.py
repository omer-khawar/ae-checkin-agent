from datetime import date

from scripts.evaluate import evaluate


def answer(client, cid, question_id, value=None, text=None):
    r = client.post(f"/api/checkins/{cid}/answers",
                    json={"answers": [{"question_id": question_id, "value": value, "text": text}]})
    assert r.status_code == 200, r.text
    return r.json()


def run_checkin(client, patient_id, responses: dict, mode="text"):
    """Walk the agent's question flow. responses: question_id -> value or text; anything else -> 0."""
    r = client.post("/api/checkins", json={"patient_id": patient_id, "mode": mode})
    assert r.status_code == 201, r.text
    body = r.json()
    cid, q = body["checkin"]["id"], body["next_question"]
    while q:
        resp = responses.get(q["id"], 0 if q["attribute"] != "text" else None)
        out = answer(client, cid, q["id"], **({"text": resp} if isinstance(resp, str) or resp is None else {"value": resp}))
        if out["end_checkin"]:
            return cid, out
        q = out["next_question"]
    return cid, client.post(f"/api/checkins/{cid}/complete").json()


def test_health_and_items(client):
    assert client.get("/health").json()["status"] == "ok"
    items = client.get("/api/items").json()
    assert any(q["id"] == "nausea.severity" for q in items["questions"])
    assert items["recall_period"] == "the past 7 days"


def test_seed_loaded(client):
    d = client.get("/api/dashboard").json()
    assert d["patients"] >= 7 and d["checkins_completed"] >= 6
    assert d["sae_clocks"], "ED-visit chart note should start an SAE clock"
    assert d["open_escalations"]["urgent"] >= 1


def test_opening_script_discloses_automation(client, new_patient):
    p = new_patient()
    body = client.post("/api/checkins", json={"patient_id": p["id"]}).json()
    script = body["opening_script"].lower()
    assert "automated" in script and "not a person" in script and "911" in script and "talk to a person" in script


def test_full_checkin_creates_graded_flag_and_conmed(client, new_patient):
    p = new_patient()
    cid, report = run_checkin(client, p["id"], {
        "nausea.frequency": 3, "nausea.severity": 2,
        "meds.changes": "Yes, I started Zofran for the nausea.",
    })
    flags = {f["term"]: f for f in report["flags"]}
    assert flags["Nausea"]["provisional_grade"] == 2
    assert "checkin_answer" in flags["Nausea"]["sources"]
    meds = {c["drug"]: c for c in report["conmed_changes"]}
    assert meds["ondansetron"]["action"] == "started" and meds["ondansetron"]["indication"] == "Nausea"
    assert report["escalations"] == []
    assert report["checkin"]["status"] == "completed" and "medical advice" in report["closing_message"]


def test_branching_skips_followups_after_never(client, new_patient):
    p = new_patient()
    cid = client.post("/api/checkins", json={"patient_id": p["id"]}).json()["checkin"]["id"]
    out = answer(client, cid, "nausea.frequency", 0)
    assert out["next_question"]["id"] == "vomiting.frequency"


def test_unparsed_answer_is_asked_again(client, new_patient):
    p = new_patient()
    cid = client.post("/api/checkins", json={"patient_id": p["id"]}).json()["checkin"]["id"]
    out = answer(client, cid, "nausea.frequency", text="hmm, hard to say")
    assert out["unparsed"] and out["next_question"]["id"] == "nausea.frequency"


def test_details_follow_up_keeps_yes(client, new_patient):
    p = new_patient()
    cid = client.post("/api/checkins", json={"patient_id": p["id"]}).json()["checkin"]["id"]
    out = answer(client, cid, "meds.changes", 1)
    assert out["needs_details"][0]["question_id"] == "meds.changes"
    out = answer(client, cid, "meds.changes", text="I started Augmentin for a sinus infection")
    assert not out["unparsed"]
    report = client.post(f"/api/checkins/{cid}/complete").json()
    assert report["other_answers"]["meds.changes"]["value"] == 1
    assert report["conmed_changes"][0]["drug"] == "amoxicillin-clavulanate"


def test_spoken_answer_is_parsed(client, new_patient):
    p = new_patient()
    cid = client.post("/api/checkins", json={"patient_id": p["id"]}).json()["checkin"]["id"]
    answer(client, cid, "shortness_of_breath.severity", text="honestly it's been pretty bad")
    report = client.get(f"/api/checkins/{cid}").json()
    sob = next(s for s in report["symptoms"] if s["symptom"] == "shortness_of_breath")
    assert sob["answers"]["severity"]["value"] == 3
    assert any(e["level"] == "urgent" for e in report["escalations"])


def test_emergency_ends_checkin_and_says_911(client, new_patient):
    p = new_patient()
    cid, out = run_checkin(client, p["id"], {"nausea.frequency": "I have crushing chest pain right now"})
    assert out["end_checkin"] is True
    assert "911" in out["patient_message"]
    report = client.get(f"/api/checkins/{cid}").json()
    assert report["checkin"]["status"] == "completed" and report["checkin"]["emergency_triggered"]
    assert any(e["level"] == "emergency" for e in report["escalations"])


def test_self_harm_gets_988(client, new_patient):
    p = new_patient()
    cid = client.post("/api/checkins", json={"patient_id": p["id"]}).json()["checkin"]["id"]
    out = client.post(f"/api/checkins/{cid}/transcript", json={"text": "Some days I just want to die."}).json()
    assert out["end_checkin"] and "988" in out["patient_message"] and "911" in out["patient_message"]


def test_human_request(client, new_patient):
    p = new_patient()
    cid = client.post("/api/checkins", json={"patient_id": p["id"]}).json()["checkin"]["id"]
    out = client.post(f"/api/checkins/{cid}/transcript", json={"text": "Can I talk to a real person?"}).json()
    assert out["escalations"][0]["level"] == "human_requested"
    assert not out["end_checkin"]


def test_consent_required_for_voice(client, new_patient):
    p = new_patient(consented_to_contact=False)
    assert client.post("/api/checkins", json={"patient_id": p["id"], "mode": "voice"}).status_code == 403
    assert client.post("/api/checkins", json={"patient_id": p["id"], "mode": "text"}).status_code == 201


def test_chart_note_dedups_with_checkin_and_respects_negation(client, new_patient):
    p = new_patient()
    _, report = run_checkin(client, p["id"], {"diarrhea.frequency": 2})
    diarrhea_flag = next(f for f in report["flags"] if f["term"] == "Diarrhea")
    r = client.post("/api/notes", json={
        "patient_id": p["id"], "note_date": date.today().isoformat(),
        "text": "Pt reports 3 days of diarrhea, 6 loose stools per day, started loperamide. Denies vomiting or fever.",
    })
    assert r.status_code == 201, r.text
    out = r.json()
    terms = {f["term"]: f for f in out["flags"]}
    assert terms["Diarrhea"]["id"] == diarrhea_flag["id"], "same AE from two sources should merge"
    assert set(terms["Diarrhea"]["sources"]) == {"checkin_answer", "chart_note"}
    assert terms["Diarrhea"]["provisional_grade"] == 2
    assert "Vomiting" not in terms and "Fever" not in terms
    assert {e["term"] for e in out["findings"]["excluded_symptoms"]} >= {"Vomiting", "Fever"}
    assert out["conmed_changes"][0]["drug"] == "loperamide"


def test_presage_raw_metrics_camelcase(client, new_patient):
    p = new_patient()
    _, report = run_checkin(client, p["id"], {"shortness_of_breath.severity": 2, "shortness_of_breath.interference": 2})
    cid = report["checkin"]["id"]
    t0 = 1_760_000_000_000_000
    metrics = [{"cardio": {"pulseRate": [{"value": 98 + i % 3, "confidence": 80, "stable": True, "timestamp": t0 + i * 10**6}]},
                "breathing": {"rate": [{"value": 26, "confidence": 70 if i > 30 else 0, "stable": i > 30,
                                        "timestamp": t0 + i * 10**6}]}} for i in range(45)]
    r = client.post(f"/api/checkins/{cid}/vitals", json={"metrics": metrics})
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["breathing_bpm"] == 26 and 98 <= v["pulse_bpm"] <= 100 and v["duration_s"] == 44
    assert any(s["kind"] == "breathing_high" for s in v["signals"])
    flag = next(f for f in client.get(f"/api/flags?patient_id={p['id']}").json() if f["term"] == "Dyspnea")
    assert "vitals" in flag["sources"]


def test_review_and_edc_draft(client, new_patient):
    p = new_patient()
    _, report = run_checkin(client, p["id"], {"rash.presence": 1})
    flag = next(f for f in report["flags"] if f["term"] == "Rash maculo-papular")
    r = client.patch(f"/api/flags/{flag['id']}", json={"status": "confirmed", "final_grade": 2, "serious": False,
                                                       "attribution": "possible", "reviewer": "RN Test"})
    assert r.status_code == 200 and r.json()["status"] == "confirmed"
    edc = client.get(f"/api/patients/{p['id']}/edc-draft").json()
    row = next(a for a in edc["AE"] if a["AEDECOD"] == "Rash maculo-papular")
    assert row["AETOXGR"] == "2" and row["AESEV"] == "MODERATE" and row["AESER"] == "N" and row["AEREL"] == "POSSIBLY RELATED"


def test_scan_endpoint(client):
    out = client.post("/api/scan", json={"text": "No fever. Started Augmentin for sinus infection."}).json()
    assert out["meds"][0]["drug"] == "amoxicillin-clavulanate" and out["meds"][0]["action"] == "started"
    assert out["symptoms"][0]["term"] == "Sinusitis"


def test_answer_key_no_urgent_case_missed():
    r = evaluate()
    caught, needed = map(int, r["escalation"]["urgent_or_emergency_recall"].split("/"))
    assert caught == needed
    assert r["ae_terms"]["recall"] >= 0.9 and r["ae_terms"]["precision"] >= 0.9
