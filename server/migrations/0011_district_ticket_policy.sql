-- District ticket policies D1 to D4 (owner-locked 2026-10-21, P1-C2-D2), on the ticket engine of 0010.
--
--   D1  RESTRICTED DISTRICTS. A district with a Proofy rule is never a default (0010's rotation
--       already leaves it out). It may be reached only by a rule ticket: an explicit collection/trait
--       rule for the NFT, and a positive answer to the district's own Proofy rule for its holder. A
--       rule ticket now records the district's Proofy rule as its configuration named it, and where
--       the positive answer came from. Locally that is only ever 'local-fixture': server-trusted TEST
--       DATA standing in for Proofy Core, never a verified answer (no Core contract exists).
--   D2  A FIXED FIFTEEN-MINUTE LEASE. A player's CLAIM WINDOW opens with the first ticket issued to
--       them in a world and lasts exactly 900 seconds, set here by this database's clock. Every ticket
--       issued to them while it is open (an NFT switch, a re-entry after cancelling, a reissue after a
--       rotation change) ends exactly when it ends: cancelling and entering again never renews it.
--       The window closes when one of its tickets becomes a property (the next claim opens a new one)
--       or once it has run out (a fresh claim after that opens a new one). Nothing else ends it, so
--       nobody is locked out for longer than the window they opened.
--   D3  CONFLICTING EXPLICIT RULES stay refused before any ticket (unchanged: the service decides it;
--       nothing here orders rules).
--   D4  SELECTIVE INVALIDATION. A change of the rotation (its districts, order or geometry) still
--       supersedes every active ticket by beginning a new epoch (0010). A change of rules only, with
--       the rotation unchanged, supersedes only the rule tickets it affects, in the current epoch, and
--       says so: `supersede_cause` 'rules' (a rotation change is 'rotation'). Unaffected tickets keep
--       their identity, district, ordinal, generation and expiry; affected holders keep their window.
--
-- Additive. One new table (world_claim_windows) and its guards; four new nullable columns on
-- world_district_tickets with shape checks; 0010's two ticket guard functions replaced (CREATE OR
-- REPLACE, as 0008 replaced world_properties_guard), keeping every rule they had. No existing row is
-- changed: an active ticket issued before this migration keeps its lease, and its holder gets a claim
-- window recorded with exactly that lease ('migration-0011'), so cancelling it does not renew it
-- either. Committed, released, expired and superseded tickets are left exactly as they are.
--
-- LOCAL ONLY, like 0007 and 0010: a claim window exists only where a ticket can.
--
-- Constraints in this file are permanent (migrations never drop one), so table CHECKs state only
-- shape. Policy lives in the guard functions, which a later migration can replace.

-- Altering world_district_tickets takes a brief exclusive lock on it. If it cannot be had quickly,
-- fail and roll back rather than queue entrants behind this migration.
SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------------------
-- world_claim_windows: one player's claim window in one world
-- ---------------------------------------------------------------------------------------

