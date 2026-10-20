-- District tickets (owner-locked rule, MCD 46A/46B): a player who enters a brand world's city is
-- given a PROVISIONAL district at once, from one citywide round-robin rotation per world shared by
-- every collection; many players hold tickets at the same time; a released, expired or superseded
-- slot is reused by the next entrant, oldest (lowest ordinal) first; and only a successful
-- activation consumes a ticket, in the activation's own transaction.
--
-- Additive. Three new tables and their guards, and two commit-time checks on existing tables
-- (world_config_adoptions, world_properties) that only ever look at worlds that have a rotation.
-- No existing row is changed or written: the Rare Friends city and its tables, every world, city,
-- event, binding, play session, configuration copy, geometry, freeze, adoption and property is left
-- exactly as it is. A world gets a rotation only when a player first enters it through a build that
-- issues tickets.
--
--   world_assignment_rotations  one per world: the rotation's district order and the governing
--                               configuration it follows, its epoch, the durable HIGH-WATER ordinal
--                               (provisional allocations ever made) and the COMMITTED count
--                               (activations that consumed a ticket). Never the same number.
--   world_assignment_slots      one per ordinal ever issued: its district, the generation of its
--                               latest issuance, and whether it is held, free (the gap pool),
--                               consumed by a property, or retired (an older epoch's district order).
--   world_district_tickets      every issuance, for good: world, installation, actor, district,
--                               ordinal and generation (fallback) or NFT and rule (explicit rule),
--                               the governing configuration version, hash and geometry it was issued
--                               on, its status and lifetime, and the property it became, if any.
--
-- LOCAL ONLY, like world properties (0007): issuance needs fixtures that stand in for Proofy Core
-- eligibility, so no staging or production database may hold a rotation, slot or ticket until a
-- later migration replaces these guards, once a verified eligibility contract exists.
--
-- Nothing here advances a city, writes an event or a property: a provisional assignment is not
-- permanent history (46B). The ticket a property consumed is linked to it after the fact.
--
-- Constraints in this file are permanent (migrations never drop one), so table CHECKs state only
-- shape. Rules that are policy live in guard functions, which a later migration can replace.

-- Creating triggers and foreign keys on worlds, world_play_bindings, world_config_geometries,
-- world_config_adoptions and world_properties takes brief locks on live tables. If one cannot be
-- had quickly, fail and roll back rather than queue readers behind this migration.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- Shapes
-- ---------------------------------------------------------------------------------------

-- A rotation's district order: at most 64 distinct permanent district keys, possibly none (every
-- district of the configuration has a Proofy rule, so there is no default district to assign).
CREATE FUNCTION world_rotation_districts_ok(districts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(districts) = 'array'
     AND jsonb_array_length(districts) <= 64
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(districts) AS d(v)
        WHERE jsonb_typeof(d.v) <> 'string' OR NOT (d.v #>> '{}' ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(d.v #>> '{}') <= 32))
     AND (SELECT count(DISTINCT d.v) FROM jsonb_array_elements(districts) AS d(v)) = jsonb_array_length(districts)
$$;

-- The district a rotation's ordinal names: positions count from the epoch's first ordinal.
CREATE FUNCTION world_rotation_district(districts jsonb, epoch_start bigint, ordinal bigint) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN jsonb_array_length(districts) = 0 OR ordinal < epoch_start THEN NULL
              ELSE districts ->> ((ordinal - epoch_start) % jsonb_array_length(districts))::integer END
$$;

-- ---------------------------------------------------------------------------------------
-- world_assignment_rotations: one default assignment rotation per world
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_assignment_rotations (
  world_id                     uuid        PRIMARY KEY REFERENCES worlds (id),
  -- Bumped when the rotation's district order or geometry changes (before a world's first property
  -- an admin may redraw its districts). Every active ticket of the old epoch is superseded first.
  epoch                        integer     NOT NULL,
  -- The first ordinal of this epoch: ordinal n names districts[(n - epoch_start_ordinal) mod length].
  epoch_start_ordinal          bigint      NOT NULL,
  -- The next ordinal to issue: every ordinal below it has a slot. Never decreases.
  high_water                   bigint      NOT NULL,
  -- Tickets consumed by a successful activation. Separate from the high-water mark, never a cursor.
  committed_count              bigint      NOT NULL,
  -- The governing configuration the rotation follows (the world's latest adoption), its hash, its
  -- layout geometry fingerprint, and the default districts in configuration order.
  basis_config_version         integer     NOT NULL,
  basis_config_hash            text        NOT NULL,
  layout_geometry_fingerprint  text        NOT NULL,
  districts                    jsonb       NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT war_basis              FOREIGN KEY (world_id, basis_config_version) REFERENCES world_config_geometries (world_id, version),
  CONSTRAINT war_epoch_positive     CHECK (epoch >= 1),
  -- The committed count is not bounded by the high-water mark: a rule ticket is committed without a rotation ordinal.
  CONSTRAINT war_ordinals           CHECK (epoch_start_ordinal >= 0 AND high_water >= epoch_start_ordinal AND committed_count >= 0),
  CONSTRAINT war_hash_shape         CHECK (basis_config_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT war_fingerprint_shape  CHECK (layout_geometry_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT war_districts_shape    CHECK (world_rotation_districts_ok(districts))
);

COMMENT ON TABLE world_assignment_rotations IS 'The citywide round-robin default district rotation of a brand world (MCD 46B): high-water ordinal, epoch and governing basis. LOCAL ONLY until a verified eligibility contract exists.';

-- ---------------------------------------------------------------------------------------
-- world_assignment_slots: every ordinal issued, and whether it is held, free, consumed or retired
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_assignment_slots (
  world_id      uuid        NOT NULL REFERENCES world_assignment_rotations (world_id),
  ordinal       bigint      NOT NULL,
  epoch         integer     NOT NULL,
  district_key  text        NOT NULL,
  -- The generation of the slot's latest issuance: 1 when first issued, +1 on each reissue from the gap pool.
  generation    integer     NOT NULL,
  -- held: its latest issuance is an active ticket. free: in the gap pool. consumed: a property took it.
  -- retired: its epoch's district order no longer governs, so it is never issued again.
  state         text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, ordinal),
  CONSTRAINT was_ordinal_shape     CHECK (ordinal >= 0 AND epoch >= 1 AND generation >= 1),
  CONSTRAINT was_state_known       CHECK (state IN ('held', 'free', 'consumed', 'retired')),
  CONSTRAINT was_district_shape    CHECK (char_length(district_key) <= 32 AND district_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')
);

-- The gap pool, oldest (lowest ordinal) first.
CREATE INDEX world_assignment_slots_free ON world_assignment_slots (world_id, ordinal) WHERE state = 'free';

COMMENT ON TABLE world_assignment_slots IS 'Every default-rotation ordinal issued in a brand world, with its district, latest generation and state (held, free gap, consumed, retired). LOCAL ONLY.';

-- ---------------------------------------------------------------------------------------
-- world_district_tickets: every provisional assignment, for good
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_district_tickets (
  -- The ticket's nonce: a page names it to activate. A reissued slot is a new ticket, a new id.
  id                             uuid        PRIMARY KEY,
  world_id                       uuid        NOT NULL,
  -- The installation the ticket was issued through: the world's own binding, whole.
  play_environment               text        NOT NULL,
  play_game_key                  text        NOT NULL,
  play_installation_id           uuid        NOT NULL,
  discord_guild_id               text        NOT NULL,
  -- The actor, as Proofy named the issuing play session's player (0006). Never from a browser.
  actor_discord_user_id          text        NOT NULL,
  actor_core_user_id             text        NOT NULL,
  -- An identifier only (sessions are tidied after their retention): provenance, not a reference.
  issued_in_play_session         uuid        NOT NULL,
  -- fallback: a slot of the default rotation. rule: an explicit collection/trait rule's district for one NFT.
  kind                           text        NOT NULL,
  district_key                   text        NOT NULL,
  district_geometry_fingerprint  text        NOT NULL,
  epoch                          integer     NOT NULL,
  ordinal                        bigint,
  generation                     integer,
  asset                          text,
  rule_ref                       text,
  -- The governing configuration it was issued on (the rotation's basis then).
  config_version                 integer     NOT NULL,
  config_hash                    text        NOT NULL,
  layout_geometry_fingerprint    text        NOT NULL,
  status                         text        NOT NULL,
  issued_at                      timestamptz NOT NULL,
  expires_at                     timestamptz NOT NULL,
  ended_at                       timestamptz,
  end_reason                     text,
  -- The property a committed ticket became, and the city sequence that activation produced.
  property_id                    uuid,
  committed_sequence             bigint,
  -- A ticket superseded by a change of the rotation is reissued, in its old order, as this one.
  reissued_from                  uuid,
  CONSTRAINT wdt_binding            FOREIGN KEY (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id)
                                    REFERENCES world_play_bindings (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id),
  CONSTRAINT wdt_rotation           FOREIGN KEY (world_id) REFERENCES world_assignment_rotations (world_id),
  CONSTRAINT wdt_slot               FOREIGN KEY (world_id, ordinal) REFERENCES world_assignment_slots (world_id, ordinal),
  CONSTRAINT wdt_config             FOREIGN KEY (world_id, config_version) REFERENCES world_config_geometries (world_id, version),
  CONSTRAINT wdt_property           FOREIGN KEY (property_id) REFERENCES world_properties (id),
  CONSTRAINT wdt_reissued_from      FOREIGN KEY (reissued_from) REFERENCES world_district_tickets (id),
  -- One issuance per slot generation: a stale generation can never be issued again.
  CONSTRAINT wdt_one_per_generation UNIQUE (world_id, ordinal, generation),
  CONSTRAINT wdt_kind_shape         CHECK ((kind = 'fallback' AND ordinal IS NOT NULL AND generation IS NOT NULL AND asset IS NULL AND rule_ref IS NULL)
                                        OR (kind = 'rule' AND ordinal IS NULL AND generation IS NULL AND asset IS NOT NULL AND rule_ref IS NOT NULL)),
  CONSTRAINT wdt_status_known       CHECK (status IN ('active', 'released', 'expired', 'superseded', 'committed')),
  CONSTRAINT wdt_end_shape          CHECK ((status = 'active') = (ended_at IS NULL) AND (status = 'active') = (end_reason IS NULL)
                                        AND (end_reason IS NULL OR (status, end_reason) IN (('released', 'cancel'), ('released', 'reassigned'), ('expired', 'expired'), ('superseded', 'rotation_changed'), ('committed', 'activated')))),
  CONSTRAINT wdt_committed_shape    CHECK ((status = 'committed') = (property_id IS NOT NULL) AND (property_id IS NULL) = (committed_sequence IS NULL)),
  -- A bounded lease: never longer than an hour.
  CONSTRAINT wdt_lifetime           CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '1 hour'),
  CONSTRAINT wdt_environment_known  CHECK (play_environment IN ('dev', 'test', 'staging', 'live')),
  CONSTRAINT wdt_actor_shape        CHECK (actor_discord_user_id ~ '^[0-9]{15,25}$' AND actor_core_user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT wdt_district_shape     CHECK (char_length(district_key) <= 32 AND district_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CONSTRAINT wdt_fingerprint_shape  CHECK (district_geometry_fingerprint ~ '^[0-9a-f]{64}$' AND layout_geometry_fingerprint ~ '^[0-9a-f]{64}$' AND config_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wdt_ordinal_shape      CHECK (epoch >= 1 AND (ordinal IS NULL OR ordinal >= 0) AND (generation IS NULL OR generation >= 1) AND config_version >= 1),
  CONSTRAINT wdt_asset_shape        CHECK (asset IS NULL OR (asset ~ '^eip155:[1-9][0-9]{0,15}/erc721:0x[0-9a-f]{40}/(0|[1-9][0-9]{0,77})$')),
  CONSTRAINT wdt_rule_shape         CHECK (rule_ref IS NULL OR (char_length(rule_ref) BETWEEN 1 AND 200 AND rule_ref ~ '^[a-z0-9][a-z0-9._-]*(,[a-z0-9][a-z0-9._-]*)*$'))
);

-- One active ticket per player per world, whatever its kind: no player holds two pending districts,
-- however often they log in, relaunch or reload.
CREATE UNIQUE INDEX world_district_tickets_one_active_per_actor ON world_district_tickets (world_id, actor_discord_user_id) WHERE status = 'active';
-- One active issuance per slot.
CREATE UNIQUE INDEX world_district_tickets_one_active_per_slot ON world_district_tickets (world_id, ordinal) WHERE status = 'active' AND ordinal IS NOT NULL;
-- A property consumes at most one ticket; a superseded ticket is reissued at most once.
CREATE UNIQUE INDEX world_district_tickets_one_per_property ON world_district_tickets (property_id) WHERE property_id IS NOT NULL;
CREATE UNIQUE INDEX world_district_tickets_one_reissue ON world_district_tickets (reissued_from) WHERE reissued_from IS NOT NULL;
CREATE INDEX world_district_tickets_expiry ON world_district_tickets (world_id, expires_at) WHERE status = 'active';

COMMENT ON TABLE world_district_tickets IS 'Provisional district assignments of a brand world (MCD 46B), for good: never a property, never city history. LOCAL ONLY until a verified eligibility contract exists.';

-- ---------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------

-- The rotation follows the governing configuration (the world's latest adoption), on the geometry
-- recorded for it, and its default districts are districts of that geometry. Its high-water mark
-- and committed count only grow, one at a time. A new epoch begins only when nothing of the old
-- one is still active or reusable, at the high-water mark, and never repeats or skips one.
CREATE FUNCTION world_assignment_rotations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  geometry record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a world''s assignment rotation is permanent: it cannot be removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'district tickets are not enabled in this database: only a local database may hold one until a verified eligibility contract exists';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a world''s assignment rotation changes only in a READ COMMITTED transaction';
  END IF;
  NEW.updated_at := clock_timestamp();

  IF TG_OP = 'INSERT' THEN
    IF NEW.epoch <> 1 OR NEW.epoch_start_ordinal <> 0 OR NEW.high_water <> 0 OR NEW.committed_count <> 0 THEN
      RAISE EXCEPTION 'a world''s assignment rotation starts at epoch 1, ordinal 0, with nothing committed';
    END IF;
  ELSE
    IF NEW.world_id IS DISTINCT FROM OLD.world_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a world''s assignment rotation keeps its world';
    END IF;
    IF NEW.high_water NOT IN (OLD.high_water, OLD.high_water + 1) OR NEW.committed_count NOT IN (OLD.committed_count, OLD.committed_count + 1) THEN
      RAISE EXCEPTION 'a rotation''s high-water mark and committed count only grow, one at a time';
    END IF;
    IF NEW.epoch <> OLD.epoch THEN
      IF NEW.epoch <> OLD.epoch + 1 OR NEW.epoch_start_ordinal <> OLD.high_water OR NEW.high_water <> OLD.high_water THEN
        RAISE EXCEPTION 'a rotation''s next epoch starts at its high-water mark';
      END IF;
      IF EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.world_id = NEW.world_id AND t.status = 'active')
         OR EXISTS (SELECT 1 FROM world_assignment_slots s WHERE s.world_id = NEW.world_id AND s.state IN ('held', 'free')) THEN
        RAISE EXCEPTION 'a rotation begins a new epoch only once every active ticket of the old one is superseded and every reusable slot retired';
      END IF;
    ELSIF NEW.epoch_start_ordinal <> OLD.epoch_start_ordinal OR NEW.layout_geometry_fingerprint <> OLD.layout_geometry_fingerprint OR NEW.districts <> OLD.districts THEN
      RAISE EXCEPTION 'a rotation changes its district order or geometry only by beginning a new epoch';
    END IF;
  END IF;

  IF NEW.basis_config_version IS DISTINCT FROM (SELECT a.version FROM world_config_adoptions a WHERE a.world_id = NEW.world_id ORDER BY a.adoption_seq DESC LIMIT 1)
     OR NOT EXISTS (SELECT 1 FROM world_config_versions v WHERE v.world_id = NEW.world_id AND v.version = NEW.basis_config_version AND v.verdict = 'accepted' AND v.config_hash = NEW.basis_config_hash) THEN
    RAISE EXCEPTION 'a world''s assignment rotation follows the configuration version that governs it';
  END IF;
  SELECT g.layout_geometry_fingerprint, g.districts INTO geometry FROM world_config_geometries g WHERE g.world_id = NEW.world_id AND g.version = NEW.basis_config_version;
  IF NOT FOUND OR geometry.layout_geometry_fingerprint <> NEW.layout_geometry_fingerprint
     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.districts) AS d(k) WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(geometry.districts) AS g(v) WHERE g.v ->> 'key' = d.k)) THEN
    RAISE EXCEPTION 'a world''s assignment rotation draws districts of its governing configuration''s geometry';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_assignment_rotations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_assignment_rotations
  FOR EACH ROW EXECUTE FUNCTION world_assignment_rotations_guard();

-- A slot is created by advancing the high-water mark, held, on the district its ordinal names in
-- the current epoch. After that it moves only: held -> free (its ticket ended without a property),
-- free -> held (reissued, next generation), held -> consumed (its ticket became a property), and
-- held or free -> retired (its epoch no longer governs). Consumed and retired are final.
CREATE FUNCTION world_assignment_slots_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rotation record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an assignment slot is permanent: it cannot be removed';
  END IF;
  SELECT r.epoch, r.epoch_start_ordinal, r.high_water, r.districts INTO rotation FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an assignment slot belongs to its world''s rotation (foreign key world_assignment_slots -> world_assignment_rotations)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.updated_at := clock_timestamp();

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'held' OR NEW.generation <> 1 OR NEW.epoch <> rotation.epoch OR NEW.ordinal <> rotation.high_water - 1
       OR NEW.district_key IS DISTINCT FROM world_rotation_district(rotation.districts, rotation.epoch_start_ordinal, NEW.ordinal) THEN
      RAISE EXCEPTION 'a new assignment slot is the ordinal just below the high-water mark, held, on the district its position in the current epoch names';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.world_id, NEW.ordinal, NEW.epoch, NEW.district_key) IS DISTINCT FROM ROW(OLD.world_id, OLD.ordinal, OLD.epoch, OLD.district_key) THEN
    RAISE EXCEPTION 'an assignment slot keeps its world, ordinal, epoch and district';
  END IF;
  IF OLD.state = 'held' AND NEW.state = 'free' AND NEW.generation = OLD.generation THEN
    IF EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.world_id = NEW.world_id AND t.ordinal = NEW.ordinal AND t.status = 'active') THEN
      RAISE EXCEPTION 'a slot returns to the gap pool only once its ticket has ended';
    END IF;
  ELSIF OLD.state = 'free' AND NEW.state = 'held' AND NEW.generation = OLD.generation + 1 THEN
    IF OLD.epoch <> rotation.epoch THEN
      RAISE EXCEPTION 'only a slot of the current epoch is reissued';
    END IF;
  ELSIF OLD.state = 'held' AND NEW.state = 'consumed' AND NEW.generation = OLD.generation THEN
    IF NOT EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.world_id = NEW.world_id AND t.ordinal = NEW.ordinal AND t.generation = NEW.generation AND t.status = 'committed') THEN
      RAISE EXCEPTION 'a slot is consumed only by the property its current generation''s ticket became';
    END IF;
  ELSIF OLD.state IN ('held', 'free') AND NEW.state = 'retired' AND NEW.generation = OLD.generation THEN
    -- That its epoch no longer governs is checked at commit (world_assignment_slot_retired_by_epoch).
    IF EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.world_id = NEW.world_id AND t.ordinal = NEW.ordinal AND t.status = 'active') THEN
      RAISE EXCEPTION 'a slot is retired only once its ticket has ended';
    END IF;
  ELSE
    RAISE EXCEPTION 'an assignment slot moves only held -> free -> held (next generation), held -> consumed, or held/free -> retired, not % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_assignment_slots_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_assignment_slots
  FOR EACH ROW EXECUTE FUNCTION world_assignment_slots_guard();

