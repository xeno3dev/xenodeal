-- Phase 2: Core Intelligence — deals table
-- Supports XEN-62 (status state machine), XEN-51 (posted numbers),
-- XEN-60/61 (classification fields), XEN-66 (dashboard labeling)

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
                         CHECK (status IN ('active', 'likely_sold', 'confirmed_sold', 'relisted')),
    post_count          INTEGER NOT NULL DEFAULT 1,
    first_posted_at     TIMESTAMPTZ NOT NULL,
    last_posted_at      TIMESTAMPTZ NOT NULL,

    -- XEN-66
    dashboard_label      TEXT
                         CHECK (dashboard_label IN ('sale', 'noise', 'sold_confirm', 'not_sold_confirm') OR dashboard_label IS NULL),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- XEN-65/66 read patterns: filter/sort by status and score
CREATE INDEX idx_deals_status ON deals (status);

-- XEN-57 needs to find existing deals per seller+group for repost tracking
CREATE INDEX idx_deals_group_sender ON deals (group_id, sender);

-- NOTE: updated_at is set manually by application code (deals.js) on each
-- transition, not a trigger — consistent with Phase 1's raw-pg, no-ORM approach.