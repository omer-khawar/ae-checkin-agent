"""Service layer: every state change goes through here, never through a router directly.

The routers translate HTTP into calls on these modules; the seed script and the
in-process eval harness call the same functions, so a seeded or replayed
check-in is audited, graded, drafted and escalated exactly like a live one.
``checkins.apply_result`` is the piece a chart-note ingestion reuses.
"""
