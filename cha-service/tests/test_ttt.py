"""TtT: three projects joined on CHA ID, completeness from the dictionary, linkage.

Synthetic data only. Hospitals, groups and IDs are fictional.
"""
import json
import tempfile
import unittest
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

from app.config import Config
from app.crosswalk import CrosswalkError, load_crosswalk
from app.output import serialize
from app.programs import ttt
from app.redcap import RedcapError
from app.runner import build_snapshot

HOSPITAL_TOKEN = "11111111111111111111111111111111"
PATIENT_TOKEN = "22222222222222222222222222222222"
DYADIC_TOKEN = "33333333333333333333333333333333"
TODAY = date(2026, 10, 20)
FORM = ttt.HOSPITAL_FORM

CROSSWALK = {
    "hospitals": [
        {"cha_id": "EX-001", "hospital": "Acme General", "hospital_dag": "acme_general", "patient_dags": ["acme_general"]},
        # Spelt differently in the patient project.
        {"cha_id": "EX-002", "hospital": "Birch Valley", "hospital_dag": "birch_valley", "patient_dags": ["birch_vly_pt"]},
        # Two patient-project groups for one hospital.
        {"cha_id": "EX-003", "hospital": "Cedar Ridge", "hospital_dag": "cedar_ridge", "patient_dags": ["cedar_ridge", "cedar_ridgeb"]},
        # Enters its patient forms in the Dyadic project.
        {"cha_id": "EX-004", "hospital": "Dogwood Health", "hospital_dag": "dogwood", "patient_dags": ["dogwood"], "dyadic_dag": "dogwood_dy"},
    ],
    "not_hospitals": ["other_collab", "test"],
}


def dictionary(extra=()):
    """The monthly form's dictionary: three required fields plus ones that must not count."""
    meta = [
        {"field_name": "record_id", "form_name": FORM, "required_field": "", "field_label": "Record ID"},
        {"field_name": "month_reporting", "form_name": FORM, "required_field": "y", "field_label": "Month"},
        {"field_name": "tot_sud_scrnd_pos", "form_name": FORM, "required_field": "y",
         "field_label": "<b>Positive</b> SUD screens"},
        {"field_name": "tot_dep_scrnd", "form_name": FORM, "required_field": "y", "field_label": "Depression screened"},
        {"field_name": "tot_anx_scrnd", "form_name": FORM, "required_field": "y", "field_label": "Anxiety screened"},
        {"field_name": "retired_count", "form_name": FORM, "required_field": "y", "field_annotation": "@hidden"},
        {"field_name": "other_form_field", "form_name": "readiness", "required_field": "y"},
        {"field_name": "optional_note", "form_name": FORM, "required_field": ""},
    ]
    return meta + list(extra)


def report(dag, record, month_code, positives="0", **over):
    row = {"record_id": record, "redcap_data_access_group": dag, "month_reporting": month_code,
           "tot_sud_scrnd_pos": positives, "tot_dep_scrnd": "10"}
    row.update(over)
    return row


def patient(dag, delivered, *codes, eligibility=""):
    row = {"record_id": f"P-{uuid.uuid4().hex[:6]}", "redcap_data_access_group": dag,
           "delivery_date_1": delivered, "sample_check_patient": eligibility}
    row.update({f"substances_used_2___{c}": "1" for c in codes})
    return row


def dyadic(dag, delivered, *codes, eligibility=""):
    row = {"redcap_data_access_group": dag, "delivery_date_1": delivered, "sample_check_mat": eligibility}
    row.update({f"substances_used_2___{c}": "1" for c in codes})
    return row


def created(record, when, action="Create record"):
    return {"timestamp": when, "username": "someone", "action": action, "details": "tot_dep_scrnd = '10'",
            "record": record}


