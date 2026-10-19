-- World policies (owner-approved, locked): a world's district geometry is frozen by its FIRST
-- PROPERTY, not by its founding; and every property keeps, for good, the player who originally
-- activated it, apart from whoever holds the NFT now.
--
-- Additive. Two new tables, two new nullable columns, new guards, and a replacement of the policy
-- function world_properties_guard (0007), which 0007 left replaceable for exactly this. Nothing is
-- removed, and no existing row is changed: the Rare Friends city and its tables, every world, city,
-- event, binding, play session, configuration copy (with its recorded verdict) and adoption, and
-- every world property are left exactly as they are. The only rows written are derived records of
-- facts the database already holds (the backfills below), and only for worlds that have them.
--
--   world_config_geometries   the district geometry of each ACCEPTED configuration version, written
--                             with its verdict: what that version would draw;
--   world_geometry_freezes    for a world with properties, the geometry that governed its first
--                             one. From then on every property stands on it and every governing
--                             version draws exactly it;
--   world_properties          + the original activator (Core user id, Discord user id), copied from
--                             the activating play session in the activation's own transaction.
--
-- Why the geometry no longer freezes at founding. Until a property exists, no plot id names any
-- ground, so an admin may change a city's district count, order and wedges (by a new Play
-- configuration version) without moving anything. Founding still records its foundation (layout,
-- districts, collections) in `city.initialized`, unchanged: that stays the founding PROVENANCE, and
-- its collections stay the ones every version must keep. Configuration verdicts recorded before
-- this migration (judge world-evolution-v2, which required the founding geometry) are not
-- revisited: a version rejected then stays rejected, and a corrected configuration arrives as a new
-- Play version, judged by the current rules.
--
-- Constraints in this file are permanent (migrations never drop one), so table CHECKs state only
-- shape. Rules that are policy live in guard functions, which a later migration can replace.

-- Creating triggers and foreign keys on city, city_events, worlds, world_config_versions and
-- world_config_adoptions takes brief locks on live tables. If one cannot be had quickly, fail and
-- roll back rather than queue readers behind this migration; the deploy can simply be run again.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- The shape of a stored district geometry
-- ---------------------------------------------------------------------------------------

-- A non-empty list of at most 64 objects, each exactly { "key": <permanent key>,
-- "geometryFingerprint": <lowercase hex SHA-256> }, no key twice: the engine's districts in
-- configuration order (src/brand/core/evolution.ts, `WorldGeometry`).
CREATE FUNCTION world_geometry_districts_ok(districts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(districts) = 'array'
     AND jsonb_array_length(districts) BETWEEN 1 AND 64
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(districts) AS d(v)
        WHERE jsonb_typeof(d.v) <> 'object'
           OR d.v - 'key' - 'geometryFingerprint' <> '{}'::jsonb
           OR jsonb_typeof(d.v -> 'key') IS DISTINCT FROM 'string'
           OR jsonb_typeof(d.v -> 'geometryFingerprint') IS DISTINCT FROM 'string'
           OR NOT (d.v ->> 'key' ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(d.v ->> 'key') <= 32)
           OR NOT (d.v ->> 'geometryFingerprint' ~ '^[0-9a-f]{64}$'))
     AND (SELECT count(DISTINCT d.v ->> 'key') FROM jsonb_array_elements(districts) AS d(v)) = jsonb_array_length(districts)
$$;