-- Checked when the transaction commits: a slot is retired only because its epoch no longer governs
-- (the rotation's next epoch, written in the same transaction, begins after it).
CREATE FUNCTION world_assignment_slot_retired_by_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'retired' AND NOT EXISTS (SELECT 1 FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id AND r.epoch > NEW.epoch) THEN
    RAISE EXCEPTION 'an assignment slot is retired only when its rotation has begun a later epoch';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_assignment_slot_retired_by_epoch
  AFTER UPDATE ON world_assignment_slots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_assignment_slot_retired_by_epoch();

-- A ticket is issued live, on the rotation as it governs now, to the player of a live play session
-- of its world (or, for a reissue after the rotation changed, to the holder of the ticket it
-- replaces, for no longer than that one had left). Its configuration, geometry and district are
-- exactly the rotation's basis and that basis's recorded geometry; a fallback ticket holds exactly
-- the current generation of its slot. After that it changes once, from active to how it ended:
--   released    by its holder (cancel), or replaced by another assignment of theirs (reassigned);
--   expired     only once its lease has run out, by this database's clock;
--   superseded  by a change of its rotation (checked at commit: the rotation has moved past its epoch);
--   committed   only while live, by the property it became: in its world, on its district and
--               geometry, at the sequence the city has just reached, activated by its holder, and,
--               for a rule ticket, its NFT.
-- Only in a READ COMMITTED transaction, so the rotation and the latest adoption are read as of now.
CREATE FUNCTION world_district_tickets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rotation record;
  source record;
  prop record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a district ticket is permanent provenance: it cannot be removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'district tickets are not enabled in this database: only a local database may hold one until a verified eligibility contract exists';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a district ticket changes only in a READ COMMITTED transaction';
  END IF;
  SELECT r.epoch, r.basis_config_version, r.basis_config_hash, r.layout_geometry_fingerprint INTO rotation FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a district ticket belongs to its world''s rotation (foreign key world_district_tickets -> world_assignment_rotations)' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.issued_at := clock_timestamp();
    IF NEW.status <> 'active' OR NEW.ended_at IS NOT NULL OR NEW.end_reason IS NOT NULL OR NEW.property_id IS NOT NULL OR NEW.committed_sequence IS NOT NULL THEN
      RAISE EXCEPTION 'a district ticket is issued active';
    END IF;
    IF NEW.expires_at <= NEW.issued_at THEN
      RAISE EXCEPTION 'a district ticket cannot be issued already expired';
    END IF;
    IF NEW.epoch <> rotation.epoch OR NEW.config_version <> rotation.basis_config_version OR NEW.config_hash <> rotation.basis_config_hash OR NEW.layout_geometry_fingerprint <> rotation.layout_geometry_fingerprint THEN
      RAISE EXCEPTION 'a district ticket is issued on its rotation as it governs now';
    END IF;
    IF NEW.config_version IS DISTINCT FROM (SELECT a.version FROM world_config_adoptions a WHERE a.world_id = NEW.world_id ORDER BY a.adoption_seq DESC LIMIT 1) THEN
      RAISE EXCEPTION 'a district ticket is issued under the configuration version that governs its world';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM world_config_geometries g
       WHERE g.world_id = NEW.world_id AND g.version = NEW.config_version
         AND g.districts @> jsonb_build_array(jsonb_build_object('key', NEW.district_key, 'geometryFingerprint', NEW.district_geometry_fingerprint))
    ) THEN
      RAISE EXCEPTION 'a district ticket names a district of its configuration''s geometry, with that geometry';
    END IF;
    IF NEW.kind = 'fallback' AND NOT EXISTS (
      SELECT 1 FROM world_assignment_slots s
       WHERE s.world_id = NEW.world_id AND s.ordinal = NEW.ordinal AND s.state = 'held' AND s.generation = NEW.generation AND s.epoch = NEW.epoch AND s.district_key = NEW.district_key
    ) THEN
      RAISE EXCEPTION 'a fallback ticket holds exactly the current generation of its slot';
    END IF;
    IF NEW.reissued_from IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM play_sessions s
         WHERE s.id = NEW.issued_in_play_session AND s.world_id = NEW.world_id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
           AND s.play_environment = NEW.play_environment AND s.play_game_key = NEW.play_game_key AND s.play_installation_id = NEW.play_installation_id AND s.discord_guild_id = NEW.discord_guild_id
           AND s.discord_user_id = NEW.actor_discord_user_id AND s.core_user_id = NEW.actor_core_user_id
      ) THEN
        RAISE EXCEPTION 'a district ticket is issued only to the player of a live play session of its world';
      END IF;
    ELSE
      SELECT t.world_id, t.kind, t.status, t.actor_discord_user_id, t.actor_core_user_id, t.issued_in_play_session, t.expires_at, t.epoch INTO source FROM world_district_tickets t WHERE t.id = NEW.reissued_from;
      IF NOT FOUND OR source.world_id <> NEW.world_id OR source.status <> 'superseded' OR source.kind <> NEW.kind OR source.epoch >= NEW.epoch
         OR source.actor_discord_user_id <> NEW.actor_discord_user_id OR source.actor_core_user_id <> NEW.actor_core_user_id
         OR source.issued_in_play_session <> NEW.issued_in_play_session OR NEW.expires_at > source.expires_at THEN
        RAISE EXCEPTION 'a reissued district ticket replaces a superseded ticket of the same holder, for no longer than it had';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.world_id, NEW.play_environment, NEW.play_game_key, NEW.play_installation_id, NEW.discord_guild_id, NEW.actor_discord_user_id, NEW.actor_core_user_id,
         NEW.issued_in_play_session, NEW.kind, NEW.district_key, NEW.district_geometry_fingerprint, NEW.epoch, NEW.ordinal, NEW.generation, NEW.asset, NEW.rule_ref,
         NEW.config_version, NEW.config_hash, NEW.layout_geometry_fingerprint, NEW.issued_at, NEW.expires_at, NEW.reissued_from)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.world_id, OLD.play_environment, OLD.play_game_key, OLD.play_installation_id, OLD.discord_guild_id, OLD.actor_discord_user_id, OLD.actor_core_user_id,
         OLD.issued_in_play_session, OLD.kind, OLD.district_key, OLD.district_geometry_fingerprint, OLD.epoch, OLD.ordinal, OLD.generation, OLD.asset, OLD.rule_ref,
         OLD.config_version, OLD.config_hash, OLD.layout_geometry_fingerprint, OLD.issued_at, OLD.expires_at, OLD.reissued_from) THEN
    RAISE EXCEPTION 'a district ticket keeps what it was issued as';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'a district ticket that has ended stays as it ended';
  END IF;
  NEW.ended_at := clock_timestamp();
  IF NEW.status = 'expired' THEN
    IF OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'a district ticket expires only once its lease has run out';
    END IF;
  ELSIF NEW.status = 'committed' THEN
    IF OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'an expired district ticket cannot be committed';
    END IF;
    IF OLD.epoch <> rotation.epoch THEN
      RAISE EXCEPTION 'a district ticket of an earlier rotation epoch cannot be committed';
    END IF;
    SELECT p.world_id, p.district_key, p.district_geometry_fingerprint, p.activated_sequence, p.activator_core_user_id, p.activator_discord_user_id,
           p.chain || '/' || p.standard || ':' || p.contract || '/' || p.token_id AS asset
      INTO prop FROM world_properties p WHERE p.id = NEW.property_id;
    IF NOT FOUND OR prop.world_id <> OLD.world_id OR prop.district_key <> OLD.district_key OR prop.district_geometry_fingerprint <> OLD.district_geometry_fingerprint
       OR prop.activated_sequence <> NEW.committed_sequence OR prop.activator_core_user_id IS DISTINCT FROM OLD.actor_core_user_id OR prop.activator_discord_user_id IS DISTINCT FROM OLD.actor_discord_user_id
       OR (OLD.kind = 'rule' AND prop.asset <> OLD.asset) THEN
      RAISE EXCEPTION 'a district ticket is committed only by the property it became: its world, district, geometry and holder';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = OLD.world_id AND c.sequence = NEW.committed_sequence) THEN
      RAISE EXCEPTION 'a district ticket is committed by the activation that has just advanced its city';
    END IF;
    IF OLD.kind = 'fallback' AND NOT EXISTS (SELECT 1 FROM world_assignment_slots s WHERE s.world_id = OLD.world_id AND s.ordinal = OLD.ordinal AND s.generation = OLD.generation AND s.state = 'held') THEN
      RAISE EXCEPTION 'a fallback ticket is committed only while it holds the current generation of its slot';
    END IF;
  ELSIF NEW.status NOT IN ('released', 'superseded') THEN
    RAISE EXCEPTION 'a district ticket ends released, expired, superseded or committed, not %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_district_tickets_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_district_tickets
  FOR EACH ROW EXECUTE FUNCTION world_district_tickets_guard();