CREATE TABLE world_claim_windows (
  id                     uuid        PRIMARY KEY,
  world_id               uuid        NOT NULL REFERENCES world_assignment_rotations (world_id),
  -- The holder, as the issuing play session named them (never a browser).
  actor_discord_user_id  text        NOT NULL,
  actor_core_user_id     text        NOT NULL,
  -- Set by this database: opened when the first ticket is issued, ending exactly 900 seconds later.
  opened_at              timestamptz NOT NULL,
  expires_at             timestamptz NOT NULL,
  -- 'issuance' (a ticket opened it), or 'migration-0011' (recorded for a ticket already active here).
  opened_by              text        NOT NULL,
  closed_at              timestamptz,
  -- 'activated': one of its tickets became `property_id`. 'lapsed': it ran out.
  close_reason           text,
  property_id            uuid        REFERENCES world_properties (id),
  CONSTRAINT wcw_actor_shape   CHECK (actor_discord_user_id ~ '^[0-9]{15,25}$' AND actor_core_user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT wcw_lifetime      CHECK (expires_at > opened_at AND expires_at <= opened_at + interval '1 hour'),
  CONSTRAINT wcw_opened_shape  CHECK (opened_by ~ '^[a-z][a-z0-9-]{0,31}$'),
  CONSTRAINT wcw_closed_shape  CHECK ((closed_at IS NULL) = (close_reason IS NULL) AND (close_reason IS NULL OR close_reason ~ '^[a-z][a-z0-9_-]{0,31}$') AND (property_id IS NULL OR close_reason IS NOT NULL))
);

-- At most one open window per player per world: a new one opens only once the last has closed.
CREATE UNIQUE INDEX world_claim_windows_one_open_per_actor ON world_claim_windows (world_id, actor_discord_user_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX world_claim_windows_one_per_property ON world_claim_windows (property_id) WHERE property_id IS NOT NULL;

COMMENT ON TABLE world_claim_windows IS 'A player''s fixed 900-second district claim window in a brand world (policy D2): every ticket issued to them while it is open ends when it ends; never renewed. LOCAL ONLY.';

-- An active ticket issued before this migration: its holder's window is its own lease, exactly.
INSERT INTO world_claim_windows (id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by)
SELECT gen_random_uuid(), t.world_id, t.actor_discord_user_id, t.actor_core_user_id, t.issued_at, t.expires_at, 'migration-0011'
  FROM world_district_tickets t WHERE t.status = 'active';

-- ---------------------------------------------------------------------------------------
-- world_district_tickets: the window, the restricted district's rule, and why it was superseded
-- ---------------------------------------------------------------------------------------

ALTER TABLE world_district_tickets
  -- The claim window it was issued in. NULL only for a ticket issued before this migration.
  ADD COLUMN claim_window          uuid REFERENCES world_claim_windows (id),
  -- A rule ticket on a restricted district: the Proofy verification rule its configuration names for
  -- that district, and the source of the positive answer it was issued on. NULL otherwise.
  ADD COLUMN gate_rule_id          bigint,
  ADD COLUMN authorization_source  text,
  -- A superseded ticket: 'rotation' (a new epoch) or 'rules' (a rule change that affected it). NULL
  -- for every other status, and for a ticket superseded before this migration (by a new epoch).
  ADD COLUMN supersede_cause       text,
  ADD CONSTRAINT wdt_gate_shape      CHECK ((gate_rule_id IS NULL) = (authorization_source IS NULL)
                                            AND (gate_rule_id IS NULL OR (kind = 'rule' AND gate_rule_id >= 1 AND authorization_source ~ '^[a-z][a-z0-9-]{0,31}$'))),
  ADD CONSTRAINT wdt_supersede_shape CHECK (supersede_cause IS NULL OR (status = 'superseded' AND supersede_cause ~ '^[a-z][a-z0-9_-]{0,31}$'));

CREATE INDEX world_district_tickets_window ON world_district_tickets (claim_window) WHERE claim_window IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------

-- The Proofy verification rule a configuration version names for one of its districts, or NULL when
-- that district has none (an unrestricted district) or the version does not have it.
CREATE FUNCTION world_config_district_rule(p_world uuid, p_version integer, p_district text) RETURNS bigint
LANGUAGE sql STABLE STRICT AS $$
  SELECT CASE WHEN jsonb_typeof(d.v -> 'proofyRule') = 'object' AND jsonb_typeof(d.v -> 'proofyRule' -> 'verificationRuleId') = 'number'
              THEN (d.v -> 'proofyRule' ->> 'verificationRuleId')::bigint END
    FROM world_config_versions v, jsonb_array_elements(v.config_canonical::jsonb -> 'districts') AS d(v)
   WHERE v.world_id = p_world AND v.version = p_version AND d.v ->> 'key' = p_district
$$;

-- A window is opened by the issuance of its first ticket, at this database's clock, for exactly 900
-- seconds; it changes once, when it closes: 'lapsed' only once it has run out and its holder has no
-- active ticket left in the world, 'activated' only by the property one of its tickets became.
CREATE FUNCTION world_claim_windows_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a claim window is permanent provenance: it cannot be removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_meta m WHERE m.key = 'environment' AND m.value = 'local') THEN
    RAISE EXCEPTION 'district tickets are not enabled in this database: only a local database may hold one until a verified eligibility contract exists';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a claim window changes only in a READ COMMITTED transaction';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.opened_by <> 'issuance' OR NEW.closed_at IS NOT NULL OR NEW.close_reason IS NOT NULL OR NEW.property_id IS NOT NULL THEN
      RAISE EXCEPTION 'a claim window is opened, open, only by the issuance of a ticket';
    END IF;
    -- The lease is this database's, exactly: whatever the caller asked for is replaced.
    NEW.opened_at := clock_timestamp();
    NEW.expires_at := NEW.opened_at + interval '900 seconds';
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.world_id, NEW.actor_discord_user_id, NEW.actor_core_user_id, NEW.opened_at, NEW.expires_at, NEW.opened_by)
     IS DISTINCT FROM ROW(OLD.id, OLD.world_id, OLD.actor_discord_user_id, OLD.actor_core_user_id, OLD.opened_at, OLD.expires_at, OLD.opened_by) THEN
    RAISE EXCEPTION 'a claim window keeps its holder and its lease: never extended, never renewed';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a claim window that has closed stays closed';
  END IF;
  NEW.closed_at := clock_timestamp();
  IF NEW.close_reason = 'lapsed' THEN
    IF OLD.expires_at > clock_timestamp() OR NEW.property_id IS NOT NULL THEN
      RAISE EXCEPTION 'a claim window lapses only once it has run out';
    END IF;
    IF EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.world_id = OLD.world_id AND t.actor_discord_user_id = OLD.actor_discord_user_id AND t.status = 'active') THEN
      RAISE EXCEPTION 'a claim window lapses only once its holder''s ticket has ended';
    END IF;
  ELSIF NEW.close_reason = 'activated' THEN
    IF NEW.property_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM world_district_tickets t
       WHERE t.property_id = NEW.property_id AND t.status = 'committed' AND t.world_id = OLD.world_id AND t.actor_discord_user_id = OLD.actor_discord_user_id
         AND (t.claim_window = OLD.id OR t.claim_window IS NULL)
    ) THEN
      RAISE EXCEPTION 'a claim window is closed by an activation only by the property one of its tickets became';
    END IF;
  ELSE
    RAISE EXCEPTION 'a claim window closes lapsed or activated, not %', NEW.close_reason;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER world_claim_windows_guard
  BEFORE INSERT OR UPDATE OR DELETE ON world_claim_windows
  FOR EACH ROW EXECUTE FUNCTION world_claim_windows_guard();