class Client:
    """Each project's canned rows, by token, and a record of every call."""

    def __init__(self, hospital=(), patients=(), dyadic_rows=(), meta=None, log=(), log_error=None,
                 dyadic_error=None):
        self.rows = {HOSPITAL_TOKEN: list(hospital), PATIENT_TOKEN: list(patients), DYADIC_TOKEN: list(dyadic_rows)}
        self.meta = dictionary() if meta is None else meta
        self.log = list(log)
        self.log_error = log_error
        self.dyadic_error = dyadic_error
        self.calls: list[tuple] = []
        self.instances: list[str] = []

    def export_metadata(self, token):
        self.calls.append(("metadata", token))
        return self.meta

    def export_records(self, token, fields, include_record_id=True):
        self.calls.append(("records", token, tuple(fields), include_record_id))
        if token == DYADIC_TOKEN and self.dyadic_error:
            raise self.dyadic_error
        return self.rows[token]

    def export_log(self, token, begin_time):
        self.calls.append(("log", token, begin_time))
        if self.log_error:
            raise self.log_error
        return self.log

    def at(self, api_url):
        self.instances.append(api_url)
        return self


def config(out=Path("."), years=(2026,), dyadic_url=None) -> Config:
    return Config(
        output_dir=out, delivery_url=None, delivery_token=None,
        redcap_api_url="https://redcap.example/api/", redcap_timeout=90.0,
        tokens={"REDCAP_TTT_HOSPITAL_TOKEN": HOSPITAL_TOKEN, "REDCAP_TTT_PATIENT_TOKEN": PATIENT_TOKEN,
                "REDCAP_TTT_DYADIC_TOKEN": DYADIC_TOKEN},
        programs=("TTT",), program_years=tuple(years), notices=(), ttt_dyadic_api_url=dyadic_url,
    )


class TttTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.write_crosswalk(CROSSWALK)

    def tearDown(self):
        self._tmp.cleanup()

    def write_crosswalk(self, content):
        (self.dir / "crosswalk.ttt.json").write_text(
            content if isinstance(content, str) else json.dumps(content)
        )

    def assess(self, client, year=2026, years=None, dyadic_url=None):
        crosswalk = load_crosswalk("TTT", self.dir)
        fetched = ttt.fetch(client, config(years=years or (year,), dyadic_url=dyadic_url), crosswalk)
        assessments, warnings = ttt.assess_year(fetched, year, crosswalk, TODAY)
        return {(a.cha_id, a.period): a for a in assessments}, warnings

    def snapshot(self, client, years=(2026,)):
        return build_snapshot(
            config(self.dir, years), client, TODAY,
            clock=lambda: datetime(2026, 10, 20, 7, 0, tzinfo=timezone.utc),
            new_id=lambda: uuid.UUID("8f2c1e4a-6b3d-4c9e-a1f7-2d5b8e0c9a31"),
            crosswalk_dir=self.dir,
        )


