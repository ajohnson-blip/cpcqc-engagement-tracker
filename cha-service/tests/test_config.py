"""Configuration: what is required, what is refused, and that tokens are never echoed."""
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from app import config as config_module
from app.config import ConfigError, default_program_years, load_config
from tests.fakes import FAKE_TOKEN

OCTOBER = date(2026, 10, 20)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def env(self, **over) -> dict:
        e = {"OUTPUT_DIR": self.out, "REDCAP_SOAR_TOKEN": FAKE_TOKEN}
        e.update(over)
        return {k: v for k, v in e.items() if v is not None}

    def problems(self, environ, today=OCTOBER) -> list[str]:
        with self.assertRaises(ConfigError) as ctx:
            load_config(environ, today)
        return ctx.exception.problems

    # --- the happy path ---

    def test_minimal_configuration(self):
        c = load_config(self.env(), OCTOBER)
        self.assertEqual(c.output_dir, Path(self.out))
        self.assertEqual(c.programs, ("SOAR",))
        self.assertEqual(c.program_years, (2026,))
        self.assertEqual(c.redcap_api_url, "https://redcap.vumc.org/api/")
        self.assertEqual(c.redcap_timeout, 90.0)
        self.assertIsNone(c.delivery_url)
        self.assertEqual(c.tokens, {"REDCAP_SOAR_TOKEN": FAKE_TOKEN})

    def test_values_are_trimmed(self):
        c = load_config(self.env(REDCAP_SOAR_TOKEN=f"  {FAKE_TOKEN}\n"), OCTOBER)
        self.assertEqual(c.tokens["REDCAP_SOAR_TOKEN"], FAKE_TOKEN)

    def test_repr_never_shows_a_token(self):
        c = load_config(self.env(DELIVERY_URL="https://tracker.example/x", DELIVERY_TOKEN="s3cret-delivery"), OCTOBER)
        self.assertNotIn(FAKE_TOKEN, repr(c))
        self.assertNotIn("s3cret-delivery", repr(c))

    # --- output ---

    def test_output_dir_is_required(self):
        self.assertTrue(any("OUTPUT_DIR is required" in p for p in self.problems(self.env(OUTPUT_DIR=None))))

    def test_a_missing_output_dir_is_not_created(self):
        missing = os.path.join(self.out, "not-mounted")
        self.assertTrue(any("does not exist" in p for p in self.problems(self.env(OUTPUT_DIR=missing))))
        self.assertFalse(os.path.exists(missing))

    def test_output_dir_must_be_a_directory(self):
        f = os.path.join(self.out, "a-file")
        Path(f).write_text("x")
        self.assertTrue(any("not a directory" in p for p in self.problems(self.env(OUTPUT_DIR=f))))

    # --- delivery ---

    def test_delivery_needs_a_token(self):
        problems = self.problems(self.env(DELIVERY_URL="https://tracker.example/ingest"))
        self.assertTrue(any("DELIVERY_TOKEN is required" in p for p in problems))

    def test_delivery_must_be_https(self):
        problems = self.problems(self.env(DELIVERY_URL="http://tracker.example/ingest", DELIVERY_TOKEN="t"))
        self.assertTrue(any("https://" in p for p in problems))

    def test_plain_http_is_allowed_to_localhost_for_testing(self):
        c = load_config(self.env(DELIVERY_URL="http://localhost:4000/ingest", DELIVERY_TOKEN="t"), OCTOBER)
        self.assertEqual(c.delivery_url, "http://localhost:4000/ingest")

    def test_credentials_in_a_url_are_refused(self):
        problems = self.problems(self.env(DELIVERY_URL="https://user:pw@tracker.example/x", DELIVERY_TOKEN="t"))
        self.assertTrue(any("must not contain credentials" in p for p in problems))

    def test_a_token_without_a_url_is_a_notice_not_an_error(self):
        c = load_config(self.env(DELIVERY_TOKEN="t"), OCTOBER)
        self.assertIsNone(c.delivery_token)
        self.assertTrue(any("will not be delivered" in n for n in c.notices))

    # --- REDCap ---

    def test_redcap_must_be_https(self):
        problems = self.problems(self.env(REDCAP_API_URL="http://redcap.example/api/"))
        self.assertTrue(any("REDCAP_API_URL must be an https:// URL." == p for p in problems))

    def test_a_malformed_token_is_refused_without_echoing_it(self):
        bad = "not-a-token-but-maybe-a-secret"
        problems = self.problems(self.env(REDCAP_SOAR_TOKEN=bad))
        self.assertTrue(any("REDCAP_SOAR_TOKEN is not a 32-character" in p for p in problems))
        self.assertFalse(any(bad in p for p in problems))

    def test_timeout_must_be_sensible(self):
        for value in ("0", "abc", "-5", "99999"):
            with self.subTest(value=value):
                self.assertTrue(any("REDCAP_TIMEOUT" in p for p in self.problems(self.env(REDCAP_TIMEOUT=value))))
        self.assertEqual(load_config(self.env(REDCAP_TIMEOUT="120"), OCTOBER).redcap_timeout, 120.0)

    # --- programs ---

    def test_without_a_token_the_default_program_list_has_nothing_to_run(self):
        problems = self.problems(self.env(REDCAP_SOAR_TOKEN=None))
        self.assertTrue(any("nothing to run" in p for p in problems))

    def test_naming_a_program_without_its_token_is_an_error(self):
        problems = self.problems(self.env(PROGRAMS="SOAR", REDCAP_SOAR_TOKEN=None))
        self.assertTrue(any("PROGRAMS includes SOAR, but REDCAP_SOAR_TOKEN is not set" in p for p in problems))

    def test_an_unknown_program_is_refused(self):
        self.assertTrue(any("not a program" in p for p in self.problems(self.env(PROGRAMS="SOAR,SAOR"))))

    def test_an_unimplemented_program_is_refused_by_name(self):
        # Every program is implemented now; the check stays for the next one.
        implemented = {k: v for k, v in config_module.IMPLEMENTED.items() if k != "TTT"}
        with mock.patch.object(config_module, "IMPLEMENTED", implemented):
            problems = self.problems(self.env(PROGRAMS="SOAR,TTT"))
        self.assertTrue(any("TTT, which this version does not implement" in p for p in problems))

    def test_program_names_are_case_insensitive_and_deduplicated(self):
        self.assertEqual(load_config(self.env(PROGRAMS="soar, SOAR"), OCTOBER).programs, ("SOAR",))

    def test_only_tokens_in_scope_are_held(self):
        # NEST is implemented, but PROGRAMS leaves it out.
        c = load_config(self.env(PROGRAMS="SOAR", REDCAP_NEST_TOKEN=FAKE_TOKEN), OCTOBER)
        self.assertNotIn("REDCAP_NEST_TOKEN", c.tokens)

    def test_a_partly_configured_program_holds_none_of_its_tokens(self):
        c = load_config(self.env(REDCAP_TTT_HOSPITAL_TOKEN=FAKE_TOKEN, REDCAP_TTT_PATIENT_TOKEN=FAKE_TOKEN), OCTOBER)
        self.assertEqual(c.programs, ("SOAR",))
        self.assertEqual(set(c.tokens), {"REDCAP_SOAR_TOKEN"})
        self.assertTrue(any("TTT skipped: REDCAP_TTT_DYADIC_TOKEN is not set" in n for n in c.notices))

    def test_ttt_needs_all_three_tokens(self):
        problems = self.problems(self.env(PROGRAMS="TTT", REDCAP_TTT_HOSPITAL_TOKEN=FAKE_TOKEN))
        self.assertTrue(any(
            "PROGRAMS includes TTT, but REDCAP_TTT_PATIENT_TOKEN, REDCAP_TTT_DYADIC_TOKEN are not set" in p
            for p in problems
        ))
        ttt = {f"REDCAP_TTT_{p}_TOKEN": FAKE_TOKEN for p in ("HOSPITAL", "PATIENT", "DYADIC")}
        c = load_config(self.env(PROGRAMS="TTT", **ttt), OCTOBER)
        self.assertEqual((c.programs, set(c.tokens)), (("TTT",), set(ttt)))
        self.assertIsNone(c.ttt_dyadic_api_url)

    def test_the_dyadic_instance_must_be_https(self):
        c = load_config(self.env(REDCAP_TTT_DYADIC_API_URL="https://redcap.other.example/api/"), OCTOBER)
        self.assertEqual(c.ttt_dyadic_api_url, "https://redcap.other.example/api/")
        problems = self.problems(self.env(REDCAP_TTT_DYADIC_API_URL="http://localhost/api/"))
        self.assertTrue(any("REDCAP_TTT_DYADIC_API_URL must be an https:// URL" in p for p in problems))

    def test_every_implemented_program_with_a_token_runs_by_default(self):
        c = load_config(self.env(REDCAP_NEST_TOKEN=FAKE_TOKEN), OCTOBER)
        self.assertEqual(c.programs, ("SOAR", "NEST"))
        c = load_config(self.env(), OCTOBER)
        self.assertEqual(c.programs, ("SOAR",))
        self.assertTrue(any("NEST skipped: REDCAP_NEST_TOKEN is not set" in n for n in c.notices))

    # --- program years ---

    def test_previous_year_stays_in_scope_through_february(self):
        self.assertEqual(default_program_years(date(2027, 1, 15)), (2026, 2027))
        self.assertEqual(default_program_years(date(2027, 2, 28)), (2026, 2027))
        self.assertEqual(default_program_years(date(2027, 3, 1)), (2027,))

    def test_program_years_override(self):
        c = load_config(self.env(PROGRAM_YEARS="2026, 2025,2026"), OCTOBER)
        self.assertEqual(c.program_years, (2025, 2026))

    def test_a_year_that_has_not_started_is_refused(self):
        self.assertTrue(any("2027 has not started" in p for p in self.problems(self.env(PROGRAM_YEARS="2027"))))

    def test_a_malformed_year_is_refused(self):
        self.assertTrue(any('"26" is not a year' in p for p in self.problems(self.env(PROGRAM_YEARS="26"))))

    # --- reporting ---

    def test_every_problem_is_reported_at_once(self):
        problems = self.problems({"REDCAP_API_URL": "ftp://x", "PROGRAMS": "XYZ"})
        self.assertGreaterEqual(len(problems), 3)


if __name__ == "__main__":
    unittest.main()
