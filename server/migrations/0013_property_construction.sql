-- Property construction (P1-C2-E3A): the first thing that can be BUILT into a brand world's
-- property, and the LOCAL TEST resource that pays for it. LOCAL DATABASES ONLY.
--
-- What a construction action is. One player, through one live play session of the world, builds
-- one fixed step of the one recipe this build has (`local-test-tier1-v1`: 50 units an action, Tier
-- 1 at 100 lifetime units, nothing above Tier 1) into one existing property. In ONE transaction the
-- city advances exactly one sequence (state version 3, `src/world/cityState.ts`), its
-- `world.property.constructed` event is appended, the construction is recorded with who built it
-- and in which role, and the player's TEST credits are debited by exactly the units built. Either
-- all of it commits or none of it does.
--
-- THE RESOURCE IS VALUELESS TEST DATA. `local-test-credit` is not RF, not Proofy Points, not a token
-- and not convertible into anything. Credits come only from grants in the server-trusted local
-- rehearsal file, recorded once each per player and world, bounded here; there is no route that
-- grants or sells any. The recipe's numbers are PROVISIONAL LOCAL REHEARSAL TUNING, mirrored from
-- `src/world/construction.ts`: not a price, not an exchange rate and not a decision about any tier
-- above 1.
--
-- WHO MAY BUILD AS OWNER. Founding a property does not prove who holds its NFT now, so the original
-- activator (0008) authorizes nothing here. An owner construction needs the current controller of
-- the NFT, which nothing verifies yet: locally, the rehearsal file names one per Discord server and
-- NFT, as TEST DATA. The first construction action to see a controller records it as a CONTROL ERA
-- of the property (`world_property_control_eras`), and a later one that sees another records the
-- next era, so earlier owners' investment stays theirs and is never moved onto whoever controls the
-- NFT later. Anyone else in the world may build as a PATRON: that develops the property, is counted
-- as community investment and never as the owner's own (Architect) progression.
--
-- Additive. Three new tables, their guards, one new unique constraint stating what world_properties'
-- primary key already implies, and replacements of two policy functions, world_city_require_property
-- (0007) and world_properties_guard (0008), which those migrations left replaceable for exactly
-- this. Nothing is removed and no row is changed: every city, event, world, binding, session,
-- configuration, adoption, freeze, property and ticket stays exactly as it is. A city with no
-- construction keeps state version 2 and is read exactly as before.
--
-- Schema decisions, and why:
--   * The city sequence advances once per construction, as it does once per activation, so the
--     event chain stays one event per sequence and a replay of activations and constructions
--     together rebuilds the stored state byte for byte (`server/src/world/verify.ts`).
--   * The state records only what was built (tier, lifetime units, latest sequence per building);
--     who built it, in which role and era, and what it cost are this migration's records.
--   * The ledger is one append-only running balance per (world, player): each entry names the
--     balance it leaves, numbered 1, 2, 3 ... per account, never below zero. Two writers of one
--     account collide on the entry number; the service also serializes every construction of a
--     world on its city row.
--   * An action is named by an id the page chooses once per press (`action_id`), unique per world:
--     a repeat of it is answered with the construction it already made, and pays nothing more.
--
-- Constraints in this file are permanent (migrations never drop one), so table CHECKs state only
-- shape. Rules that are policy (which databases may build, which recipes exist, what authorizes an
-- owner) live in guard functions, which a later migration can replace.

-- Creating triggers and foreign keys on city, city_events, worlds, world_properties and play_sessions
-- takes brief locks on live tables. If one cannot be had quickly, fail and roll back rather than
-- queue readers behind this migration; the deploy can simply be run again.
SET LOCAL lock_timeout = '10s';

-- Lets a construction and a control era name a property together with its world, so neither can
-- name another world's property. The primary key already makes these unique. No row changes.
ALTER TABLE world_properties ADD CONSTRAINT wp_world_property UNIQUE (world_id, id);

-- ---------------------------------------------------------------------------------------
-- The recipe, as the engine computes it (src/world/construction.ts)
-- ---------------------------------------------------------------------------------------

