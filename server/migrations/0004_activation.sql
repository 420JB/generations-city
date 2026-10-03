-- Activation foundation: the structures a permanent Friend/property activation will be
-- written into, and the database-level guards that make its history permanent.
--
-- Structure only. Nothing here creates a property, an ownership era or an intent, and
-- nothing here touches an existing city's state, sequence, instance or events: an
-- existing city simply gains "activation_rehearsal = false". No service route uses these
-- tables yet.

-- These statements take brief exclusive locks on live tables. If one cannot be had quickly
-- (another session is holding the table), fail and roll back rather than queue readers
-- behind this migration; the deploy can simply be run again.
SET LOCAL lock_timeout = '10s';

-- True when this database is stamped as the production database.
CREATE FUNCTION rc_database_is_production() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM app_meta WHERE key = 'environment' AND value = 'production');
END;
$$;

-- ---------------------------------------------------------------------------------------
-- city: which cities may hold real properties
-- ---------------------------------------------------------------------------------------

-- A city is exactly one of three things:
--   canonical genesis         canonical = true,  origin = 'genesis',      activation_rehearsal = false
--   ordinary demo fixture     canonical = false, origin = 'demo-fixture', activation_rehearsal = false
--   activation rehearsal      canonical = false, origin = 'demo-fixture', activation_rehearsal = true
-- The first two are what 0002 already allowed. A rehearsal is a disposable, empty,
-- genesis-shaped city on staging in which activation can be exercised for real.
ALTER TABLE city ADD COLUMN activation_rehearsal boolean NOT NULL DEFAULT false;

ALTER TABLE city ADD CONSTRAINT city_rehearsal_is_disposable
  CHECK (NOT activation_rehearsal OR (canonical = false AND origin = 'demo-fixture'));

-- Lets other tables reference one exact installation of a city, not merely its id.
ALTER TABLE city ADD CONSTRAINT city_id_instance_unique UNIQUE (id, instance_id);

COMMENT ON COLUMN city.activation_rehearsal IS 'true = a disposable, non-canonical city in which real activation is rehearsed. Never true for a canonical city.';

-- The mirror of city_guard_canonical (0002), and the rules a city row keeps for life:
--   * only a production database holds a canonical city, and a production city is never removed;
--   * a city that may hold properties starts with no buildings;
--   * what a city is (id, installation, canonical, origin, rehearsal) never changes;
--   * its sequence never goes back and never skips, and its state only changes with the sequence.
CREATE FUNCTION city_guard_environment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF rc_database_is_production() THEN
      RAISE EXCEPTION 'a production city cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  -- Only a well-formed canonical row is judged here: a malformed one is left to the table's own constraints.
  IF NEW.canonical AND NEW.origin = 'genesis' AND NOT rc_database_is_production() THEN
    RAISE EXCEPTION 'only a production database can hold a canonical city';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.sequence > 1 THEN
      RAISE EXCEPTION 'a city is installed at sequence 1';
    END IF;
    -- A well-formed city that may hold properties: its buildings must be an object, and an empty one.
    IF (NEW.canonical AND NEW.origin = 'genesis') OR (NEW.activation_rehearsal AND NOT NEW.canonical AND NEW.origin = 'demo-fixture') THEN
      IF json_typeof(NEW.state -> 'buildings') IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM json_object_keys(NEW.state -> 'buildings')) THEN
        RAISE EXCEPTION 'a city that may hold properties must start with no buildings';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.instance_id, NEW.canonical, NEW.origin, NEW.activation_rehearsal)
     IS DISTINCT FROM ROW(OLD.id, OLD.instance_id, OLD.canonical, OLD.origin, OLD.activation_rehearsal) THEN
    RAISE EXCEPTION 'what a city is cannot change: its id, installation, canonical flag, origin and rehearsal flag are permanent';
  END IF;
  IF NEW.sequence <> OLD.sequence AND NEW.sequence <> OLD.sequence + 1 THEN
    RAISE EXCEPTION 'a city sequence moves forward one step at a time';
  END IF;
  IF NEW.sequence = OLD.sequence AND NEW.state::text IS DISTINCT FROM OLD.state::text THEN
    RAISE EXCEPTION 'a city state only changes together with its sequence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER city_guard_environment
  BEFORE INSERT OR UPDATE OR DELETE ON city
  FOR EACH ROW EXECUTE FUNCTION city_guard_environment();

