-- Whether the account was sent once to Discord to join the juntos server,
-- and whether the join went through. Neither keeps any Discord token.
ALTER TABLE accounts
    ADD COLUMN guild_asked_at  timestamptz,
    ADD COLUMN guild_joined_at timestamptz;