-- Checked when the transaction commits: a window opens together with the ticket that opened it.
CREATE FUNCTION world_claim_window_opened_by_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.claim_window = NEW.id AND t.issued_at = NEW.opened_at AND t.expires_at = NEW.expires_at) THEN
    RAISE EXCEPTION 'a claim window opens with the ticket whose issuance opened it';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER world_claim_window_opened_by_ticket
  AFTER INSERT ON world_claim_windows
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION world_claim_window_opened_by_ticket();

-- 0010's ticket guard, every rule kept, and (0011):
--   * a ticket is issued in its holder's open claim window of its world, and ends exactly when the
--     window ends; the first ticket of a window is issued at the instant the window opened;
--   * a rule ticket records its district's Proofy rule exactly as its configuration names it, and a
--     restricted district's positive answer only from 'local-fixture' (no verified source exists);
--     a fallback ticket's district has no Proofy rule;
--   * a superseded ticket says why: 'rotation' or 'rules'.
CREATE OR REPLACE FUNCTION world_district_tickets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rotation record;
  source record;
  prop record;
  win record;
  district_rule bigint;
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
    IF NEW.status <> 'active' OR NEW.ended_at IS NOT NULL OR NEW.end_reason IS NOT NULL OR NEW.property_id IS NOT NULL OR NEW.committed_sequence IS NOT NULL OR NEW.supersede_cause IS NOT NULL THEN
      RAISE EXCEPTION 'a district ticket is issued active';
    END IF;
    -- The claim window (D2): its holder's, of this world, open; the ticket ends exactly when it ends.
    SELECT w.world_id, w.actor_discord_user_id, w.actor_core_user_id, w.opened_at, w.expires_at, w.opened_by, w.closed_at INTO win FROM world_claim_windows w WHERE w.id = NEW.claim_window;
    IF NOT FOUND OR win.world_id <> NEW.world_id OR win.actor_discord_user_id <> NEW.actor_discord_user_id OR win.actor_core_user_id <> NEW.actor_core_user_id OR win.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a district ticket is issued in its holder''s open claim window of its world';
    END IF;
    IF win.opened_by = 'issuance' AND NOT EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.claim_window = NEW.claim_window) THEN
      NEW.issued_at := win.opened_at;
    ELSE
      NEW.issued_at := clock_timestamp();
    END IF;
    IF win.expires_at <= clock_timestamp() OR NEW.expires_at <= NEW.issued_at THEN
      RAISE EXCEPTION 'a district ticket cannot be issued already expired';
    END IF;
    IF NEW.expires_at IS DISTINCT FROM win.expires_at THEN
      RAISE EXCEPTION 'a district ticket ends exactly when its claim window ends: never later, never renewed';
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
    -- The district's Proofy rule (D1), as the configuration it was issued on names it.
    district_rule := world_config_district_rule(NEW.world_id, NEW.config_version, NEW.district_key);
    IF NEW.kind = 'fallback' AND district_rule IS NOT NULL THEN
      RAISE EXCEPTION 'a fallback ticket names only an unrestricted district';
    END IF;
    IF NEW.kind = 'rule' AND NEW.gate_rule_id IS DISTINCT FROM district_rule THEN
      RAISE EXCEPTION 'a rule ticket records its district''s Proofy rule exactly as its configuration names it';
    END IF;
    IF NEW.authorization_source IS NOT NULL AND NEW.authorization_source <> 'local-fixture' THEN
      RAISE EXCEPTION 'a restricted district is authorized here only by local test data (local-fixture): no verified Proofy Core answer exists';
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
      SELECT t.world_id, t.kind, t.status, t.actor_discord_user_id, t.actor_core_user_id, t.issued_in_play_session, t.expires_at, t.epoch, t.claim_window INTO source FROM world_district_tickets t WHERE t.id = NEW.reissued_from;
      IF NOT FOUND OR source.world_id <> NEW.world_id OR source.status <> 'superseded' OR source.kind <> NEW.kind OR source.epoch >= NEW.epoch
         OR source.actor_discord_user_id <> NEW.actor_discord_user_id OR source.actor_core_user_id <> NEW.actor_core_user_id
         OR source.issued_in_play_session <> NEW.issued_in_play_session OR NEW.expires_at > source.expires_at
         OR (source.claim_window IS NOT NULL AND source.claim_window <> NEW.claim_window) THEN
        RAISE EXCEPTION 'a reissued district ticket replaces a superseded ticket of the same holder, for no longer than it had';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.world_id, NEW.play_environment, NEW.play_game_key, NEW.play_installation_id, NEW.discord_guild_id, NEW.actor_discord_user_id, NEW.actor_core_user_id,
         NEW.issued_in_play_session, NEW.kind, NEW.district_key, NEW.district_geometry_fingerprint, NEW.epoch, NEW.ordinal, NEW.generation, NEW.asset, NEW.rule_ref,
         NEW.config_version, NEW.config_hash, NEW.layout_geometry_fingerprint, NEW.issued_at, NEW.expires_at, NEW.reissued_from,
         NEW.claim_window, NEW.gate_rule_id, NEW.authorization_source)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.world_id, OLD.play_environment, OLD.play_game_key, OLD.play_installation_id, OLD.discord_guild_id, OLD.actor_discord_user_id, OLD.actor_core_user_id,
         OLD.issued_in_play_session, OLD.kind, OLD.district_key, OLD.district_geometry_fingerprint, OLD.epoch, OLD.ordinal, OLD.generation, OLD.asset, OLD.rule_ref,
         OLD.config_version, OLD.config_hash, OLD.layout_geometry_fingerprint, OLD.issued_at, OLD.expires_at, OLD.reissued_from,
         OLD.claim_window, OLD.gate_rule_id, OLD.authorization_source) THEN
    RAISE EXCEPTION 'a district ticket keeps what it was issued as';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'a district ticket that has ended stays as it ended';
  END IF;
  NEW.ended_at := clock_timestamp();
  IF NEW.status = 'superseded' THEN
    IF NEW.supersede_cause IS NULL OR NEW.supersede_cause NOT IN ('rotation', 'rules') THEN
      RAISE EXCEPTION 'a superseded district ticket says why: a rotation change or a rule change';
    END IF;
  ELSIF NEW.status = 'expired' THEN
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
  ELSIF NEW.status <> 'released' THEN
    RAISE EXCEPTION 'a district ticket ends released, expired, superseded or committed, not %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- 0010's commit-time check, every rule kept, and (0011): a ticket superseded by a rotation change
