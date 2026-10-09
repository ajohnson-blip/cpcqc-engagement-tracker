#!/usr/bin/env bash
#
# Clone a Render Postgres database into another one, with proof the copy is complete.
#
# Written for moving cpcqc-tracker-db (My Workspace) into et-db (Engagement
# Tracker Workspace). It takes a full dump, replaces the target's public schema
# and restores into it, then compares exact row counts table-by-table and fails
# loudly if any differ.
#
# Replacing the schema rather than restoring data-only is deliberate: the target
# will already have a schema if its service has deployed (buildCommand runs
# db:migrate). A data-only restore into an existing schema needs trigger control
# we do not have on managed Postgres, and leaves Drizzle's migration journal in
# an unknown state. A clean replace copies the journal too, so the target's next
# deploy sees every migration already applied.
#
# Dry run by default. --apply is required to write, and the target's current
# contents are printed first so nothing is destroyed unseen.
#
#   ./scripts/clone-database.sh \
#       --source ~/.cpcqc-prod-db.url \
#       --target ~/.cpcqc-et-workspace-db.url \
#       [--apply] [--keep-dump]
#
# Each of --source/--target takes either a connection URL or a path to a file
# containing one. Prefer the file: a URL on the command line lands in shell
# history and in the process list.

set -euo pipefail

SOURCE_RAW=""; TARGET_RAW=""; APPLY=0; KEEP_DUMP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_RAW="${2:-}"; shift 2 ;;
    --target) TARGET_RAW="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --keep-dump) KEEP_DUMP=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SOURCE_RAW" && -n "$TARGET_RAW" ]] || { echo "both --source and --target are required" >&2; exit 2; }

# A path means "read the URL from this file"; anything else is the URL itself.
read_url() { if [[ -f "$1" ]]; then tr -d '\r\n' < "$1"; else printf '%s' "$1"; fi; }
SOURCE_URL="$(read_url "$SOURCE_RAW")"
TARGET_URL="$(read_url "$TARGET_RAW")"

# Render requires TLS on external connections. Left alone for localhost, so the
# same script can rehearse against a local server, which has no TLS.
with_ssl() {
  case "$1" in
    *sslmode=*) printf '%s' "$1"; return ;;
    *@localhost*|*@127.0.0.1*|*%40localhost*) printf '%s' "$1"; return ;;
  esac
  case "$1" in *\?*) printf '%s&sslmode=require' "$1" ;; *) printf '%s?sslmode=require' "$1" ;; esac
}
SOURCE_URL="$(with_ssl "$SOURCE_URL")"
TARGET_URL="$(with_ssl "$TARGET_URL")"

# Host and database only — never print a URL, it carries the password.
describe() { printf '%s' "$1" | sed -E 's#^[a-z]+://[^@]*@##; s#\?.*$##'; }
SOURCE_DESC="$(describe "$SOURCE_URL")"
TARGET_DESC="$(describe "$TARGET_URL")"

echo "=============================================================="
echo " SOURCE  $SOURCE_DESC"
echo " TARGET  $TARGET_DESC"
echo " MODE    $([[ $APPLY -eq 1 ]] && echo 'APPLY — the target will be replaced' || echo 'DRY RUN — nothing will be written')"
echo "=============================================================="

# Refuse to clone a database onto itself. This script drops the target schema,
# so a copy-paste slip here would destroy production.
if [[ "$SOURCE_DESC" == "$TARGET_DESC" ]]; then
  echo "REFUSING: source and target are the same database ($SOURCE_DESC)." >&2
  exit 1
fi

psql_q() { psql "$1" -At -v ON_ERROR_STOP=1 -c "$2"; }

# Exact counts, not pg_stat estimates — this is the completeness proof.
# Every non-system schema, not just public: Drizzle's migration journal lives in
# `drizzle`, and a public-only comparison would call a copy complete without it.
COUNT_SQL="SELECT table_schema || '.' || table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
           FROM information_schema.tables
           WHERE table_schema NOT IN ('information_schema') AND table_schema NOT LIKE 'pg\\_%'
             AND table_type = 'BASE TABLE'
           ORDER BY table_schema, table_name;"

SCHEMA_SQL="SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
            ORDER BY nspname;"

echo
echo "--- connectivity ---"
echo "source server : $(psql_q "$SOURCE_URL" 'SHOW server_version;')"
echo "target server : $(psql_q "$TARGET_URL" 'SHOW server_version;')"
echo "pg_dump       : $(pg_dump --version | awk '{print $3}')"

