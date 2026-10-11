import os
import sys
import tempfile
from pathlib import Path

import pytest

# Fresh throwaway database for the test run (must be set before the app is imported).
_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_tmp) / 'test.db'}"
os.environ["SEED_ON_STARTUP"] = "true"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:  # runs lifespan -> creates tables + seeds demo data
        yield c


@pytest.fixture
def new_patient(client):
    counter = {"n": 0}

    def make(**overrides):
        counter["n"] += 1
        body = {"subject_id": f"T-{os.getpid()}-{id(counter)}-{counter['n']}", "display_name": "Test Patient",
                "baseline_meds": ["lisinopril"], **overrides}
        r = client.post("/api/patients", json=body)
        assert r.status_code == 201, r.text
        return r.json()

    return make