-- ---------------------------------------------------------------------------------------
-- app_meta: the environment stamp every guard relies on
-- ---------------------------------------------------------------------------------------

-- Once a database is stamped production it stays production: the stamp cannot be changed or
-- removed. And a database that holds a non-canonical city cannot be re-stamped production.
CREATE FUNCTION app_meta_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.key = 'environment' AND OLD.value = 'production' THEN
      RAISE EXCEPTION 'a production database stays a production database: its environment stamp is permanent';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.key = 'environment' AND NEW.value = 'production' AND EXISTS (SELECT 1 FROM city WHERE NOT canonical) THEN
    RAISE EXCEPTION 'a database that holds a non-canonical city cannot become a production database';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_meta_guard
  BEFORE INSERT OR UPDATE OR DELETE ON app_meta
  FOR EACH ROW EXECUTE FUNCTION app_meta_guard();

-- ---------------------------------------------------------------------------------------
-- city_events: append-only, enforced
-- ---------------------------------------------------------------------------------------

-- An event is appended at the sequence its city has just reached, and nowhere else. It is
-- never changed. In production it is never removed either. Outside production removal
-- stays possible, for the one operator command that replaces a disposable fixture city with
-- a rehearsal city.
CREATE FUNCTION city_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_sequence bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.sequence INTO current_sequence FROM city c WHERE c.id = NEW.city_id;
    -- An event for a city that does not exist is left to the foreign key to refuse.
    IF FOUND AND NEW.sequence <> current_sequence THEN
      RAISE EXCEPTION 'a city event is appended at the sequence its city has just reached';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'city_events is append-only: an event cannot be changed';
  END IF;
  IF rc_database_is_production() THEN
    RAISE EXCEPTION 'city_events is append-only: a production event cannot be removed';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER city_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON city_events
  FOR EACH ROW EXECUTE FUNCTION city_events_guard();

-- ---------------------------------------------------------------------------------------
-- activation_intents: what a wallet was asked to sign
-- ---------------------------------------------------------------------------------------

