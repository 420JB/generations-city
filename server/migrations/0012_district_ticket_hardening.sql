-- District ticket hardening (P1-C2-D2H), on the engine of 0010 and the owner-locked policies D1 to D4
-- of 0011. No policy changes here: this migration makes the database hold the policies it already
-- had, in two places 0011 left to the service.
--
--   LEGACY LEASES (D2). 0011 gave the holder of every ticket already active a claim window with
--       exactly that ticket's own lease ('migration-0011'), and 0010 allowed leases of up to an hour.
--       D2 is 900 seconds from the first issuance, never renewed. Here every such lease still open is
--       CUT, never lengthened, to end no later than 900 seconds after its claim was first issued (the
--       first ticket of a 0010 reissue chain: a reissue kept what was left of the lease it replaced).
--       A claim whose cut end has passed is ended here, exactly as the next ticket transaction would
--       end it: its tickets expired, their fallback slots returned to the gap pool (a later entrant
--       reuses them at their next generation), its window lapsed. A cut row keeps the end it had
--       before in `legacy_expires_at`. Nothing else is changed: tickets and windows that had already
--       ended, properties, events, freezes, activators, adoptions, rotations and slots are left
--       exactly as they are.
--   CONFIGURATION GATES (D1, D4). 0011 checks a ticket against the configuration it was ISSUED on.
--       The service also judges it against the configuration that governs NOW, at activation and in
--       every adoption; the database now does too, from the persisted copies only (the governing
--       adoption, that version's canonical text and its recorded geometry):
--         * a rotation is exactly its governing configuration's unrestricted districts, in order;
--         * an adoption leaves no active ticket its configuration does not authorize: a fallback
--           ticket on a district of the rotation that is unrestricted, a rule ticket recording
--           exactly the Proofy rule the configuration names for its district (an affected ticket is
--           superseded in the adoption's own transaction, D4);
--         * a ticket is committed only on a district of the governing geometry, under the same two
--           rules, while its rotation follows the governing configuration, and within a claim window
--           of at most 900 seconds.
--       This is consistency with stored configuration, NOT eligibility: whether a player holds an
--       NFT, meets a trait, role or rule, or qualifies at all is still decided outside the database
--       (locally by the server-trusted fixture, 'local-fixture'; in production by a Proofy Core
--       contract that does not exist). A committed property is never judged again: the checks run
--       only on active tickets and on the transition that commits one.
--
-- LOCAL ONLY, like 0007, 0010 and 0011: no other database holds a ticket or window, so there the data
-- steps below change no row.
--
-- Constraints in this file are permanent (migrations never drop one), so table CHECKs state only
-- shape. Policy lives in the guard functions, which a later migration can replace.

-- Locking and altering the ticket tables, and reading them whole. If a lock cannot be had quickly,
-- fail and roll back rather than queue players behind this migration.
SET LOCAL lock_timeout = '10s';

-- No other session reads or writes a rotation, window, ticket or slot until this transaction ends:
-- the cut below is computed and applied on one unchanging picture, and the brief moment its two
-- guards are off (below) is invisible to everyone else. Taken in the order every ticket transaction
-- takes them (rotation, windows, tickets, slots), so no ticket transaction holds one while waiting
-- for another this migration holds.
LOCK TABLE world_assignment_rotations, world_claim_windows, world_district_tickets, world_assignment_slots IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------------------
-- Shapes: the end a cut lease had before
-- ---------------------------------------------------------------------------------------

ALTER TABLE world_claim_windows
  -- The end this window had before migration 0012 cut it to D2's 900 seconds. NULL for every window it did not cut.
  ADD COLUMN legacy_expires_at timestamptz,
  ADD CONSTRAINT wcw_legacy_shape CHECK (legacy_expires_at IS NULL OR legacy_expires_at > expires_at);

ALTER TABLE world_district_tickets
  -- The end this ticket had before migration 0012 cut it to D2's 900 seconds. NULL for every ticket it did not cut.
  ADD COLUMN legacy_expires_at timestamptz,
  ADD CONSTRAINT wdt_legacy_shape CHECK (legacy_expires_at IS NULL OR legacy_expires_at > expires_at);

-- ---------------------------------------------------------------------------------------
-- Legacy leases (D2): what each open legacy lease is cut to
-- ---------------------------------------------------------------------------------------

-- When each ticket issued before 0011 was first claimed: the issuance of the first ticket of its 0010
-- reissue chain (a reissue replaced a superseded ticket of the same holder, for no longer than it had).
CREATE TEMP TABLE d2h_first_claim ON COMMIT DROP AS
WITH RECURSIVE chain AS (
  SELECT t.id AS leaf, t.reissued_from AS up, t.issued_at FROM world_district_tickets t WHERE t.claim_window IS NULL
  UNION ALL
  SELECT c.leaf, p.reissued_from, p.issued_at FROM chain c JOIN world_district_tickets p ON p.id = c.up
)
SELECT leaf AS id, min(issued_at) AS claimed_at FROM chain GROUP BY leaf;

-- Every open window 0011 recorded for a legacy ticket, cut to 900 seconds after that ticket's claim
-- (or after the window opened, which is never earlier, if the ticket cannot be found). Never later
-- than it was. The table CHECK (0011) needs a window to end after it opened: one whose claim had run
-- out before the window even opened ends one microsecond after it, already over, and lapses below.
CREATE TEMP TABLE d2h_window_cut ON COMMIT DROP AS
SELECT cut.id, cut.expires_at
  FROM (
    SELECT w.id, w.expires_at AS was, greatest(least(w.expires_at, coalesce(f.claimed_at, w.opened_at) + interval '900 seconds'), w.opened_at + interval '1 microsecond') AS expires_at
      FROM world_claim_windows w
      LEFT JOIN LATERAL (
        SELECT min(c.claimed_at) AS claimed_at
          FROM world_district_tickets t JOIN d2h_first_claim c ON c.id = t.id
         WHERE t.world_id = w.world_id AND t.actor_discord_user_id = w.actor_discord_user_id AND t.claim_window IS NULL AND t.issued_at = w.opened_at
      ) f ON true
     WHERE w.opened_by = 'migration-0011' AND w.closed_at IS NULL
  ) cut
 WHERE cut.expires_at < cut.was;

-- Every active ticket on a legacy lease: one issued before 0011 (to 900 seconds after its claim), and
-- one issued since in a window cut above (to the window's new end). Never later than it was, and,
-- as the table CHECK (0010) needs, after it was issued: a ticket issued after its claim had already
-- run out ends one microsecond after its issuance, already over, and is expired below.
CREATE TEMP TABLE d2h_ticket_cut ON COMMIT DROP AS
SELECT cut.id, cut.expires_at
  FROM (
    SELECT t.id, t.expires_at AS was, greatest(least(t.expires_at, c.claimed_at + interval '900 seconds'), t.issued_at + interval '1 microsecond') AS expires_at
      FROM world_district_tickets t JOIN d2h_first_claim c ON c.id = t.id
     WHERE t.status = 'active'
    UNION ALL
    SELECT t.id, t.expires_at, greatest(least(t.expires_at, w.expires_at), t.issued_at + interval '1 microsecond')
      FROM world_district_tickets t JOIN d2h_window_cut w ON w.id = t.claim_window
     WHERE t.status = 'active'
  ) cut
 WHERE cut.expires_at < cut.was;

-- ---------------------------------------------------------------------------------------
-- Legacy leases (D2): the cut, past the two guards that keep a lease as it was issued
-- ---------------------------------------------------------------------------------------

-- 0010's and 0011's guards keep every ticket's and window's lease exactly as issued, for good, so no
-- application session can shorten (or lengthen) one. Only their owner (the role that ran 0010 and
-- 0011, which runs this migration) can turn a table's trigger off; a superuser is not needed and a
-- non-owner runtime role cannot. They are off only for these two UPDATEs, which change nothing but
-- `expires_at` and `legacy_expires_at` of the rows listed above, and on again before anything else
-- happens, inside this transaction, behind the locks above: no other session ever sees them off.
-- The checks after them prove they are on again before this transaction can commit.
ALTER TABLE world_claim_windows DISABLE TRIGGER world_claim_windows_guard;
ALTER TABLE world_district_tickets DISABLE TRIGGER world_district_tickets_guard;

UPDATE world_claim_windows w SET legacy_expires_at = w.expires_at, expires_at = c.expires_at FROM d2h_window_cut c WHERE w.id = c.id;
UPDATE world_district_tickets t SET legacy_expires_at = t.expires_at, expires_at = c.expires_at FROM d2h_ticket_cut c WHERE t.id = c.id;

-- A table with trigger events still queued cannot be altered: the cut queued 0010's commit-time check
-- of every ticket it touched (all still active, which that check passes). Run those checks now, and
-- defer the check again for everything after, as it always is.
SET CONSTRAINTS world_district_ticket_ended_whole IMMEDIATE;
SET CONSTRAINTS world_district_ticket_ended_whole DEFERRED;

ALTER TABLE world_claim_windows ENABLE TRIGGER world_claim_windows_guard;
ALTER TABLE world_district_tickets ENABLE TRIGGER world_district_tickets_guard;

-- ---------------------------------------------------------------------------------------
-- Configuration gates (D1): a configuration version's districts, as the database reads them
-- ---------------------------------------------------------------------------------------

-- Every district of a configuration version, in configuration order, with the Proofy verification rule
-- it names (NULL: an unrestricted district). The same reading as 0011's world_config_district_rule.
CREATE FUNCTION world_config_district_rules(p_world uuid, p_version integer) RETURNS TABLE (district_key text, verification_rule_id bigint, ordinal_position bigint)
LANGUAGE sql STABLE STRICT AS $$
  SELECT d.v ->> 'key',
         CASE WHEN jsonb_typeof(d.v -> 'proofyRule') = 'object' AND jsonb_typeof(d.v -> 'proofyRule' -> 'verificationRuleId') = 'number'
              THEN (d.v -> 'proofyRule' ->> 'verificationRuleId')::bigint END,
         d.n
    FROM world_config_versions v, jsonb_array_elements(v.config_canonical::jsonb -> 'districts') WITH ORDINALITY AS d(v, n)
   WHERE v.world_id = p_world AND v.version = p_version
$$;

-- The default rotation an accepted configuration version names (D1, `defaultRotationDistricts` in
-- `src/world/assignment.ts`): its unrestricted districts, in configuration order. NULL for a version
-- that does not exist or was not accepted.
CREATE FUNCTION world_config_default_districts(p_world uuid, p_version integer) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM world_config_versions v WHERE v.world_id = p_world AND v.version = p_version AND v.verdict = 'accepted')
              THEN (SELECT coalesce(jsonb_agg(to_jsonb(r.district_key) ORDER BY r.ordinal_position), '[]'::jsonb)
                      FROM world_config_district_rules(p_world, p_version) r WHERE r.verification_rule_id IS NULL) END
$$;

-- ---------------------------------------------------------------------------------------
-- Guards, replaced (every rule they had kept)
-- ---------------------------------------------------------------------------------------

-- 0010's rotation guard, every rule kept, and (0012): its districts are exactly its governing
-- configuration's unrestricted districts, in configuration order (D1). Checked when a rotation is
-- created or its basis or districts change; a configuration version never changes after it is recorded.
CREATE OR REPLACE FUNCTION world_assignment_rotations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  geometry record;
  rebased boolean;
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
    rebased := true;
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
    rebased := NEW.basis_config_version IS DISTINCT FROM OLD.basis_config_version OR NEW.districts IS DISTINCT FROM OLD.districts;
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
  IF rebased AND NEW.districts IS DISTINCT FROM world_config_default_districts(NEW.world_id, NEW.basis_config_version) THEN
    RAISE EXCEPTION 'a world''s assignment rotation is exactly its governing configuration''s unrestricted districts, in configuration order';
  END IF;
  RETURN NEW;
END;
$$;

-- 0011's window guard, every rule kept, and (0012): `legacy_expires_at` is written only by this
-- migration's cut: never on a new window, and never changed.
CREATE OR REPLACE FUNCTION world_claim_windows_guard() RETURNS trigger
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
    IF NEW.opened_by <> 'issuance' OR NEW.closed_at IS NOT NULL OR NEW.close_reason IS NOT NULL OR NEW.property_id IS NOT NULL OR NEW.legacy_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'a claim window is opened, open, only by the issuance of a ticket';
    END IF;
    -- The lease is this database's, exactly: whatever the caller asked for is replaced.
    NEW.opened_at := clock_timestamp();
    NEW.expires_at := NEW.opened_at + interval '900 seconds';
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.world_id, NEW.actor_discord_user_id, NEW.actor_core_user_id, NEW.opened_at, NEW.expires_at, NEW.opened_by, NEW.legacy_expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.world_id, OLD.actor_discord_user_id, OLD.actor_core_user_id, OLD.opened_at, OLD.expires_at, OLD.opened_by, OLD.legacy_expires_at) THEN
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

-- 0011's ticket guard, every rule kept (and every message, which the service matches), and (0012):
--   * `legacy_expires_at` is written only by this migration's cut: never on issue, and never changed;
--   * a ticket is issued only in a claim window of at most 900 seconds (D2), and a fallback ticket
--     only on a district of its rotation;
--   * a ticket is committed only against the configuration that governs NOW (its latest adoption),
--     whatever version it was issued on: on a district of that version's recorded geometry; a fallback
--     ticket on a district of the rotation that version leaves unrestricted; a rule ticket recording
--     exactly the Proofy rule that version names for its district; while the rotation follows that
--     version; and within a claim window of at most 900 seconds.
CREATE OR REPLACE FUNCTION world_district_tickets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rotation record;
  source record;
  prop record;
  win record;
  district_rule bigint;
  governing integer;
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
  SELECT r.epoch, r.basis_config_version, r.basis_config_hash, r.layout_geometry_fingerprint, r.districts INTO rotation FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a district ticket belongs to its world''s rotation (foreign key world_district_tickets -> world_assignment_rotations)' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.ended_at IS NOT NULL OR NEW.end_reason IS NOT NULL OR NEW.property_id IS NOT NULL OR NEW.committed_sequence IS NOT NULL OR NEW.supersede_cause IS NOT NULL
       OR NEW.legacy_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'a district ticket is issued active';
    END IF;
    -- The claim window (D2): its holder's, of this world, open; the ticket ends exactly when it ends.
    SELECT w.world_id, w.actor_discord_user_id, w.actor_core_user_id, w.opened_at, w.expires_at, w.opened_by, w.closed_at INTO win FROM world_claim_windows w WHERE w.id = NEW.claim_window;
    IF NOT FOUND OR win.world_id <> NEW.world_id OR win.actor_discord_user_id <> NEW.actor_discord_user_id OR win.actor_core_user_id <> NEW.actor_core_user_id OR win.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a district ticket is issued in its holder''s open claim window of its world';
    END IF;
    IF win.expires_at > win.opened_at + interval '900 seconds' THEN
      RAISE EXCEPTION 'a district ticket is issued only in a claim window of at most 900 seconds';
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
    IF NEW.kind = 'fallback' AND NOT (rotation.districts ? NEW.district_key) THEN
      RAISE EXCEPTION 'a fallback ticket names a district of its rotation';
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
         NEW.claim_window, NEW.gate_rule_id, NEW.authorization_source, NEW.legacy_expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.world_id, OLD.play_environment, OLD.play_game_key, OLD.play_installation_id, OLD.discord_guild_id, OLD.actor_discord_user_id, OLD.actor_core_user_id,
         OLD.issued_in_play_session, OLD.kind, OLD.district_key, OLD.district_geometry_fingerprint, OLD.epoch, OLD.ordinal, OLD.generation, OLD.asset, OLD.rule_ref,
         OLD.config_version, OLD.config_hash, OLD.layout_geometry_fingerprint, OLD.issued_at, OLD.expires_at, OLD.reissued_from,
         OLD.claim_window, OLD.gate_rule_id, OLD.authorization_source, OLD.legacy_expires_at) THEN
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
    -- D2, whatever the ticket recorded: within a claim window of at most 900 seconds, ending when it ends
    -- (a ticket issued before 0011 has no window: at most 900 seconds from its own issuance).
    IF (OLD.claim_window IS NULL AND OLD.expires_at > OLD.issued_at + interval '900 seconds')
       OR EXISTS (SELECT 1 FROM world_claim_windows w WHERE w.id = OLD.claim_window AND (w.expires_at > w.opened_at + interval '900 seconds' OR OLD.expires_at > w.expires_at)) THEN
      RAISE EXCEPTION 'a district ticket is committed only within a claim window of at most 900 seconds';
    END IF;
    -- The configuration that governs the world NOW, not the one the ticket was issued on (D1, D4).
    governing := (SELECT a.version FROM world_config_adoptions a WHERE a.world_id = OLD.world_id ORDER BY a.adoption_seq DESC LIMIT 1);
    IF governing IS NULL OR NOT EXISTS (
      SELECT 1 FROM world_config_geometries g
       WHERE g.world_id = OLD.world_id AND g.version = governing AND g.layout_geometry_fingerprint = OLD.layout_geometry_fingerprint
         AND g.districts @> jsonb_build_array(jsonb_build_object('key', OLD.district_key, 'geometryFingerprint', OLD.district_geometry_fingerprint))
    ) THEN
      RAISE EXCEPTION 'a district ticket is committed only on a district of the geometry that governs its world';
    END IF;
    district_rule := world_config_district_rule(OLD.world_id, governing, OLD.district_key);
    IF OLD.kind = 'fallback' AND (district_rule IS NOT NULL OR NOT (rotation.districts ? OLD.district_key)) THEN
      RAISE EXCEPTION 'a fallback ticket is committed only on an unrestricted district of the rotation that governs';
    END IF;
    IF OLD.kind = 'rule' AND OLD.gate_rule_id IS DISTINCT FROM district_rule THEN
      RAISE EXCEPTION 'a rule ticket is committed only while the configuration that governs names its district''s Proofy rule as the ticket recorded it';
    END IF;
    IF governing <> rotation.basis_config_version THEN
      RAISE EXCEPTION 'a district ticket is committed only while its rotation follows the configuration that governs its world';
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

