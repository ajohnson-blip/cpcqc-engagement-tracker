"""SOAR assessor tests. All records here are synthetic — no PHI in fixtures."""
import json
import unittest
from datetime import date

from app.errors import ProjectConfigurationError
from app.programs import soar
from tests.fakes import soar_dictionary

CROSSWALK = {"acme_general": "EX-001"}
LABELS = {"checklist_comms_tool": "Checklist/communication tool used", "age": "Patient's age"}
TODAY = date(2026, 10, 20)


def ntsv(**over) -> dict:
    """A complete NTSV row; override fields to make it incomplete."""
    row = {
        "redcap_data_access_group": "acme_general",
        "redcap_repeat_instrument": soar.NTSV_FORM,
        "date": "2026-08-14",
        "delivery_date": "2026-07-03",
        "checklist_comms_tool": "1",
        "who_managed_labor_2": "2",
        "age": "31",
        "gest_age": "39.2",
        "c_sect_indication_primary": "4",
        "admit_reason___1": "1",
    }
    row.update(over)
    return row


def no_ntsv(**over) -> dict:
    row = {
        "redcap_data_access_group": "acme_general",
        "redcap_repeat_instrument": soar.NO_NTSV_FORM,
        "date": "2026-08-10",
        "month_year_nontsv": "7",
        "self_report_nontsv___1": "1",
    }
    row.update(over)
    return row


PERIODS_2026 = soar.attestation_periods_from_dictionary(soar_dictionary([2026]))


def run(records, year=2026, today=TODAY, periods=PERIODS_2026, untracked=frozenset()):
    return soar.assess(records, year, CROSSWALK, LABELS, today, periods, untracked)


def missing_fields(assessment) -> set[str]:
    return {f.field for g in assessment.missing_field_groups for f in g.fields}


class CompletenessTests(unittest.TestCase):
    def test_complete_ntsv_row(self):
        out, warnings = run([ntsv()])
        self.assertEqual(warnings, [])
        self.assertEqual(len(out), 1)
        a = out[0]
        self.assertEqual((a.cha_id, a.period), ("EX-001", "2026-07"))
        self.assertTrue(a.submitted and a.complete)
        self.assertEqual((a.records.total, a.records.complete), (1, 1))
        self.assertEqual(a.missing_field_groups, ())
        self.assertEqual(a.earliest_submission_date, "2026-08-14")
        self.assertEqual(a.notes, ())

    def test_incomplete_row_reports_the_blank_field_with_its_label(self):
        a = run([ntsv(checklist_comms_tool="")])[0][0]
        self.assertTrue(a.submitted)
        self.assertFalse(a.complete)
        self.assertEqual(len(a.missing_field_groups), 1)
        g = a.missing_field_groups[0]
        self.assertEqual((g.form, g.records), (soar.NTSV_FORM, 1))
        self.assertEqual(g.fields[0].field, "checklist_comms_tool")
        self.assertEqual(g.fields[0].label, "Checklist/communication tool used")

    def test_label_falls_back_to_the_variable_name(self):
        a = run([ntsv(gest_age="")])[0][0]
        self.assertEqual(a.missing_field_groups[0].fields[0].label, "gest_age")

    def test_admit_reason_option_4_requires_induction_detail(self):
        # Admitted "For induction" without the induction fields is incomplete…
        a = run([ntsv(admit_reason___1="0", admit_reason___4="1")])[0][0]
        self.assertEqual(missing_fields(a), {soar.NTSV_INDUCTION_REASON, soar.NTSV_INDUCTION_METHOD})
        # …but supplying them makes it complete.
        a = run([ntsv(admit_reason___1="0", admit_reason___4="1",
                      induction_reason___2="1", induction_method___3="1")])[0][0]
        self.assertTrue(a.complete)

    def test_an_unchecked_admit_reason_is_missing(self):
        a = run([ntsv(admit_reason___1="0")])[0][0]
        self.assertEqual(missing_fields(a), {soar.NTSV_ADMIT_CHECKBOX})

    def test_primary_indication_selects_its_conditional_fields(self):
        # primary = 2 (arrest of dilation) pulls in four conditional fields.
        a = run([ntsv(c_sect_indication_primary="2")])[0][0]
        self.assertEqual(missing_fields(a), set(soar.NTSV_COND["2"]))
        # primary = 4 has no conditional requirements.
        self.assertTrue(run([ntsv(c_sect_indication_primary="4")])[0][0].complete)

    def test_zero_case_attestation_counts_as_a_complete_submission(self):
        a = run([no_ntsv()])[0][0]
        self.assertTrue(a.submitted and a.complete and a.attestation_only)
        self.assertEqual((a.records.attestation, a.records.total), (1, 0))

    def test_an_incomplete_attestation_is_not_complete(self):
        a = run([no_ntsv(self_report_nontsv___1="0")])[0][0]
        self.assertTrue(a.submitted and a.attestation_only)
        self.assertFalse(a.complete)
        self.assertEqual(a.missing_field_groups[0].form, soar.NO_NTSV_FORM)

    def test_real_cases_take_precedence_over_an_attestation(self):
        # A hospital that filed both an incomplete case and an attestation is
        # not complete: the attestation only settles a month with no cases.
        a = run([ntsv(age=""), no_ntsv()])[0][0]
        self.assertTrue(a.submitted)
        self.assertFalse(a.complete or a.attestation_only)

    def test_attestation_fallback_wins_when_the_instrument_is_missing(self):
        # A base row carrying both a stray indication and an attestation month
        # is an attestation — the No-NTSV field is checked first on purpose.
        row = ntsv(redcap_repeat_instrument="", month_year_nontsv="7", self_report_nontsv___1="1")
        self.assertTrue(run([row])[0][0].attestation_only)


