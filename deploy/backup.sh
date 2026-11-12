#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
: "${BACKUP_AGE_RECIPIENT:?Set the age public recipient for the offline backup key}"
command -v age >/dev/null
command -v docker >/dev/null
mkdir -p deploy/backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="deploy/backups/dabas-${stamp}.dump.age"
trap 'rm -f "${target}.partial"' EXIT
# The privileged dump runs inside the DB container, never in web or worker.
docker compose --env-file deploy/pilot.env -f compose.pilot.yml exec -T --user postgres postgres \
  pg_dump --username postgres --dbname dabas --format custom \
  | age --recipient "$BACKUP_AGE_RECIPIENT" --output "${target}.partial"
mv "${target}.partial" "$target"
printf 'Encrypted backup created: %s\n' "$target"
printf 'Copy it to the separate backup destination and verify that destination.\n'
