-- Architect property design (P1-C2-E4A): the first thing a property's current NFT controller can CHOOSE
-- about how its building looks. LOCAL DATABASES ONLY, LOCAL TEST CONTROL ONLY, FREE.
--
-- What a design is. Two identifiers from one versioned catalog, mirrored from `src/world/design.ts`:
-- a facade finish and a roof silhouette, each one the standard city renderer already draws. Nothing
-- else: no color, markup, URL, image, text or script, so nothing a browser authors can reach the city.
-- `architect-design-v1` offers five facades (slate, limestone, brick, copper, jade) and four roofs
-- (flat, terrace, dome, spire); a property with no saved design is drawn with slate and flat, as every
-- new building is. Every choice is free: a design spends no test credit, adds no construction unit,
-- and earns no tier, rank, Crown, Capital or monument.
--
-- Who may save one. Only the player the trusted source names as the NFT's CURRENT controller in this
-- world's Discord server (locally the rehearsal file: TEST DATA, never verified ownership), asked again
-- for every save under the city's lock, through a live play session of the world, as for an owner's
-- construction (0013). Founding the property (its original activator, 0008) authorizes nothing, and a
-- patron or anyone else may look but not change it. The database cannot see the trusted source, so
-- that rule is the service's; the database holds every rule it can see (below).
--
-- What a design belongs to. The PROPERTY, not whoever chose it: a saved design stays when the NFT's
-- controller changes, and the next controller may change it. It is not public owner media (billboards),
-- whose transfer rules are separate and not part of this migration.
--
-- Schema decisions, and why:
--   * One append-only row per save, numbered 1, 2, 3 ... per property (`revision`): the latest is the
--     property's design, and every earlier one stays, so a later save can restore any of them and the
--     history is never rewritten. Two saves made on the same revision collide on the primary key.
--   * A design does NOT advance the city's sequence and writes no city event. The city's state (0007,
--     0013) records what the engine simulates and replays (properties, wards, construction); a design is
--     how a building is drawn, so the city, its events, its replay and every guard of 0007 to 0014 are
--     untouched. The row records the city sequence it was saved at, so designs and constructions still
--     read in one order.
--   * A save is named by an id the page chooses once per press (`action_id`), unique per world: a repeat
--     of it is answered with the design it saved, and saves nothing more.
--
-- Additive. One new table and its guard; nothing else is created, replaced or changed, and no row of any
-- other table is touched. Constraints are permanent (migrations never drop one), so table CHECKs state
-- only shape; which catalogs and choices exist is a policy function a later migration can replace.

-- Creating a foreign key on worlds and world_properties and a trigger takes brief locks. If one cannot be had
-- quickly, fail and roll back rather than queue readers behind this migration; the deploy can be run again.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- The catalog, as the engine lists it (src/world/design.ts)
-- ---------------------------------------------------------------------------------------

-- Whether a facade and a roof are both choices of a catalog this database knows. False for anything else.
CREATE FUNCTION world_design_choice_known(catalog text, facade text, roof text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE catalog
    WHEN 'architect-design-v1' THEN facade IN ('slate', 'limestone', 'brick', 'copper', 'jade') AND roof IN ('flat', 'terrace', 'dome', 'spire')
    ELSE false
  END
$$;

-- ---------------------------------------------------------------------------------------
-- world_property_designs: one row per saved design of a world property, for good
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_property_designs (
  world_id                    uuid        NOT NULL,
  city_id                     text        NOT NULL,
  city_instance_id            uuid        NOT NULL,
  property_id                 uuid        NOT NULL,
  -- 1, 2, 3 ... per property. The latest is the property's design.
  revision                    integer     NOT NULL,
  -- The page's id for this one save: a repeat of it is the same design.
  action_id                   uuid        NOT NULL,
  catalog                     text        NOT NULL,
  facade                      text        NOT NULL,
  roof                        text        NOT NULL,
  -- The player who saved it, as Proofy named them for the play session that saved it (0006), never as a browser said.
  designer_core_user_id       text        NOT NULL,
  designer_discord_user_id    text        NOT NULL,
  -- An identifier only: sessions are tidied after their retention.
  designed_in_play_session    uuid        NOT NULL,
  -- What authorized it: the trusted source named the designer the NFT's current controller. Only the local fixture exists.
  authority                   text        NOT NULL,
  -- The city's sequence when it was saved (a design advances none).
  at_city_sequence            bigint      NOT NULL,
  designed_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, revision),
  CONSTRAINT wpd_world_city        FOREIGN KEY (world_id, city_id, city_instance_id) REFERENCES worlds (id, city_id, city_instance_id),
  CONSTRAINT wpd_property          FOREIGN KEY (world_id, property_id) REFERENCES world_properties (world_id, id),
  CONSTRAINT wpd_one_per_action    UNIQUE (world_id, action_id),
  CONSTRAINT wpd_revision_positive CHECK (revision >= 1),
  CONSTRAINT wpd_catalog_shape     CHECK (catalog ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(catalog) <= 64),
  CONSTRAINT wpd_choice_shape      CHECK (facade ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(facade) <= 32 AND roof ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(roof) <= 32),
  CONSTRAINT wpd_designer_shape    CHECK (designer_core_user_id ~ '^[A-Za-z0-9_-]{1,64}$' AND designer_discord_user_id ~ '^[0-9]{15,25}$'),
  CONSTRAINT wpd_authority_known   CHECK (authority = 'local-fixture-controller'),
  CONSTRAINT wpd_sequence_shape    CHECK (at_city_sequence >= 2)
);

