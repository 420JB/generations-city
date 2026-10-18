-- World properties: the permanent record of an NFT placed on one exact plot of a brand world's
-- city, and the rules that keep a world's city, its events and those records in step.
--
-- Why a new table. The Rare Friends `properties` table (0004) cannot hold a brand world's
-- property: its CHECKs pin one chain and one contract, Rare Friends family geography and token
-- ids below 2^53, it requires an EIP-712 activation intent of a wallet session, and 0005 refuses
-- it for every world's city. A brand world needs other permanent facts: any number of
-- collections and chains, uint256 token ids, V2 property ids, district keys from configuration
-- and the Play session that asked. Its uniqueness (one property per NFT per world, one per plot)
-- must be the database's, not only the service's.
--
-- Structure only. Nothing here creates a property, advances a city or changes an existing row:
-- the Rare Friends city, its properties, eras, intents and events, every world and its city,
-- bindings, configuration copies, adoptions and play sessions are left exactly as they are. No
-- route writes these tables; only an internal service (server/src/world/properties.ts) does,
-- and only in a local database (world_properties_guard, below), until the live-mutation gates
-- recorded in e2e-city-play/README.md are closed.
--
-- Constraints in this file are permanent (migrations never drop one), so table CHECKs state only
-- shape. Rules that are policy (which databases may hold properties, which token standard, how a
-- district's geometry is judged, what authorizes an activation) live in guard functions, which a
-- later migration can replace.

-- Creating triggers and foreign keys on city, city_events, worlds and play_sessions takes brief
-- locks on live tables. If one cannot be had quickly, fail and roll back rather than queue
-- readers behind this migration; the deploy can simply be run again.
SET LOCAL lock_timeout = '10s';

-- Lets a property name its world, the world's city and that city's exact installation together,
-- so it can never sit in another world's city. The primary key already makes these unique; this
-- states it in the form a foreign key needs. No row changes.
ALTER TABLE worlds ADD CONSTRAINT worlds_city_scope UNIQUE (id, city_id, city_instance_id);

-- ---------------------------------------------------------------------------------------
-- The V2 property id, as the engine derives it (src/world/property.ts)
-- ---------------------------------------------------------------------------------------

-- uuidV8(SHA-256("proofy-world:property:v2|world=<world uuid>|asset=<CAIP-19 asset id>")):
-- the first 16 bytes, version nibble 8, RFC variant bits. Pinned by the engine's golden vector
-- (server/tests/worldProperties.db.test.ts).
CREATE FUNCTION world_property_id_v2(world uuid, asset text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (substr(h, 1, 12) || '8' || substr(h, 14, 3)
          || substr('89ab', ((position(substr(h, 17, 1) IN '0123456789abcdef') - 1) & 3) + 1, 1)
          || substr(h, 18, 15))::uuid
    FROM (SELECT encode(sha256(convert_to('proofy-world:property:v2|world=' || world::text || '|asset=' || asset, 'UTF8')), 'hex') AS h) AS digest
$$;

-- ---------------------------------------------------------------------------------------
-- world_properties: one permanent property per NFT per world
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_properties (
  -- The V2 property id of (world, NFT). Derived, never chosen: see world_properties_guard.
  id                             uuid        PRIMARY KEY,
  world_id                       uuid        NOT NULL,
  city_id                        text        NOT NULL,
  city_instance_id               uuid        NOT NULL,
  -- The NFT, canonically: CAIP-2 chain, token standard, lowercase contract, decimal token id.
  chain                          text        NOT NULL,
  standard                       text        NOT NULL,
  contract                       text        NOT NULL,
  -- Text, not numeric: a uint256 in its one canonical decimal spelling, whole range.
  token_id                       text        NOT NULL,
  -- The world collection key the NFT was activated under (a key names one contract for good, 0005/evolution).
  collection_key                 text        NOT NULL,
  -- The exact plot, as the player chose it.
  district_key                   text        NOT NULL,
  ward                           integer     NOT NULL,
  plot                           integer     NOT NULL,
  plot_id                        text        NOT NULL,
  -- The key of this property's building in city.state.buildings.
  building_id                    text        NOT NULL,
  -- The engine's geometry fingerprint of the district when the property was placed: what proves,
  -- later, that the plot id still names the same ground.
  district_geometry_fingerprint  text        NOT NULL,
  -- ORIGINAL PROVENANCE, permanent. The city sequence this activation produced and its event,
  -- the adoption that governed the world then and its configuration version, the Play session
  -- that asked, and when. (The adoption, not a timestamp, is what orders an activation against
  -- configuration changes: both queue on the city's lock, but their timestamps are when each
  -- transaction began.)
  activated_sequence             bigint      NOT NULL,
  activated_adoption_seq         integer     NOT NULL,
  activated_config_version       integer     NOT NULL,
  -- An identifier only: sessions are tidied after their retention, and this then names a session
  -- that no longer exists. No player identity is stored here (see the end of this file).
  activated_in_play_session      uuid        NOT NULL,
  activated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wp_world_city          FOREIGN KEY (world_id, city_id, city_instance_id) REFERENCES worlds (id, city_id, city_instance_id),
  CONSTRAINT wp_event               FOREIGN KEY (city_id, activated_sequence) REFERENCES city_events (city_id, sequence),
  CONSTRAINT wp_config_version      FOREIGN KEY (world_id, activated_config_version) REFERENCES world_config_versions (world_id, version),
  CONSTRAINT wp_adoption            FOREIGN KEY (world_id, activated_adoption_seq) REFERENCES world_config_adoptions (world_id, adoption_seq),
  -- One property per NFT in a world. (The id already implies it; this says it in the NFT's own terms.)
  CONSTRAINT wp_one_per_asset       UNIQUE (world_id, chain, standard, contract, token_id),
  -- One property per plot.
  CONSTRAINT wp_one_per_plot        UNIQUE (world_id, plot_id),
  CONSTRAINT wp_one_building        UNIQUE (world_id, building_id),
  -- One activation per city sequence.
  CONSTRAINT wp_one_per_sequence    UNIQUE (city_id, activated_sequence),
  CONSTRAINT wp_chain_shape         CHECK (chain ~ '^eip155:[1-9][0-9]{0,15}$'),
  CONSTRAINT wp_standard_shape      CHECK (standard ~ '^[a-z][a-z0-9]{1,15}$'),
  CONSTRAINT wp_contract_shape      CHECK (contract ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT wp_token_shape         CHECK (token_id ~ '^(0|[1-9][0-9]{0,77})$'
                                           AND token_id::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  CONSTRAINT wp_collection_key_shape CHECK (char_length(collection_key) <= 32 AND collection_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CONSTRAINT wp_district_key_shape  CHECK (char_length(district_key) <= 32 AND district_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CONSTRAINT wp_plot_shape          CHECK (ward BETWEEN 0 AND 999999 AND plot BETWEEN 0 AND 999999 AND plot_id = district_key || '-w' || ward || '-p' || plot),
  CONSTRAINT wp_building_shape      CHECK (building_id = 'b-' || id::text),
  CONSTRAINT wp_fingerprint_shape   CHECK (district_geometry_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wp_sequence_after_founding CHECK (activated_sequence >= 2),
  CONSTRAINT wp_config_version_positive CHECK (activated_config_version >= 1),
  CONSTRAINT wp_adoption_positive   CHECK (activated_adoption_seq >= 1)
);

COMMENT ON TABLE world_properties IS 'Permanent property identity and location in a brand world, one per NFT per world. Immutable and never removed, in every environment. The world''s city state projects it as a building.';

-- A world property is written once, as the change its city has just made, and never changed or
-- removed in any environment: like the world it belongs to, it must outlive everything.
--
-- An insert must be exactly the activation the city's state and event at that sequence record:
--   * the database is a LOCAL one. Policy, and the hold this slice ships with: no staging or
--     production database can hold a world property until a later migration replaces this
--     function, once the Core/Play gates for live player mutations exist;
--   * the city is this world's city, at exactly the sequence the property names (just advanced),
--     holding version 2 state whose building `building_id` is this property on this plot;
--   * the event at that sequence is `world.property.activated` for this property, plot and version;
--   * the id is the V2 property id of (world, NFT), and the standard is ERC-721;
--   * the district's geometry fingerprint is the one the world was founded on (the current rule:
--     district geometry is fixed when a world is founded; a later policy may judge it otherwise);
--   * the adoption is the world's latest, and the configuration version is the one it adopted;
--   * the Play session that asked is live and belongs to this world's binding. It is locked
--     until this transaction ends, so a sign-out either came first and is seen here, or waits.
-- Every rule requires the row it depends on to be there; none is left to a foreign key, which is
-- only checked when the statement ends. Time is this database's clock.
CREATE FUNCTION world_properties_guard() RETURNS trigger
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
    SELECT 1 FROM city_events e
     WHERE e.city_id = NEW.city_id AND e.sequence = 1 AND e.type = 'city.initialized'
       AND (e.payload -> 'world' -> 'foundation' -> 'districts') @> jsonb_build_array(jsonb_build_object('key', NEW.district_key, 'geometryFingerprint', NEW.district_geometry_fingerprint))
  ) THEN
    RAISE EXCEPTION 'a world property stands on a district with the geometry its world was founded on';
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_properties_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_properties
  FOR EACH ROW EXECUTE FUNCTION world_properties_guard();

-- ---------------------------------------------------------------------------------------
-- A world's city advances only by activating a property
-- ---------------------------------------------------------------------------------------

-- Checked when the transaction commits, for every update that advanced a world's city: the
-- sequence it reached is explained by a `world.property.activated` event and the property that
-- event records, and the state it holds is version 2. So a world's city is never left advanced
-- without its property, and since a property can only be written in a local database (above),
-- no other database's world city can advance at all. The Rare Friends city is not a world and is
-- not affected.
CREATE FUNCTION world_city_require_property() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sequence = OLD.sequence OR NOT EXISTS (SELECT 1 FROM worlds w WHERE w.city_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM city_events e WHERE e.city_id = NEW.id AND e.sequence = NEW.sequence AND e.type = 'world.property.activated')
     OR NOT EXISTS (SELECT 1 FROM world_properties p WHERE p.city_id = NEW.id AND p.activated_sequence = NEW.sequence) THEN
    RAISE EXCEPTION 'a world''s city advances only by activating a property: sequence % has no world.property.activated event and property', NEW.sequence;
  END IF;
  IF NEW.state_version <> 2 THEN
    RAISE EXCEPTION 'a world''s city with properties holds state version 2';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_city_require_property
  AFTER UPDATE ON city
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_city_require_property();

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004, 0005)
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY['world_property_id_v2(uuid, text)', 'world_properties_guard()', 'world_city_require_property()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- A runtime role that does not own these tables needs, to activate a property: UPDATE on city
-- (it advances the city, and already locks it), INSERT on city_events and world_properties, and
-- SELECT on app_meta, worlds, city, city_events, world_config_versions, world_config_adoptions and
-- play_sessions; the session row lock (FOR SHARE) needs UPDATE on one column of play_sessions,
-- which UPDATE (revoked_at) already is. Never grant UPDATE or DELETE on world_properties.
--
-- Not here, on purpose, because each waits on a decision or a contract that does not exist yet:
--   * who owns a property, or a durable player identity on it (only the session id is kept);
--   * evidence that the player held the NFT or met a district's Proofy rule when it was placed;
--   * district tickets, turns or any allocation; points, building progress or any economy.
