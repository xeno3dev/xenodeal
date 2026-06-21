// src/intelligence/testClassify.js
require('dotenv').config();
const pg = require('../db/connection.js');
const { classifyDeal } = require('./aiClient.js');
const tg = require('../alerts/telegram.js');

async function run() {
    const { rows } = await pg.query(
        "SELECT raw_text, media_ref FROM messages WHERE raw_text IS NOT NULL AND raw_text != '' ORDER BY timestamp DESC LIMIT 5"
    );

    for (const row of rows) {
        try {
            const dealData = await classifyDeal(row.raw_text, row.media_ref);
            await tg.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID,
                `${row.raw_text}\n\n${JSON.stringify(dealData, null, 2)}`
            );
        } catch (err) {
            console.error('Classification failed:', err);
        }
    }
}

run();