-- Checked when the transaction commits, for every ticket that ended: nothing it held is lost or left
-- half-done. A fallback slot that ended without a property is back in the gap pool, reissued at a
-- later generation, or retired by a new epoch; one that became a property is consumed at exactly its
-- generation, and counted. A superseded ticket's rotation has moved past its epoch.
CREATE FUNCTION world_district_ticket_ended_whole() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'superseded' AND NOT EXISTS (SELECT 1 FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id AND r.epoch > NEW.epoch) THEN
    RAISE EXCEPTION 'a district ticket is superseded only by its rotation beginning a later epoch';
  END IF;
  IF NEW.status = 'committed' THEN
    IF NEW.kind = 'fallback' AND NOT EXISTS (SELECT 1 FROM world_assignment_slots s WHERE s.world_id = NEW.world_id AND s.ordinal = NEW.ordinal AND s.generation = NEW.generation AND s.state = 'consumed') THEN
      RAISE EXCEPTION 'a committed fallback ticket''s slot is consumed at its generation';
    END IF;
    IF (SELECT r.committed_count FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id)
       <> (SELECT count(*) FROM world_district_tickets t WHERE t.world_id = NEW.world_id AND t.status = 'committed') THEN
      RAISE EXCEPTION 'a rotation counts every committed ticket of its world';
    END IF;
  ELSIF NEW.kind = 'fallback' AND NOT EXISTS (
    SELECT 1 FROM world_assignment_slots s
     WHERE s.world_id = NEW.world_id AND s.ordinal = NEW.ordinal AND (s.state IN ('free', 'retired') OR (s.state = 'held' AND s.generation > NEW.generation))
  ) THEN
    RAISE EXCEPTION 'a fallback slot whose ticket ended without a property returns to the gap pool (or is reissued, or retired)';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_district_ticket_ended_whole
  AFTER UPDATE ON world_district_tickets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_district_ticket_ended_whole();

