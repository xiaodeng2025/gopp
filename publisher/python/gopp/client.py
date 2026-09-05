"""Small, dependency-light GOPP v1 Publisher client.

This module has no CMS, database, tenant, framework, or application imports.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from .errors import (
    GoppAuthenticationError,
    GoppError,
    GoppProblem,
    GoppProtocolError,
    GoppSecurityError,
    GoppTransportError,
)


def credential_from_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise GoppError("GOPP credential is unavailable.")
    return value


class GoppClient:
    def __init__(self, base_url: str, token: str, *, timeout: float = 10.0, allow_loopback: bool = False):
        parsed = urlparse(base_url.rstrip("/"))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise GoppError("GOPP base URL is invalid.")
        if parsed.scheme != "https" and not allow_loopback:
            raise GoppSecurityError("GOPP production transport requires HTTPS.")
        if not token:
            raise GoppError("GOPP credential is unavailable.")
        self.base_url = base_url.rstrip("/")
        self.host = parsed.hostname
        self.port = parsed.port or (443 if parsed.scheme == "https" else 80)
        self.token = token
        self.timeout = min(max(float(timeout), 0.1), 30.0)
        self.allow_loopback = allow_loopback
        self._check_target()

    def _check_target(self) -> None:
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)}
        except OSError as exc:
            raise GoppSecurityError("GOPP target DNS lookup failed.") from exc
        if not addresses:
            raise GoppSecurityError("GOPP target has no address.")
        if self.allow_loopback and all(ipaddress.ip_address(value).is_loopback for value in addresses):
            return
        for value in addresses:
            try:
                address = ipaddress.ip_address(value)
            except ValueError as exc:
                raise GoppSecurityError("GOPP target DNS result is invalid.") from exc
            if address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast or address.is_reserved:
                raise GoppSecurityError("GOPP target address is not allowed.")

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        request_headers = {"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        try:
            with httpx.Client(timeout=self.timeout, follow_redirects=False, trust_env=False) as client:
                response = client.request(method, self.base_url + path, json=body, headers=request_headers)
        except httpx.TimeoutException as exc:
            raise GoppTransportError("GOPP request timed out.") from exc
        except httpx.HTTPError as exc:
            raise GoppTransportError("GOPP transport request failed.") from exc
        if 300 <= response.status_code < 400:
            raise GoppSecurityError("GOPP redirects are blocked.")
        try:
            data = response.json()
        except ValueError as exc:
            raise GoppProtocolError("GOPP response was not JSON.") from exc
        if response.status_code == 401:
            raise GoppAuthenticationError("GOPP authentication failed.")
        if response.status_code >= 400:
            problem = GoppProblem(
                code=str(data.get("code", "remote_error")) if isinstance(data, dict) else "remote_error",
                status=response.status_code,
                title=data.get("title") if isinstance(data, dict) else None,
                detail=data.get("detail") if isinstance(data, dict) else None,
                request_id=data.get("request_id") if isinstance(data, dict) else None,
                retryable=data.get("retryable") if isinstance(data, dict) else None,
                field_errors=data.get("field_errors") if isinstance(data, dict) else None,
            )
            raise GoppProtocolError("GOPP Receiver rejected the request.", request_id=problem.request_id, problem=problem)
        if not isinstance(data, dict) or data.get("protocol") != "GOPP" or data.get("protocol_version") != "1.0" or not isinstance(data.get("data"), dict):
            raise GoppProtocolError("GOPP response envelope is invalid.")
        return data

    def verify(self) -> dict[str, Any]:
        return self._request("POST", "/v1/verify", {})

    def channels(self) -> list[dict[str, Any]]:
        data = self._request("GET", "/v1/channels")
        channels = data["data"].get("channels")
        if not isinstance(channels, list):
            raise GoppProtocolError("GOPP channels response is invalid.")
        return channels

    def put_content(self, source_id: str, content: dict[str, Any]) -> dict[str, Any]:
        if not source_id or any(ord(char) < 32 or ord(char) == 127 for char in source_id):
            raise GoppError("source_id is invalid.")
        data = self._request("PUT", "/v1/content/" + quote(source_id, safe=""), content)
        result = data["data"].get("result")
        if result not in {"created", "updated", "unchanged"}:
            raise GoppProtocolError("GOPP content result is invalid.")
        return {**data["data"], "request_id": data.get("request_id")}
