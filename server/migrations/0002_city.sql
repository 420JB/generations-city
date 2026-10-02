-- The shared city: one authoritative read model and the sequence that orders its changes.
--
-- This migration creates structure only. It installs no city: a database stays without
-- one until a city is installed deliberately (see server/README.md).

CREATE TABLE city (
  id            text        PRIMARY KEY,
  -- Identity of this installation. A city that is wiped and reinstalled gets a new one.
  instance_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  -- false = non-canonical staging/test state, to be wiped before real RF.
  canonical     boolean     NOT NULL,
  origin        text        NOT NULL,
  -- Version of the GameState shape held in "state".
  state_version integer     NOT NULL,
  -- Increases by exactly one with every authoritative change, under a lock on this row.
  sequence      bigint      NOT NULL,
  -- json, not jsonb: jsonb reorders object keys, and the renderer reads some of them in order.
  state         json        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT city_origin_known CHECK (origin IN ('genesis', 'demo-fixture')),
  CONSTRAINT city_canonical_is_genesis CHECK (canonical = (origin = 'genesis')),
  CONSTRAINT city_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT city_state_is_object CHECK (json_typeof(state) = 'object'),
  -- IS TRUE: a CHECK passes on NULL, and a state without a "version" key yields NULL here.
  CONSTRAINT city_state_version_matches CHECK (
    (json_typeof(state -> 'version') = 'number' AND (state ->> 'version') = state_version::text) IS TRUE
  )
);

COMMENT ON TABLE city IS 'The authoritative city read model. One row per city; the service is its only writer.';

-- Append-only history: one row for every value "city.sequence" has ever held.
CREATE TABLE city_events (
  city_id    text        NOT NULL REFERENCES city (id),
  sequence   bigint      NOT NULL,
  type       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, sequence),
  CONSTRAINT city_events_sequence_positive CHECK (sequence >= 1)
);

COMMENT ON TABLE city_events IS 'Append-only. Row N explains how the city reached sequence N.';

-- Last line of defence: a database stamped "production" can never hold a non-canonical
-- city, whatever code is pointed at it.
CREATE FUNCTION city_guard_canonical() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.canonical AND EXISTS (SELECT 1 FROM app_meta WHERE key = 'environment' AND value = 'production') THEN
    RAISE EXCEPTION 'a production database cannot hold a non-canonical city';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER city_guard_canonical
  BEFORE INSERT OR UPDATE ON city
  FOR EACH ROW EXECUTE FUNCTION city_guard_canonical();