-- 0010's commit-time check of an adoption, every rule kept, and (0012): what the adoption leaves
-- governing is what the world's rotation and live tickets stand on. The rotation is exactly that
-- version's unrestricted districts in order; every active ticket is of the rotation's epoch, on a
-- district of that version; a fallback one on a district of the rotation that is unrestricted, a rule
-- one recording exactly the Proofy rule that version names for its district. A rule change only
-- (D4) must therefore supersede, in the adoption's own transaction, exactly the rule tickets it
-- affects; any other change begins a new epoch (0010). Tickets that have ended are never judged again.
CREATE OR REPLACE FUNCTION world_config_adoption_moves_rotation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rotation record;
  governing integer;
BEGIN
  SELECT r.epoch, r.basis_config_version, r.districts INTO rotation FROM world_assignment_rotations r WHERE r.world_id = NEW.world_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  governing := (SELECT a.version FROM world_config_adoptions a WHERE a.world_id = NEW.world_id ORDER BY a.adoption_seq DESC LIMIT 1);
  IF rotation.basis_config_version IS DISTINCT FROM governing THEN
    RAISE EXCEPTION 'a world''s assignment rotation follows every configuration adoption, in the adoption''s transaction';
  END IF;
  IF rotation.districts IS DISTINCT FROM world_config_default_districts(NEW.world_id, governing) THEN
    RAISE EXCEPTION 'a world''s assignment rotation is exactly its governing configuration''s unrestricted districts, in configuration order';
  END IF;
  IF EXISTS (
    SELECT 1 FROM world_district_tickets t
      LEFT JOIN world_config_district_rules(NEW.world_id, governing) d ON d.district_key = t.district_key
     WHERE t.world_id = NEW.world_id AND t.status = 'active'
       AND (t.epoch <> rotation.epoch OR d.district_key IS NULL
            OR (t.kind = 'fallback' AND (d.verification_rule_id IS NOT NULL OR NOT (rotation.districts ? t.district_key)))
            OR (t.kind = 'rule' AND t.gate_rule_id IS DISTINCT FROM d.verification_rule_id))
  ) THEN
    RAISE EXCEPTION 'an adoption leaves no active district ticket its configuration does not authorize: an affected ticket is superseded in the adoption''s transaction';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Legacy leases (D2): a claim whose cut end has passed ends now, through the guards above