-- ---------------------------------------------------------------------------------------
-- world_config_geometries: what each accepted configuration version would draw
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_config_geometries (
  world_id                     uuid        NOT NULL,
  version                      integer     NOT NULL,
  -- The engine's layout key and layout geometry fingerprint, and every district's key and geometry
  -- fingerprint in configuration order (src/world/definition.ts, GEOMETRY FINGERPRINTS).
  layout_key                   text        NOT NULL,
  layout_geometry_fingerprint  text        NOT NULL,
  districts                    jsonb       NOT NULL,
  -- What computed it: the judge that accepted the version, or this migration for a version accepted
  -- before it (whose judge required the founding geometry, so this records the founding geometry).
  recorded_by                  text        NOT NULL,
  recorded_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, version),
  -- Part of the version's copy: outside production a copy may be removed (0005), and its geometry goes with it.
  CONSTRAINT wcg_version               FOREIGN KEY (world_id, version) REFERENCES world_config_versions (world_id, version) ON DELETE CASCADE,
  CONSTRAINT wcg_layout_key_shape      CHECK (char_length(layout_key) <= 32 AND layout_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CONSTRAINT wcg_fingerprint_shape     CHECK (layout_geometry_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wcg_districts_shape       CHECK (world_geometry_districts_ok(districts)),
  CONSTRAINT wcg_recorded_by_shape     CHECK (char_length(recorded_by) BETWEEN 1 AND 100)
);

COMMENT ON TABLE world_config_geometries IS 'The district geometry each accepted configuration version of a world draws, recorded with its verdict. Immutable; in production never removed.';

-- Every version accepted before this migration was accepted by a judge that required the world's
-- founding geometry, and the service read it only if it still drew exactly that (0005, store.ts).
-- So its geometry is the foundation's, recorded in the world's `city.initialized` event.
INSERT INTO world_config_geometries (world_id, version, layout_key, layout_geometry_fingerprint, districts, recorded_by)
SELECT v.world_id, v.version,
       e.payload #>> '{world,foundation,layout,key}',
       e.payload #>> '{world,foundation,layout,geometryFingerprint}',
       e.payload #> '{world,foundation,districts}',
       'migration-0008-founding-geometry'
  FROM world_config_versions v
  JOIN worlds w ON w.id = v.world_id
  JOIN city_events e ON e.city_id = w.city_id AND e.sequence = 1 AND e.type = 'city.initialized'
 WHERE v.verdict = 'accepted';

-- A geometry is recorded once, for an accepted version of its world, and never changed; outside
-- production it may be removed with its version (0005 lets a non-production copy go).
CREATE FUNCTION world_config_geometries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a configuration version''s geometry is permanent: it cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF rc_database_is_production() THEN
      RAISE EXCEPTION 'a configuration version''s geometry is permanent: a production copy cannot be removed';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM world_config_versions v WHERE v.world_id = NEW.world_id AND v.version = NEW.version AND v.verdict = 'accepted') THEN
    RAISE EXCEPTION 'a geometry is recorded only for an accepted configuration version of its world';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_config_geometries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_config_geometries
  FOR EACH ROW EXECUTE FUNCTION world_config_geometries_guard();

-- Checked when the transaction commits: from now on an accepted version is never recorded without
-- the geometry it draws.
CREATE FUNCTION world_config_version_require_geometry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verdict = 'accepted' AND NOT EXISTS (SELECT 1 FROM world_config_geometries g WHERE g.world_id = NEW.world_id AND g.version = NEW.version) THEN
    RAISE EXCEPTION 'an accepted configuration version is recorded with its geometry (world_config_geometries)';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_config_version_require_geometry
  AFTER INSERT ON world_config_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_config_version_require_geometry();

