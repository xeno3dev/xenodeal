-- Phase 2: Core Intelligence | deals table
-- Supports XEN-62 (status state machine), XEN-51 (posted numbers),
-- XEN-60/61 (classification fields), XEN-66 (dashboard labeling)
-- Run after: db/schema.sql (groups + messages tables)

CREATE TABLE deals (
    id                  SERIAL PRIMARY KEY,
    source_message_id   TEXT REFERENCES messages(message_id),
    group_id            TEXT NOT NULL,
    sender              TEXT NOT NULL,

    -- XEN-60 / XEN-61
    deal_score          INTEGER,
    category            TEXT,
    price               NUMERIC,
    price_raw           TEXT,
    is_trade            BOOLEAN NOT NULL DEFAULT false,
    condition           TEXT,
    fix_score           INTEGER,

    -- XEN-51
    posted_numbers      TEXT[],

    -- XEN-62 / XEN-57
    status              TEXT NOT NULL DEFAULT 'active'
                            CONSTRAINT deals_status_check
                            CHECK (status IN ('active', 'likely_sold', 'confirmed_sold', 'relisted')),
    post_count          INTEGER NOT NULL DEFAULT 1,
    first_posted_at     TIMESTAMPTZ NOT NULL,
    last_posted_at      TIMESTAMPTZ NOT NULL,

    -- XEN-66
    dashboard_label     TEXT
                            CONSTRAINT deals_dashboard_label_check
                            CHECK (dashboard_label IN ('sale', 'noise', 'sold_confirm', 'not_sold_confirm')
                                OR dashboard_label IS NULL),

    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),

    -- XEN-60: AI classification fields
    notes               TEXT,
    is_noise            BOOLEAN NOT NULL DEFAULT false,
    raw_text            TEXT,

    -- Full-text search across listing content (RAG keyword retrieval)
    search_vector       TSVECTOR GENERATED ALWAYS AS (
                            to_tsvector('english',
                                COALESCE(raw_text, '') || ' ' ||
                                COALESCE(notes, '') || ' ' ||
                                COALESCE(category, '') || ' ' ||
                                COALESCE(price_raw, '') || ' ' ||
                                COALESCE(condition, ''))
                        ) STORED
);

-- XEN-65/66: filter/sort by status
CREATE INDEX idx_deals_status ON deals (status);

-- XEN-57: find existing deals per seller+group for repost tracking
CREATE INDEX idx_deals_group_sender ON deals (group_id, sender);

-- RAG keyword retrieval
CREATE INDEX idx_deals_fts ON deals USING GIN (search_vector);