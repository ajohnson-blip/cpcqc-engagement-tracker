"""SPARK assessor tests. Synthetic records and fictional hospitals only."""
import json
import unittest

from app.programs import spark

DAG = "example_hospital_a"
CROSSWALK = {DAG: "EX-001"}
LABELS = {"denom_total": "Total deliveries"}


def full_row(**over) -> dict:
    """Every always-required field filled; IPV screening not implemented."""
    row = {f: "10" for f in spark.ALWAYS_REQUIRED}
    row["ipv_screen_implemented"] = "2"
    row.update(
        {
            "record_id": "SYNTH-1",
            "redcap_event_name": "janmar_26_data_arm_1",
            "redcap_data_access_group": DAG,
            "date": "2026-04-07",
        }
    )
    row.update(over)
    return row


def run(records, year=2026, untracked=frozenset()):
    return spark.assess(records, year, CROSSWALK, LABELS, untracked)


class FieldTests(unittest.TestCase):
    def test_56_always_required_and_74_data_fields(self):
        self.assertEqual(len(spark.ALWAYS_REQUIRED), 56)
        self.assertEqual(len(spark.IPV_CONDITIONAL_FIELDS), 18)
        self.assertEqual(len(spark.ALL_DATA_FIELDS), 74)

    def test_only_the_data_fields_and_date_are_requested(self):
        self.assertEqual(set(spark.MINIMUM_FIELDS), {"date", *spark.ALL_DATA_FIELDS})


class EventTests(unittest.TestCase):
    def test_confirmed_event_names(self):
        self.assertEqual(spark.event_quarter("julysept_25_data_p_arm_1"), "2025-Q3")
        self.assertEqual(spark.event_quarter("octdec_25_data_arm_1"), "2025-Q4")
        self.assertEqual(spark.event_quarter("janmar_26_data_arm_1"), "2026-Q1")
        self.assertEqual(spark.event_quarter("aprjune_26_data_arm_1"), "2026-Q2")

    def test_future_quarters_by_pattern_both_spellings_of_june(self):
        self.assertEqual(spark.event_quarter("aprjun_26_data_arm_1"), "2026-Q2")
        self.assertEqual(spark.event_quarter("aprjune_27_data_arm_1"), "2027-Q2")
        self.assertEqual(spark.event_quarter("octdec_26_data_arm_1"), "2026-Q4")
        self.assertEqual(spark.event_quarter("janmar_27_data_arm_1"), "2027-Q1")

    def test_assessment_and_empty_events_are_not_quarters(self):
        self.assertIsNone(spark.event_quarter("baseline_assessmen_arm_1"))
        self.assertIsNone(spark.event_quarter("self_assessment__t_arm_1"))
        self.assertIsNone(spark.event_quarter(""))
        self.assertIsNone(spark.event_quarter(None))


class CompletenessTests(unittest.TestCase):
    def test_complete_without_ipv_screening(self):
        self.assertEqual(spark.missing_fields(full_row()), [])
        self.assertEqual(len(spark.required_fields(full_row())), 56)

    def test_ipv_screening_requires_18_more(self):
        row = full_row(ipv_screen_implemented="1")
        self.assertEqual(len(spark.required_fields(row)), 74)
        self.assertEqual(spark.missing_fields(row), spark.IPV_CONDITIONAL_FIELDS)

    def test_a_placeholder_row_has_no_data(self):
        self.assertFalse(spark.row_has_data({"denom_total": "", "ssdoh_total": ""}))
        self.assertTrue(spark.row_has_data({"denom_total": "5"}))