class GroupingTests(unittest.TestCase):
    def test_grouping_distinguishes_an_abandoned_entry_from_a_systematic_gap(self):
        abandoned = run([ntsv(age="", gest_age="", who_managed_labor_2="")])[0][0]
        self.assertEqual(len(abandoned.missing_field_groups), 1)
        self.assertEqual(abandoned.missing_field_groups[0].records, 1)
        self.assertEqual(len(abandoned.missing_field_groups[0].fields), 3)

        systematic = run([ntsv(checklist_comms_tool="") for _ in range(3)])[0][0]
        self.assertEqual(len(systematic.missing_field_groups), 1)
        self.assertEqual(systematic.missing_field_groups[0].records, 3)
        self.assertEqual(len(systematic.missing_field_groups[0].fields), 1)

    def test_groups_order_by_field_count_then_record_count(self):
        records = [ntsv(age="")] * 2 + [ntsv(gest_age="")] * 3 + [ntsv(age="", gest_age="")]
        groups = run(records)[0][0].missing_field_groups
        self.assertEqual(
            [(len(g.fields), g.records) for g in groups],
            [(2, 1), (1, 3), (1, 2)],
        )

    def test_fields_within_a_group_are_alphabetical_as_in_the_tracker(self):
        g = run([ntsv(who_managed_labor_2="", age="")])[0][0].missing_field_groups[0]
        self.assertEqual([f.field for f in g.fields], ["age", "who_managed_labor_2"])