-- ---------------------------------------------------------------------------------------
-- world_geometry_freezes: the geometry a world's first property froze
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_geometry_freezes (
  -- At most one per world, for good.
  world_id                     uuid        PRIMARY KEY REFERENCES worlds (id),
  city_id                      text        NOT NULL,
  -- The sequence the first property produced (always 2: sequence 1 is the founding).
  frozen_at_sequence           bigint      NOT NULL,
  -- The adoption and configuration version that governed that activation, and the geometry that
  -- version draws, copied from world_config_geometries.
  adoption_seq                 integer     NOT NULL,
  config_version               integer     NOT NULL,
  layout_key                   text        NOT NULL,
  layout_geometry_fingerprint  text        NOT NULL,
  districts                    jsonb       NOT NULL,
  -- 'first-property': written by the first activation, in its transaction. 'migration-0008': a
  -- world whose first property was placed before this migration, when geometry froze at founding.
  frozen_by                    text        NOT NULL,
  frozen_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wgf_event              FOREIGN KEY (city_id, frozen_at_sequence) REFERENCES city_events (city_id, sequence),
  CONSTRAINT wgf_adoption           FOREIGN KEY (world_id, adoption_seq) REFERENCES world_config_adoptions (world_id, adoption_seq),
  CONSTRAINT wgf_geometry           FOREIGN KEY (world_id, config_version) REFERENCES world_config_geometries (world_id, version),
  CONSTRAINT wgf_frozen_by_known    CHECK (frozen_by IN ('first-property', 'migration-0008')),
  CONSTRAINT wgf_layout_key_shape   CHECK (char_length(layout_key) <= 32 AND layout_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CONSTRAINT wgf_fingerprint_shape  CHECK (layout_geometry_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wgf_districts_shape    CHECK (world_geometry_districts_ok(districts))
);

COMMENT ON TABLE world_geometry_freezes IS 'The district geometry that governed a world''s first property. Every later property stands on it and every governing configuration draws it. Immutable and never removed, in every environment.';

-- Worlds whose first property was placed before this migration froze their geometry at founding,
-- and every property and governing version since stands on it (0007 required it). Record that.
INSERT INTO world_geometry_freezes (world_id, city_id, frozen_at_sequence, adoption_seq, config_version, layout_key, layout_geometry_fingerprint, districts, frozen_by, frozen_at)
SELECT p.world_id, p.city_id, p.activated_sequence, p.activated_adoption_seq, p.activated_config_version, g.layout_key, g.layout_geometry_fingerprint, g.districts, 'migration-0008', p.activated_at
  FROM world_properties p
  JOIN world_config_geometries g ON g.world_id = p.world_id AND g.version = p.activated_config_version
 WHERE p.activated_sequence = 2;

-- A freeze is written once, by the first activation of its world, in that activation's
-- transaction, between the event and the property (world/properties.ts), and never changed or
-- removed in any environment. It must be exactly what that activation stood on:
--   * the world's city has just advanced to sequence 2 (its first change) and is locked here, so a
--     configuration adoption either came first and is the governing one seen below, or waits;
--   * no property of the world exists yet;
--   * the event at that sequence is the `world.property.activated` the freeze names, under the same
--     adoption and version, on a district of this geometry;
--   * the adoption is the world's latest, and the geometry is exactly the one recorded for its version.
-- Only in a READ COMMITTED transaction, so "latest" is read after the lock, not from an older snapshot.
CREATE FUNCTION world_geometry_freezes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a world''s frozen district geometry is permanent: it cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a world''s frozen district geometry is permanent: it cannot be removed';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a world''s district geometry is frozen only in a READ COMMITTED transaction';
  END IF;
  IF NEW.frozen_by <> 'first-property' THEN
    RAISE EXCEPTION 'a world''s district geometry is frozen by its first property';
  END IF;

  PERFORM 1 FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = NEW.world_id AND c.id = NEW.city_id FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a freeze names its world and that world''s city (foreign key world_geometry_freezes -> worlds)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.frozen_at_sequence <> 2 OR NOT EXISTS (SELECT 1 FROM city c WHERE c.id = NEW.city_id AND c.sequence = NEW.frozen_at_sequence AND c.state_version = 2) THEN
    RAISE EXCEPTION 'a world''s district geometry is frozen by the activation that has just advanced its city to sequence 2';
  END IF;
  IF EXISTS (SELECT 1 FROM world_properties p WHERE p.world_id = NEW.world_id) THEN
    RAISE EXCEPTION 'a world''s district geometry is frozen with its first property, never after';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM city_events e
     WHERE e.city_id = NEW.city_id AND e.sequence = NEW.frozen_at_sequence AND e.type = 'world.property.activated'
       AND e.payload ->> 'adoption' = NEW.adoption_seq::text AND e.payload ->> 'configVersion' = NEW.config_version::text
       AND NEW.districts @> jsonb_build_array(jsonb_build_object('key', e.payload ->> 'districtKey', 'geometryFingerprint', e.payload ->> 'districtGeometryFingerprint'))
  ) THEN
    RAISE EXCEPTION 'a world''s district geometry is frozen by the world.property.activated event that stands on it, under the same configuration';
  END IF;
  IF ROW(NEW.adoption_seq, NEW.config_version) IS DISTINCT FROM
       (SELECT ROW(a.adoption_seq, a.version) FROM world_config_adoptions a WHERE a.world_id = NEW.world_id ORDER BY a.adoption_seq DESC LIMIT 1) THEN
    RAISE EXCEPTION 'a world''s district geometry is frozen under the configuration version that governs it';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM world_config_geometries g
     WHERE g.world_id = NEW.world_id AND g.version = NEW.config_version
       AND g.layout_key = NEW.layout_key AND g.layout_geometry_fingerprint = NEW.layout_geometry_fingerprint AND g.districts = NEW.districts
  ) THEN
    RAISE EXCEPTION 'a world''s frozen district geometry is exactly the geometry recorded for its governing version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_geometry_freezes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_geometry_freezes
  FOR EACH ROW EXECUTE FUNCTION world_geometry_freezes_guard();

-- Checked when the transaction commits: a freeze never outlives a rolled-back or abandoned
-- activation; it commits only with the property at its sequence.
CREATE FUNCTION world_geometry_freeze_require_property() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM world_properties p WHERE p.world_id = NEW.world_id AND p.activated_sequence = NEW.frozen_at_sequence) THEN
    RAISE EXCEPTION 'a world''s district geometry is frozen only together with its first property';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_geometry_freeze_require_property
  AFTER INSERT ON world_geometry_freezes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_geometry_freeze_require_property();

