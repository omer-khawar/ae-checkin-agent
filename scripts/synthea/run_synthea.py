#!/usr/bin/env python3
"""Reproducible Synthea generation for Interim, then the FHIR import.

Everything is pinned in ``scripts/synthea/synthea_config.json`` (jar URL and sha256, Docker
image, population, seeds, reference date, exporter flags, keep module). This script:

1. downloads ``synthea-with-dependencies.jar`` to a cache directory OUTSIDE the repo
   (default ``%LOCALAPPDATA%/interim/synthea`` on Windows, ``~/.cache/interim/synthea``
   elsewhere; ``--cache-dir`` overrides) and verifies its sha256. The release tag
   ``master-branch-latest`` moves, so a mismatch fails unless ``--accept-new-jar`` is given,
   in which case the new hash is written back into the config (and the regenerated data
   will differ from the committed data; review the diff);
2. runs Synthea with a local ``java`` (11+) when one is on PATH, else in Docker
   (``eclipse-temurin:17-jre``); Windows paths are passed to ``docker -v`` as absolute
   Windows paths with ``MSYS_NO_PATHCONV=1`` so Git Bash does not rewrite them;
3. runs a top-up generation with the next seed when the primary run keeps fewer than
   ``population`` patients (the keep module rejects most simulated people; Synthea gives up
   on a person after ``generate.max_attempts_to_keep_patient`` tries);
4. calls ``import_synthea.py`` on the output.

Timing: generation takes ~10-15 minutes (the committed primary run took 896 s on a
16-thread laptop) because NSCLC is rare and the keep module rejects most simulated
people; the top-up took 45 s. ``--dry-run`` prints the exact commands and touches nothing.

Usage (repo root)::

    .venv/Scripts/python.exe scripts/synthea/run_synthea.py --dry-run
    .venv/Scripts/python.exe scripts/synthea/run_synthea.py --out C:/tmp/synthea-out
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_CONFIG = SCRIPT_DIR / "synthea_config.json"
DEFAULT_IMPORT_OUTDIR = REPO_ROOT / "data" / "synthetic" / "synthea"
JAR_NAME = "synthea-with-dependencies.jar"

# Container mount points (POSIX paths inside the container).
C_JAR_DIR, C_KEEP_DIR, C_OUT_DIR = "/synthea", "/keep", "/out"

EXIT_JAR_MISMATCH = 3
EXIT_NO_RUNNER = 4
EXIT_SYNTHEA_FAILED = 5

JsonObj = dict[str, Any]


class JarMismatchError(RuntimeError):
    """The cached/downloaded jar's sha256 differs from the pinned one."""


def default_cache_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "interim" / "synthea"
    return Path.home() / ".cache" / "interim" / "synthea"


def load_config(path: Path) -> JsonObj:
    config: JsonObj = json.loads(path.read_text(encoding="utf-8"))
    return config


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------------------
# Jar download and verification
# --------------------------------------------------------------------------------------


def download(url: str, dest: Path) -> None:
    """Stream ``url`` to ``dest`` via a .part file (so an interrupted download is not cached)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    print(f"downloading {url}\n  -> {dest}")
    request = urllib.request.Request(url, headers={"User-Agent": "interim-run-synthea"})
    with urllib.request.urlopen(request, timeout=60) as response, part.open("wb") as out:
        shutil.copyfileobj(response, out, length=1 << 20)
    part.replace(dest)


def verify_jar(jar: Path, config: JsonObj, config_path: Path, *, accept_new: bool) -> str:
    """Check the jar against the pinned sha256. On mismatch: raise, or (accept_new) record the
    new hash, size and retrieval time in the config file and warn. Returns the jar's hash."""
    actual = sha256_file(jar)
    expected = str(config.get("jar_sha256", ""))
    if actual == expected:
        print(f"jar sha256 OK ({actual[:16]}...)")
        return actual
    message = (
        f"jar sha256 mismatch: pinned {expected[:16]}..., got {actual[:16]}... "
        f"({jar.stat().st_size:,} bytes). The '{config.get('synthea_release')}' release moves; "
        "the committed data was generated with the pinned jar."
    )
    if not accept_new:
        raise JarMismatchError(message + " Re-run with --accept-new-jar to record the new hash.")
    print(f"WARNING: {message} Recording the new hash in {config_path.name} (--accept-new-jar).")
    config["jar_sha256"] = actual
    config["jar_bytes"] = jar.stat().st_size
    config["retrieved_at"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    config_path.write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return actual


# --------------------------------------------------------------------------------------
# Command construction (pure; unit-tested)
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RunSpec:
    """One Synthea invocation."""

    role: str  # "primary" | "top_up"
    seed: int
    clinician_seed: int
    population: int
    out_dir: Path
    flags: dict[str, Any]


def _flag_value(value: Any) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)