class AssessTests(unittest.TestCase):
    def test_one_complete_on_time_submission(self):
        out, warnings = run([full_row()])
        self.assertEqual(warnings, [])
        a = out[0]
        self.assertEqual((a.cha_id, a.period), ("EX-001", "2026-Q1"))
        self.assertTrue(a.submitted and a.complete)
        self.assertEqual(a.earliest_submission_date, "2026-04-07")
        self.assertEqual((a.records.total, a.records.complete), (1, 1))
        self.assertEqual(a.fields_required, 56)
        self.assertEqual(a.missing_field_groups, ())

    def test_q2_lands_under_the_real_aprjune_event(self):
        a = run([full_row(redcap_event_name="aprjune_26_data_arm_1", date="2026-07-05")])[0][0]
        self.assertEqual(a.period, "2026-Q2")
        self.assertTrue(a.complete)

    def test_a_corrupt_date_is_no_date_and_noted(self):
        a = run([full_row(redcap_event_name="aprjune_26_data_arm_1", date="#C@9J&ikv$fU%!KF")])[0][0]
        self.assertTrue(a.submitted)
        self.assertIsNone(a.earliest_submission_date)
        self.assertIn("not a valid date", a.notes[0])
        self.assertNotIn("#C@9J", a.notes[0])

    def test_test_dag_and_assessment_events_are_ignored(self):
        records = [
            full_row(redcap_data_access_group="test"),
            full_row(redcap_event_name="baseline_assessmen_arm_1"),
        ]
        self.assertEqual(run(records), ([], []))

    def test_competing_records_prefer_the_latest_dated(self):
        records = [
            full_row(record_id="SYNTH-1", date="2026-04-01", denom_total=""),  # earlier, incomplete
            full_row(record_id="SYNTH-2", date="2026-06-02"),  # later, complete: wins
        ]
        a = run(records)[0][0]
        self.assertTrue(a.complete)
        self.assertEqual(a.earliest_submission_date, "2026-06-02")
        self.assertEqual((a.records.total, a.records.complete), (2, 1))

    def test_with_no_dated_row_the_most_complete_wins(self):
        records = [
            full_row(record_id="a", redcap_event_name="octdec_25_data_arm_1", date="", denom_total=""),
            full_row(record_id="a", redcap_event_name="octdec_25_data_arm_1", date=""),
        ]
        a = run(records, year=2025)[0][0]
        self.assertTrue(a.complete)
        self.assertIsNone(a.earliest_submission_date)
        # One record entered twice is not a competing record.
        self.assertEqual(a.records.total, 1)

    def test_a_tie_on_completeness_goes_to_the_higher_denominator(self):
        records = [
            full_row(record_id="a", date="", denom_total="5", denom_race_white=""),
            full_row(record_id="b", date="", denom_total="9", denom_race_white=""),
        ]
        a = run(records)[0][0]
        self.assertFalse(a.complete)
        self.assertEqual(a.records.total, 2)

    def test_an_incomplete_submission_reports_its_missing_fields(self):
        a = run([full_row(denom_total="", ipv_screen_implemented="1")])[0][0]
        self.assertFalse(a.complete)
        self.assertEqual(a.fields_required, 74)
        g = a.missing_field_groups[0]
        self.assertEqual((g.form, g.records, len(g.fields)), (spark.FORM, 1, 19))
        self.assertEqual({f.field: f.label for f in g.fields}["denom_total"], "Total deliveries")

    def test_an_unknown_quarterly_event_is_reported_not_guessed(self):
        out, warnings = run([full_row(redcap_event_name="springs_26_data_arm_1")])
        self.assertEqual(out, [])
        self.assertIn('"springs_26_data_arm_1" has SPARK data but is not a known quarter', warnings[0])

    def test_an_unknown_dag_warns_and_an_untracked_one_does_not(self):
        out, warnings = run([full_row(redcap_data_access_group="example_unknown")])
        self.assertEqual(out, [])
        self.assertIn('"example_unknown"', warnings[0])
        self.assertEqual(
            run([full_row(redcap_data_access_group="example_known")], untracked=frozenset({"example_known"})),
            ([], []),
        )

    def test_other_years_quarters_are_left_out(self):
        self.assertEqual(run([full_row()], year=2025), ([], []))

    def test_the_file_carries_fields_required_and_no_record_values(self):
        out, _ = run([full_row(record_id="R-1041", denom_total="")])
        d = out[0].to_dict()
        self.assertEqual(d["fields_required"], 56)
        self.assertNotIn("forms", d)
        blob = json.dumps(d)
        self.assertNotIn("R-1041", blob)
        self.assertNotIn("record_id", blob)


if __name__ == "__main__":
    unittest.main()
