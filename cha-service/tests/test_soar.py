"""SOAR assessor tests. All records here are synthetic — no PHI in fixtures."""
import json

from app.models import Assessment
from app.programs import soar

CROSSWALK = {"acme_general": {"cha_id": "428", "hospital": "Acme General"}}
LABELS = {"checklist_comms_tool": "Checklist/communication tool used", "age": "Patient's age"}


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


def run(records, year=2026, periods=None):
    return soar.assess(records, year, CROSSWALK, LABELS, periods)


def test_complete_ntsv_row():
    out, warnings = run([ntsv()])
    assert warnings == []
    assert len(out) == 1
    a = out[0]
    assert (a.cha_id, a.period) == ("428", "2026-07")
    assert a.submitted and a.complete
    assert a.records.total == 1 and a.records.complete == 1
    assert a.missing_field_groups == []
    assert a.earliest_submission_date == "2026-08-14"


def test_incomplete_row_reports_the_blank_field_with_its_label():
    out, _ = run([ntsv(checklist_comms_tool="")])
    a = out[0]
    assert a.submitted and not a.complete
    assert len(a.missing_field_groups) == 1
    g = a.missing_field_groups[0]
    assert g.form == soar.NTSV_FORM and g.records == 1
    assert g.fields[0].field == "checklist_comms_tool"
    assert g.fields[0].label == "Checklist/communication tool used"


def test_label_falls_back_to_the_variable_name():
    out, _ = run([ntsv(gest_age="")])
    assert out[0].missing_field_groups[0].fields[0].label == "gest_age"


def test_admit_reason_option_4_requires_induction_detail():
    # Admitted "For induction" without the induction fields is incomplete…
    out, _ = run([ntsv(admit_reason___1="0", admit_reason___4="1")])
    missing = {f.field for g in out[0].missing_field_groups for f in g.fields}
    assert missing == {soar.NTSV_INDUCTION_REASON, soar.NTSV_INDUCTION_METHOD}
    # …but supplying them makes it complete.
    out, _ = run([ntsv(admit_reason___1="0", admit_reason___4="1",
                       induction_reason___2="1", induction_method___3="1")])
    assert out[0].complete


def test_primary_indication_selects_its_conditional_fields():
    # primary = 2 (arrest of dilation) pulls in four conditional fields.
    out, _ = run([ntsv(c_sect_indication_primary="2")])
    missing = {f.field for g in out[0].missing_field_groups for f in g.fields}
    assert missing == set(soar.NTSV_COND["2"])
    # primary = 4 has no conditional requirements.
    assert run([ntsv(c_sect_indication_primary="4")])[0][0].complete


def test_zero_case_attestation_counts_as_a_complete_submission():
    out, _ = run([no_ntsv()])
    a = out[0]
    assert a.submitted and a.complete and a.attestation_only
    assert a.records.attestation == 1 and a.records.total == 0


def test_real_cases_take_precedence_over_an_attestation():
    # A hospital that filed both an incomplete case and an attestation is not
    # complete: the attestation only settles a month with no cases.
    out, _ = run([ntsv(age=""), no_ntsv()])
    a = out[0]
    assert a.submitted and not a.complete and not a.attestation_only


def test_grouping_distinguishes_an_abandoned_entry_from_a_systematic_gap():
    abandoned = run([ntsv(age="", gest_age="", who_managed_labor_2="")])[0][0]
    assert len(abandoned.missing_field_groups) == 1
    assert abandoned.missing_field_groups[0].records == 1
    assert len(abandoned.missing_field_groups[0].fields) == 3

    systematic = run([ntsv(checklist_comms_tool="") for _ in range(3)])[0][0]
    assert len(systematic.missing_field_groups) == 1
    assert systematic.missing_field_groups[0].records == 3
    assert len(systematic.missing_field_groups[0].fields) == 1


def test_earliest_submission_date_wins():
    out, _ = run([ntsv(date="2026-08-20"), ntsv(date="2026-08-02")])
    assert out[0].earliest_submission_date == "2026-08-02"


def test_unknown_dag_warns_rather_than_disappearing():
    out, warnings = run([ntsv(redcap_data_access_group="mystery_hospital")])
    assert out == []
    assert any("mystery_hospital" in w for w in warnings)


def test_test_dag_is_not_warned_about():
    _, warnings = run([ntsv(redcap_data_access_group="test")])
    assert warnings == []


def test_rows_outside_the_program_year_are_ignored():
    assert run([ntsv(delivery_date="2025-11-02")])[0] == []


def test_periods_filter():
    records = [ntsv(delivery_date="2026-07-03"), ntsv(delivery_date="2026-08-03")]
    out, _ = run(records, periods=["2026-08"])
    assert [a.period for a in out] == ["2026-08"]


def test_attestation_fallback_wins_when_the_instrument_is_missing():
    # A base row carrying both a stray indication and an attestation month is
    # an attestation — the No-NTSV field is checked first on purpose.
    row = ntsv(redcap_repeat_instrument="", month_year_nontsv="7",
               self_report_nontsv___1="1")
    out, _ = run([row])
    assert out[0].attestation_only


def test_response_never_carries_a_record_identifier():
    # The whole reason the service exists: identifiers stay in REDCap.
    out, _ = run([ntsv(record_id="1041", age=""), no_ntsv(record_id="2077")])
    blob = json.dumps([Assessment.model_dump(a) for a in out])
    assert "1041" not in blob and "2077" not in blob
    assert "record_id" not in blob
