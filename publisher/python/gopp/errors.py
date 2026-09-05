"""Public, protocol-level errors for the GOPP Python client."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class GoppProblem:
    code: str
    status: int
    title: str | None = None
    detail: str | None = None
    request_id: str | None = None
    retryable: bool | None = None
    field_errors: list[dict[str, Any]] | None = None


class GoppError(Exception):
    def __init__(self, message: str, *, request_id: str | None = None, problem: GoppProblem | None = None):
        super().__init__(message)
        self.request_id = request_id
        self.problem = problem


class GoppAuthenticationError(GoppError):
    pass


class GoppTransportError(GoppError):
    pass


class GoppSecurityError(GoppError):
    pass


class GoppProtocolError(GoppError):
    pass