-- The tier `built` lifetime units reach under a recipe, or NULL for a recipe this database does not know.
CREATE FUNCTION world_construction_tier(recipe text, built integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE recipe WHEN 'local-test-tier1-v1' THEN CASE WHEN built >= 100 THEN 1 ELSE 0 END END
$$;

-- The units one action builds into a building that has `built_before`, or NULL: an unknown recipe, or nothing left to build.
CREATE FUNCTION world_construction_units(recipe text, built_before integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE recipe WHEN 'local-test-tier1-v1' THEN CASE WHEN built_before >= 0 AND built_before < 100 THEN least(50, 100 - built_before) END END
$$;

-- ---------------------------------------------------------------------------------------
-- world_property_control_eras: who the local fixture said controlled a property's NFT, and from when
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_property_control_eras (
  world_id                    uuid        NOT NULL,
  property_id                 uuid        NOT NULL,
  -- 1, 2, 3 ... per property: each a different controller from the one before.
  era_seq                     integer     NOT NULL,
  -- The Discord user the trusted source named as the NFT's current controller. Not verified ownership.
  controller_discord_user_id  text        NOT NULL,
  -- Where that came from. Only the local rehearsal file exists: TEST DATA, never Proofy Core.
  source                      text        NOT NULL,
  city_id                     text        NOT NULL,
  -- The construction (its city sequence) that first saw this controller.
  observed_at_sequence        bigint      NOT NULL,
  observed_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, era_seq),
  CONSTRAINT wpce_property         FOREIGN KEY (world_id, property_id) REFERENCES world_properties (world_id, id),
  CONSTRAINT wpce_event            FOREIGN KEY (city_id, observed_at_sequence) REFERENCES city_events (city_id, sequence),
  CONSTRAINT wpce_world_scope      UNIQUE (world_id, property_id, era_seq),
  CONSTRAINT wpce_era_positive     CHECK (era_seq >= 1),
  CONSTRAINT wpce_controller_shape CHECK (controller_discord_user_id ~ '^[0-9]{15,25}$'),
  CONSTRAINT wpce_source_known     CHECK (source = 'local-fixture'),
  CONSTRAINT wpce_sequence_shape   CHECK (observed_at_sequence >= 3)
);

COMMENT ON TABLE world_property_control_eras IS 'Append-only provenance of who a trusted source named as a world property''s current NFT controller, as construction actions saw it. Local test data only; not verified ownership.';

-- ---------------------------------------------------------------------------------------
-- world_property_constructions: one row per construction action, for good
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_property_constructions (
  world_id                     uuid        NOT NULL,
  city_id                      text        NOT NULL,
  city_instance_id             uuid        NOT NULL,
  -- The city sequence this action produced (its `world.property.constructed` event).
  sequence                     bigint      NOT NULL,
  property_id                  uuid        NOT NULL,
  -- The page's id for this one press: a repeat of it is the same construction.
  action_id                    uuid        NOT NULL,
  recipe                       text        NOT NULL,
  -- owner: the NFT's current controller (per the trusted source, in era control_era_seq). patron: anyone else.
  role                         text        NOT NULL,
  -- The contributor, as Proofy named them for the play session that acted (0006), never as a browser said.
  contributor_core_user_id     text        NOT NULL,
  contributor_discord_user_id  text        NOT NULL,
  -- An identifier only: sessions are tidied after their retention.
  contributed_in_play_session  uuid        NOT NULL,
  -- The property's control era when it was built: an owner's own, or for a patron the era then current (none if no controller was known).
  control_era_seq              integer,
  resource                     text        NOT NULL,
  units                        integer     NOT NULL,
  built_before                 integer     NOT NULL,
  built_after                  integer     NOT NULL,
  tier_before                  integer     NOT NULL,
  tier_after                   integer     NOT NULL,
  constructed_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, sequence),
  CONSTRAINT wpc_world_city          FOREIGN KEY (world_id, city_id, city_instance_id) REFERENCES worlds (id, city_id, city_instance_id),
  CONSTRAINT wpc_event               FOREIGN KEY (city_id, sequence) REFERENCES city_events (city_id, sequence),
  CONSTRAINT wpc_property            FOREIGN KEY (world_id, property_id) REFERENCES world_properties (world_id, id),
  CONSTRAINT wpc_era                 FOREIGN KEY (world_id, property_id, control_era_seq) REFERENCES world_property_control_eras (world_id, property_id, era_seq),
  CONSTRAINT wpc_one_per_action      UNIQUE (world_id, action_id),
  CONSTRAINT wpc_sequence_shape      CHECK (sequence >= 3),
  CONSTRAINT wpc_recipe_shape        CHECK (recipe ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(recipe) <= 64),
  CONSTRAINT wpc_role_known          CHECK (role IN ('owner', 'patron')),
  CONSTRAINT wpc_owner_has_era       CHECK (role <> 'owner' OR control_era_seq IS NOT NULL),
  CONSTRAINT wpc_contributor_shape   CHECK (contributor_core_user_id ~ '^[A-Za-z0-9_-]{1,64}$' AND contributor_discord_user_id ~ '^[0-9]{15,25}$'),
  CONSTRAINT wpc_resource_known      CHECK (resource = 'local-test-credit'),
  CONSTRAINT wpc_units_shape         CHECK (units >= 1 AND built_before >= 0 AND built_after = built_before + units),
  CONSTRAINT wpc_tier_shape          CHECK (tier_before >= 0 AND tier_after >= tier_before)
);