-- One row per permanent action a wallet was asked to authorise. The signed fields are
-- written once and never change. V1 knows exactly one collection on one chain.
CREATE TABLE activation_intents (
  -- 32 random bytes as lowercase hex. Also the bytes32 the wallet signs.
  id               text          PRIMARY KEY,
  user_id          uuid          NOT NULL REFERENCES users (id),
  wallet_id        uuid          NOT NULL REFERENCES wallets (id),
  -- The session that asked. Sessions are deleted some time after they end, and the intent outlives them.
  session_id       uuid          REFERENCES sessions (id) ON DELETE SET NULL,
  owner_address    text          NOT NULL,
  chain_id         integer       NOT NULL,
  collection       text          NOT NULL,
  -- uint256 fits. The supported range is narrower: see ai_token_supported.
  token_id         numeric(78,0) NOT NULL,
  family_id        smallint      NOT NULL,
  city_id          text          NOT NULL,
  city_instance_id uuid          NOT NULL,
  district_id      text          NOT NULL,
  ward             integer       NOT NULL,
  plot             integer       NOT NULL,
  plot_id          text          NOT NULL,
  -- The public origin the intent was issued for.
  origin           text          NOT NULL,
  -- The EIP-712 hash that must be signed.
  digest           bytea         NOT NULL,
  issued_at        timestamptz   NOT NULL,
  expires_at       timestamptz   NOT NULL,
  -- Chain block at which ownership was verified when the intent was issued.
  issued_block     bigint        NOT NULL,
  status           text          NOT NULL DEFAULT 'issued',
  committed_at     timestamptz,
  signature        bytea,
  property_id      uuid,
  CONSTRAINT ai_id_shape          CHECK (id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_owner_normalized  CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT ai_canonical_chain   CHECK (chain_id = 4663 AND collection = '0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d'),
  -- The city state holds a Friend id as a JavaScript number: nothing above 2^53 - 1 can be activated.
  CONSTRAINT ai_token_supported   CHECK (token_id >= 0 AND token_id <= 9007199254740991),
  CONSTRAINT ai_family_district   CHECK ((family_id, district_id) IN
    ((0, 'd8'), (1, 'd6'), (2, 'd4'), (3, 'd5'), (4, 'd7'), (5, 'd9'), (6, 'd3'), (7, 'd2'), (8, 'd1'))),
  CONSTRAINT ai_plot_shape        CHECK (ward >= 0 AND plot >= 0 AND plot_id = district_id || '-w' || ward || '-p' || plot),
  CONSTRAINT ai_origin_shape      CHECK (origin ~ '^https?://[^/[:space:]]+$'),
  CONSTRAINT ai_digest_is_32      CHECK (octet_length(digest) = 32),
  CONSTRAINT ai_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT ai_block_nonnegative CHECK (issued_block >= 0),
  CONSTRAINT ai_status_known      CHECK (status IN ('issued', 'committed', 'superseded')),
  -- Committed means exactly: a time, the signature that authorised it, and the property it created.
  CONSTRAINT ai_committed_shape   CHECK ((status = 'committed') =
    (committed_at IS NOT NULL AND signature IS NOT NULL AND property_id IS NOT NULL)),
  CONSTRAINT ai_uncommitted_empty CHECK (status = 'committed' OR
    (committed_at IS NULL AND signature IS NULL AND property_id IS NULL)),
  CONSTRAINT ai_signature_is_65   CHECK (signature IS NULL OR octet_length(signature) = 65),
  -- An intent authorises nothing after it expires.
  CONSTRAINT ai_committed_in_time CHECK (committed_at IS NULL OR (committed_at >= issued_at AND committed_at <= expires_at)),
  CONSTRAINT ai_city              FOREIGN KEY (city_id, city_instance_id) REFERENCES city (id, instance_id),
  CONSTRAINT ai_property_unique   UNIQUE (property_id)
);

-- At most one live intent per wallet and Friend.
CREATE UNIQUE INDEX activation_intents_one_issued
  ON activation_intents (wallet_id, chain_id, collection, token_id) WHERE status = 'issued';
CREATE INDEX activation_intents_expires_at ON activation_intents (expires_at);
CREATE INDEX activation_intents_session_id ON activation_intents (session_id);

COMMENT ON TABLE activation_intents IS 'Signed-intent records for permanent activation. Signed fields are immutable; status moves issued -> committed or issued -> superseded, once.';

-- An intent begins as issued, by one user through their own wallet and session, for a city
-- that may hold properties. The only changes it may ever undergo:
--   issued -> committed, issued -> superseded (each once), and
--   session_id becoming NULL, which is the sessions foreign key doing its normal cleanup.
CREATE FUNCTION activation_intents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'committed' AND rc_database_is_production() THEN
      RAISE EXCEPTION 'a committed activation intent is permanent';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'issued' THEN
      RAISE EXCEPTION 'an activation intent begins as issued';
    END IF;
    -- A wallet that does not exist is left to the foreign key to refuse.
    IF EXISTS (SELECT 1 FROM wallets w WHERE w.id = NEW.wallet_id)
       AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.id = NEW.wallet_id AND w.user_id = NEW.user_id AND w.chain_id = NEW.chain_id AND w.address = NEW.owner_address) THEN
      RAISE EXCEPTION 'an activation intent is issued to one user through their own wallet';
    END IF;
    IF NEW.session_id IS NOT NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = NEW.session_id)
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = NEW.session_id AND s.user_id = NEW.user_id AND s.wallet_id = NEW.wallet_id) THEN
      RAISE EXCEPTION 'an activation intent is issued in a session of the same user and wallet';
    END IF;
    IF EXISTS (SELECT 1 FROM city c WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND NOT (c.canonical OR c.activation_rehearsal)) THEN
      RAISE EXCEPTION 'an activation intent can only be issued for a canonical or rehearsal city';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.user_id, NEW.wallet_id, NEW.owner_address, NEW.chain_id, NEW.collection, NEW.token_id, NEW.family_id,
         NEW.city_id, NEW.city_instance_id, NEW.district_id, NEW.ward, NEW.plot, NEW.plot_id, NEW.origin, NEW.digest,
         NEW.issued_at, NEW.expires_at, NEW.issued_block)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.user_id, OLD.wallet_id, OLD.owner_address, OLD.chain_id, OLD.collection, OLD.token_id, OLD.family_id,
         OLD.city_id, OLD.city_instance_id, OLD.district_id, OLD.ward, OLD.plot, OLD.plot_id, OLD.origin, OLD.digest,
         OLD.issued_at, OLD.expires_at, OLD.issued_block) THEN
    RAISE EXCEPTION 'the signed fields of an activation intent cannot be changed';
  END IF;

  IF NEW.session_id IS DISTINCT FROM OLD.session_id AND NEW.session_id IS NOT NULL THEN
    RAISE EXCEPTION 'an activation intent cannot be moved to another session';
  END IF;

  IF NEW.status = OLD.status THEN
    IF ROW(NEW.committed_at, NEW.signature, NEW.property_id) IS DISTINCT FROM ROW(OLD.committed_at, OLD.signature, OLD.property_id) THEN
      RAISE EXCEPTION 'the outcome of an activation intent cannot be changed';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'issued' OR NEW.status NOT IN ('committed', 'superseded') THEN
    RAISE EXCEPTION 'an activation intent can only move from issued to committed or superseded';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activation_intents_guard
  BEFORE INSERT OR UPDATE OR DELETE ON activation_intents
  FOR EACH ROW EXECUTE FUNCTION activation_intents_guard();