-- needs its rotation past its epoch; one superseded by a rule change is a rule ticket of the epoch
-- that still governs (a rule change never moves the rotation); a committed ticket leaves its holder
-- no open claim window in the world (the activation closed it).
CREATE OR REPLACE FUNCTION world_district_ticket_ended_whole() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'superseded' THEN
    IF NEW.supersede_cause = 'rules' THEN
      IF NEW.kind <> 'rule' OR NOT EXISTS (SELECT 1 FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id AND r.epoch = NEW.epoch) THEN
        RAISE EXCEPTION 'a rule change supersedes only a rule ticket of the epoch that governs';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id AND r.epoch > NEW.epoch) THEN
      RAISE EXCEPTION 'a district ticket is superseded only by its rotation beginning a later epoch';
    END IF;
  END IF;
  IF NEW.status = 'committed' THEN
    IF NEW.kind = 'fallback' AND NOT EXISTS (SELECT 1 FROM world_assignment_slots s WHERE s.world_id = NEW.world_id AND s.ordinal = NEW.ordinal AND s.generation = NEW.generation AND s.state = 'consumed') THEN
      RAISE EXCEPTION 'a committed fallback ticket''s slot is consumed at its generation';
    END IF;
    IF (SELECT r.committed_count FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id)
       <> (SELECT count(*) FROM world_district_tickets t WHERE t.world_id = NEW.world_id AND t.status = 'committed') THEN
      RAISE EXCEPTION 'a rotation counts every committed ticket of its world';
    END IF;
    IF EXISTS (SELECT 1 FROM world_claim_windows w WHERE w.world_id = NEW.world_id AND w.actor_discord_user_id = NEW.actor_discord_user_id AND w.closed_at IS NULL)
       OR (NEW.claim_window IS NOT NULL AND NOT EXISTS (SELECT 1 FROM world_claim_windows w WHERE w.id = NEW.claim_window AND w.close_reason = 'activated' AND w.property_id = NEW.property_id)) THEN
      RAISE EXCEPTION 'a committed district ticket closes its holder''s claim window, by its property';
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

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0010). CREATE OR
-- REPLACE resets a function's settings, so the two replaced guards are pinned again.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY[
    'world_config_district_rule(uuid, integer, text)', 'world_claim_windows_guard()', 'world_claim_window_opened_by_ticket()', 'world_district_tickets_guard()', 'world_district_ticket_ended_whole()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- A runtime role that does not own these tables also needs SELECT, INSERT and UPDATE on
-- world_claim_windows (row locks included). Never DELETE.
--
-- Not here, on purpose:
--   * a verified Proofy Core answer to a district's rule, or Core's NFT, trait and role evaluation:
--     no contract exists, so 'local-fixture' is the only authorization source this database accepts;
--   * the explicit rules themselves: they are the local fixture's, not Play configuration (schema v1
--     has no rule field), so which rule tickets a rule change affects is decided by the service
--     (`server/src/world/tickets.ts`) and recorded here as 'rules';
--   * closing a collection to new claims (locked policy B), which still needs Play schema v2.