class RuleTests(unittest.TestCase):
    def test_required_fields_come_from_the_dictionary(self):
        self.assertEqual(ttt.required_fields(dictionary()), ("month_reporting", "tot_sud_scrnd_pos", "tot_dep_scrnd"))

    def test_a_field_with_no_form_name_counts_as_the_monthly_forms(self):
        self.assertIn("loose", ttt.required_fields(dictionary([{"field_name": "loose", "required_field": "Y"}])))

    def test_month_codes_count_from_january_2025(self):
        cases = {"1": "2025-01", "12": "2025-12", "13": "2026-01", "24": "2026-12", "25": "2027-01", " 13": "2026-01"}
        for code, period in cases.items():
            self.assertEqual(ttt.month_code_to_period(code), period, code)
        for code in ("0", "-3", "", "abc", None):
            self.assertIsNone(ttt.month_code_to_period(code), code)

    def test_patient_eligibility_is_derived(self):
        codes, field = ttt.PATIENT_QUALIFYING_CODES, ttt.PATIENT_ELIGIBILITY_FIELD
        self.assertTrue(ttt.is_eligible(patient("a", "2026-01-01", "1"), field, codes))
        # The eligibility field left blank still counts a real form.
        self.assertTrue(ttt.is_eligible(patient("a", "2026-01-01", "9", eligibility=""), field, codes))
        self.assertFalse(ttt.is_eligible(patient("a", "2026-01-01", "1", eligibility="2"), field, codes))
        for only in ("3", "7", "10"):  # not qualifying in the patient project
            self.assertFalse(ttt.is_eligible(patient("a", "2026-01-01", only), field, codes), only)
        self.assertFalse(ttt.is_eligible(patient("a", "2026-01-01", eligibility="1"), field, codes))

    def test_dyadic_codes_are_its_own(self):
        codes, field = ttt.DYADIC_QUALIFYING_CODES, ttt.DYADIC_ELIGIBILITY_FIELD
        self.assertTrue(ttt.is_eligible(dyadic("a", "2026-01-01", "3"), field, codes))
        for only in ("7", "8", "9"):  # alcohol, nicotine, cannabis in Dyadic
            self.assertFalse(ttt.is_eligible(dyadic("a", "2026-01-01", only), field, codes), only)
        self.assertFalse(ttt.is_eligible(dyadic("a", "2026-01-01", "1", eligibility="2"), field, codes))
        # The patient project's field means nothing in Dyadic.
        row = {**dyadic("a", "2026-01-01", "1"), "sample_check_patient": "2"}
        self.assertTrue(ttt.is_eligible(row, field, codes))

    def test_a_patient_row_keeps_only_group_month_and_eligibility(self):
        form = ttt.reduce_patient_row(patient("acme_general", "2026-03-17", "1"), ttt.PATIENT_ELIGIBILITY_FIELD,
                                      ttt.PATIENT_QUALIFYING_CODES)
        self.assertEqual(form, ttt.PatientForm(dag="acme_general", month="2026-03", eligible=True))
        bad = ttt.reduce_patient_row(patient("acme_general", "2026-02-30", "1"), ttt.PATIENT_ELIGIBILITY_FIELD,
                                     ttt.PATIENT_QUALIFYING_CODES)
        self.assertIsNone(bad.month)

    def test_submission_date_is_the_earliest_create_entry(self):
        log = [
            created("R-1", "2026-06-12 09:30"),
            created("R-1", "2026-06-10 16:02"),
            created("R-1", "2026-06-01 08:00", action="Update record"),
            created("R-2", "not a time"),
            created("", "2026-06-03 10:00"),
        ]
        self.assertEqual(ttt.earliest_creation(log), {"R-1": "2026-06-10"})

    def test_positive_screens(self):
        cases = {"": (0, True), None: (0, True), "4": (4, True), " 4 ": (4, True), "4.0": (4, True),
                 "2.5": (0, False), "-1": (0, False), "abc": (0, False), "inf": (0, False), "nan": (0, False)}
        for value, expected in cases.items():
            self.assertEqual(ttt.positive_screens(value), expected, value)

    def test_linkage_floor_and_ideal(self):
        none = ttt.linkage(0, 2)
        self.assertEqual((none.shortfall, none.floor_met, none.ideal_met), (0, True, True))
        no_forms = ttt.linkage(3, 0)
        self.assertEqual((no_forms.shortfall, no_forms.floor_met, no_forms.ideal_met), (3, False, False))
        short = ttt.linkage(3, 1)
        self.assertEqual((short.shortfall, short.floor_met, short.ideal_met), (2, True, False))
        enough = ttt.linkage(3, 4)
        self.assertEqual((enough.shortfall, enough.floor_met, enough.ideal_met), (0, True, True))


