// src/cron/classifier.js
// Polls for unprocessed messages, runs AI classification, writes to deals table.

const { pool } = require('../db/connection');
const { classifyMessage } = require('../intelligence/preFilter');
const { classifyDeal } = require('../intelligence/aiClient');
const { extractPostedNumbers } = require('../intelligence/phoneExtractor');
const { sendDealAlert } = require('../alerts/telegram');

const MAX_BATCH = 100;
const MIN_BATCH = 20;
const INTERVAL_MS = 60 * 1000; // 60 seconds

async function getBatchSize() {
    const r = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE processed = false'
    );
    const pending = parseInt(r.rows[0].count);
    if (pending > 100) return MAX_BATCH;
    if (pending > 20)  return 50;
    return MIN_BATCH;    throw new Error('[aiClient] extract_deal not returned after pass 2');

}

// ─────────────────────────────────────────────────────────────────────────────
// processBatch — runs once per tick
// ─────────────────────────────────────────────────────────────────────────────
async function processBatch() {
    const batchSize = await getBatchSize();

    // 1. Grab up to 20 unprocessed rows, oldest first.
    //    pool.query() is fine here — no transaction needed for a plain SELECT.
    let rows;
    try {
        const result = await pool.query(
            `SELECT * FROM messages
             WHERE processed = false
             ORDER BY timestamp ASC
             LIMIT $1`,
            [batchSize]
        );
        rows = result.rows;
    } catch (err) {
        console.error('[classifier] DB fetch failed:', err.message);
        return; // nothing to do this tick
    }

    if (rows.length === 0) return; // queue empty, bail quietly

    console.log(`[classifier] Processing ${rows.length} row(s)...`);

    let done = 0;

    // 2. Process each row one at a time (await inside for…of = sequential).
    //    Sequential matters: hammering the Anthropic API with 20 parallel calls
    //    will hit rate limits fast. One at a time is safe.
    for (const row of rows) {

        // ── Step A: pre-filter ───────────────────────────────────────────────
        // classifyMessage() is a pure local function — no API, no DB.
        // Returns 'candidate', 'noise', or 'link_only'.
        // We pass undefined for messageType because that field only exists on
        // the live wwebjs object, not in the DB row. The sticker branch won't
        // fire here — acceptable gap for the poller.
        const preResult = classifyMessage(row.raw_text, row.has_media, undefined);

        if (preResult === 'noise' || preResult === 'link_only') {
            // ── Noise path: no AI call needed ────────────────────────────────
            // Still write a deal row (is_noise = true) and mark processed.
            // If we skip the INSERT and just mark processed, we lose the record
            // of why it was ignored — harder to audit later.
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                await client.query(
                    `INSERT INTO deals (
                        source_message_id, group_id, sender, raw_text,
                        is_noise, is_trade, status, post_count,
                        first_posted_at, last_posted_at, posted_numbers
                    ) VALUES ($1,$2,$3,$4, $5,$6,$7,$8, $9,$10,$11)`,
                    [
                        row.message_id, row.group_id, row.sender, row.raw_text,
                        true, false, 'active', 1,
                        row.timestamp, row.timestamp,
                        extractPostedNumbers(row.raw_text)
                    ]
                );

                await client.query(
                    `UPDATE messages SET processed = true WHERE message_id = $1`,
                    [row.message_id]
                );

                await client.query('COMMIT');
                done++;
            } catch (err) {
                // ROLLBACK undoes both the INSERT and the UPDATE atomically.
                // processed stays false → row will be retried next tick.
                await client.query('ROLLBACK');
                console.error(`[classifier] DB error (noise) ${row.message_id}:`, err.message);
            } finally {
                // ALWAYS release the client back to the pool.
                // Missing this = pool exhaustion = everything hangs.
                client.release();
            }

            continue; // move to next row
        }

        // ── Step B: AI classification (candidate only) ───────────────────────
        // We call classifyDeal BEFORE opening a DB transaction.
        // Reason: if the Anthropic API throws, we haven't touched the DB yet —
        // no rollback needed, the row just stays unprocessed and retries next tick.
        let result;
        try {
            result = await classifyDeal(row.raw_text, row.media_ref);
        } catch (err) {
            console.error(`[classifier] AI error on ${row.message_id}:`, err.message);
            continue; // skip this row this tick, will retry
        }

        // ── Step C: write AI result to DB ────────────────────────────────────
        // Now we have a result — open a transaction and write everything at once.
        // If either query fails, ROLLBACK keeps the DB consistent and the row
        // retries next tick (because processed is still false).
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const insertResult = await client.query(
                `INSERT INTO deals (
                    source_message_id, group_id, sender, raw_text,
                    deal_score, category, price, price_raw,
                    is_trade, condition, fix_score,
                    is_noise, notes,
                    status, post_count,
                    first_posted_at, last_posted_at,
                    posted_numbers, potential_selling_price
                ) VALUES (
                    $1,  $2,  $3,  $4,
                    $5,  $6,  $7,  $8,
                    $9,  $10, $11,
                    $12, $13,
                    $14, $15,
                    $16, $17,
                    $18, $19
                ) RETURNING *`,
                [
                    row.message_id,    row.group_id,       row.sender,         row.raw_text,
                    result.deal_score, result.category,    result.price,       null,        // price_raw: not in AI schema
                    result.is_trade,   result.condition,   result.fix_score,
                    result.is_noise,   result.notes,
                    'active',          1,
                    row.timestamp,     row.timestamp,
                    extractPostedNumbers(row.raw_text), result.potential_selling_price
                ]
            );

            await client.query(
                `UPDATE messages SET processed = true WHERE message_id = $1`,
                [row.message_id]
            );

            const inserted = insertResult.rows[0];

            await client.query('COMMIT');
            done++;
            
            await sendDealAlert(inserted).catch(err =>
                console.error(`[classifier] Alert failed ${row.message_id}:`, err.message)
            );
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[classifier] DB error (candidate) ${row.message_id}:`, err.message);
        } finally {
            client.release();
        }

    } // end for loop

    console.log(`[classifier] Done. ${done}/${rows.length} processed.`);
}


// ─────────────────────────────────────────────────────────────────────────────
// Kick-off
// ─────────────────────────────────────────────────────────────────────────────

// Run once immediately on startup, then every 60s.
// getBatchSize() handles backlog automatically — no drain loop needed.
processBatch().catch(err => console.error('[classifier] Startup error:', err.message));

setInterval(async () => {
    try { await processBatch(); }
    catch (err) { console.error('[classifier] Tick error:', err.message); }
}, INTERVAL_MS);

console.log('[classifier] Poller started.');