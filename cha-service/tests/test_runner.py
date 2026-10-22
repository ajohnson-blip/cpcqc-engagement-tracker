"""A whole run: per-program status, the file's exact shape, and what never reaches it."""
import json
import tempfile
import unittest
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

from app.config import Config
from app.crosswalk import CrosswalkError, load_crosswalk
from app.output import filename_for, serialize, write_file
from app.programs import soar
from app.redcap import RedcapError
from app.runner import build_snapshot
from tests.fakes import FAKE_TOKEN, FakeRedcapClient, soar_dictionary

TODAY = date(2026, 10, 20)
STARTED = datetime(2026, 10, 20, 7, 5, 12, tzinfo=timezone.utc)
SNAPSHOT_ID = uuid.UUID("8f2c1e4a-6b3d-4c9e-a1f7-2d5b8e0c9a31")

# Every key the contract defines, by object. The tracker refuses a file with
# any other key; this checks the same thing before the file leaves CHA.
CONTRACT_KEYS = {
    "envelope": {"format_version", "snapshot_id", "generated_at", "generator", "runs"},
    "generator": {"name", "version"},
    "run_ok": {"program", "program_year", "status", "methodology_version", "source", "assessments", "warnings"},
    "run_error": {"program", "program_year", "status", "error"},
    "source": {"records_read", "redcap_project"},
    "error": {"code", "message"},
    "assessment": {
        "cha_id", "period", "submitted", "complete", "earliest_submission_date", "records",
        "attestation_only", "missing_field_groups", "notes",
    },
    "records": {"total", "complete", "attestation"},
    "group": {"form", "records", "fields"},
    "field": {"field", "label"},
}


def config(out: Path, years=(2026,)) -> Config:
    return Config(
        output_dir=out,
        delivery_url=None,
        delivery_token=None,
        redcap_api_url="https://redcap.example/api/",
        redcap_timeout=90.0,
        tokens={"REDCAP_SOAR_TOKEN": FAKE_TOKEN},
        programs=("SOAR",),
        program_years=tuple(years),
        notices=(),
    )


