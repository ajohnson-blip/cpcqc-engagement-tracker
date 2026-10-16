"""Per-program assessors.

SOAR is the reference implementation. Adding a program means a module here
exposing MINIMUM_FIELDS, METHODOLOGY_VERSION and assess(), plus a
crosswalk.<program>.json beside app/, and a branch in main.assess().
"""