-- ---------------------------------------------------------------------------------------
-- properties: one permanent property per activated Friend
-- ---------------------------------------------------------------------------------------

-- The authority for which Friend has a property, in which city, on which plot. A row is
-- written once and never changes. Who owns it is not here: see ownership_eras.
CREATE TABLE properties (
  id                     uuid          PRIMARY KEY,
  city_id                text          NOT NULL,
  city_instance_id       uuid          NOT NULL,
  chain_id               integer       NOT NULL,
  collection             text          NOT NULL,
  token_id               numeric(78,0) NOT NULL,
  family_id              smallint      NOT NULL,
  district_id            text          NOT NULL,
  ward                   integer       NOT NULL,
  plot                   integer       NOT NULL,
  plot_id                text          NOT NULL,
  -- The key of this property's building in city.state.buildings.
  building_id            text          NOT NULL,
  activated_at           timestamptz   NOT NULL,
  -- The city sequence this activation produced.
  activated_sequence     bigint        NOT NULL,
  activated_by_user_id   uuid          NOT NULL REFERENCES users (id),
  activated_by_wallet_id uuid          NOT NULL REFERENCES wallets (id),
  activation_intent_id   text          NOT NULL REFERENCES activation_intents (id),
  -- Chain block at which ownership was verified immediately before the write.
  verified_block         bigint        NOT NULL,
  CONSTRAINT p_city             FOREIGN KEY (city_id, city_instance_id) REFERENCES city (id, instance_id),
  CONSTRAINT p_event            FOREIGN KEY (city_id, activated_sequence) REFERENCES city_events (city_id, sequence),
  CONSTRAINT p_one_per_friend   UNIQUE (chain_id, collection, token_id),
  CONSTRAINT p_one_per_plot     UNIQUE (city_id, plot_id),
  CONSTRAINT p_one_building     UNIQUE (city_id, building_id),
  CONSTRAINT p_one_per_intent   UNIQUE (activation_intent_id),
  CONSTRAINT p_one_per_sequence UNIQUE (city_id, activated_sequence),
  CONSTRAINT p_id_intent        UNIQUE (id, activation_intent_id),
  CONSTRAINT p_canonical_chain  CHECK (chain_id = 4663 AND collection = '0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d'),
  CONSTRAINT p_token_supported  CHECK (token_id >= 0 AND token_id <= 9007199254740991),
  -- Family geography is permanent: registry family id -> district.
  --   0 Skeleton d8, 1 Mask d6, 2 Family d4, 3 Cellular d5, 4 Asymmetry d7, 5 Hoverer d9, 6 Colossus d3, 7 Sparkling d2, 8 Hollow d1
  CONSTRAINT p_family_district  CHECK ((family_id, district_id) IN
    ((0, 'd8'), (1, 'd6'), (2, 'd4'), (3, 'd5'), (4, 'd7'), (5, 'd9'), (6, 'd3'), (7, 'd2'), (8, 'd1'))),
  CONSTRAINT p_plot_shape       CHECK (ward >= 0 AND plot >= 0 AND plot_id = district_id || '-w' || ward || '-p' || plot),
  CONSTRAINT p_building_shape   CHECK (building_id = 'b-' || token_id::text),
  CONSTRAINT p_sequence_after_install CHECK (activated_sequence >= 2),
  CONSTRAINT p_block_nonnegative CHECK (verified_block >= 0)
);