-- ---------------------------------------------------------------------------------------

-- Exactly as `expireLapsed` (server/src/world/rotation.ts) ends one, for the legacy claims only: the
-- ticket expires, its fallback slot returns to the gap pool, and the window lapses once its holder has
-- no active ticket left. Every step is a transition the guards allow on their own.
CREATE TEMP TABLE d2h_expired (world_id uuid, ordinal bigint) ON COMMIT DROP;
WITH ended AS (
  UPDATE world_district_tickets t SET status = 'expired', end_reason = 'expired'
   WHERE t.status = 'active' AND t.expires_at <= clock_timestamp()
     AND (t.claim_window IS NULL OR EXISTS (SELECT 1 FROM world_claim_windows w WHERE w.id = t.claim_window AND w.opened_by = 'migration-0011'))
  RETURNING t.world_id, t.ordinal
)
INSERT INTO d2h_expired SELECT world_id, ordinal FROM ended WHERE ordinal IS NOT NULL;

UPDATE world_assignment_slots s SET state = 'free' FROM d2h_expired e WHERE s.world_id = e.world_id AND s.ordinal = e.ordinal AND s.state = 'held';

UPDATE world_claim_windows w SET close_reason = 'lapsed'
 WHERE w.opened_by = 'migration-0011' AND w.closed_at IS NULL AND w.expires_at <= clock_timestamp()
   AND NOT EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.world_id = w.world_id AND t.actor_discord_user_id = w.actor_discord_user_id AND t.status = 'active');