-- Once a world's geometry is frozen, a configuration version can come to govern it only if it draws
-- exactly that geometry; presentation and added collections are untouched by this. The world's city
-- row is locked first (the lock its first activation holds), so an adoption racing that activation
-- either came first, and the activation froze the geometry it adopted, or waits and sees the freeze.
-- Named to fire after world_config_adoptions_guard (0005), whose refusals are reported first.
CREATE FUNCTION world_config_adoptions_keep_frozen_geometry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = NEW.world_id FOR UPDATE OF c;
  IF EXISTS (SELECT 1 FROM world_geometry_freezes f WHERE f.world_id = NEW.world_id)
     AND NOT EXISTS (
       SELECT 1 FROM world_geometry_freezes f
         JOIN world_config_geometries g ON g.world_id = f.world_id AND g.version = NEW.version
        WHERE f.world_id = NEW.world_id
          AND g.layout_key = f.layout_key AND g.layout_geometry_fingerprint = f.layout_geometry_fingerprint AND g.districts = f.districts
     ) THEN
    RAISE EXCEPTION 'a world whose district geometry is frozen adopts only a configuration version that draws exactly that geometry';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_config_adoptions_keep_frozen_geometry
  BEFORE INSERT ON world_config_adoptions
  FOR EACH ROW EXECUTE FUNCTION world_config_adoptions_keep_frozen_geometry();

-- ---------------------------------------------------------------------------------------
-- world_properties: the original activator, for good
-- ---------------------------------------------------------------------------------------

-- The player who originally activated the property, as Proofy named them for the activating play
-- session (0006): Play's redeemed run, signed by Proofy Core. Never supplied by a browser, never
-- changed, and not the NFT's current holder (nothing here tracks that). A session is tidied after
-- its retention; these columns are not, so who activated a property outlives every session.
-- Properties written before this migration have none (only a local database could hold one).
ALTER TABLE world_properties
  ADD COLUMN activator_core_user_id    text,
  ADD COLUMN activator_discord_user_id text;

ALTER TABLE world_properties
  ADD CONSTRAINT wp_activator_shape CHECK (
    (activator_core_user_id IS NULL) = (activator_discord_user_id IS NULL)
    AND (activator_core_user_id IS NULL OR (activator_core_user_id ~ '^[A-Za-z0-9_-]{1,64}$' AND activator_discord_user_id ~ '^[0-9]{15,25}$'))
  );

-- Every property written from now on names its original activator. NOT VALID: enforced for every
-- new row, and not asserted of the rows written before this migration.
ALTER TABLE world_properties
  ADD CONSTRAINT wp_activator_required CHECK (activator_core_user_id IS NOT NULL AND activator_discord_user_id IS NOT NULL) NOT VALID;

COMMENT ON COLUMN world_properties.activator_core_user_id IS 'Original activator: the Proofy Core user id of the activating play session. Permanent; not the current NFT holder.';
COMMENT ON COLUMN world_properties.activator_discord_user_id IS 'Original activator: the Discord user id of the activating play session. Permanent; not the current NFT holder.';

-- ---------------------------------------------------------------------------------------
-- world_properties_guard, replaced: the frozen geometry and the original activator
-- ---------------------------------------------------------------------------------------