-- A committed intent points at exactly the property that points back at it.
ALTER TABLE activation_intents ADD CONSTRAINT ai_property
  FOREIGN KEY (property_id, id) REFERENCES properties (id, activation_intent_id);

COMMENT ON TABLE properties IS 'Permanent property identity and location, one per activated Friend. Immutable. The city snapshot projects it as a building.';

-- A property is written once. It is created only in a city that may hold real
-- properties, only as exactly what its intent authorised and while that intent is live,
-- and only beside the event that records it, at the sequence the city has just reached. It
-- is never changed, and in production never removed.
CREATE FUNCTION properties_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a property is permanent: it cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF rc_database_is_production() THEN
      RAISE EXCEPTION 'a property is permanent: it cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM city c WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND (c.canonical OR c.activation_rehearsal)) THEN
    RAISE EXCEPTION 'a property can only exist in a canonical or rehearsal city';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM activation_intents i
     WHERE i.id = NEW.activation_intent_id AND i.status = 'issued'
       AND i.user_id = NEW.activated_by_user_id AND i.wallet_id = NEW.activated_by_wallet_id
       AND i.chain_id = NEW.chain_id AND i.collection = NEW.collection AND i.token_id = NEW.token_id AND i.family_id = NEW.family_id
       AND i.city_id = NEW.city_id AND i.city_instance_id = NEW.city_instance_id
       AND i.district_id = NEW.district_id AND i.ward = NEW.ward AND i.plot = NEW.plot AND i.plot_id = NEW.plot_id
       AND NEW.activated_at >= i.issued_at AND NEW.activated_at <= i.expires_at
       AND NEW.verified_block >= i.issued_block
  ) THEN
    RAISE EXCEPTION 'a property must be exactly what its issued intent authorised';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM city c WHERE c.id = NEW.city_id AND c.instance_id = NEW.city_instance_id AND c.sequence = NEW.activated_sequence)
     OR NOT EXISTS (SELECT 1 FROM city_events e WHERE e.city_id = NEW.city_id AND e.sequence = NEW.activated_sequence AND e.type = 'property.activated') THEN
    RAISE EXCEPTION 'a property must be recorded by a property.activated event at the sequence its city has just reached';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER properties_guard
  BEFORE INSERT OR UPDATE OR DELETE ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_guard();

