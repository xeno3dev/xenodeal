const { pool } = require('../db/connection');
const { classifyMessage } = require('../intelligence/preFilter');
const { classifyDeal } = require('../intelligence/aiClient');
const { extractPostedNumbers } = require('../intelligence/phoneExtractor');
const { sendDealAlert } = require('../alerts/telegram');

const MAX_BATCH = 100;
const MIN_BATCH = 20;
const INTERVAL_MS = 60 * 1000;

async function getBatchSize() {
    const r = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE processed = false'
    );
    const pending = parseInt(r.rows[0].count);
    if (pending > 100) return MAX_BATCH;
    if (pending > 20)  return 50;
    return MIN_BATCH;    throw new Error('[aiClient] extract_deal not returned after pass 2');

}

async function processBatch() {
    const batchSize = await getBatchSize();

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
        return;
    }

    if (rows.length === 0) return;

    console.log(`[classifier] Processing ${rows.length} row(s)...`);

    let done = 0;

    for (const row of rows) {
        const preResult = classifyMessage(row.raw_text, row.has_media, undefined);

        if (preResult === 'noise' || preResult === 'link_only') {
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
                await client.query('ROLLBACK');
                console.error(`[classifier] DB error (noise) ${row.message_id}:`, err.message);
            } finally {
                client.release();
            }

            continue;
        }

        let result;
        try {
            result = await classifyDeal(row.raw_text, row.media_ref);
        } catch (err) {
            console.error(`[classifier] AI error on ${row.message_id}:`, err.message);
            continue;
        }

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
                ) ON CONFLICT (source_message_id) DO NOTHING RETURNING *`,
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

            const inserted = insertResult.rows[0] ?? null;

            await client.query(
                `UPDATE messages SET processed = true WHERE message_id = $1`,
                [row.message_id]
            );

            await client.query('COMMIT');
            done++;

            if (inserted) {
                await sendDealAlert(inserted).catch(err =>
                    console.error(`[classifier] Alert failed ${row.message_id}:`, err.message)
                );
            }
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[classifier] DB error (candidate) ${row.message_id}:`, err.message);
        } finally {
            client.release();
        }

    } // end for loop

    console.log(`[classifier] Done. ${done}/${rows.length} processed.`);
}

setTimeout(() => {
    processBatch().catch(err => console.error('[classifier] Startup error:', err.message));
}, 5000);

setInterval(async () => {
    try { await processBatch(); }
    catch (err) { console.error('[classifier] Tick error:', err.message); }
}, INTERVAL_MS);

console.log('[classifier] Poller started.');