-- As in 0007 (every rule kept, including the hold: only a LOCAL database may hold a world property
-- until live player mutations are authorized), with two changes:
--   * a property stands on the geometry its world FROZE (world_geometry_freezes), not on the one it
--     was founded on. The first property's freeze is written just before it, in its transaction;
--   * its original activator is exactly the player of the live play session that activates it,
--     read from that session's row, which is locked until this transaction ends.
-- Only in a READ COMMITTED transaction, so the latest adoption is read as of now.
CREATE OR REPLACE FUNCTION world_properties_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  building json;
  asset text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a world property is permanent: it cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a world property is permanent: it cannot be removed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'world properties are not enabled in this database: only a local database may hold one until live player mutations are authorized';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a world property is activated only in a READ COMMITTED transaction';
  END IF;
  IF NEW.standard <> 'erc721' THEN
    RAISE EXCEPTION 'a world property is an ERC-721 NFT';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM worlds w WHERE w.id = NEW.world_id AND w.city_id = NEW.city_id AND w.city_instance_id = NEW.city_instance_id) THEN
    RAISE EXCEPTION 'a world property belongs to its world''s own city (foreign key world_properties -> worlds)' USING ERRCODE = 'foreign_key_violation';
  END IF;

  asset := NEW.chain || '/' || NEW.standard || ':' || NEW.contract || '/' || NEW.token_id;
  IF NEW.id IS DISTINCT FROM world_property_id_v2(NEW.world_id, asset) THEN
    RAISE EXCEPTION 'a world property id is the V2 property id of its world and NFT';
  END IF;

  SELECT c.state -> 'buildings' -> NEW.building_id INTO building
    FROM city c
   WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND c.sequence = NEW.activated_sequence AND c.state_version = 2;
  IF building IS NULL
     OR building ->> 'propertyId' IS DISTINCT FROM NEW.id::text
     OR building ->> 'asset' IS DISTINCT FROM asset
     OR building ->> 'collection' IS DISTINCT FROM NEW.collection_key
     OR building ->> 'districtKey' IS DISTINCT FROM NEW.district_key
     OR building ->> 'ward' IS DISTINCT FROM NEW.ward::text
     OR building ->> 'plot' IS DISTINCT FROM NEW.plot::text
     OR building ->> 'sequence' IS DISTINCT FROM NEW.activated_sequence::text THEN
    RAISE EXCEPTION 'a world property must be the building its city has just recorded, at the sequence it has just reached';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM city_events e
     WHERE e.city_id = NEW.city_id AND e.sequence = NEW.activated_sequence AND e.type = 'world.property.activated'
       AND e.payload ->> 'propertyId' = NEW.id::text AND e.payload ->> 'plotId' = NEW.plot_id AND e.payload ->> 'asset' = asset
       AND e.payload ->> 'configVersion' = NEW.activated_config_version::text AND e.payload ->> 'adoption' = NEW.activated_adoption_seq::text
       AND e.payload ->> 'districtGeometryFingerprint' = NEW.district_geometry_fingerprint
  ) THEN
    RAISE EXCEPTION 'a world property must be recorded by a world.property.activated event at the sequence its city has just reached';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM world_geometry_freezes f
     WHERE f.world_id = NEW.world_id
       AND f.districts @> jsonb_build_array(jsonb_build_object('key', NEW.district_key, 'geometryFingerprint', NEW.district_geometry_fingerprint))
  ) THEN
    RAISE EXCEPTION 'a world property stands on a district with the geometry its world froze at its first property';
  END IF;

  IF ROW(NEW.activated_adoption_seq, NEW.activated_config_version) IS DISTINCT FROM
       (SELECT ROW(a.adoption_seq, a.version) FROM world_config_adoptions a WHERE a.world_id = NEW.world_id ORDER BY a.adoption_seq DESC LIMIT 1)
     OR NOT EXISTS (SELECT 1 FROM world_config_versions v WHERE v.world_id = NEW.world_id AND v.version = NEW.activated_config_version AND v.verdict = 'accepted') THEN
    RAISE EXCEPTION 'a world property is activated under the configuration version that governs its world';
  END IF;

  PERFORM 1 FROM play_sessions s
    WHERE s.id = NEW.activated_in_play_session AND s.world_id = NEW.world_id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a world property is activated only in a live play session of its world';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM play_sessions s
     WHERE s.id = NEW.activated_in_play_session AND s.core_user_id = NEW.activator_core_user_id AND s.discord_user_id = NEW.activator_discord_user_id
  ) THEN
    RAISE EXCEPTION 'a world property''s original activator is the player of the play session that activates it';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0007)
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY[
    'world_geometry_districts_ok(jsonb)', 'world_config_geometries_guard()', 'world_config_version_require_geometry()', 'world_geometry_freezes_guard()',
    'world_geometry_freeze_require_property()', 'world_config_adoptions_keep_frozen_geometry()', 'world_properties_guard()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- A runtime role that does not own these tables needs, beyond 0005 to 0007:
--   recording a configuration version   INSERT on world_config_geometries;
--   adopting one                        SELECT on world_geometry_freezes and world_config_geometries
--                                       (and the city row lock, UPDATE on a column of city, which it has);
--   activating a property               INSERT on world_geometry_freezes, SELECT on world_config_geometries,
--                                       world_geometry_freezes and world_properties.
-- Never grant UPDATE or DELETE on world_geometry_freezes or world_properties.
--
-- Not here, on purpose:
--   * closing and re-opening a collection to new claims (locked policy): it needs an explicit field
--     in Play's configuration contract, which does not exist yet (e2e-city-play/README.md);
--   * the NFT's current holder, or any transfer of a property;
--   * district tickets, turns or any allocation.
