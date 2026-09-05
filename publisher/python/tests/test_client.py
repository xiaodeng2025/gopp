import os
import unittest
from unittest.mock import patch

import httpx

from gopp.client import GoppClient
from gopp.errors import GoppAuthenticationError, GoppSecurityError


class PythonClientTests(unittest.TestCase):
    def test_production_rejects_http(self):
        with self.assertRaises(GoppSecurityError):
            GoppClient("http://example.invalid", "test-token")

    def test_verify_and_content_use_gopp_envelope(self):
        responses = [
            httpx.Response(200, json={"protocol": "GOPP", "protocol_version": "1.0", "request_id": "r1", "data": {"capabilities": {}}}),
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
            with self.assertRaises(GoppAuthenticationError):
                GoppClient("https://receiver.example.invalid", "test-token").verify()


if __name__ == "__main__":
    unittest.main()