COMMENT ON TABLE world_property_constructions IS 'Permanent record of every construction action on a world property: the recipe step built, by whom, in which role and control era, at which city sequence. Local test construction only.';

-- ---------------------------------------------------------------------------------------
-- world_test_credit_entries: the LOCAL TEST credit ledger, one running balance per player and world
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_test_credit_entries (
  world_id                  uuid        NOT NULL REFERENCES worlds (id),
  account_discord_user_id   text        NOT NULL,
  account_core_user_id      text        NOT NULL,
  -- 1, 2, 3 ... per account.
  entry_seq                 integer     NOT NULL,
  -- fixture-grant: credits the local rehearsal file grants this player here, once per grant key.
  -- construction-debit: the units of one construction by this player.
  kind                      text        NOT NULL,
  delta                     integer     NOT NULL,
  -- The account's balance once this entry is applied. Never negative.
  balance_after             integer     NOT NULL,
  grant_key                 text,
  city_id                   text,
  construction_sequence     bigint,
  -- The play session that caused the entry. An identifier only.
  recorded_in_play_session  uuid        NOT NULL,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, account_discord_user_id, account_core_user_id, entry_seq),
  CONSTRAINT wtce_construction    FOREIGN KEY (city_id, construction_sequence) REFERENCES world_property_constructions (city_id, sequence),
  CONSTRAINT wtce_one_grant       UNIQUE (world_id, account_discord_user_id, grant_key),
  CONSTRAINT wtce_one_debit       UNIQUE (city_id, construction_sequence),
  CONSTRAINT wtce_kind_known      CHECK (kind IN ('fixture-grant', 'construction-debit')),
  CONSTRAINT wtce_kind_shape      CHECK (
    (kind = 'fixture-grant' AND delta > 0 AND grant_key IS NOT NULL AND city_id IS NULL AND construction_sequence IS NULL)
    OR (kind = 'construction-debit' AND delta < 0 AND grant_key IS NULL AND city_id IS NOT NULL AND construction_sequence IS NOT NULL)
  ),
  CONSTRAINT wtce_delta_bounded   CHECK (delta BETWEEN -1000 AND 1000),
  CONSTRAINT wtce_balance_shape   CHECK (balance_after >= 0),
  CONSTRAINT wtce_entry_positive  CHECK (entry_seq >= 1),
  CONSTRAINT wtce_account_shape   CHECK (account_core_user_id ~ '^[A-Za-z0-9_-]{1,64}$' AND account_discord_user_id ~ '^[0-9]{15,25}$'),
  CONSTRAINT wtce_grant_key_shape CHECK (grant_key IS NULL OR grant_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);

