"""The entry point: exit codes, the one file it writes, and what reaches the log."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run_assessment
from app import runner
from app.delivery import DeliveryResult
from app.programs import soar
from app.redcap import RedcapError
from tests.fakes import FAKE_TOKEN, FakeRedcapClient

# A fictional hospital, mapped by a crosswalk of the test's own.
CROSSWALK = {"example_hospital_a": {"cha_id": "EX-001", "hospital": "Example Hospital A"}}

RECORD = {
    "redcap_data_access_group": "example_hospital_a",
    "redcap_repeat_instrument": soar.NTSV_FORM,
    "record_id": "R-1041",
    "date": "2026-08-14",
    "delivery_date": "2026-07-23",
    "checklist_comms_tool": "1",
    "who_managed_labor_2": "2",
    "age": "43",
    "gest_age": "38.6",
    "c_sect_indication_primary": "4",
    "admit_reason___1": "1",
}


class MainTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name)
        self._xw = tempfile.TemporaryDirectory()
        self.crosswalks = Path(self._xw.name)
        (self.crosswalks / "crosswalk.soar.json").write_text(json.dumps(CROSSWALK))
        self.env = {"OUTPUT_DIR": str(self.out), "REDCAP_SOAR_TOKEN": FAKE_TOKEN, "PROGRAM_YEARS": "2026"}

    def tearDown(self):
        self._tmp.cleanup()
        self._xw.cleanup()

    def main(self, client=None, env=None, deliver=None):
        client = client or FakeRedcapClient([RECORD])
        patches = [
            # A developer's real .env must never leak into a test run.
            mock.patch.object(run_assessment, "load_dotenv"),
            mock.patch.dict(os.environ, env or self.env, clear=True),
            mock.patch.object(run_assessment, "RedcapClient", return_value=client),
            mock.patch.object(
                run_assessment,
                "build_snapshot",
                lambda config, client, today: runner.build_snapshot(
                    config, client, today, crosswalk_dir=self.crosswalks
                ),
            ),
        ]
        if deliver is not None:
            patches.append(mock.patch.object(run_assessment, "deliver", deliver))
        for p in patches:
            p.start()
        try:
            with self.assertLogs("engagement-assessment", level="INFO") as logs:
                code = run_assessment.main()
        finally:
            for p in reversed(patches):
                p.stop()
        return code, "\n".join(logs.output)

    def files(self) -> list[Path]:
        return sorted(self.out.iterdir())

    def test_success_writes_one_file_and_exits_0(self):
        code, log = self.main()
        self.assertEqual(code, 0)
        files = self.files()
        self.assertEqual(len(files), 1)
        self.assertRegex(files[0].name, r"^engagement-assessment-\d{8}T\d{6}Z\.json$")
        doc = json.loads(files[0].read_text(encoding="utf-8"))
        self.assertEqual(doc["runs"][0]["status"], "ok")
        self.assertEqual(doc["runs"][0]["assessments"][0]["cha_id"], "EX-001")
        self.assertIn("SOAR 2026: ok, 1 records read, 1 assessments", log)
        self.assertIn("DELIVERY_URL is not set", log)

    def test_a_configuration_error_runs_nothing_and_exits_2(self):
        client = FakeRedcapClient([RECORD])
        code, log = self.main(client=client, env={"REDCAP_SOAR_TOKEN": FAKE_TOKEN})
        self.assertEqual(code, 2)
        self.assertEqual(client.exports, [])
        self.assertEqual(self.files(), [])
        self.assertIn("OUTPUT_DIR is required", log)

    def test_a_program_failure_still_writes_the_file_and_exits_1(self):
        code, log = self.main(client=FakeRedcapClient(error=RedcapError("REDCap did not respond within 90s")))
        self.assertEqual(code, 1)
        doc = json.loads(self.files()[0].read_text(encoding="utf-8"))
        self.assertEqual(doc["runs"][0]["error"]["code"], "redcap_unavailable")
        self.assertIn("redcap_unavailable", log)

    def test_delivery_sends_the_written_bytes(self):
        deliver = mock.Mock(return_value=DeliveryResult(True, "stored by the tracker"))
        env = {**self.env, "DELIVERY_URL": "https://tracker.example/ingest", "DELIVERY_TOKEN": "dtok"}
        code, log = self.main(env=env, deliver=deliver)
        self.assertEqual(code, 0)
        body, url, token = deliver.call_args.args
        self.assertEqual(body, self.files()[0].read_bytes())
        self.assertEqual((url, token), ("https://tracker.example/ingest", "dtok"))
        self.assertIn("Delivered: stored by the tracker.", log)

    def test_a_failed_delivery_keeps_the_file_and_exits_1(self):
        deliver = mock.Mock(return_value=DeliveryResult(False, "the tracker returned HTTP 503, after 3 attempts"))
        env = {**self.env, "DELIVERY_URL": "https://tracker.example/ingest", "DELIVERY_TOKEN": "dtok"}
        code, log = self.main(env=env, deliver=deliver)
        self.assertEqual(code, 1)
        self.assertEqual(len(self.files()), 1)
        self.assertIn("Delivery failed", log)

    def test_the_log_never_carries_tokens_or_record_content(self):
        env = {**self.env, "DELIVERY_URL": "https://tracker.example/ingest", "DELIVERY_TOKEN": "dtok-secret"}
        deliver = mock.Mock(return_value=DeliveryResult(True, "stored by the tracker"))
        unknown = {**RECORD, "redcap_data_access_group": "new_hospital_x", "record_id": "R-2077"}
        _, log = self.main(client=FakeRedcapClient([RECORD, unknown]), env=env, deliver=deliver)
        for value in (FAKE_TOKEN, "dtok-secret", "R-1041", "R-2077", "2026-07-23", "38.6"):
            self.assertNotIn(value, log)
        # Warnings are fine to log: they describe the data, never quote it.
        self.assertIn('"new_hospital_x"', log)


if __name__ == "__main__":
    unittest.main()
