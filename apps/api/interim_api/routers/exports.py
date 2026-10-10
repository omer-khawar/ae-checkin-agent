"""Exports and the mock EDC (CONTRACTS.md §2.2, D-008)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response

from ..audit import Actor
from ..auth import require_role
from ..db import Database
from ..deps import get_database
from ..problems import problem
from ..schemas import MockEdcRequest
from ..services.exports import (
    build_bundle,
    check_domain,
    export_json_document,
    log_export,
    per_sample_records,
    post_mock_edc,
    records_for,
    sha256_hex,
    to_csv,
    to_json_bytes,
)
from ..util import now_iso

router = APIRouter(tags=["exports"])

StatusFilter = Literal["confirmed", "all"]


@router.get("/export/bundle.zip")
def export_bundle(
    status: StatusFilter = Query(default="confirmed"),
    include_eval: bool = Query(default=False),
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> Response:
    with database.write_scope() as db:
        blob, manifest = build_bundle(db, actor, status=status, include_eval=include_eval)
    stamp = manifest["generated_at"].replace(":", "").replace("-", "")[:15]
    return Response(
        content=blob,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="interim-bundle-{stamp}.zip"',
            "X-Interim-Audit-Head": str(manifest.get("audit_head_hash") or ""),
        },
    )


@router.get("/export/{domain_and_format}")
def export_domain(
    domain_and_format: str,
    status: StatusFilter = Query(default="confirmed"),
    per_sample: bool = Query(default=False),
    include_eval: bool = Query(default=False),
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> Response:
    """``/export/AE.csv``, ``/export/VS.json?per_sample=true`` ..."""
    if "." not in domain_and_format:
        check_domain(domain_and_format)  # raises the 404 problem
    name, _, fmt = domain_and_format.rpartition(".")
    domain = check_domain(name)
    fmt = fmt.lower()
    if fmt not in ("csv", "json"):
        raise problem(
            404, f"Unknown export format {fmt!r}; use csv or json", title="Unknown format"
        )
    generated_at = now_iso()
    with database.write_scope() as db:
        if per_sample and domain == "VS":
            records = per_sample_records(db, status, include_eval=include_eval)
        else:
            records = records_for(db, domain, status, include_eval=include_eval)
        if fmt == "csv":
            payload = to_csv(records)
            media_type = "text/csv; charset=utf-8"
        else:
            document = export_json_document(domain, status, records, generated_at=generated_at)
            document["per_sample"] = per_sample and domain == "VS"
            payload = to_json_bytes(document)
            media_type = "application/json"
        digest = sha256_hex(payload)
        log_export(
            db,
            actor,
            kind=fmt,
            domain=domain,
            status=status,
            n_records=len(records),
            sha256=digest,
            extra={"per_sample": per_sample and domain == "VS", "include_eval": include_eval},
            now=generated_at,
        )
    suffix = "_samples" if per_sample and domain == "VS" else ""
    return Response(
        content=payload,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{domain}{suffix}.{fmt}"',
            "X-Interim-SHA256": digest,
        },
    )


@router.post("/mock-edc/{domain}")
def mock_edc(
    domain: str,
    body: MockEdcRequest,
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    checked = check_domain(domain)
    with database.write_scope() as db:
        return post_mock_edc(db, actor, checked, body.records)