COMMENT ON TABLE world_test_credit_entries IS 'Append-only ledger of valueless LOCAL TEST construction credits per player and world: fixture grants and construction debits, each with the running balance it leaves. Not a currency; local databases only.';

-- ---------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------

-- A control era is written once, by the construction action that first saw its controller, in that action's
-- transaction, and never changed or removed:
--   * the database is a LOCAL one, in a READ COMMITTED transaction;
--   * its property is a property of its world, in the world's own city;
--   * the city has just reached the sequence it names, by a `world.property.constructed` event for that property;
--   * eras are numbered 1, 2, 3 ... per property, and each names another controller than the one before.
CREATE FUNCTION world_property_control_eras_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a control era is permanent: it cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a control era is permanent: it cannot be removed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'construction is not enabled in this database: only a local database may record it until live player mutations are authorized';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a control era is recorded only in a READ COMMITTED transaction';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM world_properties p JOIN worlds w ON w.id = p.world_id
     WHERE p.id = NEW.property_id AND p.world_id = NEW.world_id AND w.city_id = NEW.city_id
  ) THEN
    RAISE EXCEPTION 'a control era belongs to a property of its world, in that world''s city (foreign key world_property_control_eras -> world_properties)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM city c WHERE c.id = NEW.city_id AND c.sequence = NEW.observed_at_sequence)
     OR NOT EXISTS (
       SELECT 1 FROM city_events e
        WHERE e.city_id = NEW.city_id AND e.sequence = NEW.observed_at_sequence AND e.type = 'world.property.constructed' AND e.payload ->> 'propertyId' = NEW.property_id::text
     ) THEN
    RAISE EXCEPTION 'a control era is recorded by the construction its city has just made on that property';
  END IF;
  SELECT era_seq, controller_discord_user_id INTO previous FROM world_property_control_eras WHERE property_id = NEW.property_id ORDER BY era_seq DESC LIMIT 1;
  IF NEW.era_seq <> COALESCE(previous.era_seq, 0) + 1 THEN
    RAISE EXCEPTION 'control eras are numbered consecutively from 1 for each property';
  END IF;
  IF previous.controller_discord_user_id IS NOT DISTINCT FROM NEW.controller_discord_user_id THEN
    RAISE EXCEPTION 'a new control era names another controller than the era before it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_property_control_eras_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_property_control_eras
  FOR EACH ROW EXECUTE FUNCTION world_property_control_eras_guard();

-- Checked when the transaction commits: an era is recorded only with the construction that saw it, in its era.
CREATE FUNCTION world_property_control_era_observed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM world_property_constructions c
     WHERE c.city_id = NEW.city_id AND c.sequence = NEW.observed_at_sequence AND c.property_id = NEW.property_id AND c.control_era_seq = NEW.era_seq
  ) THEN
    RAISE EXCEPTION 'a control era is recorded together with the construction that saw it';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_property_control_era_observed
  AFTER INSERT ON world_property_control_eras
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_property_control_era_observed();

