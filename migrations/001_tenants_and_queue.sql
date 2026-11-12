BEGIN;
CREATE SCHEMA IF NOT EXISTS dabas;
REVOKE ALL ON SCHEMA dabas FROM PUBLIC;
GRANT USAGE ON SCHEMA dabas TO dabas_app,dabas_worker;
CREATE TABLE IF NOT EXISTS dabas.schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS dabas.tenants(user_id text PRIMARY KEY CHECK(length(user_id) BETWEEN 1 AND 200));
ALTER TABLE dabas.tenants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS dabas.auth_records(bucket text NOT NULL,id text NOT NULL,payload text NOT NULL,PRIMARY KEY(bucket,id));
CREATE TABLE IF NOT EXISTS dabas.records(user_id text NOT NULL REFERENCES dabas.tenants(user_id),bucket text NOT NULL,id text NOT NULL,payload text NOT NULL,PRIMARY KEY(user_id,bucket,id));
ALTER TABLE dabas.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE dabas.records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS records_student ON dabas.records;
CREATE POLICY records_student ON dabas.records TO dabas_app USING(user_id=current_setting('app.user_id',true) AND NOT EXISTS(SELECT 1 FROM dabas.tenants t WHERE t.user_id=records.user_id AND t.deleted_at IS NOT NULL)) WITH CHECK(user_id=current_setting('app.user_id',true) AND NOT EXISTS(SELECT 1 FROM dabas.tenants t WHERE t.user_id=records.user_id AND t.deleted_at IS NOT NULL));
DROP POLICY IF EXISTS records_maintenance_owner ON dabas.records;
CREATE POLICY records_maintenance_owner ON dabas.records TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE TABLE IF NOT EXISTS dabas.jobs(
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES dabas.tenants(user_id),type text NOT NULL,payload text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','completed','failed','needs_review')),
 priority integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,completed_at timestamptz,lease_until timestamptz,lease_token uuid,worker_id text,
 attempts integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
 retry_safe boolean NOT NULL DEFAULT false,result text,error_code text,idempotency_key text,expires_at timestamptz NOT NULL,
 UNIQUE(user_id,type,idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_ready ON dabas.jobs(status,available_at,priority DESC);
CREATE INDEX IF NOT EXISTS jobs_tenant ON dabas.jobs(user_id,created_at DESC);
ALTER TABLE dabas.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dabas.jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_student ON dabas.jobs;
CREATE POLICY jobs_student ON dabas.jobs TO dabas_app USING(user_id=current_setting('app.user_id',true) AND NOT EXISTS(SELECT 1 FROM dabas.tenants t WHERE t.user_id=jobs.user_id AND t.deleted_at IS NOT NULL)) WITH CHECK(user_id=current_setting('app.user_id',true) AND NOT EXISTS(SELECT 1 FROM dabas.tenants t WHERE t.user_id=jobs.user_id AND t.deleted_at IS NOT NULL));
-- The owner is available only through narrowly granted SECURITY DEFINER functions.
DROP POLICY IF EXISTS jobs_dispatch_owner ON dabas.jobs;
CREATE POLICY jobs_dispatch_owner ON dabas.jobs TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON ALL TABLES IN SCHEMA dabas FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON dabas.records,dabas.auth_records,dabas.jobs TO dabas_app;
GRANT SELECT,INSERT ON dabas.tenants TO dabas_app;

-- Serialize all content creation with permanent deletion, including direct SQL writes.
CREATE OR REPLACE FUNCTION dabas.guard_student_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,dabas AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('student:'||NEW.user_id,0));
 IF EXISTS(SELECT 1 FROM dabas.tenants WHERE user_id=NEW.user_id AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'STUDENT_DELETED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS records_student_active ON dabas.records;
CREATE TRIGGER records_student_active BEFORE INSERT OR UPDATE ON dabas.records FOR EACH ROW EXECUTE FUNCTION dabas.guard_student_write();
DROP TRIGGER IF EXISTS jobs_student_active ON dabas.jobs;
CREATE TRIGGER jobs_student_active BEFORE INSERT OR UPDATE OF user_id,payload ON dabas.jobs FOR EACH ROW EXECUTE FUNCTION dabas.guard_student_write();
REVOKE ALL ON FUNCTION dabas.guard_student_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dabas.guard_student_write() TO dabas_app;

CREATE OR REPLACE FUNCTION dabas.delete_student(p_user text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,dabas AS $$
BEGIN
 IF p_user IS DISTINCT FROM current_setting('app.user_id',true) OR length(p_user)<1 THEN RAISE EXCEPTION 'Student scope required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('student:'||p_user,0));
 PERFORM id FROM dabas.jobs WHERE user_id=p_user FOR UPDATE;
 IF EXISTS(SELECT 1 FROM dabas.jobs WHERE user_id=p_user AND status='running') THEN RAISE EXCEPTION 'STUDENT_JOBS_RUNNING'; END IF;
 DELETE FROM dabas.jobs WHERE user_id=p_user;
 DELETE FROM dabas.records WHERE user_id=p_user;
 DELETE FROM dabas.auth_records WHERE bucket='users' AND id=p_user;
 INSERT INTO dabas.tenants(user_id,deleted_at) VALUES(p_user,clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET deleted_at=COALESCE(dabas.tenants.deleted_at,EXCLUDED.deleted_at);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION dabas.delete_student(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dabas.delete_student(text) TO dabas_app;

CREATE OR REPLACE FUNCTION dabas.claim_job(p_worker text,p_types text[],p_lease_ms integer,p_concurrency integer,p_token uuid)
RETURNS SETOF dabas.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,dabas AS $$
BEGIN
 IF length(p_worker)<1 OR length(p_worker)>200 OR p_lease_ms<1000 OR p_lease_ms>900000 OR p_concurrency<1 OR p_concurrency>32 THEN RAISE EXCEPTION 'Invalid worker configuration'; END IF;
 PERFORM pg_advisory_xact_lock(118327,1);
 DELETE FROM dabas.jobs WHERE expires_at<clock_timestamp() AND status<>'running';
 UPDATE dabas.jobs SET status=CASE WHEN retry_safe AND attempts<max_attempts AND expires_at>clock_timestamp() THEN 'queued' WHEN retry_safe THEN 'failed' ELSE 'needs_review' END,
  available_at=clock_timestamp(),completed_at=CASE WHEN retry_safe AND attempts<max_attempts AND expires_at>clock_timestamp() THEN NULL ELSE clock_timestamp() END,
  error_code='LEASE_EXPIRED',lease_until=NULL,lease_token=NULL,worker_id=NULL
  WHERE status='running' AND lease_until<clock_timestamp();
 IF (SELECT count(*) FROM dabas.jobs WHERE status='running' AND (p_types IS NULL OR type=ANY(p_types)))>=p_concurrency THEN RETURN; END IF;
 RETURN QUERY WITH candidate AS (
  SELECT id FROM dabas.jobs WHERE status='queued' AND available_at<=clock_timestamp() AND expires_at>clock_timestamp() AND (p_types IS NULL OR type=ANY(p_types))
  ORDER BY priority DESC,available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE dabas.jobs j SET status='running',worker_id=p_worker,lease_token=p_token,lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond',attempts=j.attempts+1,started_at=clock_timestamp()
 FROM candidate c WHERE j.id=c.id RETURNING j.*;
END $$;

CREATE OR REPLACE FUNCTION dabas.transition_job(p_id uuid,p_token uuid,p_worker text,p_action text,p_result text,p_error text,p_retry boolean,p_lease_ms integer)
RETURNS SETOF dabas.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,dabas AS $$
BEGIN
 IF p_action NOT IN('heartbeat','complete','fail') OR p_lease_ms<1000 OR p_lease_ms>900000 THEN RAISE EXCEPTION 'Invalid transition'; END IF;
 RETURN QUERY UPDATE dabas.jobs SET
 status=CASE WHEN p_action='heartbeat' THEN 'running' WHEN p_action='complete' THEN 'completed' WHEN p_retry AND retry_safe AND attempts<max_attempts AND expires_at>clock_timestamp() THEN 'queued' WHEN NOT retry_safe THEN 'needs_review' ELSE 'failed' END,
 lease_until=CASE WHEN p_action='heartbeat' THEN clock_timestamp()+p_lease_ms*interval '1 millisecond' ELSE NULL END,
 lease_token=CASE WHEN p_action='heartbeat' THEN lease_token ELSE NULL END,
 worker_id=CASE WHEN p_action='heartbeat' THEN worker_id ELSE NULL END,
 result=CASE WHEN p_action='complete' THEN p_result ELSE result END,
 error_code=CASE WHEN p_action='fail' THEN left(p_error,80) ELSE NULL END,
 available_at=CASE WHEN p_action='fail' THEN clock_timestamp()+(least(300,power(2,attempts)::integer))*interval '1 second' ELSE available_at END,
 completed_at=CASE WHEN p_action='heartbeat' OR (p_action='fail' AND p_retry AND retry_safe AND attempts<max_attempts AND expires_at>clock_timestamp()) THEN NULL ELSE clock_timestamp() END
 WHERE id=p_id AND lease_token=p_token AND worker_id=p_worker AND status='running' AND lease_until>clock_timestamp()
 RETURNING *;
END $$;
REVOKE ALL ON FUNCTION dabas.claim_job(text,text[],integer,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION dabas.transition_job(uuid,uuid,text,text,text,text,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dabas.claim_job(text,text[],integer,integer,uuid) TO dabas_worker;
GRANT EXECUTE ON FUNCTION dabas.transition_job(uuid,uuid,text,text,text,text,boolean,integer) TO dabas_worker;
INSERT INTO dabas.schema_migrations(version) VALUES('001') ON CONFLICT DO NOTHING;
COMMIT;
