"""NEST assessor tests. Synthetic records and fictional hospitals only."""
import json
import unittest

from app.programs import nest

DAG = "example_hospital_a"
CROSSWALK = {DAG: "EX-001"}
LABELS = {"language": "Primary language", "compliant_ssp": "Safe sleep compliant"}
EVENT = "march_2026_arm_1"  # -> 2026-03


def ssp(date="2026-04-05", **over) -> dict:
    row = {
        "redcap_repeat_instrument": nest.SSP_FORM,
        "redcap_event_name": EVENT,
        "redcap_data_access_group": DAG,
        "compliant_ssp": "1",
        "data_entry_date_ssp": date,
    }
    row.update(over)
    return row


def chart(date="2026-04-05", **over) -> dict:
    row = {
        "redcap_repeat_instrument": nest.CHART_FORM,
        "redcap_event_name": EVENT,
        "redcap_data_access_group": DAG,
        "data_entry_date": date,
        "race___1": "1",
        "ethnicity": "1",
        "language": "1",
        "payor": "2",
        "ss_education_doc": "1",
        "ss_screening_doc": "2",  # "not documented": a complete answer, no follow-up required
        "ss_resources_doc": "1",
    }
    row.update(over)
    return row


def run(records, year=2026, untracked=frozenset()):
    return nest.assess(records, year, CROSSWALK, LABELS, untracked)


def forms(assessment) -> dict:
    return {f.form: (f.total, f.complete) for f in assessment.forms}


class EventTests(unittest.TestCase):
    def test_monthly_events_map_to_months(self):
        self.assertEqual(nest.event_period("january_2026_arm_1"), "2026-01")
        self.assertEqual(nest.event_period("sept_2026_arm_1"), "2026-09")
        self.assertEqual(nest.event_period("dec_2026_arm_1"), "2026-12")

    def test_readiness_and_empty_events_map_to_nothing(self):
        self.assertIsNone(nest.event_period("baseline_assessmen_arm_1"))
        self.assertIsNone(nest.event_period("readiness_assessme_arm_1"))
        self.assertIsNone(nest.event_period(""))


class RowTests(unittest.TestCase):
    def test_a_compliant_audit_row_is_complete(self):
        self.assertEqual(nest.missing_ssp_fields({"compliant_ssp": "1"}), [])

    def test_a_noncompliant_audit_row_needs_the_reason_and_addressed(self):
        self.assertEqual(
            nest.missing_ssp_fields({"compliant_ssp": "0"}),
            ["noncomp_addressed", "notcompliant_reasons"],
        )
        self.assertEqual(
            nest.missing_ssp_fields({"compliant_ssp": "0", "noncomp_addressed": "1"}),
            ["notcompliant_reasons"],
        )
        self.assertEqual(
            nest.missing_ssp_fields(
                {"compliant_ssp": "0", "noncomp_addressed": "1", "notcompliant_reasons___3": "1"}
            ),
            [],
        )

    def test_a_blank_compliance_answer_is_missing(self):
        self.assertIn("compliant_ssp", nest.missing_ssp_fields({"compliant_ssp": ""}))

    def test_a_fully_answered_chart_is_complete(self):
        self.assertEqual(nest.missing_chart_fields(chart()), [])

    def test_the_race_checkbox_is_required(self):
        self.assertIn("race", nest.missing_chart_fields(chart(race___1="0")))

    def test_a_blank_required_chart_field_is_missing(self):
        self.assertIn("language", nest.missing_chart_fields(chart(language="")))

    def test_documented_screening_requires_home_needs(self):
        self.assertIn("homeneeds_doc", nest.missing_chart_fields(chart(ss_screening_doc="1")))
        self.assertEqual(nest.missing_chart_fields(chart(ss_screening_doc="1", homeneeds_doc="2")), [])

    def test_home_needs_requires_a_referral(self):
        self.assertEqual(
            nest.missing_chart_fields(chart(ss_screening_doc="1", homeneeds_doc="1")),
            ["referral_resource_doc"],
        )


