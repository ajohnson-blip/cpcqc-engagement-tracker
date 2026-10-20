"""REDCap client: what is requested, and that errors describe responses without quoting them."""
import unittest

import requests

from app.redcap import RedcapClient, RedcapError
from tests.fakes import FAKE_TOKEN, FakeSession, response

URL = "https://redcap.example/api/"


def client(*outcomes) -> tuple[RedcapClient, FakeSession]:
    session = FakeSession(*outcomes)
    return RedcapClient(URL, 90, session=session), session


class ExportRecordsTests(unittest.TestCase):
    def test_requests_named_fields_and_no_forms(self):
        c, s = client(response(body=[]))
        c.export_records(FAKE_TOKEN, ["date", "age"])
        data = s.calls[0]["data"]
        self.assertEqual(
            [data[k] for k in sorted(k for k in data if k.startswith("fields["))],
            ["record_id", "date", "age"],
        )
        # REDCap unions fields with forms, so any forms[] would restrict nothing.
        self.assertFalse(any(k.startswith("forms") or k == "form" for k in data))
        self.assertEqual(data["exportDataAccessGroups"], "true")
        self.assertEqual(data["rawOrLabel"], "raw")
        self.assertEqual(s.calls[0]["timeout"], 90)

    def test_record_id_can_be_left_out(self):
        c, s = client(response(body=[]))
        c.export_records(FAKE_TOKEN, ["date"], include_record_id=False)
        self.assertEqual(s.calls[0]["data"]["fields[0]"], "date")

    def test_returns_the_records(self):
        c, _ = client(response(body=[{"a": "1"}]))
        self.assertEqual(c.export_records(FAKE_TOKEN, ["a"]), [{"a": "1"}])


class ErrorTests(unittest.TestCase):
    def assert_error(self, outcome, *expected, forbidden=()):
        c, _ = client(outcome)
        with self.assertRaises(RedcapError) as ctx:
            c.export_records(FAKE_TOKEN, ["date"])
        message = str(ctx.exception)
        for text in expected:
            self.assertIn(text, message)
        for text in (*forbidden, FAKE_TOKEN):
            self.assertNotIn(text, message)
        return message

    def test_a_malformed_body_is_described_not_quoted(self):
        # Truncated JSON that begins with record content.
        body = '[{"record_id":"R-1041","delivery_date":"2026-07-23"'
        self.assert_error(response(text=body), "JSON-like content that failed to parse",
                          forbidden=("R-1041", "2026-07-23"))

    def test_an_html_page_is_recognised(self):
        self.assert_error(response(text="<html>Sign in</html>"), "HTML")

    def test_an_error_status_with_an_unreadable_body(self):
        self.assert_error(response(502, text="<html>Bad gateway</html>"), "HTTP 502", "HTML",
                          forbidden=("Bad gateway",))

    def test_redcaps_own_error_message_is_passed_on(self):
        self.assert_error(response(403, body={"error": "You do not have API rights"}),
                          "HTTP 403", "You do not have API rights")

    def test_an_error_object_on_a_200(self):
        self.assert_error(response(body={"error": "Invalid field"}), "REDCap error: Invalid field")

    def test_an_object_that_is_not_an_error(self):
        self.assert_error(response(body={"record_id": "R-1041"}), "an object where a list",
                          forbidden=("R-1041",))

    def test_a_timeout(self):
        self.assert_error(requests.Timeout("read timed out at https://redcap.example"), "within 90s",
                          forbidden=("redcap.example",))

    def test_a_connection_failure_names_only_the_class(self):
        self.assert_error(requests.ConnectionError("Max retries exceeded with url: /api/"),
                          "Could not reach REDCap (ConnectionError)", forbidden=("Max retries",))

    def test_a_long_redcap_message_is_capped(self):
        message = self.assert_error(response(400, body={"error": "x" * 5000}), "rejected")
        self.assertLess(len(message), 400)


class LabelTests(unittest.TestCase):
    def test_labels_are_stripped_of_markup(self):
        c, s = client(response(body=[
            {"field_name": "age", "field_label": "<b>Patient's</b> age"},
            {"field_name": "blank", "field_label": ""},
        ]))
        self.assertEqual(c.export_field_labels(FAKE_TOKEN), {"age": "Patient's age"})
        self.assertEqual(s.calls[0]["data"]["content"], "metadata")

    def test_a_failure_returns_no_labels_rather_than_failing(self):
        c, _ = client(response(500, text=""))
        self.assertEqual(c.export_field_labels(FAKE_TOKEN), {})


if __name__ == "__main__":
    unittest.main()
