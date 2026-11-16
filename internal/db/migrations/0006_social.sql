-- The Discord avatar hash, as Discord last said it; the image is served
-- through the site so the Discord id never reaches a friend's browser.
ALTER TABLE accounts ADD COLUMN discord_avatar text NOT NULL DEFAULT '';

-- A device's public key for private messages. The private half never
-- leaves the device; the server only routes and keeps ciphertext.
CREATE TABLE dm_devices (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    public_key text NOT NULL,
    label      text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dm_devices_account ON dm_devices (account_id, created_at);

-- One message between two accounts. body is AES-GCM ciphertext; keys holds,
-- per device id, the message key wrapped for that device.
CREATE TABLE dm_messages (
    id            bigserial PRIMARY KEY,
    a             bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    b             bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    sender        bigint NOT NULL,
    sender_device uuid NOT NULL,
    client_id     text NOT NULL,
    iv            text NOT NULL,
    body          text NOT NULL,
    keys          jsonb NOT NULL,
    at            timestamptz NOT NULL DEFAULT now(),
    CHECK (a < b),
    UNIQUE (sender, client_id)
);
CREATE INDEX dm_messages_pair ON dm_messages (a, b, id DESC);

-- How far each account read each conversation.
CREATE TABLE dm_reads (
    account_id bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    other_id   bigint NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    up_to      bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, other_id)
);