-- ---------------------------------------------------------------------------------------
-- Commit-time checks on existing tables, for worlds that have a rotation only
-- ---------------------------------------------------------------------------------------

-- An adoption changes what governs a world; the world's rotation, if it has one, must follow it in
-- the same transaction (a new basis, and a new epoch if the default districts or their geometry
-- changed), so no ticket is ever read against a configuration it was not issued on.
CREATE FUNCTION world_config_adoption_moves_rotation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id)
     AND (SELECT r.basis_config_version FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id)
         IS DISTINCT FROM (SELECT a.version FROM world_config_adoptions a WHERE a.world_id = NEW.world_id ORDER BY a.adoption_seq DESC LIMIT 1) THEN
    RAISE EXCEPTION 'a world''s assignment rotation follows every configuration adoption, in the adoption''s transaction';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_config_adoption_moves_rotation
  AFTER INSERT ON world_config_adoptions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_config_adoption_moves_rotation();

-- In a world whose players are assigned districts by tickets, a property is activated only by
-- consuming one, in the activation's transaction. (A world nobody has entered through a build that
-- issues tickets has no rotation and is not affected.)
CREATE FUNCTION world_property_consumes_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id)
     AND NOT EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.property_id = NEW.id AND t.status = 'committed') THEN
    RAISE EXCEPTION 'in a world that assigns districts by tickets, a property is activated only by consuming a live ticket';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_property_consumes_ticket
  AFTER INSERT ON world_properties
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_property_consumes_ticket();

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0009)
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY[
    'world_rotation_districts_ok(jsonb)', 'world_rotation_district(jsonb, bigint, bigint)', 'world_assignment_rotations_guard()', 'world_assignment_slots_guard()',
    'world_assignment_slot_retired_by_epoch()', 'world_district_tickets_guard()', 'world_district_ticket_ended_whole()', 'world_config_adoption_moves_rotation()',
    'world_property_consumes_ticket()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- A runtime role that does not own these tables needs SELECT, INSERT and UPDATE on the three new
-- tables (row locks included), and SELECT on app_meta, play_sessions, world_config_adoptions,
-- world_config_versions, world_config_geometries, world_properties, worlds and city. Never grant
-- DELETE on any of them.
--
-- Not here, on purpose:
--   * production eligibility: which NFTs a Proofy player holds, and their collection/trait rule
--     results, need a verified Proofy Core contract that does not exist (local fixtures stand in);
--   * the precedence of overlapping explicit district rules (OPEN, MCD 46A): an NFT matched by rules
--     naming different districts is refused, never resolved by guessing;
--   * renewal of a ticket's lease, and its length beyond the bounded local setting (OPEN, MCD 46B);
--   * closing a collection to new claims (locked policy B), which still needs Play schema v2.
