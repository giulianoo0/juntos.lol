-- Who owns each extension id, and where its code comes from. The first to
-- register an id keeps it; sub is the subdomain it is served from.
-- created_by_account is null once that account is gone.
CREATE TABLE extensions (
    id                 text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{2,31}$'),
    source             text NOT NULL CHECK (source ~ '^github:[a-z0-9-]+/[a-z0-9._-]+$'),
    sub                text NOT NULL UNIQUE,
    name               text NOT NULL,
    icon               text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_by_account bigint REFERENCES accounts (id) ON DELETE SET NULL
);