class AssessmentTests(TttTestCase):
    def client(self, **over):
        defaults = dict(
            hospital=[
                # Acme, June 2026: two reports, one complete. Complete, since one passes.
                report("acme_general", "R-1", "18", positives="2"),
                report("acme_general", "R-2", "18", positives="1", tot_dep_scrnd=""),
                # Birch, June: positives but no patient form.
                report("birch_valley", "R-3", "18", positives="3"),
                # Cedar, June: forms from both of its patient groups.
                report("cedar_ridge", "R-4", "18", positives="2"),
                # Dogwood, June: forms from Dyadic.
                report("dogwood", "R-5", "18", positives="2"),
                # Acme, December 2025: another program year.
                report("acme_general", "R-6", "12", positives="1"),
                # Not a TtT hospital; nobody has listed this one.
                report("other_collab", "R-7", "18", positives="5"),
                report("new_hospital_x", "R-8", "18"),
            ],
            patients=[
                patient("acme_general", "2026-06-03", "1"),
                patient("acme_general", "2026-06-21", "7"),  # cannabis only: not eligible
                patient("acme_general", "2026-07-02", "2"),  # July: no report yet
                patient("cedar_ridge", "2026-06-09", "4"),
                patient("cedar_ridgeb", "2026-06-15", "5"),
                patient("birch_vly_pt", "2026-05-30", "1"),  # May, not June
                patient("other_collab", "2026-06-01", "1"),
                patient("unlisted_pt", "2026-06-01", "1"),
            ],
            dyadic_rows=[
                dyadic("dogwood_dy", "2026-06-05", "3"),
                dyadic("dogwood_dy", "2026-06-11", "9"),  # cannabis in Dyadic: not eligible
                dyadic("another_collab_dy", "2026-06-01", "1"),
            ],
            log=[created(f"R-{i}", f"2026-07-{10 + i:02d} 12:00") for i in range(1, 8)],
        )
        defaults.update(over)
        return Client(**defaults)

    def test_a_month_is_complete_when_any_report_passes(self):
        cells, _ = self.assess(self.client())
        a = cells[("EX-001", "2026-06")]
        self.assertTrue(a.submitted)
        self.assertTrue(a.complete)
        self.assertEqual((a.records.total, a.records.complete), (2, 1))
        self.assertEqual(a.earliest_submission_date, "2026-07-11")
        group = a.missing_field_groups[0]
        self.assertEqual((group.form, group.records), (FORM, 1))
        self.assertEqual([(f.field, f.label) for f in group.fields], [("tot_dep_scrnd", "Depression screened")])
        self.assertIn("2 reports were entered for this month; their positive screens are added together.", a.notes)

    def test_linkage_counts_eligible_forms_through_each_projects_groups(self):
        cells, _ = self.assess(self.client())
        acme = cells[("EX-001", "2026-06")].linkage
        self.assertEqual((acme.positive_screens, acme.patient_forms, acme.shortfall), (3, 1, 2))
        self.assertEqual((acme.floor_met, acme.ideal_met), (True, False))
        birch = cells[("EX-002", "2026-06")].linkage
        self.assertEqual((birch.positive_screens, birch.patient_forms, birch.floor_met), (3, 0, False))
        cedar = cells[("EX-003", "2026-06")].linkage
        self.assertEqual((cedar.patient_forms, cedar.ideal_met), (2, True))
        dogwood = cells[("EX-004", "2026-06")].linkage
        self.assertEqual((dogwood.positive_screens, dogwood.patient_forms, dogwood.floor_met), (2, 1, True))

    def test_a_month_with_only_patient_forms_is_listed_unsubmitted(self):
        cells, _ = self.assess(self.client())
        for key in (("EX-001", "2026-07"), ("EX-002", "2026-05")):
            a = cells[key]
            self.assertFalse(a.submitted)
            self.assertFalse(a.complete)
            self.assertEqual((a.records.total, a.earliest_submission_date, a.missing_field_groups), (0, None, ()))
            self.assertEqual((a.linkage.positive_screens, a.linkage.patient_forms, a.linkage.floor_met), (0, 1, True))

    def test_each_program_year_sees_only_its_months(self):
        cells_2025, _ = self.assess(self.client(), year=2025, years=(2025, 2026))
        self.assertEqual(list(cells_2025), [("EX-001", "2025-12")])
        cells_2026, _ = self.assess(self.client())
        self.assertTrue(all(period.startswith("2026-") for _, period in cells_2026))

    def test_unlisted_groups_are_reported_per_project_and_known_ones_are_not(self):
        _, warnings = self.assess(self.client())
        self.assertTrue(any('"new_hospital_x" has TtT hospital-project data' in w for w in warnings))
        self.assertTrue(any('"unlisted_pt" has TtT patient-project data' in w for w in warnings))
        self.assertFalse(any("other_collab" in w for w in warnings))
        # The Dyadic project is shared: other groups there are expected.
        self.assertFalse(any("another_collab_dy" in w for w in warnings))

    def test_a_group_is_mapped_only_in_its_own_project(self):
        # Birch's patient-project spelling means nothing in the hospital project.
        cells, warnings = self.assess(self.client(hospital=[report("birch_vly_pt", "R-1", "18", positives="1")]))
        self.assertNotIn(("EX-002", "2026-06"), cells)
        self.assertTrue(any('"birch_vly_pt" has TtT hospital-project data' in w for w in warnings))

    def test_an_unreadable_log_leaves_every_date_unknown_with_one_warning(self):
        client = self.client(log_error=RedcapError("REDCap rejected the request (HTTP 403): You do not have Logging rights"))
        cells, warnings = self.assess(client)
        self.assertTrue(all(a.earliest_submission_date is None for a in cells.values()))
        self.assertTrue(all(not any("creation entry" in n for n in a.notes) for a in cells.values()))
        self.assertEqual(sum("log for the TtT hospital project could not be read" in w for w in warnings), 1)
        self.assertTrue(any("Logging user right" in w for w in warnings))

    def test_a_report_missing_from_the_log_is_noted(self):
        cells, _ = self.assess(self.client(log=[created("R-1", "2026-07-11 12:00")]))
        acme = cells[("EX-001", "2026-06")]
        self.assertEqual(acme.earliest_submission_date, "2026-07-11")
        self.assertIn("1 report has no creation entry in REDCap's log, so when it was submitted is unknown.", acme.notes)

    def test_the_log_is_read_from_the_earliest_year_assessed(self):
        client = self.client()
        self.assess(client, year=2025, years=(2025, 2026))
        self.assertIn(("log", HOSPITAL_TOKEN, "2025-01-01 00:00"), client.calls)

    def test_reports_and_forms_that_cannot_be_placed_in_a_month_are_counted(self):
        client = self.client(
            hospital=[report("acme_general", "R-1", "", positives="2"), report("acme_general", "R-2", "")],
            patients=[patient("birch_vly_pt", "", "1"), patient("birch_vly_pt", "not a date", "2"),
                      patient("birch_vly_pt", "", "7")],
        )
        _, warnings = self.assess(client)
        self.assertIn("Acme General (CHA ID EX-001): 2 hospital reports have data but no reporting month, so they "
                      "are not counted in any month.", warnings)
        # Only the eligible ones: the cannabis-only form would not have counted anyway.
        self.assertIn("Birch Valley (CHA ID EX-002): 2 eligible patient forms have no valid delivery date, so they "
                      "are not counted in any month's linkage.", warnings)

    def test_an_unreadable_positive_count_is_noted_and_counted_as_zero(self):
        cells, _ = self.assess(self.client(hospital=[report("acme_general", "R-1", "18", positives="two")]))
        a = cells[("EX-001", "2026-06")]
        self.assertEqual(a.linkage.positive_screens, 0)
        self.assertIn("1 report has a positive-screen count that is not a whole number, counted as 0.", a.notes)

    def test_reads_ask_only_for_what_the_rules_use(self):
        client = self.client()
        self.assess(client)
        records = [c for c in client.calls if c[0] == "records"]
        self.assertEqual(records[0], ("records", HOSPITAL_TOKEN, ("month_reporting", "tot_sud_scrnd_pos", "tot_dep_scrnd"), True))
        self.assertEqual(records[1], ("records", PATIENT_TOKEN, tuple(ttt.PATIENT_MINIMUM_FIELDS), True))
        self.assertEqual(records[2], ("records", DYADIC_TOKEN, tuple(ttt.DYADIC_MINIMUM_FIELDS), False))
        self.assertEqual(client.instances, [])

    def test_the_dyadic_project_can_be_on_another_instance(self):
        client = self.client()
        self.assess(client, dyadic_url="https://redcap.other.example/api/")
        self.assertEqual(client.instances, ["https://redcap.other.example/api/"])

    def test_a_dyadic_group_with_no_rows_is_reported(self):
        cells, warnings = self.assess(self.client(dyadic_rows=[dyadic("another_collab_dy", "2026-06-01", "1")]))
        self.assertEqual(cells[("EX-004", "2026-06")].linkage.patient_forms, 0)
        self.assertTrue(any('none in data access group "dogwood_dy", so Dogwood Health (CHA ID EX-004) has no '
                            "patient forms from it" in w for w in warnings))

    def test_without_a_dyadic_hospital_the_dyadic_project_is_not_read(self):
        crosswalk = json.loads(json.dumps(CROSSWALK))
        del crosswalk["hospitals"][3]["dyadic_dag"]
        self.write_crosswalk(crosswalk)
        client = self.client()
        self.assess(client)
        self.assertFalse(any(c[0] == "records" and c[1] == DYADIC_TOKEN for c in client.calls))


