#!/usr/bin/env bash
# AC-13: prove a backup can be restored. Dumps the database, restores it into a scratch
# database, and compares row counts and the ledger/audit integrity checks.
# Usage: DATABASE_URL=postgres://... ./scripts/backup-restore-check.sh
set -euo pipefail
SRC="${DATABASE_URL:?set DATABASE_URL}"
SCRATCH_DB="restore_check_$(date +%s)"
BASE="${SRC%/*}"
FILE="$(mktemp -t legacy-backup-XXXX.dump)"
echo "1/4 Dumping to $FILE"
pg_dump --format=custom --no-owner "$SRC" > "$FILE"
echo "2/4 Restoring into $SCRATCH_DB"
psql "$BASE/postgres" -qc "CREATE DATABASE $SCRATCH_DB" >/dev/null
pg_restore --no-owner --dbname="$BASE/$SCRATCH_DB" "$FILE"
COUNTS="SELECT (SELECT count(*) FROM members)||','||(SELECT count(*) FROM payments)||','||(SELECT count(*) FROM ledger_entries)||','||(SELECT count(*) FROM audit_events)||','||(SELECT sum(debit)-sum(credit) FROM ledger_entries)"
A=$(psql "$SRC" -tAc "$COUNTS"); B=$(psql "$BASE/$SCRATCH_DB" -tAc "$COUNTS")
echo "3/4 Source   members,payments,ledger lines,audit events,ledger imbalance = $A"
echo "    Restored members,payments,ledger lines,audit events,ledger imbalance = $B"
psql "$BASE/postgres" -qc "DROP DATABASE $SCRATCH_DB" >/dev/null; rm -f "$FILE"
if [ "$A" = "$B" ]; then echo "4/4 PASS — restore matches the source exactly"; else echo "4/4 FAIL — restore differs"; exit 1; fi