class DateTests(unittest.TestCase):
    def test_earliest_submission_date_wins(self):
        a = run([ntsv(date="2026-08-20"), ntsv(date="2026-08-02")])[0][0]
        self.assertEqual(a.earliest_submission_date, "2026-08-02")

    def test_earliest_spans_both_forms(self):
        a = run([ntsv(date="2026-08-20"), no_ntsv(date="2026-08-05")])[0][0]
        self.assertEqual(a.earliest_submission_date, "2026-08-05")

    def test_a_time_suffix_is_dropped(self):
        a = run([ntsv(date="2026-08-14 10:22")])[0][0]
        self.assertEqual(a.earliest_submission_date, "2026-08-14")

    def test_an_invalid_submission_date_is_ignored_and_counted(self):
        a = run([ntsv(date="14/08/2026"), ntsv(date="2026-08-20")])[0][0]
        self.assertEqual(a.earliest_submission_date, "2026-08-20")
        self.assertEqual(len(a.notes), 1)
        self.assertIn("1 record has a submission date that is not a valid date", a.notes[0])
        self.assertNotIn("14/08/2026", a.notes[0])

    def test_an_impossible_calendar_date_is_invalid(self):
        a = run([ntsv(date="2026-02-30")])[0][0]
        self.assertIsNone(a.earliest_submission_date)
        self.assertIn("not a valid date", a.notes[0])

    def test_no_submission_date_means_unknown_timeliness_without_a_note(self):
        a = run([ntsv(date="")])[0][0]
        self.assertIsNone(a.earliest_submission_date)
        self.assertEqual(a.notes, ())

    def test_a_future_delivery_date_is_counted_never_quoted(self):
        records = [ntsv(delivery_date="2026-12-05"), ntsv(delivery_date="2026-12-09")]
        a = run(records)[0][0]
        self.assertEqual(a.period, "2026-12")
        self.assertEqual(len(a.notes), 1)
        self.assertIn("2 NTSV records have a delivery date in the future", a.notes[0])
        blob = json.dumps(a.to_dict())
        self.assertNotIn("2026-12-05", blob)
        self.assertNotIn("2026-12-09", blob)

    def test_todays_delivery_date_is_not_in_the_future(self):
        a = run([ntsv(delivery_date=TODAY.isoformat())])[0][0]
        self.assertEqual(a.notes, ())


