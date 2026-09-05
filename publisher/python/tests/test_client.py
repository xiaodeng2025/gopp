import os
import unittest
from unittest.mock import patch

import httpx

from gopp.client import GoppClient
from gopp.errors import GoppAuthenticationError, GoppProtocolError, GoppSecurityError


class PythonClientTests(unittest.TestCase):
    def test_production_rejects_http(self):
        with self.assertRaises(GoppSecurityError):
            GoppClient("http://example.invalid", "test-token")

    def test_verify_and_content_use_gopp_envelope(self):
        responses = [
            httpx.Response(200, json={"protocol": "GOPP", "protocol_version": "1.0", "request_id": "r1", "data": {"site": {}, "capabilities": {"content_formats": ["html"], "statuses": ["draft"], "upsert": True, "channels": False, "tags": False, "seo": False, "media": False, "revision": False, "extensions": []}}}),
            httpx.Response(201, json={"protocol": "GOPP", "protocol_version": "1.0", "request_id": "r2", "data": {"result": "created", "remote_id": "remote-1"}}),
        ]

        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def request(self, *_args, **_kwargs):
                return responses.pop(0)

        with patch.dict(os.environ, {}, clear=False), patch.object(GoppClient, "_check_target"), patch("gopp.client.httpx.Client", FakeClient):
            client = GoppClient("https://receiver.example.invalid", "test-token")
            self.assertEqual(client.verify()["protocol"], "GOPP")
            self.assertEqual(client.put_content("source-1", {"title": "T", "content": {"format": "html", "body": "<p>x</p>"}})["result"], "created")

    def test_authentication_error_is_typed(self):
        class FakeClient:
            def __init__(self, **_kwargs):
                pass

            def __enter__(self): return self
            def __exit__(self, *_): return False
            def request(self, *_args, **_kwargs): return httpx.Response(401, json={"code": "authentication_failed"})

        with patch.object(GoppClient, "_check_target"), patch("gopp.client.httpx.Client", FakeClient):
            with self.assertRaises(GoppProtocolError):
                GoppClient("https://receiver.example.invalid", "test-token").verify()

    def test_http_test_exception_is_loopback_only(self):
        with self.assertRaises(GoppSecurityError):
            GoppClient("http://example.com", "test-token", allow_loopback=True)
        with self.assertRaises(GoppSecurityError):
            GoppClient("http://10.0.0.1", "test-token", allow_loopback=True)

    def test_public_https_target_is_allowed(self):
        with patch.object(GoppClient, "_check_target"):
            GoppClient("https://example.com", "test-token")

    def test_malformed_401_is_not_authentication_error(self):
        class FakeClient:
            def __init__(self, **_kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def request(self, *_args, **_kwargs):
                return httpx.Response(401, json={"code": "authentication_failed", "retryable": False})

        with patch.object(GoppClient, "_check_target"), patch("gopp.client.httpx.Client", FakeClient):
            with self.assertRaises(GoppProtocolError):
                GoppClient("https://receiver.example.invalid", "test-token").verify()

    def test_retryable_false_problem_is_valid_and_typed(self):
        class FakeClient:
            def __init__(self, **_kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def request(self, *_args, **_kwargs):
                return httpx.Response(401, json={"type": "about:blank", "title": "Authentication failed", "status": 401, "code": "authentication_failed", "request_id": "r401", "retryable": False})

        with patch.object(GoppClient, "_check_target"), patch("gopp.client.httpx.Client", FakeClient):
            with self.assertRaises(GoppAuthenticationError):
                GoppClient("https://receiver.example.invalid", "test-token").verify()


if __name__ == "__main__":
    unittest.main()
