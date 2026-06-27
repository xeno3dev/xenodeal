--- subscribers + user_groups | multiuser support

CREATE TABLE subscribers (
    telegram_chat_id   TEXT        PRIMARY KEY,
    telegram_username  TEXT,
    threshold          INTEGER     NOT NULL DEFAULT 65,
    categories         TEXT[],     -- NULL = all categories, no filter
    status             TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'paused')),
    wa_status          TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (wa_status IN ('pending', 'connected', 'disconnected')),
    session_id         TEXT        UNIQUE,  -- same as telegram_chat_id, used as LocalAuth clientId
    created_at         TIMESTAMPTZ DEFAULT now(),
    updated_at         TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_groups (
    id               SERIAL      PRIMARY KEY,
    subscriber_id    TEXT        NOT NULL REFERENCES subscribers(telegram_chat_id) ON DELETE CASCADE,
    group_jid        TEXT        NOT NULL,
    friendly_name    TEXT,
    added_at         TIMESTAMPTZ DEFAULT now(),

    UNIQUE (subscriber_id, group_jid)
);

CREATE INDEX idx_user_groups_subscriber ON user_groups (subscriber_id);
CREATE INDEX idx_user_groups_jid        ON user_groups (group_jid);

ALTER TABLE messages
    ADD COLUMN subscriber_id TEXT REFERENCES subscribers(telegram_chat_id);

CREATE INDEX idx_messages_subscriber ON messages (subscriber_id);

ALTER TABLE subscribers ADD COLUMN phone_number TEXT;