-- A construction is written once, as the change its city has just made, and never changed or removed:
--   * the database is a LOCAL one, in a READ COMMITTED transaction (the hold this slice ships with, as for properties);
--   * it is on a property of its world, in the world's own city, at exactly the sequence the city has just reached,
--     whose version 3 state records the building's development as this construction leaves it;
--   * the event at that sequence is the `world.property.constructed` of exactly this action, property, role and step;
--   * the step is the recipe's: the units one action builds from what the property had (its latest construction's
--     built_after, or nothing), and the tiers those units make. A recipe this database does not know builds nothing;
--   * the contributor is the player of the live play session of this world that acts, read from that session's row,
--     which is locked until this transaction ends;
--   * an OWNER builds in the property's latest control era, whose controller is the contributor; a PATRON in the latest
--     era, whose controller is someone else, or in none. Either way the era is the one current now.
CREATE FUNCTION world_property_constructions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  building_key text;
  development json;
  had integer;
  latest record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a construction is permanent: it cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a construction is permanent: it cannot be removed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'construction is not enabled in this database: only a local database may record it until live player mutations are authorized';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a construction is recorded only in a READ COMMITTED transaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM worlds w WHERE w.id = NEW.world_id AND w.city_id = NEW.city_id AND w.city_instance_id = NEW.city_instance_id) THEN
    RAISE EXCEPTION 'a construction belongs to its world''s own city (foreign key world_property_constructions -> worlds)' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT p.building_id INTO building_key FROM world_properties p WHERE p.id = NEW.property_id AND p.world_id = NEW.world_id;
  IF building_key IS NULL THEN
    RAISE EXCEPTION 'a construction is on a property of its world (foreign key world_property_constructions -> world_properties)' USING ERRCODE = 'foreign_key_violation';
  END IF;

  had := COALESCE((SELECT c.built_after FROM world_property_constructions c WHERE c.property_id = NEW.property_id ORDER BY c.sequence DESC LIMIT 1), 0);
  IF NEW.built_before IS DISTINCT FROM had
     OR NEW.units IS DISTINCT FROM world_construction_units(NEW.recipe, had)
     OR NEW.tier_before IS DISTINCT FROM world_construction_tier(NEW.recipe, NEW.built_before)
     OR NEW.tier_after IS DISTINCT FROM world_construction_tier(NEW.recipe, NEW.built_after) THEN
    RAISE EXCEPTION 'a construction builds exactly its recipe''s next step on what the property already has';
  END IF;

  SELECT c.state -> 'development' -> building_key INTO development
    FROM city c
   WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND c.sequence = NEW.sequence AND c.state_version = 3;
  IF development IS NULL
     OR development ->> 'tier' IS DISTINCT FROM NEW.tier_after::text
     OR development ->> 'built' IS DISTINCT FROM NEW.built_after::text
     OR development ->> 'sequence' IS DISTINCT FROM NEW.sequence::text THEN
    RAISE EXCEPTION 'a construction must be the development its city has just recorded, at the sequence it has just reached';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM city_events e
     WHERE e.city_id = NEW.city_id AND e.sequence = NEW.sequence AND e.type = 'world.property.constructed'
       AND e.payload ->> 'propertyId' = NEW.property_id::text AND e.payload ->> 'buildingId' = building_key AND e.payload ->> 'action' = NEW.action_id::text
       AND e.payload ->> 'role' = NEW.role AND e.payload ->> 'recipe' = NEW.recipe AND e.payload ->> 'units' = NEW.units::text
       AND e.payload ->> 'builtBefore' = NEW.built_before::text AND e.payload ->> 'builtAfter' = NEW.built_after::text
       AND e.payload ->> 'tierBefore' = NEW.tier_before::text AND e.payload ->> 'tierAfter' = NEW.tier_after::text
  ) THEN
    RAISE EXCEPTION 'a construction must be recorded by a world.property.constructed event at the sequence its city has just reached';
  END IF;

  PERFORM 1 FROM play_sessions s
    WHERE s.id = NEW.contributed_in_play_session AND s.world_id = NEW.world_id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a construction is made only in a live play session of its world';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM play_sessions s
     WHERE s.id = NEW.contributed_in_play_session AND s.core_user_id = NEW.contributor_core_user_id AND s.discord_user_id = NEW.contributor_discord_user_id
  ) THEN
    RAISE EXCEPTION 'a construction''s contributor is the player of the play session that makes it';
  END IF;

  SELECT e.era_seq, e.controller_discord_user_id INTO latest FROM world_property_control_eras e WHERE e.property_id = NEW.property_id ORDER BY e.era_seq DESC LIMIT 1;
  IF NEW.role = 'owner' THEN
    IF NEW.control_era_seq IS DISTINCT FROM latest.era_seq OR latest.controller_discord_user_id IS DISTINCT FROM NEW.contributor_discord_user_id THEN
      RAISE EXCEPTION 'an owner builds only in the property''s current control era, as its controller';
    END IF;
  ELSIF NEW.control_era_seq IS NOT NULL
        AND (NEW.control_era_seq IS DISTINCT FROM latest.era_seq OR latest.controller_discord_user_id = NEW.contributor_discord_user_id) THEN
    RAISE EXCEPTION 'a patron builds in the property''s current control era, whose controller is someone else, or in none';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_property_constructions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_property_constructions
  FOR EACH ROW EXECUTE FUNCTION world_property_constructions_guard();

