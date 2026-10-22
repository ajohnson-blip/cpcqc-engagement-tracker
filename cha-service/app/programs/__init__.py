"""Per-program assessors.

SOAR is the reference implementation. Each program is a module here exposing:

    PROGRAM              "SOAR", "NEST", ...
    TOKEN_SETTINGS       the environment variables holding its REDCap token(s)
    METHODOLOGY_VERSION  changes whenever its rules change
    REDCAP_PROJECT       a name for the project(s) read, for reconciliation
    fetch(client, tokens) -> Fetched          all REDCap reads; has .records_read.
                                              Raises RedcapError, or
                                              ProjectConfigurationError when the
                                              project cannot be relied on.
    assess_year(fetched, year, crosswalk, today) -> (assessments, warnings)
                                              crosswalk is a crosswalk.Crosswalk

plus `crosswalk.<program>.json` beside this package. Reading is separated from
assessing so one export serves every program year in scope.

Adding a program means adding it to IMPLEMENTED below.
"""
from . import soar

IMPLEMENTED = {soar.PROGRAM: soar}

# Every program the contract defines, implemented or not, so configuration can
# tell a typo from a program that simply has not been ported yet.
KNOWN = ("SPARK", "NEST", "SOAR", "TTT")
