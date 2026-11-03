-- A TV linked to an account. Like a session, only the sha256 of its token
-- is kept: the token itself goes out once, to the TV that paired.
CREATE TABLE tv_devices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name         text NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tv_devices_account_id ON tv_devices (account_id);
