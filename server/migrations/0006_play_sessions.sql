-- Play sessions: a player who launched Rare City from Proofy Play, kept signed in to the one
-- city that launch opened.
--
-- A Play run token opens a city once (Play redeems it once). A play session is what lets the
-- same browser read that city again, after a reload or in a new tab, without another launch.
-- It is opened only by a launch that Play redeemed and the world store accepted, and it names
-- exactly what that launch established:
--   the player     Play's redeemed run: the Discord user id Proofy Core signed (Core read it
--                  from its own Discord sign-in, checked live guild membership and Play
--                  entitlement, then signed it; Play verified that and pinned it to the run);
--   the city       the world the launch opened, through its permanent Play binding (0005).
--
-- Structure only. No session is created here, and nothing here changes an existing row: the
-- Rare Friends city, its wallet users, wallets and sessions (0003, 0004) and the worlds of
-- 0005 are left exactly as they are. A play session is not a wallet session and never makes a
-- `users` row: Rare City keeps no second identity for a Proofy player. The Discord user id is
-- recorded as Proofy said it, and only for the session's lifetime and retention.
--
-- Constraints in this file are permanent (migrations never drop one), so table CHECKs state
-- only shape. Rules that are policy live in the guard function, which a later migration can
-- replace.

SET LOCAL lock_timeout = '10s';

-- A session is scoped by a foreign key to the exact binding its world has: the world, its
-- Play environment, game, installation and Discord server together. A session can therefore
-- never name a world with another installation's or another environment's identity, whatever
-- the service writes. The binding's primary key already makes these columns unique; this
-- states it in the form a foreign key needs. No row changes.
ALTER TABLE world_play_bindings
  ADD CONSTRAINT wpb_session_scope UNIQUE (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id);

CREATE TABLE play_sessions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the cookie value. The value itself is never stored.
  token_hash            bytea       NOT NULL,
  world_id              uuid        NOT NULL,
  play_environment      text        NOT NULL,
  play_game_key         text        NOT NULL,
  play_installation_id  uuid        NOT NULL,
  discord_guild_id      text        NOT NULL,
  -- The player, as Play's redeemed run named them. The Discord user id is the canonical
  -- Proofy player identity; the Core user id is Core's opaque companion, never interpreted.
  discord_user_id       text        NOT NULL,
  core_user_id          text        NOT NULL,
  -- A presentation snapshot from the launch. Never an identity.
  display_name          text        NOT NULL,
  -- The run that opened the session. One run opens at most one session.
  play_run_id           uuid        NOT NULL,
  -- What the run was pinned to, for the record.
  launch_config_version integer     NOT NULL,
  launch_config_hash    text        NOT NULL,
  -- Play's own end of the run. A session never outlives it.
  run_expires_at        timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  -- Set by sign-out, by a newer launch in the same browser, or when Play says the
  -- installation is no longer active. Never cleared.
  revoked_at            timestamptz,
  CONSTRAINT play_sessions_token_hash_is_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT play_sessions_token_hash_unique    UNIQUE (token_hash),
  CONSTRAINT play_sessions_one_per_run          UNIQUE (play_environment, play_run_id),
  CONSTRAINT play_sessions_binding              FOREIGN KEY (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id)
                                                REFERENCES world_play_bindings (world_id, play_environment, play_game_key, play_installation_id, discord_guild_id),
  CONSTRAINT play_sessions_environment_known    CHECK (play_environment IN ('dev', 'test', 'staging', 'live')),
  CONSTRAINT play_sessions_game_key_shape       CHECK (play_game_key ~ '^[a-z][a-z0-9-]{1,62}[a-z0-9]$'),
  CONSTRAINT play_sessions_guild_id_shape       CHECK (discord_guild_id ~ '^[0-9]{15,25}$'),
  CONSTRAINT play_sessions_user_id_shape        CHECK (discord_user_id ~ '^[0-9]{15,25}$'),
  CONSTRAINT play_sessions_core_user_id_shape   CHECK (core_user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT play_sessions_display_name_length  CHECK (char_length(display_name) BETWEEN 1 AND 100),
  CONSTRAINT play_sessions_config_version_positive CHECK (launch_config_version > 0),
  CONSTRAINT play_sessions_config_hash_shape    CHECK (launch_config_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT play_sessions_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT play_sessions_within_run           CHECK (expires_at <= run_expires_at)
);

CREATE INDEX play_sessions_expires_at ON play_sessions (expires_at);
CREATE INDEX play_sessions_world_player ON play_sessions (world_id, discord_user_id);

COMMENT ON TABLE play_sessions IS 'Proofy Play gameplay sessions. token_hash is SHA-256 of the cookie value; the value itself is never stored. Each names one player and one world binding.';

-- A play session is opened live, for the player and the binding it names, and lasts at most as
-- long as it was given. It can end; it cannot be handed on, extended or revived. Ended
-- sessions may be deleted (the service tidies them after a retention period); a live one may
-- not be, so a session cannot be made to vanish while a browser still holds it.
CREATE FUNCTION play_sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a play session is opened live';
    END IF;
    IF NEW.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'a play session cannot be opened already expired';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.revoked_at IS NULL AND OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'a live play session cannot be removed: revoke it';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.token_hash, NEW.world_id, NEW.play_environment, NEW.play_game_key, NEW.play_installation_id, NEW.discord_guild_id,
         NEW.discord_user_id, NEW.core_user_id, NEW.display_name, NEW.play_run_id, NEW.launch_config_version, NEW.launch_config_hash,
         NEW.run_expires_at, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.token_hash, OLD.world_id, OLD.play_environment, OLD.play_game_key, OLD.play_installation_id, OLD.discord_guild_id,
         OLD.discord_user_id, OLD.core_user_id, OLD.display_name, OLD.play_run_id, OLD.launch_config_version, OLD.launch_config_hash,
         OLD.run_expires_at, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a play session keeps the player, the city, the credential and the lifetime it was opened with';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked play session stays revoked';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER play_sessions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON play_sessions
  FOR EACH ROW EXECUTE FUNCTION play_sessions_guard();

-- The guard reads no table, but is pinned like every other guard (0004, 0005).
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.play_sessions_guard() SET search_path = %I, pg_temp', current_schema(), current_schema());
END;
$$;

-- Privileges a runtime role that does not own this table needs: SELECT and INSERT, UPDATE
-- (revoked_at) to end a session, and DELETE to tidy ended ones; SELECT on worlds and
-- world_play_bindings to read a session's city. The foreign key check runs as the owner.
