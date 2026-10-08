-- Extensions on the main app database (POSTGRES_DB, i.e. "feedhound").
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Separate database for integration tests, freely truncatable.
SELECT 'CREATE DATABASE feedhound_test OWNER feedhound'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'feedhound_test')\gexec

\connect feedhound_test
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