-- ---------------------------------------------------------------------------------------
-- What must hold before this transaction may commit, or it rolls back whole
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  off text;
BEGIN
  SELECT string_agg(g.tgname, ', ') INTO off
    FROM pg_trigger g
   WHERE g.tgrelid IN ('world_claim_windows'::regclass, 'world_district_tickets'::regclass) AND NOT g.tgisinternal AND g.tgenabled <> 'O';
  IF off IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0012: a ticket or window guard is not on again (%)', off;
  END IF;
  IF EXISTS (SELECT 1 FROM world_claim_windows w WHERE w.closed_at IS NULL AND w.expires_at > w.opened_at + interval '900 seconds') THEN
    RAISE EXCEPTION 'migration 0012: an open claim window still lasts longer than 900 seconds';
  END IF;
  IF EXISTS (
    SELECT 1 FROM world_district_tickets t
      LEFT JOIN d2h_first_claim c ON c.id = t.id
      LEFT JOIN world_claim_windows w ON w.id = t.claim_window
     WHERE t.status = 'active'
       AND ((t.claim_window IS NULL AND (t.expires_at <= clock_timestamp() OR t.expires_at > c.claimed_at + interval '900 seconds'))
            OR (w.opened_by = 'migration-0011' AND t.expires_at <= clock_timestamp())
            OR (t.claim_window IS NOT NULL AND t.expires_at <> w.expires_at))
  ) THEN
    RAISE EXCEPTION 'migration 0012: an active ticket still runs past its claim''s 900 seconds, or past its window';
  END IF;
  IF EXISTS (SELECT 1 FROM world_claim_windows w WHERE w.closed_at IS NULL AND w.expires_at <= clock_timestamp() AND w.opened_by = 'migration-0011') THEN
    RAISE EXCEPTION 'migration 0012: a legacy claim window that ran out is still open';
  END IF;
  IF EXISTS (SELECT 1 FROM world_assignment_rotations r WHERE r.districts IS DISTINCT FROM world_config_default_districts(r.world_id, r.basis_config_version)) THEN
    RAISE EXCEPTION 'migration 0012: a rotation is not its governing configuration''s unrestricted districts in order; fix it before this migration';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones (as in 0004 to 0011). CREATE OR