SRC_COUNTS="$(psql_q "$SOURCE_URL" "$COUNT_SQL")"
TGT_COUNTS="$(psql_q "$TARGET_URL" "$COUNT_SQL" || true)"
SRC_TABLES="$(printf '%s\n' "$SRC_COUNTS" | grep -c . || true)"
TGT_TABLES="$(printf '%s\n' "$TGT_COUNTS" | grep -c . || true)"
SRC_ROWS="$(printf '%s\n' "$SRC_COUNTS" | awk -F= '{s+=$2} END {print s+0}')"
TGT_ROWS="$(printf '%s\n' "$TGT_COUNTS" | awk -F= '{s+=$2} END {print s+0}')"

echo
echo "--- source ---"
echo "$SRC_TABLES tables, $SRC_ROWS rows"
echo
echo "--- target (will be REPLACED) ---"
if [[ "$TGT_TABLES" -eq 0 ]]; then
  echo "empty — no tables in schema public"
else
  echo "$TGT_TABLES tables, $TGT_ROWS rows:"
  printf '%s\n' "$TGT_COUNTS" | sed 's/^/    /'
fi
TGT_SCHEMAS="$(psql_q "$TARGET_URL" "$SCHEMA_SQL" || true)"
echo "schemas to be dropped: $(printf '%s' "$TGT_SCHEMAS" | tr '\n' ' ')"

if [[ $APPLY -eq 0 ]]; then
  echo
  echo "Dry run complete. Re-run with --apply to replace the target."
  exit 0
fi

# The dump holds staff and hospital-champion names and email addresses, so it
# lives in a 700 directory and is shredded on exit unless --keep-dump.
WORKDIR="$(mktemp -d)"; chmod 700 "$WORKDIR"
DUMP="$WORKDIR/source.dump"
cleanup() {
  if [[ $KEEP_DUMP -eq 1 ]]; then
    echo "dump kept at $DUMP (contains names and email addresses — delete when done)"
  else
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

echo
echo "--- dumping source ---"
pg_dump "$SOURCE_URL" --format=custom --no-owner --no-privileges --file="$DUMP"
echo "wrote $(du -h "$DUMP" | cut -f1)"

echo
echo "--- replacing target schemas ---"
# Drop every non-system schema, then recreate public. `drizzle` is recreated by
# the restore; dropping only public would leave a stale migration journal behind
# and make pg_restore collide with it.
for sch in $(psql_q "$TARGET_URL" "$SCHEMA_SQL"); do
  echo "  dropping schema $sch"
  psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS \"$sch\" CASCADE;"
done
psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA IF NOT EXISTS public;'

echo
echo "--- restoring ---"
# --no-owner/--no-privileges because the roles differ between workspaces.
# A non-zero exit here is usually benign (comments on extensions we do not own),
# so verification below is what decides success, not this exit code.
pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --exit-on-error "$DUMP" || {
  echo "pg_restore reported errors — verification below decides whether the copy is usable." >&2
}

echo
echo "--- verification: exact row counts, source vs target ---"
AFTER_COUNTS="$(psql_q "$TARGET_URL" "$COUNT_SQL")"
FAILED=0
printf '    %-34s %10s %10s   %s\n' TABLE SOURCE TARGET RESULT
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  t="${line%%=*}"; s="${line##*=}"
  a="$(printf '%s\n' "$AFTER_COUNTS" | awk -F= -v k="$t" '$1==k {print $2}')"
  if [[ -z "$a" ]]; then a="MISSING"; fi
  if [[ "$a" == "$s" ]]; then r="ok"; else r="MISMATCH"; FAILED=1; fi
  printf '    %-34s %10s %10s   %s\n' "$t" "$s" "$a" "$r"
done <<< "$SRC_COUNTS"

# A table present in the target but not the source means the restore left
# something behind, which the schema replace should have prevented.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  t="${line%%=*}"
  printf '%s\n' "$SRC_COUNTS" | grep -q "^${t}=" || { printf '    %-34s %10s %10s   EXTRA\n' "$t" "-" "${line##*=}"; FAILED=1; }
done <<< "$AFTER_COUNTS"

echo
if [[ $FAILED -eq 0 ]]; then
  echo "PASS — every table matches on exact row count ($SRC_TABLES tables, $SRC_ROWS rows)."
else
  echo "FAIL — see mismatches above. The target is NOT a complete copy." >&2
  exit 1
fi