COMMENT ON TABLE world_property_designs IS 'Append-only record of every saved Architect design (catalog facade and roof identifiers) of a world property, by its current local-fixture controller. Free, local test control only; the latest revision is the property''s design.';

-- ---------------------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------------------

-- A design is written once and never changed or removed:
--   * the database is a LOCAL one, in a READ COMMITTED transaction (the hold every player change ships with);
--   * it is on a property of its world, in the world's own city, at exactly the sequence the city is at now;
--   * it is the property's next revision (1, 2, 3 ...), and its city sequence is never before its revision's before it;
--   * its facade and roof are both choices of a catalog this database knows;
--   * its designer is the player of the live play session of this world that saves it, read from that session's row,
--     which is locked until this transaction ends.
CREATE FUNCTION world_property_designs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a saved design is permanent: it cannot be changed (save a new revision)';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a saved design is permanent: it cannot be removed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'property design is not enabled in this database: only a local database may record it until live player mutations are authorized';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a design is recorded only in a READ COMMITTED transaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM worlds w WHERE w.id = NEW.world_id AND w.city_id = NEW.city_id AND w.city_instance_id = NEW.city_instance_id) THEN
    RAISE EXCEPTION 'a design belongs to its world''s own city (foreign key world_property_designs -> worlds)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM world_properties p WHERE p.id = NEW.property_id AND p.world_id = NEW.world_id AND p.city_id = NEW.city_id AND p.activated_sequence <= NEW.at_city_sequence) THEN
    RAISE EXCEPTION 'a design is on a property of its world (foreign key world_property_designs -> world_properties)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM city c WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND c.sequence = NEW.at_city_sequence) THEN
    RAISE EXCEPTION 'a design records the sequence its city is at when it is saved';
  END IF;

  SELECT d.revision, d.at_city_sequence INTO previous FROM world_property_designs d WHERE d.property_id = NEW.property_id ORDER BY d.revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(previous.revision, 0) + 1 THEN
    RAISE EXCEPTION 'designs are numbered consecutively from 1 for each property';
  END IF;
  IF previous.at_city_sequence IS NOT NULL AND NEW.at_city_sequence < previous.at_city_sequence THEN
    RAISE EXCEPTION 'a design is never saved at an earlier city sequence than the revision before it';
  END IF;

  IF NOT world_design_choice_known(NEW.catalog, NEW.facade, NEW.roof) THEN
    RAISE EXCEPTION 'a design is a facade and a roof of a catalog this database knows: % / % / % is not', NEW.catalog, NEW.facade, NEW.roof;
  END IF;

  PERFORM 1 FROM play_sessions s
    WHERE s.id = NEW.designed_in_play_session AND s.world_id = NEW.world_id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a design is saved only in a live play session of its world';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM play_sessions s
     WHERE s.id = NEW.designed_in_play_session AND s.core_user_id = NEW.designer_core_user_id AND s.discord_user_id = NEW.designer_discord_user_id
  ) THEN
    RAISE EXCEPTION 'a design''s designer is the player of the play session that saves it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_property_designs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_property_designs
  FOR EACH ROW EXECUTE FUNCTION world_property_designs_guard();

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0014)
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY['world_design_choice_known(text, text, text)', 'world_property_designs_guard()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- A runtime role that does not own this table needs, to save a design: SELECT on app_meta, worlds, city, world_properties,
-- play_sessions and world_property_designs, INSERT on world_property_designs, and (to lock the city row and the session,
-- as construction does) UPDATE on city and on one column of play_sessions. Never grant UPDATE or DELETE on
-- world_property_designs. As 0005 says, TRUNCATE, disabling triggers and table-rewriting DDL are owner powers this row
-- trigger does not cover.
--
-- Not here, on purpose, because each waits on a decision or a contract that does not exist yet:
--   * verified current NFT control (Proofy Core), or any real NFT transfer;
--   * paid, earned, ranked or unlockable designs, a design economy or marketplace;
--   * uploaded media, textures, user-authored billboards, links or text, and public owner media's transfer rules;
--   * any change to a property's tier, construction, founder, district or plot (a design touches none).