class RunTests(TttTestCase):
    def test_an_ok_run_carries_linkage_and_nothing_from_a_record(self):
        client = Client(
            hospital=[report("acme_general", "R-1041", "18", positives="2", optional_note="free text here")],
            patients=[patient("acme_general", "2026-06-03", "1"), patient("acme_general", "2026-06-29", "2")],
            dyadic_rows=[dyadic("dogwood_dy", "2026-06-07", "1")],
            log=[created("R-1041", "2026-07-14 09:12")],
        )
        snap = self.snapshot(client)
        run = snap.runs[0]
        self.assertEqual((run.program, run.status, run.methodology_version), ("TTT", "ok", ttt.METHODOLOGY_VERSION))
        self.assertEqual(run.source.records_read, 4)
        doc = json.loads(serialize(snap))
        a = doc["runs"][0]["assessments"][0]
        self.assertEqual(a["linkage"], {"positive_screens": 2, "patient_forms": 2, "shortfall": 0,
                                        "floor_met": True, "ideal_met": True})
        self.assertNotIn("forms", a)
        self.assertNotIn("fields_required", a)
        blob = serialize(snap).decode()
        for value in ("R-1041", "2026-06-03", "2026-06-29", "2026-06-07", "09:12", "free text here",
                      "tot_dep_scrnd = ", "someone", "P-", "record_id", "delivery_date"):
            self.assertNotIn(value, blob)

    def test_a_dictionary_with_no_required_field_is_a_configuration_error(self):
        snap = self.snapshot(Client(meta=[{"field_name": "month_reporting", "form_name": FORM}]))
        self.assertEqual(snap.runs[0].error.code, "configuration")

    def test_a_failed_dyadic_read_fails_the_program_and_names_the_project(self):
        # Partial linkage would read as Denver Health missing its forms.
        snap = self.snapshot(Client(dyadic_error=RedcapError("REDCap did not respond within 90s")), years=(2025, 2026))
        self.assertEqual([(r.status, r.error.code) for r in snap.runs], [("error", "redcap_unavailable")] * 2)
        self.assertEqual(snap.runs[0].error.message, "CHoSEN Dyadic project: REDCap did not respond within 90s")

    def test_a_malformed_crosswalk_is_a_configuration_error(self):
        self.write_crosswalk({"hospitals": []})
        self.assertEqual(self.snapshot(Client()).runs[0].error.code, "configuration")