def records() -> list[dict]:
    """Synthetic SOAR export with distinctive values that must not reach the file."""
    base = {
        "redcap_data_access_group": "acme_general",
        "redcap_repeat_instrument": soar.NTSV_FORM,
        "checklist_comms_tool": "1",
        "who_managed_labor_2": "2",
        "gest_age": "38.6",
        "c_sect_indication_primary": "4",
        "admit_reason___1": "1",
    }
    return [
        {**base, "record_id": "R-1041", "date": "2026-08-14", "delivery_date": "2026-07-23", "age": "43"},
        {**base, "record_id": "R-1042", "date": "2026-08-15", "delivery_date": "2026-07-19", "age": "",
         "admit_other": "free text here"},
        {**base, "record_id": "R-0999", "date": "2026-01-08", "delivery_date": "2025-12-28", "age": "29"},
        {"redcap_data_access_group": "new_hospital_x", "redcap_repeat_instrument": soar.NO_NTSV_FORM,
         "record_id": "R-3001", "date": "2026-08-02", "month_year_nontsv": "7", "self_report_nontsv___1": "1"},
    ]


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name)
        self.crosswalks = self.out / "crosswalks"
        self.crosswalks.mkdir()
        (self.crosswalks / "crosswalk.soar.json").write_text(
            json.dumps({"acme_general": {"cha_id": "EX-001", "hospital": "Acme General"}})
        )

    def tearDown(self):
        self._tmp.cleanup()

    def snapshot(self, client, years=(2026,)):
        return build_snapshot(
            config(self.out, years), client, TODAY,
            clock=lambda: STARTED, new_id=lambda: SNAPSHOT_ID, crosswalk_dir=self.crosswalks,
        )

    def test_an_ok_run_per_program_year_from_one_export(self):
        client = FakeRedcapClient(records(), labels={"age": "Patient's age"})
        snap = self.snapshot(client, years=(2025, 2026))
        self.assertEqual(len(client.exports), 1)
        self.assertEqual([(r.program, r.program_year, r.status) for r in snap.runs],
                         [("SOAR", 2025, "ok"), ("SOAR", 2026, "ok")])
        y2025, y2026 = snap.runs
        self.assertEqual([a.period for a in y2025.assessments], ["2025-12"])
        self.assertEqual([a.period for a in y2026.assessments], ["2026-07"])
        july = y2026.assessments[0]
        self.assertEqual((july.records.total, july.records.complete), (2, 1))
        self.assertEqual(july.missing_field_groups[0].fields[0].label, "Patient's age")
        self.assertEqual(y2026.source.records_read, 4)
        self.assertEqual(y2026.methodology_version, soar.METHODOLOGY_VERSION)
        self.assertTrue(any('"new_hospital_x"' in w for w in y2026.warnings))

    def test_the_export_asks_only_for_the_minimum_fields(self):
        client = FakeRedcapClient(records())
        self.snapshot(client)
        self.assertEqual(client.exports[0]["fields"], soar.MINIMUM_FIELDS)

    def test_generated_at_is_taken_before_reading_and_ids_are_stable(self):
        snap = self.snapshot(FakeRedcapClient(records()))
        self.assertEqual(snap.generated_at, "2026-10-20T07:05:12Z")
        self.assertEqual(snap.snapshot_id, str(SNAPSHOT_ID))
        self.assertEqual(filename_for(snap), "engagement-assessment-20261020T070512Z.json")

    def test_a_redcap_failure_fails_every_year_of_that_program(self):
        snap = self.snapshot(FakeRedcapClient(error=RedcapError("REDCap did not respond within 90s")),
                             years=(2025, 2026))
        self.assertEqual([(r.status, r.error.code) for r in snap.runs],
                         [("error", "redcap_unavailable")] * 2)
        self.assertEqual(snap.runs[0].assessments, ())
        self.assertIn("within 90s", snap.runs[0].error.message)

    def test_an_unexpected_error_never_carries_its_message(self):
        # The kind of message Python writes when a value from a record breaks
        # a conversion.
        boom = ValueError("invalid literal for int() with base 10: 'R-1041'")
        snap = self.snapshot(FakeRedcapClient(error=boom))
        err = snap.runs[0].error
        self.assertEqual(err.code, "internal")
        self.assertIn("ValueError at", err.message)
        self.assertNotIn("R-1041", err.message)
        self.assertNotIn("invalid literal", err.message)

    def test_an_unreadable_dictionary_fails_the_program_as_redcap_unavailable(self):
        snap = self.snapshot(FakeRedcapClient(records(), meta_error=RedcapError("REDCap did not respond within 90s")))
        self.assertEqual(snap.runs[0].error.code, "redcap_unavailable")

    def test_a_dictionary_that_breaks_the_code_pattern_is_a_configuration_error(self):
        snap = self.snapshot(FakeRedcapClient(records(), meta=soar_dictionary([2027])))
        err = snap.runs[0].error
        self.assertEqual(err.code, "configuration")
        self.assertIn('code 1 is labelled "January 2027"', err.message)

    def test_a_missing_crosswalk_is_a_configuration_error(self):
        (self.crosswalks / "crosswalk.soar.json").unlink()
        snap = self.snapshot(FakeRedcapClient(records()))
        self.assertEqual(snap.runs[0].error.code, "configuration")

    def test_the_file_has_exactly_the_contract_keys(self):
        snap = self.snapshot(FakeRedcapClient(records()))
        failed = self.snapshot(FakeRedcapClient(error=RedcapError("down")))
        doc = json.loads(serialize(snap))
        self.assertEqual(set(doc), CONTRACT_KEYS["envelope"])
        self.assertEqual(doc["format_version"], "v2")
        self.assertEqual(set(doc["generator"]), CONTRACT_KEYS["generator"])
        run = doc["runs"][0]
        self.assertEqual(set(run), CONTRACT_KEYS["run_ok"])
        self.assertEqual(set(run["source"]), CONTRACT_KEYS["source"])
        self.assertTrue(run["assessments"])
        for a in run["assessments"]:
            self.assertEqual(set(a), CONTRACT_KEYS["assessment"])  # no linkage outside TtT
            self.assertEqual(set(a["records"]), CONTRACT_KEYS["records"])
            for g in a["missing_field_groups"]:
                self.assertEqual(set(g), CONTRACT_KEYS["group"])
                for f in g["fields"]:
                    self.assertEqual(set(f), CONTRACT_KEYS["field"])
        err_run = json.loads(serialize(failed))["runs"][0]
        self.assertEqual(set(err_run), CONTRACT_KEYS["run_error"])
        self.assertEqual(set(err_run["error"]), CONTRACT_KEYS["error"])

    def test_the_file_never_carries_record_content(self):
        blob = serialize(self.snapshot(FakeRedcapClient(records()), years=(2025, 2026))).decode()
        for value in ("R-1041", "R-1042", "R-0999", "R-3001", "38.6", "2026-07-23", "2026-07-19",
                      "2025-12-28", "free text here", '"43"', '"29"', "record_id", FAKE_TOKEN):
            self.assertNotIn(value, blob)

    def test_writing_leaves_exactly_one_file(self):
        snap = self.snapshot(FakeRedcapClient(records()))
        path = write_file(serialize(snap), self.out, filename_for(snap))
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["crosswalks", path.name])
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["snapshot_id"], str(SNAPSHOT_ID))
        with self.assertRaises(FileExistsError):
            write_file(serialize(snap), self.out, filename_for(snap))


class CrosswalkTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def load(self, content):
        (self.dir / "crosswalk.soar.json").write_text(content if isinstance(content, str) else json.dumps(content))
        return load_crosswalk("SOAR", self.dir)

    def test_maps_dag_to_cha_id(self):
        self.assertEqual(self.load({"a": {"cha_id": "EX-001", "hospital": "A"}, "b": {"cha_id": 9001}}).cha_ids,
                         {"a": "EX-001", "b": "9001"})

    def test_tracked_false_is_known_but_skipped(self):
        crosswalk = self.load({"a": {"cha_id": "EX-001"}, "b": {"cha_id": "EX-002", "tracked": False}})
        self.assertEqual((crosswalk.cha_ids, crosswalk.untracked), ({"a": "EX-001"}, frozenset({"b"})))

    def test_untracked_ids_still_cannot_repeat(self):
        with self.assertRaisesRegex(CrosswalkError, "both map to CHA ID EX-001"):
            self.load({"a": {"cha_id": "EX-001"}, "b": {"cha_id": "EX-001", "tracked": False}})

    def test_refuses_a_tracked_value_that_is_not_true_or_false(self):
        with self.assertRaisesRegex(CrosswalkError, "not true or false"):
            self.load({"a": {"cha_id": "EX-001", "tracked": "no"}})

    def test_refuses_a_crosswalk_that_tracks_nothing(self):
        with self.assertRaisesRegex(CrosswalkError, "tracks no hospital"):
            self.load({"a": {"cha_id": "EX-001", "tracked": False}})

    def test_refuses_an_entry_without_a_cha_id(self):
        with self.assertRaises(CrosswalkError):
            self.load({"a": {"hospital": "A"}})

    def test_refuses_two_groups_claiming_one_hospital(self):
        with self.assertRaisesRegex(CrosswalkError, "both map to CHA ID EX-001"):
            self.load({"a": {"cha_id": "EX-001"}, "b": {"cha_id": "EX-001"}})

    def test_refuses_unreadable_json(self):
        with self.assertRaises(CrosswalkError):
            self.load("{not json")

    def test_the_shipped_soar_crosswalk_loads(self):
        crosswalk = load_crosswalk("SOAR")
        self.assertEqual((len(crosswalk.cha_ids), len(crosswalk.untracked)), (16, 21))
        self.assertTrue(all(cha_id.isdigit() for cha_id in crosswalk.cha_ids.values()))


if __name__ == "__main__":
    unittest.main()