-- Checked when the transaction commits: a property is never left half-activated. Its
-- intent must have been committed to it, and its first ownership era must exist.
CREATE FUNCTION properties_require_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A property removed again inside the same transaction (outside production) has nothing left to complete.
  IF NOT EXISTS (SELECT 1 FROM properties p WHERE p.id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM activation_intents i WHERE i.id = NEW.activation_intent_id AND i.status = 'committed' AND i.property_id = NEW.id) THEN
    RAISE EXCEPTION 'a property cannot be committed without its activation intent being committed to it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ownership_eras e WHERE e.property_id = NEW.id AND e.era_number = 1) THEN
    RAISE EXCEPTION 'a property cannot be committed without its first ownership era';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- ownership_eras: who a property has belonged to
-- ---------------------------------------------------------------------------------------

-- One row per period of ownership. Era 1 opens at activation. A later era opens when a new
-- owner is recognised after a transfer (not implemented yet). A property with no open era
-- is visible but uncontrolled.
CREATE TABLE ownership_eras (
  id              uuid        PRIMARY KEY,
  property_id     uuid        NOT NULL REFERENCES properties (id),
  era_number      integer     NOT NULL,
  -- The on-chain owner this era belongs to. Always lowercase.
  owner_address   text        NOT NULL,
  -- Set when the owner was a signed-in Rare City user as the era opened; both or neither. They
  -- are opening facts and never change: an era opened for an address Rare City does not know
  -- stays unlinked. How a later owner is recognised belongs to the transfer slice.
  owner_wallet_id uuid        REFERENCES wallets (id),
  owner_user_id   uuid        REFERENCES users (id),
  started_at      timestamptz NOT NULL,
  start_reason    text        NOT NULL,
  -- Chain block at which this owner was verified.
  start_block     bigint      NOT NULL,
  ended_at        timestamptz,
  end_reason      text,
  end_block       bigint,
  CONSTRAINT oe_number_unique      UNIQUE (property_id, era_number),
  CONSTRAINT oe_number_positive    CHECK (era_number >= 1),
  CONSTRAINT oe_owner_normalized   CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT oe_identity_pair      CHECK ((owner_wallet_id IS NULL) = (owner_user_id IS NULL)),
  CONSTRAINT oe_start_reason_known CHECK (start_reason IN ('activation', 'transfer')),
  -- The first era is the activation; every later one follows a transfer.
  CONSTRAINT oe_first_is_activation CHECK ((era_number = 1) = (start_reason = 'activation')),
  CONSTRAINT oe_start_block_nonnegative CHECK (start_block >= 0),
  CONSTRAINT oe_end_reason_known   CHECK (end_reason IS NULL OR end_reason IN ('transfer')),
  CONSTRAINT oe_end_together       CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL) = (end_block IS NULL)),
  CONSTRAINT oe_end_after_start    CHECK (ended_at IS NULL OR (ended_at >= started_at AND end_block >= start_block))
);

-- At most one open era per property.
CREATE UNIQUE INDEX ownership_eras_one_open ON ownership_eras (property_id) WHERE ended_at IS NULL;

COMMENT ON TABLE ownership_eras IS 'Ownership history of a property. Opening facts are immutable; the only change an era ever undergoes is being closed, once.';