def synthea_args(config: JsonObj, spec: RunSpec, *, keep_module: str, base_dir: str) -> list[str]:
    """Synthea CLI arguments (after ``-jar <jar>``) for one run."""
    args = [
        "-p",
        str(spec.population),
        "-a",
        str(config["age"]),
        "-s",
        str(spec.seed),
        "-cs",
        str(spec.clinician_seed),
        "-r",
        str(config["reference_date"]),
        "-k",
        keep_module,
        f"--exporter.baseDirectory={base_dir}",
    ]
    args += [f"--{key}={_flag_value(value)}" for key, value in spec.flags.items()]
    args.append(str(config["state"]))
    return args


def build_command(
    config: JsonObj,
    spec: RunSpec,
    *,
    runner: str,
    jar: Path,
    keep_module: Path,
) -> list[str]:
    """The full argv for ``runner`` ('java' or 'docker'). Host paths are absolute."""
    java_opts = [str(o) for o in config.get("java_opts", [])]
    if runner == "java":
        return [
            "java",
            *java_opts,
            "-jar",
            str(jar.resolve()),
            *synthea_args(
                config,
                spec,
                keep_module=str(keep_module.resolve()),
                base_dir=str(spec.out_dir.resolve()),
            ),
        ]
    if runner == "docker":
        return [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{jar.parent.resolve()}:{C_JAR_DIR}:ro",
            "-v",
            f"{keep_module.parent.resolve()}:{C_KEEP_DIR}:ro",
            "-v",
            f"{spec.out_dir.resolve()}:{C_OUT_DIR}",
            "-w",
            C_OUT_DIR,
            str(config["docker_image"]),
            "java",
            *java_opts,
            "-jar",
            f"{C_JAR_DIR}/{jar.name}",
            *synthea_args(
                config,
                spec,
                keep_module=f"{C_KEEP_DIR}/{keep_module.name}",
                base_dir=C_OUT_DIR,
            ),
        ]
    raise ValueError(f"unknown runner {runner!r}")


def primary_spec(config: JsonObj, out_root: Path) -> RunSpec:
    return RunSpec(
        role="primary",
        seed=int(config["seed"]),
        clinician_seed=int(config["clinician_seed"]),
        population=int(config["population"]),
        out_dir=out_root / "primary",
        flags=dict(config["exporter_flags"]),
    )


def top_up_spec(config: JsonObj, out_root: Path, shortfall: int) -> RunSpec:
    top = config["top_up"]
    return RunSpec(
        role="top_up",
        seed=int(top["seed"]),
        clinician_seed=int(top["clinician_seed"]),
        population=shortfall,
        out_dir=out_root / "top_up",
        flags={**config["exporter_flags"], **top.get("exporter_flags_override", {})},
    )


def choose_runner(requested: str) -> str:
    """'auto' prefers a local java, then Docker."""
    if requested != "auto":
        return requested
    if shutil.which("java"):
        return "java"
    if shutil.which("docker"):
        return "docker"
    raise FileNotFoundError("neither java nor docker is on PATH; install one (see README.md)")


def subprocess_env() -> dict[str, str]:
    """Stop Git Bash/MSYS from rewriting '/out'-style container paths and Windows -v paths."""
    env = dict(os.environ)
    env["MSYS_NO_PATHCONV"] = "1"
    env["MSYS2_ARG_CONV_EXCL"] = "*"
    return env


def count_patient_bundles(out_dir: Path) -> int:
    fhir = out_dir / "fhir"
    if not fhir.is_dir():
        return 0
    return sum(
        1
        for p in fhir.glob("*.json")
        if not p.name.startswith(("hospitalInformation", "practitionerInformation"))
    )


