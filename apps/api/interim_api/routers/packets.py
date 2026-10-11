"""Serious-event packets (CONTRACTS R3.2 "Packets", R4.2 follow-ups; CLAUDE.md §00.2).

| Method & path | Who | Notes |
|---|---|---|
| ``POST /packets {clock_id}`` | coordinator+ | create (201) or return (200) the initial report |
| ``GET /packets?clock_id=&usubjid=&status=`` | any dashboard role | paginated summaries |
| ``GET /packets/{id}`` | any dashboard role | fields + evidence, missing info, narrative |
| ``PATCH /packets/{id}`` | coordinator+ (AESER/AEREL/INTERIM_IRAE: investigator) | new version |
| ``POST /packets/{id}/sign`` | investigator | clock "reported (mock)", mock-EDC ack |
| ``POST /packets/{id}/follow-up`` | coordinator+ | follow-up n+1 of a signed packet |
| ``GET /packets/{id}/export.json`` | any dashboard role | JSON download (audited) |
| ``GET /packets/{id}/print`` | any dashboard role | self-contained printable HTML (audited) |
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import HTMLResponse

from ..audit import Actor
from ..auth import require_clinical, require_role
from ..db import Database
from ..deps import Pagination, get_database, get_settings
from ..schemas_packets import CreatePacketRequest, PatchPacketRequest, SignPacketRequest
from ..services.packets import (
    create_packet,
    edit_packet,
    export_packet,
    get_packet_or_404,
    list_packets,
    packet_to_dict,
    print_packet,
    sign_packet,
    start_follow_up,
)
from ..settings import Settings
from ..writers.base import Writer, get_writer

router = APIRouter(tags=["packets"])


def packet_writer(request: Request, settings: Settings = Depends(get_settings)) -> Writer:
    """Template writer unless ``ANTHROPIC_API_KEY`` is set; tests may inject a fake LLM client
    as ``app.state.llm_client`` (never a real one)."""
    return get_writer(settings, client=getattr(request.app.state, "llm_client", None))


@router.post("/packets")
def post_packet(
    body: CreatePacketRequest,
    response: Response,
    actor: Actor = Depends(require_clinical()),
    writer: Writer = Depends(packet_writer),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        packet, created = create_packet(db, actor, body.clock_id, writer)
        response.status_code = 201 if created else 200
        return packet_to_dict(db, packet)


@router.get("/packets")
def get_packets(
    clock_id: str | None = Query(default=None),
    usubjid: str | None = Query(default=None),
    status: str | None = Query(default=None, pattern="^(draft|signed)$"),
    page: Pagination = Depends(),
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return list_packets(
            db,
            clock_id=clock_id,
            usubjid=usubjid,
            status=status,
            limit=page.limit,
            offset=page.offset,
        )


@router.get("/packets/{packet_id}")
def get_packet(
    packet_id: str,
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return packet_to_dict(db, get_packet_or_404(db, packet_id))


@router.patch("/packets/{packet_id}")
def patch_packet(
    packet_id: str,
    body: PatchPacketRequest,
    actor: Actor = Depends(require_clinical()),
    writer: Writer = Depends(packet_writer),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        packet = edit_packet(
            db,
            actor,
            get_packet_or_404(db, packet_id),
            writer,
            changes=body.fields,
            narrative_text=body.narrative_text,
            note=body.note,
        )
        return packet_to_dict(db, packet)


@router.post("/packets/{packet_id}/sign")
def post_sign(
    packet_id: str,
    body: SignPacketRequest | None = None,
    actor: Actor = Depends(require_role("investigator")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        packet, ack = sign_packet(
            db,
            actor,
            get_packet_or_404(db, packet_id),
            note=body.note if body else None,
            narrative_reviewed=bool(body and body.narrative_reviewed),
            missing_info_acknowledged=bool(body and body.missing_info_acknowledged),
            missing_info_not_available=(body.missing_info_not_available if body else None),
        )
        return {**packet_to_dict(db, packet), "mock_edc_ack": ack}


@router.post("/packets/{packet_id}/follow-up")
def post_follow_up(
    packet_id: str,
    response: Response,
    actor: Actor = Depends(require_clinical()),
    writer: Writer = Depends(packet_writer),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        packet, created = start_follow_up(db, actor, packet_id, writer)
        response.status_code = 201 if created else 200
        return packet_to_dict(db, packet)


@router.get("/packets/{packet_id}/export.json")
def get_packet_export(
    packet_id: str,
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> Response:
    with database.write_scope() as db:
        packet = get_packet_or_404(db, packet_id)
        data, digest = export_packet(db, actor, packet)
        name = f"packet-{packet.kind}-{packet.sequence}-{packet.id}.json"
    return Response(
        content=data,
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "X-Interim-SHA256": digest,
        },
    )


@router.get("/packets/{packet_id}/print", response_class=HTMLResponse)
def get_packet_print(
    packet_id: str,
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> HTMLResponse:
    with database.write_scope() as db:
        page = print_packet(db, actor, get_packet_or_404(db, packet_id))
    return HTMLResponse(content=page)
