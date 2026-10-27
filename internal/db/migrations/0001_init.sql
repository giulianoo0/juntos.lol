CREATE TABLE accounts (
    id                  bigserial PRIMARY KEY,
    discord_id          text NOT NULL UNIQUE,
    nickname            text NOT NULL,
    avatar              text NOT NULL DEFAULT '',
    visibility          text NOT NULL DEFAULT 'private',
    discord_username    text NOT NULL DEFAULT '',
    discord_global_name text NOT NULL DEFAULT '',
    discord_public      boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    sessions            bigint NOT NULL DEFAULT 0,
    watched_seconds     bigint NOT NULL DEFAULT 0
);

-- Only the sha256 of the cookie is kept: a leaked dump signs no one in.
CREATE TABLE account_sessions (
    token_hash bytea PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX account_sessions_expires_at ON account_sessions (expires_at);

-- One row per pair, the smaller id first.
CREATE TABLE friendships (
    a          bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    b          bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (a, b),
    CHECK (a < b)
);
CREATE INDEX friendships_b ON friendships (b);

CREATE TABLE friend_requests (
    from_id    bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    to_id      bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (from_id, to_id),
    CHECK (from_id <> to_id)
);
CREATE INDEX friend_requests_to_id ON friend_requests (to_id);

CREATE TABLE watches (
    id           bigserial PRIMARY KEY,
    account_id   bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    room_id      text NOT NULL,
    title        text NOT NULL DEFAULT '',
    kind         text NOT NULL DEFAULT '',
    started_at   timestamptz NOT NULL,
    duration_sec bigint NOT NULL DEFAULT 0,
    with_ids     bigint[] NOT NULL DEFAULT '{}'
);
CREATE INDEX watches_account_started ON watches (account_id, started_at DESC, id DESC);

-- A friend calling an account into a room: one per friend, the newest
-- standing, gone an hour after it was sent.
CREATE TABLE room_invites (
    to_id      bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    from_id    bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    room_id    text NOT NULL,
    at         timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (to_id, from_id)
);
CREATE INDEX room_invites_expires_at ON room_invites (expires_at);

-- Enrollment only: liveness, jobs and charges stay in Redis.
CREATE TABLE workers (
    id             text PRIMARY KEY,
    pubkey         text NOT NULL,
    public_base    text NOT NULL DEFAULT '',
    enrolled_at    timestamptz NOT NULL DEFAULT now(),
    cert_not_after bigint
);