class ScopeTests(unittest.TestCase):
    def test_unknown_dag_warns_rather_than_disappearing(self):
        out, warnings = run([ntsv(redcap_data_access_group="mystery_hospital")] * 2)
        self.assertEqual(out, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn('"mystery_hospital"', warnings[0])

    def test_test_and_blank_dags_are_not_warned_about(self):
        _, warnings = run([ntsv(redcap_data_access_group="test"), ntsv(redcap_data_access_group="")])
        self.assertEqual(warnings, [])

    def test_rows_outside_the_program_year_are_ignored(self):
        self.assertEqual(run([ntsv(delivery_date="2025-11-02")])[0], [])

    def test_each_program_year_takes_only_its_own_cases(self):
        records = [ntsv(delivery_date="2025-12-12", date="2026-01-09"), ntsv(delivery_date="2026-01-04")]
        self.assertEqual([a.period for a in run(records, year=2025)[0]], ["2025-12"])
        self.assertEqual([a.period for a in run(records, year=2026)[0]], ["2026-01"])

    def test_an_attestation_code_the_dictionary_does_not_define_is_reported_not_guessed(self):
        out, warnings = run([no_ntsv(month_year_nontsv="13")])  # 2027 codes not added yet
        self.assertEqual(out, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn("1 No-NTSV attestation uses a month code the data dictionary does not define", warnings[0])
        self.assertNotIn('"13"', warnings[0])

    def test_a_known_untracked_dag_is_skipped_without_a_warning(self):
        out, warnings = run([ntsv(redcap_data_access_group="example_sustaining")],
                            untracked=frozenset({"example_sustaining"}))
        self.assertEqual((out, warnings), ([], []))

    def test_rows_that_are_neither_form_are_ignored(self):
        self.assertEqual(run([{"redcap_data_access_group": "acme_general", "date": "2026-08-01"}])[0], [])

    def test_output_is_sorted_by_hospital_then_period(self):
        records = [ntsv(delivery_date="2026-08-03"), ntsv(delivery_date="2026-07-03")]
        self.assertEqual([a.period for a in run(records)[0]], ["2026-07", "2026-08"])


class NoRecordContentTests(unittest.TestCase):
    def test_output_never_carries_a_record_value(self):
        # Distinctive synthetic values that must not survive into the output:
        # identifiers, ages, gestational ages and full delivery dates. Field
        # names may appear; values may not.
        records = [
            ntsv(record_id="R-1041", redcap_repeat_instance="3", age="43", gest_age="38.6",
                 delivery_date="2026-07-23", checklist_comms_tool="", admit_other="free text here"),
            no_ntsv(record_id="R-2077"),
        ]
        out, warnings = run(records)
        blob = json.dumps({"a": [a.to_dict() for a in out], "w": warnings})
        for value in ("R-1041", "R-2077", "38.6", "2026-07-23", "free text here", '"43"'):
            self.assertNotIn(value, blob)
        self.assertNotIn("record_id", blob)

    def test_minimum_fields_never_include_free_text(self):
        self.assertNotIn("admit_other", soar.MINIMUM_FIELDS)
        self.assertNotIn("op_vag_birth_exp", soar.MINIMUM_FIELDS)

    def test_every_field_the_rules_read_is_requested(self):
        rule_fields = {
            *soar.NTSV_ALWAYS, soar.NTSV_ADMIT_CHECKBOX, soar.NTSV_INDUCTION_REASON,
            soar.NTSV_INDUCTION_METHOD, *(f for fs in soar.NTSV_COND.values() for f in fs),
            soar.NO_NTSV_MONTH_FIELD, soar.NO_NTSV_CHECKBOX, soar.F_SUBMIT_DATE,
        }
        self.assertEqual(rule_fields, set(soar.MINIMUM_FIELDS))


class AttestationPeriodTests(unittest.TestCase):
    """month_year_nontsv codes carry the year: 1 = January 2026, consecutive."""

    def test_codes_run_consecutively_from_january_2026(self):
        self.assertEqual(soar.attestation_code_period(1), "2026-01")
        self.assertEqual(soar.attestation_code_period(12), "2026-12")
        self.assertEqual(soar.attestation_code_period(13), "2027-01")
        self.assertEqual(soar.attestation_code_period(24), "2027-12")

    def test_labels_name_a_month_and_year(self):
        self.assertEqual(soar.period_from_label("January 2026"), "2026-01")
        self.assertEqual(soar.period_from_label("<b>Sept</b> 2027"), "2027-09")
        self.assertEqual(soar.period_from_label("Dec-2026"), "2026-12")
        self.assertIsNone(soar.period_from_label("2026"))
        self.assertIsNone(soar.period_from_label("Month 13"))

    def test_choice_lists_parse(self):
        self.assertEqual(soar.parse_choices("1, January 2026 | 2, February 2026"),
                         [("1", "January 2026"), ("2", "February 2026")])
        self.assertEqual(soar.parse_choices(""), [])

    def test_2027_codes_map_once_added(self):
        periods = soar.attestation_periods_from_dictionary(soar_dictionary([2026, 2027]))
        self.assertEqual((periods["7"], periods["19"], len(periods)), ("2026-07", "2027-07", 24))

    def test_a_dictionary_relabelled_as_2027_is_refused(self):
        with self.assertRaisesRegex(ProjectConfigurationError, 'code 1 is labelled "January 2027".*should be 2026-01'):
            soar.attestation_periods_from_dictionary(soar_dictionary([2027]))

    def test_a_dictionary_without_the_field_or_with_a_bad_code_is_refused(self):
        with self.assertRaisesRegex(ProjectConfigurationError, "defines no codes"):
            soar.attestation_periods_from_dictionary([])
        bad = [{"field_name": "month_year_nontsv", "select_choices_or_calculations": "x, January 2026"}]
        with self.assertRaisesRegex(ProjectConfigurationError, "not a positive whole number"):
            soar.attestation_periods_from_dictionary(bad)

    def test_each_attestation_counts_in_exactly_one_year(self):
        # The case that motivated this: in January both years are assessed.
        periods = soar.attestation_periods_from_dictionary(soar_dictionary([2026, 2027]))
        records = [no_ntsv(month_year_nontsv="7"), no_ntsv(month_year_nontsv="13", date="2027-02-04")]
        y2026, _ = run(records, year=2026, periods=periods)
        y2027, _ = run(records, year=2027, periods=periods)
        self.assertEqual([a.period for a in y2026], ["2026-07"])
        self.assertEqual([a.period for a in y2027], ["2027-01"])

    def test_a_zero_padded_code_is_the_same_code(self):
        self.assertEqual(soar.no_ntsv_period(no_ntsv(month_year_nontsv="07"), PERIODS_2026), "2026-07")


if __name__ == "__main__":
    unittest.main()
