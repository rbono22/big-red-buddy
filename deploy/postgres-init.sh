#!/bin/sh
set -eu
# Official PostgreSQL entrypoint runs this once for a new data volume. Database
# passwords are generated as hex; validation makes interpolation into SQL safe.
owner_password="$(cat /run/secrets/database_owner_password)"
web_password="$(cat /run/secrets/database_web_password)"
worker_password="$(cat /run/secrets/database_worker_password)"
for value in "$owner_password" "$web_password" "$worker_password"; do
  case "$value" in *[!a-f0-9]*|'') exit 1 ;; esac
  [ "${#value}" -ge 64 ] || exit 1
done
psql --username "$POSTGRES_USER" --dbname postgres --no-psqlrc --set ON_ERROR_STOP=1 <<SQL
CREATE ROLE dabas_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE dabas_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE dabas_owner LOGIN PASSWORD '$owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE dabas_web LOGIN PASSWORD '$web_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE dabas_jobs LOGIN PASSWORD '$worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT dabas_app TO dabas_web;
GRANT dabas_app, dabas_worker TO dabas_jobs;
CREATE DATABASE dabas OWNER dabas_owner;
REVOKE CONNECT ON DATABASE dabas FROM PUBLIC;
GRANT CONNECT ON DATABASE dabas TO dabas_app, dabas_worker;
\connect dabas
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