def import_command(in_dirs: Sequence[Path], outdir: Path) -> list[str]:
    cmd = [sys.executable, str(SCRIPT_DIR / "import_synthea.py")]
    for d in in_dirs:
        cmd += ["--in", str(d)]
    return [*cmd, "--outdir", str(outdir)]


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--cache-dir", type=Path, default=None, help="jar cache (outside repo)")
    parser.add_argument(
        "--out", type=Path, default=None, help="Synthea output root (default: a new temp dir)"
    )
    parser.add_argument("--runner", choices=("auto", "java", "docker"), default="auto")
    parser.add_argument(
        "--accept-new-jar",
        action="store_true",
        help="accept a jar whose sha256 differs from the pin and record the new hash",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the exact commands; download/run nothing"
    )
    parser.add_argument("--skip-import", action="store_true", help="generate only")
    parser.add_argument(
        "--import-outdir",
        type=Path,
        default=DEFAULT_IMPORT_OUTDIR,
        help="where import_synthea.py writes (default data/synthetic/synthea)",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    config = load_config(args.config)
    cache_dir: Path = args.cache_dir or default_cache_dir()
    jar = cache_dir / JAR_NAME
    keep_module = args.config.parent / str(config["keep_module"])
    if args.out is not None:
        out_root: Path = args.out
    elif args.dry_run:
        out_root = Path(tempfile.gettempdir()) / "interim-synthea-<new temp dir>"
    else:
        out_root = Path(tempfile.mkdtemp(prefix="interim-synthea-"))

    try:
        runner = choose_runner(args.runner)
    except FileNotFoundError as exc:
        if not args.dry_run:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_NO_RUNNER
        runner = "docker"  # a dry run still shows the command

    primary = primary_spec(config, out_root)
    top_up_preview = top_up_spec(config, out_root, 1)
    final_import = import_command([primary.out_dir, top_up_preview.out_dir], args.import_outdir)

    if args.dry_run:
        print("# dry run: nothing is downloaded, generated or written")
        print(
            f"# jar: {jar} ({'cached' if jar.is_file() else 'would download'} from "
            f"{config['jar_url']}; pinned sha256 {config['jar_sha256']})"
        )
        print(f"# runner: {runner}; env MSYS_NO_PATHCONV=1")
        print("# primary run:")
        print(
            shlex.join(
                build_command(config, primary, runner=runner, jar=jar, keep_module=keep_module)
            )
        )
        print(
            f"# top-up run, only if the primary keeps fewer than {primary.population} "
            f"patients (population = the shortfall; shown for a shortfall of 1):"
        )
        print(
            shlex.join(
                build_command(
                    config, top_up_preview, runner=runner, jar=jar, keep_module=keep_module
                )
            )
        )
        print("# import (the top-up dir is passed only if it was generated):")
        print(shlex.join(final_import))
        return 0

    if not jar.is_file():
        download(str(config["jar_url"]), jar)
    try:
        verify_jar(jar, config, args.config, accept_new=args.accept_new_jar)
    except JarMismatchError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_JAR_MISMATCH

    env = subprocess_env()
    in_dirs: list[Path] = []
    specs = [primary]
    total_start = time.monotonic()
    while specs:
        spec = specs.pop(0)
        spec.out_dir.mkdir(parents=True, exist_ok=True)
        cmd = build_command(config, spec, runner=runner, jar=jar, keep_module=keep_module)
        print(f"[{spec.role}] {shlex.join(cmd)}")
        print(
            f"[{spec.role}] generating {spec.population} patient(s); NSCLC is rare, so expect "
            "~10-15 min for the primary run"
        )
        start = time.monotonic()
        result = subprocess.run(cmd, env=env, check=False)
        elapsed = time.monotonic() - start
        kept = count_patient_bundles(spec.out_dir)
        print(f"[{spec.role}] exit {result.returncode}, {elapsed:.0f} s, kept {kept} patient(s)")
        if result.returncode != 0:
            return EXIT_SYNTHEA_FAILED
        in_dirs.append(spec.out_dir)
        if spec.role == "primary" and kept < spec.population and "top_up" in config:
            specs.append(top_up_spec(config, out_root, spec.population - kept))
    print(f"generation total {time.monotonic() - total_start:.0f} s; output in {out_root}")

    if args.skip_import:
        return 0
    cmd = import_command(in_dirs, args.import_outdir)
    print(f"[import] {shlex.join(cmd)}")
    return subprocess.run(cmd, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