-- REPLACE resets a function's settings, so the replaced guards are pinned again.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY[
    'world_config_district_rules(uuid, integer)', 'world_config_default_districts(uuid, integer)', 'world_assignment_rotations_guard()', 'world_claim_windows_guard()',
    'world_district_tickets_guard()', 'world_config_adoption_moves_rotation()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges, and what is deliberately not here
-- ---------------------------------------------------------------------------------------

-- Running this migration needs the owner of world_claim_windows and world_district_tickets (to turn
-- their guards off for the cut above, and to add columns); a runtime role that does not own them can
-- do neither. It needs no new privilege at run time: the guards read world_config_versions,
-- world_config_adoptions and world_config_geometries, which 0010 already lists.
--
-- Not here, on purpose:
--   * eligibility: a player's NFTs, traits, roles and rule answers are never read or checked here;
--     configuration consistency is no substitute for a verified Proofy Core answer (none exists, so
--     'local-fixture' is still the only authorization source this database accepts);
--   * the explicit collection/trait rules: they are the local fixture's, not configuration, so which
--     rule tickets a fixture change affects is still decided by the service (`server/src/world/tickets.ts`);
--   * a fallback ticket for a player whose every NFT an explicit rule sends to a restricted district
--     they do not qualify for (an open owner decision): unchanged, and still refused at activation;
--   * closing a collection to new claims (locked policy B), which still needs Play schema v2.
