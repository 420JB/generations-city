-- Identity: who a visitor is, proven by a wallet signature.
--
-- Structure only. No user, wallet or session is created here; they appear when someone
-- signs in. Nothing in this migration touches the city, and nothing here records
-- properties or ownership of Friends: ownership is read from the chain, never stored.

-- A person, as Rare City knows them. Deliberately not keyed by a wallet address: a user
-- may link more wallets later, and a wallet is not assumed to be one person forever.
CREATE TABLE users (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE users IS 'Stable server identity. Created the first time a wallet signs in.';

-- A wallet that has proven control of its address with a signed challenge.
CREATE TABLE wallets (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users (id),
  -- EIP-155 chain the sign-in was bound to.
  chain_id         integer     NOT NULL,
  -- Always lowercase hex. EIP-55 checksum case is presentation, applied when read, so two
  -- spellings of one address can never become two rows.
  address          text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- The most recent successful signed challenge for this wallet.
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_chain_positive CHECK (chain_id > 0),
  CONSTRAINT wallets_address_normalized CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT wallets_chain_address_unique UNIQUE (chain_id, address)
);

CREATE INDEX wallets_user_id ON wallets (user_id);

COMMENT ON TABLE wallets IS 'Wallets that signed in. One user may hold several; an address is unique per chain.';

-- A signed-in browser. The browser holds an opaque random credential in a cookie; only
-- its SHA-256 is stored, so reading this table yields nothing that can be presented.
CREATE TABLE sessions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea       NOT NULL,
  user_id    uuid        NOT NULL REFERENCES users (id),
  -- The wallet whose signature opened this session.
  wallet_id  uuid        NOT NULL REFERENCES wallets (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set by sign-out, or when the same browser signs in again. Never cleared.
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_is_sha256 CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_id ON sessions (user_id);

COMMENT ON TABLE sessions IS 'Server sessions. token_hash is SHA-256 of the cookie value; the value itself is never stored.';

-- One-time sign-in challenges. A row is the exact text a wallet was asked to sign, bound
-- to one address and one chain. It authenticates at most once and only before it expires.
CREATE TABLE auth_challenges (
  nonce       text        PRIMARY KEY,
  chain_id    integer     NOT NULL,
  address     text        NOT NULL,
  -- The EIP-4361 message as issued. Verification uses this copy, never one sent back.
  message     text        NOT NULL,
  issued_at   timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  -- Set in the same transaction that creates the session. A consumed nonce is dead.
  consumed_at timestamptz,
  CONSTRAINT auth_challenges_nonce_shape CHECK (nonce ~ '^[0-9a-f]{32}$'),
  CONSTRAINT auth_challenges_chain_positive CHECK (chain_id > 0),
  CONSTRAINT auth_challenges_address_normalized CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT auth_challenges_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE INDEX auth_challenges_expires_at ON auth_challenges (expires_at);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

COMMENT ON TABLE auth_challenges IS 'Single-use sign-in challenges. The service deletes dead ones and keeps only the newest.';
