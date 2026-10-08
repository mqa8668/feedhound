-- Server -> `/ws` client push. `apps/api/src/ws/live.ts`
-- LISTENs on these four channels. Payload is kept small (an id) so `pg_notify`'s
-- 8000-byte limit is never a concern; the listener re-queries the row it needs.
-- Applied via packages/db/migrations/0012_charming_lila_cheney.sql (initial
-- version) and 0014_source_key_and_trigger_fixes.sql (idempotent DROP TRIGGER
-- IF EXISTS + change-gated source_health_trigger) —
-- this file is the source of truth for that DDL, kept alongside the code
-- that consumes it.

CREATE OR REPLACE FUNCTION post_notify_new() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('post_new', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS post_new_trigger ON "post";
CREATE TRIGGER post_new_trigger
AFTER INSERT ON "post"
FOR EACH ROW EXECUTE FUNCTION post_notify_new();

CREATE OR REPLACE FUNCTION post_revision_notify_updated() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('post_updated', NEW.post_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS post_revision_updated_trigger ON "post_revision";
CREATE TRIGGER post_revision_updated_trigger
AFTER INSERT ON "post_revision"
FOR EACH ROW EXECUTE FUNCTION post_revision_notify_updated();

CREATE OR REPLACE FUNCTION match_notify_new() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('match_new', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS match_new_trigger ON "match";
CREATE TRIGGER match_new_trigger
AFTER INSERT ON "match"
FOR EACH ROW EXECUTE FUNCTION match_notify_new();

CREATE OR REPLACE FUNCTION source_notify_health() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('source_health', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `WHEN` clause: only NOTIFY when status/health
-- actually changed, not on every UPDATE statement that merely re-writes the
-- same value (e.g. a routine ok=true heartbeat) — avoids a NOTIFY + row
-- re-query + client broadcast per heartbeat.
DROP TRIGGER IF EXISTS source_health_trigger ON "source";
CREATE TRIGGER source_health_trigger
AFTER UPDATE OF status, health ON "source"
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.health IS DISTINCT FROM OLD.health)
EXECUTE FUNCTION source_notify_health();
