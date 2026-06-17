# XenoDeal — System Design Document

> Automated WhatsApp marketplace deal finder for Dominica buy/sell groups.  
> Collects daily message archives, classifies deals using Claude AI and local ML models,  
> extracts seller contacts, tracks sold status, and delivers alerts via Telegram and Postal email.

---

## Table of contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Tech stack](#tech-stack)
4. [Database schema](#database-schema)
5. [Phase 1 — Collection foundation](#phase-1--collection-foundation)
6. [Phase 2 — Core intelligence](#phase-2--core-intelligence)
7. [Phase 3 — ML training](#phase-3--ml-training)
8. [Phase 4 — ML deployment](#phase-4--ml-deployment)
9. [Seller contact extraction](#seller-contact-extraction)
10. [Sold detection](#sold-detection)
11. [Claude AI prompts](#claude-ai-prompts)
12. [Notification system](#notification-system)
13. [Deployment on Coolify](#deployment-on-coolify)
14. [Dominican context and customization](#dominican-context-and-customization)
15. [WhatsApp session notes](#whatsapp-session-notes)

---

## Overview

XenoDeal is a Node.js service that runs on Xeno Solutions' existing Proxmox/Coolify infrastructure. It connects to WhatsApp via `whatsapp-web.js`, pulls daily message archives from configured buy/sell groups, filters and classifies listings using Claude AI, and surfaces deals through Telegram alerts and a Postal-powered daily email digest.

A secondary ML layer, trained on labeled data accumulated by the system itself, progressively replaces expensive Claude API calls for routine filtering and sold-status classification, making the pipeline faster and cheaper over time.

The system is built to understand the specific pricing context, informal language, and marketplace patterns of Dominica — not generic Caribbean English.

---

## Architecture

```
WhatsApp groups (configured)
        │
        ▼ (daily cron + 24/7 real-time listener)
┌──────────────────────────────┐
│   whatsapp-web.js service    │  Node.js, Docker, Coolify
│   ├── archive collector      │  daily cron at 06:00
│   ├── real-time listener     │  sold detection, 24/7
│   └── media downloader       │  product photos
└──────────────┬───────────────┘
               │
               ▼
        SQLite (raw_messages, media)
               │
               ▼
┌──────────────────────────────┐
│      pre-filter layer        │  heuristic (Phase 2) → ML (Phase 4)
│   sale listing? yes/no       │
└──────────────┬───────────────┘
               │ potential deals only
               ▼
┌──────────────────────────────┐
│       Claude API             │  claude-sonnet-4-6
│   ├── deal scorer            │  0–100 deal quality
│   ├── price extractor        │  EC$ normalized
│   ├── fix scorer             │  0–100 repair potential
│   └── Vision (photos)        │  condition assessment
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      ML anomaly layer        │  Phase 4 only
│   └── price anomaly check    │  IsolationForest on history
└──────────────┬───────────────┘
               │
               ▼
        SQLite (deals, price_history)
               │
       ┌───────┼───────┐
       ▼       ▼       ▼
  Telegram  Postal   React
   alerts   digest  dashboard
```

---

## Tech stack

| Component | Technology | Notes |
|---|---|---|
| WhatsApp client | `whatsapp-web.js` (Node.js) | Unofficial; see session notes |
| Scheduler | `node-cron` | Runs inside the same Node service |
| Database | SQLite | Single file, zero setup; swap to Postgres later if needed |
| AI classification | Claude Sonnet 4.6 (`claude-sonnet-4-6`) | Anthropic SDK |
| Image analysis | Claude Vision | Attached product photos |
| ML pre-filter | scikit-learn (Python sidecar) | TF-IDF + logistic regression |
| ML embeddings | `@xenova/transformers` (ONNX) | Runs locally in Node, no Python needed |
| Anomaly detection | scikit-learn `IsolationForest` | Price history per category |
| Telegram alerts | `node-telegram-bot-api` | Inline keyboard with WA deep link |
| Email digest | Postal (self-hosted SMTP) | Already on Xeno Solutions stack |
| Dashboard | Vite + React + shadcn/ui + Tailwind | Same stack as Keylo |
| Deployment | Docker Compose on Coolify | Inside Proxmox LXC |

---

## Database schema

```sql
-- Configured groups to monitor
CREATE TABLE groups (
  id          TEXT PRIMARY KEY,  -- WhatsApp group ID (e.g. 1234@g.us)
  name        TEXT NOT NULL,
  active      INTEGER DEFAULT 1,
  added_at    INTEGER            -- unix timestamp
);

-- Raw incoming messages (all groups, unfiltered)
CREATE TABLE raw_messages (
  id             TEXT PRIMARY KEY,  -- WhatsApp message ID
  group_id       TEXT NOT NULL,
  sender_number  TEXT NOT NULL,     -- stripped from msg.author (@c.us removed)
  body           TEXT,
  media_path     TEXT,              -- local path if image downloaded
  has_quoted     INTEGER DEFAULT 0, -- msg.hasQuotedMsg
  quoted_id      TEXT,              -- ID of message being replied to
  timestamp      INTEGER NOT NULL,
  processed      INTEGER DEFAULT 0,
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

-- Classified deals
CREATE TABLE deals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      TEXT NOT NULL,
  group_id        TEXT NOT NULL,
  sender_number   TEXT NOT NULL,     -- from msg.author
  posted_number   TEXT,              -- phone number extracted from message body, if different
  item_name       TEXT,
  price_ec        REAL,              -- normalized EC$ price
  price_raw       TEXT,              -- original price string as written
  condition       TEXT,              -- new / used / broken / unknown
  deal_score      INTEGER,           -- 0–100 overall deal quality
  fix_score       INTEGER,           -- 0–100 buy-and-fix potential (NULL if not broken)
  fix_difficulty  TEXT,              -- easy / medium / hard / expert
  fix_cost_ec     REAL,              -- estimated repair cost EC$
  market_value_ec REAL,              -- estimated working value EC$
  category        TEXT,              -- electronics / appliance / vehicle / general
  status          TEXT DEFAULT 'active', -- active / likely_sold / confirmed_sold / stale / relisted
  post_count      INTEGER DEFAULT 1, -- how many times this seller reposted this item
  first_posted_at INTEGER,
  last_posted_at  INTEGER,
  dismissed       INTEGER DEFAULT 0,
  detected_at     INTEGER,
  FOREIGN KEY (message_id) REFERENCES raw_messages(id)
);

-- Price history per category (for anomaly detection)
CREATE TABLE price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,
  item_name   TEXT,
  price_ec    REAL NOT NULL,
  condition   TEXT,
  recorded_at INTEGER NOT NULL
);

-- Labels for ML training (applied via dashboard)
CREATE TABLE labels (
  message_id   TEXT PRIMARY KEY,
  label        TEXT NOT NULL, -- 'sale' / 'noise' / 'sold_confirm' / 'not_sold_confirm'
  labeled_at   INTEGER,
  labeled_by   TEXT DEFAULT 'user'
);
```

---

## Phase 1 — Collection foundation

**Goal:** get messages, contacts, and basic sold flags flowing into the database every day. Nothing does AI classification yet — this phase is purely about reliable data collection.

### What gets built

- `whatsapp-web.js` Docker service with QR-based auth and persistent session volume
- `groups.json` config file listing the WhatsApp group IDs to monitor
- Daily cron job at 06:00 that pulls all messages from the past 24 hours per group
- Product photo downloader — saves attached images locally, stores path in `raw_messages.media_path`
- Sender number extraction from `msg.author` (see [Seller contact extraction](#seller-contact-extraction))
- Regex extraction of any additional phone numbers posted in message body
- Reply chain tracking via `msg.hasQuotedMsg` and `msg.getQuotedMessage()`
- Rule-based sold keyword detection (see [Sold detection — Layer 1](#layer-1--rule-based-keyword-detection))
- No-more-listing re-post tracker: updates `post_count`, `first_posted_at`, `last_posted_at` per item-seller pair

### Deliverable

Messages, contacts, and basic sold flags arriving in SQLite daily. The pipeline runs silently forever from this point on. Phase 2 is added on top — Phase 1 does not pause.

### Getting WhatsApp group IDs

```javascript
// Run once to list all groups and their IDs
const chats = await client.getChats();
const groups = chats.filter(c => c.isGroup);
groups.forEach(g => console.log(g.id._serialized, g.name));
```

Copy the IDs of your target groups into `groups.json`:

```json
[
  { "id": "1767XXXXXXXXX-XXXXXXXXXX@g.us", "name": "Dominica buy and sell" },
  { "id": "1767XXXXXXXXX-XXXXXXXXXX@g.us", "name": "Deals and classifieds" }
]
```

---

## Phase 2 — Core intelligence

**Goal:** classify incoming messages, score deals, extract contacts, wire up Telegram and Postal notifications, and launch the basic dashboard. By the end of this phase the system is fully usable day-to-day.

### What gets built

- Keyword heuristic pre-filter: drops obvious noise (greetings, questions, reactions) before Claude ever sees a message. Reduces API cost by an estimated 70–80%
- Claude classification pipeline: deal score, price extraction, fix score, category tagging — one structured JSON call per potential listing
- Claude Vision: if `media_path` is set, include the image in the classification call for condition assessment
- Sold status badge on every deal: `active`, `likely_sold`, `confirmed_sold`, `stale`
- 24/7 real-time sold-status listener (see [Sold detection — Layer 2](#layer-2--no-more-listing-decay))
- Telegram bot with inline "Message seller" button (WhatsApp deep link)
- Postal daily email digest at 08:00 with top 10 deals ranked by score
- React dashboard: browse all deals, filter by category/score/status, dismiss, manually label for ML training

### Deliverable

Alerts firing in Telegram with one-tap seller contact. Deal status updating in near-real-time. Dashboard live and usable.

### Daily pipeline execution order

```
06:00  cron fires
06:01  collector: pull 24h messages from all active groups → raw_messages
06:05  processor: heuristic pre-filter → Claude classification → write to deals
06:15  Telegram: send alerts for deal_score > 75 and status = 'active'
06:30  Postal: send morning digest (top 10 deals, past 24h)
       (dashboard is always live between runs)
```

---

## Phase 3 — ML training

**Goal:** accumulate enough labeled data to train local ML models that can replace the heuristic pre-filter, catch sold confirmations more accurately, and detect price anomalies. No models are deployed yet — this phase is about data and training only.

**When this unlocks:** after approximately 4–6 weeks of Phase 1+2 running, once you have 200+ labeled examples per class. The dashboard's label UI (applied in Phase 2) is how labels accumulate.

### Label classes

| Class | Applied when |
|---|---|
| `sale` | Message is a genuine for-sale listing |
| `noise` | Message is not a listing (question, greeting, reaction, etc.) |
| `sold_confirm` | Follow-up message confirms item is sold or gone |
| `not_sold_confirm` | Follow-up confirms item is still available |

### Models to train

**Sale/noise classifier**
- Algorithm: TF-IDF vectorizer + logistic regression (scikit-learn)
- Input: `raw_messages.body`
- Output: binary — sale or noise
- Replaces the heuristic keyword pre-filter in Phase 4
- Expected accuracy: 90–95% once trained on local Dominica marketplace text

**Sold-status classifier**
- Same algorithm
- Input: follow-up message text + features: `has_quoted`, `sender == original_poster`, `hours_since_listing`
- Output: binary — sold confirmation or not
- Handles ambiguous phrasing that rule-based detection misses

**Price embeddings for deduplication**
- Model: `@xenova/transformers` (all-MiniLM-L6-v2, ONNX, runs in Node.js)
- Generates sentence embeddings for each listing
- Cosine similarity check at write time: if similarity > 0.85 to an existing active deal from the same group within 7 days, flag as duplicate and merge

### Deliverable

Trained `.pkl` model files for the sale classifier and sold-status classifier, ready to swap into the pipeline in Phase 4. Price history table populated with enough data to run anomaly detection.

---

## Phase 4 — ML deployment

**Goal:** replace the heuristic pre-filter and rule-based sold detection with the trained ML models, add price anomaly detection, and establish a weekly automated retrain loop.

### What gets deployed

**Sale/noise ML classifier (replaces heuristic pre-filter)**
- Python sidecar service exposes a `/classify` HTTP endpoint
- Node.js processor calls it instead of the keyword check
- Falls back to heuristic if the sidecar is unavailable

**Sold-status ML classifier**
- Added to the real-time listener pipeline
- Runs on every reply message alongside the existing rule-based check
- Rule-based catches clear-cut sold confirmations; ML handles ambiguous cases

**IsolationForest price anomaly detection**
- Trained on `price_history` per category
- Flags listings where the price is statistically unusual (very low = alert, very high = warn)
- Anomaly score added to the deal record and shown in the dashboard

**No-more-listing decay scoring**  
(moved from heuristic rule to ML-scored probability in this phase)
- Feeds `post_count`, `days_since_last_post`, and `category` into a simple regression
- Outputs a `sold_probability` score 0–1 updated nightly

**Automated retrain loop**
- Weekly cron retrains all models on the latest labeled data
- Logs accuracy metrics per run
- Alerts via Telegram if accuracy drops below threshold

### Deliverable

Fully autonomous pipeline. Claude API calls reduced to classification only (no pre-filtering cost). Sold status accurate and updating in real-time. System improves automatically as more labeled data accumulates.

---

## Seller contact extraction

### Primary number — from `msg.author`

In `whatsapp-web.js` group messages, `msg.from` is the group ID. The actual sender's number is always in `msg.author`, formatted as `17671234567@c.us`. Strip `@c.us` to get a clean E.164-format number ready for a WhatsApp deep link:

```javascript
const senderNumber = msg.author.replace('@c.us', ''); // "17671234567"
const waLink = `https://wa.me/${senderNumber}`;
```

This is available for every single message with zero extraction effort. Store as `deals.sender_number`.

### Secondary number — posted in message body

Sellers sometimes post a different contact number in the message text. Claude extracts this during classification and returns it in the structured JSON response. Store as `deals.posted_number`.

Regex fallback for Dominica numbers (767 country code) if Claude extraction is unavailable:

```javascript
const dmNumber = body.match(/\b(767[-.\s]?\d{3}[-.\s]?\d{4}|\+?1[-.\s]?767[-.\s]?\d{3}[-.\s]?\d{4})\b/);
```

### Telegram inline keyboard

```javascript
bot.sendMessage(chatId, formatDealText(deal), {
  reply_markup: {
    inline_keyboard: [[
      { text: 'Message seller', url: `https://wa.me/${deal.sender_number}` },
      { text: 'Dismiss',        callback_data: `dismiss:${deal.id}` }
    ]]
  }
});
```

"Message seller" opens a WhatsApp conversation with the seller directly — no number copying, no app switching. If `posted_number` differs from `sender_number`, show both buttons.

---

## Sold detection

Sold status is tracked across three layers that run simultaneously and update the same `deals.status` field.

### Layer 1 — Rule-based keyword detection

Runs in the 24/7 real-time listener (not the daily batch). On every incoming message, the listener checks:

1. Is this message a reply (via `msg.hasQuotedMsg`) to a tracked deal?
2. Is the sender the same person who posted the original listing?
3. Does the message contain a configured sold keyword?

If all three: immediately set `deals.status = 'confirmed_sold'`.

Also checked without the reply requirement: if the original poster sends any message in the same group that contains a sold keyword and mentions the same item name or category, flag it.

**You define the keyword list** based on what people actually write in your groups. Example structure (to be populated with real Dominican marketplace language):

```javascript
const SOLD_KEYWORDS = [
  // add real phrases here based on your group patterns
  // e.g. "sold", "gone", "no more", etc.
];

const STILL_AVAILABLE_KEYWORDS = [
  // phrases that confirm the item is still for sale
  // e.g. "still there", "still available", etc.
];
```

### Layer 2 — No-more-listing decay

Tracks re-post behaviour. Sellers in buy/sell groups typically repost the same item every day or every few days until it sells. When the reposts stop, the item is likely sold.

On every archive pull, update the re-post tracker:

```javascript
// Check if this message is the same seller posting the same item again
// Update post_count, last_posted_at, first_posted_at accordingly
```

Nightly decay query:

```sql
-- Flag as likely sold if seller was actively relisting then went quiet
UPDATE deals
SET status = 'likely_sold'
WHERE status = 'active'
  AND post_count >= 2
  AND (julianday('now') - julianday(datetime(last_posted_at, 'unixepoch'))) > 3;

-- Flag as stale if no activity after 7 days regardless of post count
UPDATE deals
SET status = 'stale'
WHERE status IN ('active', 'likely_sold')
  AND (julianday('now') - julianday(datetime(last_posted_at, 'unixepoch'))) > 7;
```

Also handles **relisting**: if the same seller posts the same item again after it was marked `likely_sold` or `stale`, create a new deal record and mark the old one as `relisted`.

### Layer 3 — ML sold-status classifier (Phase 4)

Once trained in Phase 3, this classifier runs on every reply message processed by the real-time listener. It handles cases where Layer 1 misses:

- Ambiguous phrasing without an explicit sold keyword
- Third-party confirmations ("it gone already, check next week")
- Seller saying item is gone for reasons other than sale (gave it away, changed mind)

Features fed to the classifier:

| Feature | Description |
|---|---|
| `message_text` | TF-IDF vectorized body of the reply |
| `is_reply` | `msg.hasQuotedMsg` boolean |
| `sender_is_poster` | whether replier is the original seller |
| `hours_since_listing` | time elapsed since the original listing |
| `post_count` | how many times the item was relisted |

---

## Claude AI prompts

All three classifiers are called in a single API request per message, returning one structured JSON object. The system prompt carries the Dominica-specific context.

### System prompt structure

```
You are a marketplace deal analyzer for Dominica, Eastern Caribbean.

Currency: EC$ (Eastern Caribbean Dollar). 1 USD ≈ 2.70 EC$.
Pricing context: [add real local market values per category once known]
Language: Messages may contain a mix of Standard English and local informal text.
Known sold phrases: [populate with real phrases from your groups]
Known availability phrases: [populate with real phrases from your groups]

Always respond with valid JSON only. No preamble, no markdown.
```

### Classification request structure

```json
{
  "message": "[full message body]",
  "has_image": true,
  "image_base64": "[if media_path is set]",
  "group_name": "[group name for context]"
}
```

### Expected response structure

```json
{
  "is_sale_listing": true,
  "item_name": "iPhone 12",
  "price_ec": 650,
  "price_raw": "650",
  "condition": "broken",
  "condition_notes": "cracked screen, everything else works",
  "deal_score": 84,
  "deal_reasoning": "Below typical market price for condition; easy fix",
  "fix_score": 91,
  "fix_difficulty": "easy",
  "fix_notes": "Screen replacement, widely available part",
  "fix_cost_ec_estimate": 200,
  "market_value_ec_estimate": 1400,
  "category": "electronics",
  "posted_number": null,
  "seller_intent_urgency": "high"
}
```

### Fix difficulty scale

| Level | Description | Examples |
|---|---|---|
| `easy` | Common part, DIY-able, parts available locally or via online order | Screen, battery, charging port |
| `medium` | Requires some skill or tools, parts may need ordering | Camera module, speakers, minor board work |
| `hard` | Specialist tools or skills required | Water damage recovery, logic board repair |
| `expert` | Not worth attempting without professional equipment | BGA rework, GPU reballing |

---

## Notification system

### Telegram alerts

Fires immediately after the morning classification run for any deal with `deal_score > 75` and `status = 'active'`. Also fires in near-real-time if the 24/7 listener detects a high-score listing posted outside the daily cron window.

**Alert format:**

```
Deal found — Score 84/100
────────────────────────
iPhone 12 · cracked screen
EC$650 · Fixed value ~EC$1,400
Easy fix · Screen replacement ~EC$200
Group: Dominica buy and sell
────────────────────────
Posted 12 min ago · Status: active

[Message seller]  [Dismiss]
```

**Sold status update notification** (fires when a tracked deal changes status):

```
Status update
────────────────────────
iPhone 12 (EC$650) — Dominica buy and sell
Status changed: active → confirmed sold
Deal #42
```

### Postal daily digest

Sent at 08:00 via Postal SMTP. Contains:

- Top 10 deals from the past 24 hours, ranked by `deal_score`
- Fix opportunities section: deals where `fix_score > 80`, sorted by `(market_value_ec - price_ec - fix_cost_ec)` (estimated net gain)
- Sold status summary: how many tracked deals changed status overnight
- Footer: link to the dashboard for full browsing

---

## Deployment on Coolify

XenoDeal runs as a dedicated Docker Compose service on the same Coolify LXC as other Xeno Solutions apps. It requires a persistent volume for the WhatsApp session and the SQLite database.

### Docker Compose

```yaml
version: "3.9"

services:
  xenodeal:
    build: ./xenodeal
    restart: unless-stopped
    volumes:
      - xenodeal_session:/app/.wwebjs_auth
      - xenodeal_db:/app/data
      - xenodeal_media:/app/media
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
      - POSTAL_SMTP_HOST=${POSTAL_SMTP_HOST}
      - POSTAL_SMTP_USER=${POSTAL_SMTP_USER}
      - POSTAL_SMTP_PASS=${POSTAL_SMTP_PASS}
      - DIGEST_EMAIL_TO=${DIGEST_EMAIL_TO}
      - DEAL_SCORE_THRESHOLD=75
    networks:
      - coolify

  xenodeal-ml:
    build: ./xenodeal-ml   # Python sidecar (Phase 4 only)
    restart: unless-stopped
    volumes:
      - xenodeal_models:/app/models
      - xenodeal_db:/app/data  # shared read-only access to SQLite
    networks:
      - coolify

volumes:
  xenodeal_session:
  xenodeal_db:
  xenodeal_media:
  xenodeal_models:

networks:
  coolify:
    external: true
```

### Nginx route (via nginx-ui)

The dashboard frontend is served through the existing nginx-ui ingress at `10.10.10.2`, routed to the xenodeal container's internal port. No public-facing exposure needed — dashboard is accessed locally or over VPN.

---

## Dominican context and customization

This section is intentionally left as a placeholder. The system's accuracy depends entirely on real examples from your specific groups. Before building Phase 2 prompts and the Phase 1 sold keyword list, collect:

**20–30 anonymized real examples per category:**

- Sale listings (item name, price format, condition language)
- Sold confirmations (exact phrasing used when items sell)
- "Still available" confirmations
- Noise messages (questions, greetings, non-listings)
- Re-listing patterns (how often, what changes between posts)

From these examples you'll populate:

- `SOLD_KEYWORDS` array in the real-time listener
- `STILL_AVAILABLE_KEYWORDS` array
- Claude system prompt `Language` section with real phrasing patterns
- Claude system prompt `Pricing context` section with real local market values
- Heuristic pre-filter keyword list for Phase 2

Paste real examples into a conversation and the Claude prompt sections can be written accurately from actual data.

---

## WhatsApp session notes

`whatsapp-web.js` is an unofficial client that mirrors WhatsApp Web via headless Chromium. Meta does not officially support or permit this use.

**Practical steps to reduce ban risk:**

- Use a dedicated phone number, not your primary personal account
- Keep the SIM active (no long periods offline)
- Do not send automated messages — this system is read-only
- Do not aggressively poll at high frequency; the daily cron plus passive 24/7 listener is appropriate
- If the session drops (phone offline, WhatsApp update, etc.), the service logs a warning and waits for re-authentication — navigate to the service URL to re-scan the QR

**Session persistence:**  
The auth session is stored in the `xenodeal_session` Docker volume. It survives container restarts and redeployments as long as the volume is not wiped.

**If the account gets banned:**  
Create a new number, re-scan, update `TELEGRAM_CHAT_ID` if needed. The database and trained models are unaffected — they live in separate volumes.

---

*Document version: 1.0 — reflects Phases 1–4 design as of initial planning.*  
*Update this document as sold keyword lists and Dominican text patterns are finalized.*
