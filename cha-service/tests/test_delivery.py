"""Delivery: what is sent, when it retries, and what it reports."""
import unittest

import requests

from app.delivery import deliver
from tests.fakes import FakeSession, response

URL = "https://tracker.example/ingest"
BODY = b'{"format_version": "v2"}\n'


def send(*outcomes, delays=(30.0, 120.0)):
    session = FakeSession(*outcomes)
    slept: list[float] = []
    result = deliver(BODY, URL, "delivery-token", session=session, delays=delays, sleep=slept.append)
    return result, session, slept


class DeliveryTests(unittest.TestCase):
    def test_sends_the_exact_bytes_with_the_token(self):
        result, s, slept = send(response(200, body={"status": "stored"}))
        self.assertTrue(result.ok)
        self.assertEqual(result.message, "stored by the tracker")
        call = s.calls[0]
        self.assertEqual(call["url"], URL)
        self.assertIs(call["data"], BODY)
        self.assertEqual(call["headers"]["Authorization"], "Bearer delivery-token")
        self.assertEqual(call["headers"]["Content-Type"], "application/json")
        self.assertFalse(call["allow_redirects"])
        self.assertEqual(slept, [])

    def test_a_repeat_delivery_is_reported_as_already_stored(self):
        result, _, _ = send(response(200, body={"status": "already_stored"}))
        self.assertTrue(result.ok)
        self.assertIn("already stored", result.message)

    def test_a_refusal_is_final_and_explains_itself(self):
        result, s, _ = send(response(400, body={"error": {"message": 'Unrecognised key "delivery_date"'}}))
        self.assertFalse(result.ok)
        self.assertIn("refused the file (HTTP 400)", result.message)
        self.assertIn('Unrecognised key "delivery_date"', result.message)
        self.assertEqual(len(s.calls), 1)

    def test_a_bad_token_is_final(self):
        result, s, _ = send(response(401, body={"error": "unauthorized"}))
        self.assertFalse(result.ok)
        self.assertIn("DELIVERY_TOKEN", result.message)
        self.assertNotIn("delivery-token", result.message)
        self.assertEqual(len(s.calls), 1)

    def test_a_redirect_is_not_followed(self):
        result, s, _ = send(response(302, text=""))
        self.assertFalse(result.ok)
        self.assertIn("redirected", result.message)
        self.assertEqual(len(s.calls), 1)

    def test_a_server_error_is_retried_with_waits(self):
        result, s, slept = send(response(503, text=""), response(200, body={"status": "stored"}))
        self.assertTrue(result.ok)
        self.assertEqual(len(s.calls), 2)
        self.assertEqual(slept, [30.0])

    def test_gives_up_after_the_last_attempt(self):
        result, s, slept = send(
            requests.ConnectionError("x"), requests.Timeout("y"), response(500, text="")
        )
        self.assertFalse(result.ok)
        self.assertEqual(len(s.calls), 3)
        self.assertEqual(slept, [30.0, 120.0])
        self.assertIn("HTTP 500, after 3 attempts", result.message)

    def test_an_unreadable_refusal_is_described(self):
        result, _, _ = send(response(422, text="<html>nope</html>"))
        self.assertIn("HTML", result.message)
        self.assertNotIn("nope", result.message)


if __name__ == "__main__":
    unittest.main()