-- Checked when the transaction commits: a construction is paid for, by its contributor, by exactly its units.
CREATE FUNCTION world_property_construction_paid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM world_test_credit_entries t
     WHERE t.city_id = NEW.city_id AND t.construction_sequence = NEW.sequence AND t.world_id = NEW.world_id AND t.kind = 'construction-debit'
       AND t.account_discord_user_id = NEW.contributor_discord_user_id AND t.account_core_user_id = NEW.contributor_core_user_id AND t.delta = -NEW.units
  ) THEN
    RAISE EXCEPTION 'a construction is paid for by its contributor''s test credits, by exactly its units';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_property_construction_paid
  AFTER INSERT ON world_property_constructions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_property_construction_paid();

-- A ledger entry is appended once and never changed or removed:
--   * the database is a LOCAL one, in a READ COMMITTED transaction;
--   * it is the account's next entry, and leaves exactly the account's balance plus its delta, never below zero;
--   * it is made in a live play session of its world by the account's own player, whose row is locked until this
--     transaction ends;
--   * a grant is one of at most 20 per account (the rehearsal file's grants are bounded, and so is what they can add);
--   * a debit pays for one construction of that player in that world's city, by exactly its units.
CREATE FUNCTION world_test_credit_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a test credit entry is permanent: it cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a test credit entry is permanent: it cannot be removed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'test credits are not enabled in this database: only a local database may hold them';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a test credit entry is recorded only in a READ COMMITTED transaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM worlds w WHERE w.id = NEW.world_id) THEN
    RAISE EXCEPTION 'a test credit entry belongs to a world (foreign key world_test_credit_entries -> worlds)' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT t.entry_seq, t.balance_after INTO previous FROM world_test_credit_entries t
   WHERE t.world_id = NEW.world_id AND t.account_discord_user_id = NEW.account_discord_user_id AND t.account_core_user_id = NEW.account_core_user_id
   ORDER BY t.entry_seq DESC LIMIT 1;
  IF NEW.entry_seq <> COALESCE(previous.entry_seq, 0) + 1 THEN
    RAISE EXCEPTION 'test credit entries are numbered consecutively from 1 for each account';
  END IF;
  IF NEW.balance_after <> COALESCE(previous.balance_after, 0) + NEW.delta THEN
    RAISE EXCEPTION 'a test credit entry leaves exactly the account''s balance plus its delta';
  END IF;
  IF NEW.balance_after < 0 THEN
    RAISE EXCEPTION 'insufficient test credits: a balance never goes below zero';
  END IF;

  PERFORM 1 FROM play_sessions s
    WHERE s.id = NEW.recorded_in_play_session AND s.world_id = NEW.world_id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
      AND s.core_user_id = NEW.account_core_user_id AND s.discord_user_id = NEW.account_discord_user_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a test credit entry is recorded only in a live play session of its world, by the account''s own player';
  END IF;

  IF NEW.kind = 'fixture-grant' THEN
    IF (SELECT count(*) FROM world_test_credit_entries t WHERE t.world_id = NEW.world_id AND t.account_discord_user_id = NEW.account_discord_user_id AND t.kind = 'fixture-grant') >= 20 THEN
      RAISE EXCEPTION 'an account holds at most 20 test credit grants';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM world_property_constructions c JOIN worlds w ON w.id = c.world_id
     WHERE c.city_id = NEW.city_id AND c.sequence = NEW.construction_sequence AND c.world_id = NEW.world_id AND w.city_id = NEW.city_id
       AND c.contributor_discord_user_id = NEW.account_discord_user_id AND c.contributor_core_user_id = NEW.account_core_user_id AND c.units = -NEW.delta
  ) THEN
    RAISE EXCEPTION 'a test credit debit pays for one construction of its own player, by exactly its units';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_test_credit_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_test_credit_entries
  FOR EACH ROW EXECUTE FUNCTION world_test_credit_entries_guard();

