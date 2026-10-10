"""The distribution must ship the JSON rule tables (CLAUDE.md §0 "runs from a clean clone").

The tables live at the canonical repository path ``packages/rules/data/`` and are mapped into
the wheel as the ``interim_rules.data`` package (``pyproject.toml``). A non-editable install
(``pip install ./packages/rules``, a Docker multi-stage ``COPY`` + install) must therefore
find them under ``<site-packages>/interim_rules/data`` through ``tables.data_dir()``.

The static test always runs. The install test builds the package into a temporary target
with ``uv`` (the project's installer) and imports it from a Python started with ``-I -S`` so
the editable install in the venv cannot leak in; it is skipped when ``uv`` is unavailable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import textwrap
import tomllib
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PACKAGE_ROOT / "pyproject.toml"


def test_pyproject_maps_the_tables_into_the_package() -> None:
    config = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["tool"]["setuptools"]
    assert "interim_rules.data" in config["packages"]
    assert config["package-dir"]["interim_rules.data"] == "data"
    assert "*.json" in config["package-data"]["interim_rules.data"]
    assert "py.typed" in config["package-data"]["interim_rules"]
    on_disk = sorted(p.name for p in (PACKAGE_ROOT / "data").glob("*.json"))
    assert on_disk, "no tables on disk?"


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not on PATH")
def test_non_editable_install_ships_and_finds_the_tables(tmp_path: Path) -> None:
    target = tmp_path / "site"
    install = subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            sys.executable,
            "--no-deps",
            "--quiet",
            "--target",
            str(target),
            str(PACKAGE_ROOT),
        ],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert install.returncode == 0, install.stderr
    shipped = sorted(p.name for p in (target / "interim_rules" / "data").glob("*.json"))
    expected = sorted(p.name for p in (PACKAGE_ROOT / "data").glob("*.json"))
    assert shipped == expected
    assert not (target / "interim_rules" / "data" / "README.md").exists()

    probe = textwrap.dedent(
        f"""
        import json, sys
        sys.path.insert(0, {str(target)!r})
        from interim_rules import tables, evaluate_checkin, __file__ as pkg_file
        from interim_rules.serialize import input_from_dict, result_to_dict
        result = evaluate_checkin(input_from_dict({{
            "session_id": "S", "usubjid": "X-P-001", "completed_at": "2026-10-10T18:00:00Z",
            "responses": {{"cough": {{"severity": 2, "interference": 2}}}},
            "gates": {{"hospitalization": False, "conmed_changed": False}},
        }}))
        print(json.dumps({{
            "pkg_file": pkg_file,
            "data_dir": str(tables.data_dir()),
            "n_items": len(tables.items()),
            "n_catalog": len(tables.rules_catalog()),
            "tier": result.escalation_tier,
            "json_ok": bool(json.dumps(result_to_dict(result), allow_nan=False)),
        }}))
        """
    )
    # -I ignores PYTHON* env vars and the user site; -S skips site.py, so the venv's editable
    # finder (.pth) is never installed and only the target copy can satisfy the import.
    run = subprocess.run(
        [sys.executable, "-I", "-S", "-c", probe],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
        cwd=str(tmp_path),
    )
    assert run.returncode == 0, run.stderr
    report = json.loads(run.stdout.strip().splitlines()[-1])
    assert Path(report["pkg_file"]).resolve().is_relative_to(target.resolve())
    assert Path(report["data_dir"]).resolve() == (target / "interim_rules" / "data").resolve()
    assert report["n_items"] == 10 and report["n_catalog"] > 40
    assert report["tier"] == 1 and report["json_ok"] is True
