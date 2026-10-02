-- Rare City production foundation.
--
-- Deliberately minimal: migration bookkeeping lives in schema_migrations (created by the
-- runner), and this table records facts about the database itself. Users, wallets,
-- commands, events and the city tables arrive with the slices that define them.

CREATE TABLE app_meta (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_meta IS 'Facts about this database. The "environment" row pins it to local, staging or production.';
