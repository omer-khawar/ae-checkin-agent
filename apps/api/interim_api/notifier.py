"""Text-message senders behind one interface (CONTRACTS.md R6).

``get_notifier`` picks Twilio when ``TWILIO_ACCOUNT_SID``, ``TWILIO_AUTH_TOKEN`` and
``TWILIO_FROM`` are all set, else the mock outbox (the ``messages`` table only, nothing
leaves the machine). ``send`` never raises: a failure comes back as ``status="failed"``
with the reason, so a check-in is never failed by its confirmation text.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import httpx

from .settings import Settings

TWILIO_API = "https://api.twilio.com/2010-04-01"


@dataclass(frozen=True)
class SendResult:
    channel: str
    """``twilio`` | ``outbox``."""
    status: str
    """``sent`` (Twilio accepted it) | ``outbox`` (mock, stored only) | ``failed``."""
    provider_id: str | None = None
    error: str | None = None


class Notifier(Protocol):
    channel: str

    def send(self, to: str, body: str) -> SendResult: ...


class OutboxNotifier:
    """No keys: the message is only written to the ``messages`` table (the mock outbox)."""

    channel = "outbox"

    def send(self, to: str, body: str) -> SendResult:
        return SendResult(channel=self.channel, status="outbox")


class TwilioNotifier:
    """Real SMS through Twilio's REST API (form POST, basic auth). Never raises."""

    channel = "twilio"

    def __init__(
        self,
        account_sid: str,
        auth_token: str,
        from_number: str,
        *,
        timeout_s: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._sid = account_sid
        self._token = auth_token
        self._from = from_number
        self._timeout = timeout_s
        self._transport = transport

    def send(self, to: str, body: str) -> SendResult:
        url = f"{TWILIO_API}/Accounts/{self._sid}/Messages.json"
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                r = client.post(
                    url,
                    auth=(self._sid, self._token),
                    data={"To": to, "From": self._from, "Body": body},
                )
        except httpx.HTTPError as exc:
            return SendResult(self.channel, "failed", error=f"{type(exc).__name__}: {exc}"[:300])
        if r.status_code in (200, 201):
            try:
                sid = r.json().get("sid")
            except ValueError:
                sid = None
            return SendResult(self.channel, "sent", provider_id=sid)
        try:
            detail = str(r.json().get("message") or "")
        except ValueError:
            detail = ""
        return SendResult(
            self.channel, "failed", error=f"HTTP {r.status_code} {detail}".strip()[:300]
        )


def get_notifier(settings: Settings) -> Notifier:
    if settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_from:
        return TwilioNotifier(
            settings.twilio_account_sid, settings.twilio_auth_token, settings.twilio_from
        )
    return OutboxNotifier()