class CrosswalkTests(TttTestCase):
    def load(self, content):
        self.write_crosswalk(content)
        return load_crosswalk("TTT", self.dir)

    def entry(self, **over):
        e = {"cha_id": "EX-001", "hospital": "Acme General", "hospital_dag": "acme", "patient_dags": ["acme"]}
        e.update(over)
        return {k: v for k, v in e.items() if v is not ...}

    def test_maps_each_project_separately(self):
        c = load_crosswalk("TTT", self.dir)
        self.assertEqual(c.hospital_dags["birch_valley"], "EX-002")
        self.assertEqual(c.patient_dags["birch_vly_pt"], "EX-002")
        self.assertNotIn("birch_vly_pt", c.hospital_dags)
        self.assertEqual((c.patient_dags["cedar_ridge"], c.patient_dags["cedar_ridgeb"]), ("EX-003", "EX-003"))
        self.assertEqual(c.dyadic_dags, {"dogwood_dy": "EX-004"})
        self.assertEqual(c.not_hospitals, frozenset({"other_collab", "test"}))
        self.assertEqual(c.describe("EX-001"), "Acme General (CHA ID EX-001)")

    def test_a_hospital_may_have_no_hospital_project_group(self):
        c = self.load({"hospitals": [self.entry(hospital_dag=None), self.entry(cha_id=9002, hospital=..., hospital_dag="b", patient_dags=[])]})
        self.assertEqual((c.hospital_dags, c.patient_dags), ({"b": "9002"}, {"acme": "EX-001"}))
        self.assertEqual(c.describe("9002"), "CHA ID 9002")

    def test_refusals(self):
        cases = {
            "listed twice": {"hospitals": [self.entry(), self.entry(hospital_dag="b", patient_dags=["b"])]},
            'patient-project group "acme" is listed for CHA ID EX-001 and EX-002':
                {"hospitals": [self.entry(), self.entry(cha_id="EX-002", hospital_dag="b")]},
            'hospital-project group "acme"': {"hospitals": [self.entry(), self.entry(cha_id="EX-002", patient_dags=[])]},
            "names no data access group": {"hospitals": [self.entry(hospital_dag=None, patient_dags=[])]},
            "unknown key patient_dag": {"hospitals": [self.entry(patient_dag="acme")]},
            "unknown key hospital_list": {"hospitals": [self.entry()], "hospital_list": []},
            "needs a non-empty": {"hospitals": [self.entry(cha_id=" ")]},
            "not a list": {"hospitals": [self.entry(patient_dags="acme")]},
            "non-empty data access group name": {"hospitals": [self.entry(dyadic_dag="")]},
            'listed both as a hospital\'s group and in not_hospitals': {"hospitals": [self.entry()], "not_hospitals": ["acme"]},
            'non-empty "hospitals" list': {"hospitals": []},
        }
        for message, content in cases.items():
            with self.subTest(message), self.assertRaises(CrosswalkError) as ctx:
                self.load(content)
            self.assertIn(message, str(ctx.exception))
        with self.assertRaises(CrosswalkError):
            self.load("{not json")

    def test_the_shipped_ttt_crosswalk_loads(self):
        c = load_crosswalk("TTT")
        self.assertEqual(len(set(c.hospital_dags.values()) | set(c.patient_dags.values())), 30)
        self.assertEqual(len(c.dyadic_dags), 1)
        self.assertTrue(all(cha_id.isdigit() for cha_id in c.hospital_dags.values()))
        # One CHA ID covers two patient-project groups until 2027.
        self.assertTrue(any(list(c.patient_dags.values()).count(cha_id) == 2 for cha_id in c.patient_dags.values()))


if __name__ == "__main__":
    unittest.main()