-- Eras are numbered 1, 2, 3 ... per property. The only UPDATE is the one-time close.
CREATE FUNCTION ownership_eras_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF rc_database_is_production() THEN
      RAISE EXCEPTION 'ownership history is permanent: an era cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT e.era_number, e.ended_at, e.end_block INTO previous
      FROM ownership_eras e WHERE e.property_id = NEW.property_id ORDER BY e.era_number DESC LIMIT 1;
    IF NEW.era_number <> 1 + COALESCE(previous.era_number, 0) THEN
      RAISE EXCEPTION 'ownership eras are numbered consecutively from 1';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'an ownership era opens open: it is closed later, once';
    END IF;
    IF previous.era_number IS NOT NULL AND (previous.ended_at IS NULL OR NEW.started_at < previous.ended_at OR NEW.start_block < previous.end_block) THEN
      RAISE EXCEPTION 'an ownership era opens only after the one before it has closed';
    END IF;
    -- A wallet that does not exist is left to the foreign key to refuse.
    IF NEW.owner_wallet_id IS NOT NULL AND EXISTS (SELECT 1 FROM wallets w WHERE w.id = NEW.owner_wallet_id)
       AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.id = NEW.owner_wallet_id AND w.user_id = NEW.owner_user_id AND w.address = NEW.owner_address) THEN
      RAISE EXCEPTION 'an ownership era names one owner: the address, its wallet and that wallet''s user';
    END IF;
    IF NEW.era_number = 1 AND EXISTS (SELECT 1 FROM properties p WHERE p.id = NEW.property_id)
       AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.id = NEW.property_id AND p.activated_by_wallet_id = NEW.owner_wallet_id AND p.activated_by_user_id = NEW.owner_user_id
                         AND p.activated_at = NEW.started_at AND p.verified_block = NEW.start_block) THEN
      RAISE EXCEPTION 'the first ownership era belongs to the wallet that activated the property, from the moment and block of the activation';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.property_id, NEW.era_number, NEW.owner_address, NEW.owner_wallet_id, NEW.owner_user_id, NEW.started_at, NEW.start_reason, NEW.start_block)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.property_id, OLD.era_number, OLD.owner_address, OLD.owner_wallet_id, OLD.owner_user_id, OLD.started_at, OLD.start_reason, OLD.start_block) THEN
    RAISE EXCEPTION 'the opening facts of an ownership era cannot be changed';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ownership era can only be closed once';
  END IF;
  IF NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'the only change to an ownership era is closing it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ownership_eras_guard
  BEFORE INSERT OR UPDATE OR DELETE ON ownership_eras
  FOR EACH ROW EXECUTE FUNCTION ownership_eras_guard();

CREATE CONSTRAINT TRIGGER properties_require_completion
  AFTER INSERT ON properties
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION properties_require_completion();

-- ---------------------------------------------------------------------------------------
-- wallets, sessions: what intents and eras rely on does not move
-- ---------------------------------------------------------------------------------------

-- A wallet row is one address on one chain, for good. Intents and ownership eras name a
-- wallet by id and record its address; if the row could be re-pointed at another address
-- they would silently name someone else. Which user a wallet belongs to is deliberately
-- left alone here (0003: a wallet is not assumed to be one person forever).
CREATE FUNCTION wallets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.chain_id, NEW.address) IS DISTINCT FROM ROW(OLD.id, OLD.chain_id, OLD.address) THEN
    RAISE EXCEPTION 'a wallet is one address on one chain: neither can be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallets_guard
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_guard();

-- A session belongs to the user and wallet that opened it. It can end; it cannot be handed on.
CREATE FUNCTION sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.user_id, NEW.wallet_id) IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.wallet_id) THEN
    RAISE EXCEPTION 'a session belongs to the user and wallet that opened it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_guard
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_guard();

-- ---------------------------------------------------------------------------------------
-- The guards read real tables, never a session's temporary ones
-- ---------------------------------------------------------------------------------------

-- Without a fixed search path, a session could create a temporary table named app_meta,
-- city, city_events or activation_intents and every guard above would read that instead.
-- Each guard function is pinned to the schema it was created in, with the temporary schema
-- searched last. This includes city_guard_canonical from 0002, which had the same weakness.
DO $$
DECLARE
  guard text;
BEGIN
  FOREACH guard IN ARRAY ARRAY[
    'rc_database_is_production()', 'city_guard_canonical()', 'city_guard_environment()', 'app_meta_guard()', 'city_events_guard()',
    'activation_intents_guard()', 'properties_guard()', 'properties_require_completion()', 'ownership_eras_guard()',
    'wallets_guard()', 'sessions_guard()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), guard, current_schema());
  END LOOP;
END;
$$;