class AssessTests(unittest.TestCase):
    def test_both_forms_all_rows_complete(self):
        out, warnings = run([ssp(), ssp(), chart()])
        self.assertEqual(warnings, [])
        a = out[0]
        self.assertEqual((a.cha_id, a.period), ("EX-001", "2026-03"))
        self.assertTrue(a.submitted and a.complete)
        self.assertEqual(forms(a), {nest.SSP_FORM: (2, 2), nest.CHART_FORM: (1, 1)})
        self.assertEqual((a.records.total, a.records.complete, a.records.attestation), (3, 3, 0))
        self.assertEqual(a.earliest_submission_date, "2026-04-05")

    def test_one_bad_row_fails_the_month(self):
        a = run([ssp(), chart(), chart(language="")])[0][0]
        self.assertTrue(a.submitted)
        self.assertFalse(a.complete)
        self.assertEqual(forms(a)[nest.CHART_FORM], (2, 1))
        g = a.missing_field_groups[0]
        self.assertEqual((g.form, g.records, g.fields[0].field, g.fields[0].label),
                         (nest.CHART_FORM, 1, "language", "Primary language"))

    def test_one_form_alone_is_submitted_but_not_complete(self):
        a = run([ssp()])[0][0]
        self.assertTrue(a.submitted)
        self.assertFalse(a.complete)
        self.assertEqual(forms(a), {nest.SSP_FORM: (1, 1), nest.CHART_FORM: (0, 0)})

    def test_the_earliest_date_spans_both_forms(self):
        a = run([ssp(date="2026-04-20"), chart(date="2026-04-02")])[0][0]
        self.assertEqual(a.earliest_submission_date, "2026-04-02")

    def test_an_invalid_date_is_ignored_and_counted(self):
        a = run([ssp(date="#C@9J&ikv$fU%!KF"), chart(date="2026-04-05")])[0][0]
        self.assertEqual(a.earliest_submission_date, "2026-04-05")
        self.assertIn("1 record has a data-entry date that is not a valid date", a.notes[0])
        self.assertNotIn("#C@9J", a.notes[0])

    def test_test_dags_and_readiness_rows_are_ignored(self):
        records = [
            ssp(redcap_data_access_group="test"),
            ssp(redcap_data_access_group="test_2"),
            {"redcap_repeat_instrument": "", "redcap_event_name": "baseline_assessmen_arm_1",
             "redcap_data_access_group": DAG},
        ]
        self.assertEqual(run(records), ([], []))

    def test_an_unknown_event_is_reported_not_guessed(self):
        out, warnings = run([ssp(redcap_event_name="january_2027_arm_1")])
        self.assertEqual(out, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn('"january_2027_arm_1" has NEST data but is not a known month', warnings[0])

    def test_an_unknown_dag_warns_and_an_untracked_one_does_not(self):
        out, warnings = run([ssp(redcap_data_access_group="example_unknown")])
        self.assertEqual(out, [])
        self.assertIn('"example_unknown"', warnings[0])
        self.assertEqual(
            run([ssp(redcap_data_access_group="example_known")], untracked=frozenset({"example_known"})),
            ([], []),
        )

    def test_rows_outside_the_program_year_are_ignored(self):
        self.assertEqual(run([ssp(), chart()], year=2025), ([], []))

    def test_the_file_carries_forms_and_no_record_values(self):
        records = [
            ssp(record_id="R-1041", compliant_ssp="0", other_notes="free text here"),
            chart(record_id="R-2077", race___3="1", language="7", payor="4"),
        ]
        out, _ = run(records)
        d = out[0].to_dict()
        self.assertEqual([f["form"] for f in d["forms"]], [nest.SSP_FORM, nest.CHART_FORM])
        self.assertNotIn("linkage", d)
        blob = json.dumps(d)
        for value in ("R-1041", "R-2077", "free text here", "record_id"):
            self.assertNotIn(value, blob)


class FieldListTests(unittest.TestCase):
    def test_every_field_the_rules_read_is_requested(self):
        rule_fields = {
            *nest.SSP_ALWAYS, *nest.SSP_NONCOMPLIANT_FIELDS, nest.SSP_NONCOMPLIANT_CHECKBOX,
            nest.CHART_CHECKBOX, *nest.CHART_ALWAYS, *nest.CHART_IF_SCREENING,
            *nest.CHART_IF_HOMENEEDS, nest.F_SSP_DATE, nest.F_CHART_DATE,
        }
        self.assertEqual(rule_fields, set(nest.MINIMUM_FIELDS))

    def test_free_text_companions_are_never_requested(self):
        self.assertNotIn("other_race_text", nest.MINIMUM_FIELDS)
        self.assertNotIn("other_language2", nest.MINIMUM_FIELDS)


if __name__ == "__main__":
    unittest.main()
