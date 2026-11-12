#!/bin/sh
set -eu
umask 077

# Compose grants each service only the secret files it needs. Never echo values.
if [ -n "${DATABASE_PASSWORD_FILE:-}" ]; then
  DATABASE_URL="$(node /app/deploy/database-url.mjs)"
  export DATABASE_URL
fi
if [ "${SERVICE_ROLE:-web}" = "migrate" ]; then
  MIGRATION_DATABASE_URL="$DATABASE_URL"
  export MIGRATION_DATABASE_URL
else
  if [ "${SERVICE_ROLE:-web}" = "worker" ]; then
    WORKER_DATABASE_URL="$DATABASE_URL"
    export WORKER_DATABASE_URL
  fi
  if [ -f /run/secrets/data_encryption_key ]; then
    DATA_ENCRYPTION_KEY="$(cat /run/secrets/data_encryption_key)"
    export DATA_ENCRYPTION_KEY
  fi
  if [ -f /run/secrets/session_secret ]; then
    SESSION_SECRET="$(cat /run/secrets/session_secret)"
    export SESSION_SECRET
  fi
  if [ -f /run/secrets/google_client_secret ]; then
    GOOGLE_CLIENT_SECRET="$(cat /run/secrets/google_client_secret)"
    export GOOGLE_CLIENT_SECRET
  fi
  if [ -f /run/secrets/telegram_bot_token ]; then
    TELEGRAM_BOT_TOKEN="$(cat /run/secrets/telegram_bot_token)"
    export TELEGRAM_BOT_TOKEN
  fi
  if [ -f /run/secrets/slack_client_secret ]; then
    SLACK_CLIENT_SECRET="$(cat /run/secrets/slack_client_secret)"
    export SLACK_CLIENT_SECRET
  fi
fi
exec "$@"