-- ---------------------------------------------------------------------------------------
-- A world's city advances only by activating a property or building on one (replaces 0007)
-- ---------------------------------------------------------------------------------------

-- As in 0007, checked when the transaction commits, for every update that advanced a world's city: the sequence it
-- reached is explained by a `world.property.activated` event and the property it records, or (new) by a
-- `world.property.constructed` event and the construction it records. A city with any construction holds state
-- version 3 from then on; without, version 2. Since properties and constructions can only be written in a local
-- database, no other database's world city can advance at all.
CREATE OR REPLACE FUNCTION world_city_require_property() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  built boolean;
BEGIN
  IF NEW.sequence = OLD.sequence OR NOT EXISTS (SELECT 1 FROM worlds w WHERE w.city_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM city_events e WHERE e.city_id = NEW.id AND e.sequence = NEW.sequence AND e.type = 'world.property.activated')
     AND EXISTS (SELECT 1 FROM world_properties p WHERE p.city_id = NEW.id AND p.activated_sequence = NEW.sequence) THEN
    NULL;
  ELSIF EXISTS (SELECT 1 FROM city_events e WHERE e.city_id = NEW.id AND e.sequence = NEW.sequence AND e.type = 'world.property.constructed')
        AND EXISTS (SELECT 1 FROM world_property_constructions c WHERE c.city_id = NEW.id AND c.sequence = NEW.sequence) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'a world''s city advances only by activating a property or building on one: sequence % has no world.property.activated event and property, nor world.property.constructed event and construction', NEW.sequence;
  END IF;
  built := EXISTS (SELECT 1 FROM world_property_constructions c WHERE c.city_id = NEW.id);
  IF (built AND NEW.state_version <> 3) OR (NOT built AND NEW.state_version <> 2) THEN
    RAISE EXCEPTION 'a world''s city with properties holds state version 2, and version 3 once anything is built in it';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- world_properties_guard, replaced: a property may also be activated in a city with construction
-- ---------------------------------------------------------------------------------------

-- Exactly 0008's rules (including the hold: only a LOCAL database may hold a world property until live player
-- mutations are authorized), with one change: the city may hold state version 3 (with construction), in which the
-- new building is recorded the same way.
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
   WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND c.sequence = NEW.activated_sequence AND c.state_version IN (2, 3);
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
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0012)
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY[
    'world_construction_tier(text, integer)', 'world_construction_units(text, integer)', 'world_property_control_eras_guard()', 'world_property_control_era_observed()',
    'world_property_constructions_guard()', 'world_property_construction_paid()', 'world_test_credit_entries_guard()', 'world_city_require_property()', 'world_properties_guard()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- A runtime role that does not own these tables needs, to build: UPDATE on city (it advances the city, and already
-- locks it), INSERT on city_events, world_property_control_eras, world_property_constructions and
-- world_test_credit_entries, and SELECT on app_meta, worlds, city, city_events, world_properties, play_sessions and
-- the three new tables; the session row lock (FOR SHARE) needs UPDATE on one column of play_sessions, which
-- UPDATE (revoked_at) already is. Never grant UPDATE or DELETE on any of the three new tables.
--
-- The guards are row triggers: TRUNCATE, disabling triggers and table-rewriting DDL are table-owner powers they do not
-- cover (as 0005 says). Against those, a deployed database relies on a runtime role that does not own these tables.
--
-- Not here, on purpose, because each waits on a decision or a contract that does not exist yet:
--   * verified current NFT control (Proofy Core), or any real transfer of an NFT or a property;
--   * any real currency: RF, Proofy Points, tokens, wallets, prices, purchases or exchange;
--   * any tier above 1, any other recipe, and any final tier balancing;
--   * patron rewards, recognition levels and Architect levels (only the units each role contributed are recorded).
