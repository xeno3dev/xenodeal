const { Client, LocalAuth } = require('whatsapp-web.js');
const pg = require('../db/connection');
const pool = pg.pool;
const { bot } = require('../alerts/telegram.js');
const state = require('../bot/state.js');
const { handleMessage } = require('./messageHandler.js');

const clientPool = new Map();
const MAX_SESSIONS = 10;

function spawnClient(chatId, phone) {
    if (clientPool.size >= MAX_SESSIONS) {
        bot.telegram.sendMessage(chatId, 'Sorry, we\'re at capacity right now. Please try again later.');
        return;
    } else {
        const client = new Client({
            puppeteer: {
                executablePath: '/usr/bin/chromium',
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            },
            authStrategy: new LocalAuth({ clientId: String(chatId), dataPath: 'auth_data' }),
            webVersion: '2.3000.1041871181-alpha',
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017054665.html'
            }
        });

        let pairingCodeSent = false;

        client.on('qr', async () => {
            const { rows } = await pool.query(
                'SELECT wa_status FROM subscribers WHERE telegram_chat_id = $1',
                [chatId]
            );
            if (rows[0]?.wa_status === 'connected') return; // ← already connected, skip pairing
            if (pairingCodeSent) return;
            console.log('[clientPool] qr fired  for', chatId);
            console.log('[clientPool] phone type:', typeof phone);
            try {
                pairingCodeSent = true;
                const code = await client.requestPairingCode(phone);
                await bot.telegram.sendMessage(chatId,
                    `🔑 Your pairing code: *${code}*\n\nOpen WhatsApp → Linked Devices → Link with phone number → enter this code`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                console.error(`[clientPool] Pairing code error for ${chatId}:`, err.message);
                try {
                    await bot.telegram.sendMessage(chatId, '❌ Failed to generate pairing code. Run /start again.');
                } catch (tgErr) {
                    console.error(`[clientPool] Failed to notify ${chatId}:`, tgErr.message);
                }
            }
        });

        client.on('auth_failure', async (err) => {
            console.log(`[spawnClient] Client for ${chatId} failed to authenticate:`, err);
            bot.telegram.sendMessage(chatId, `WhatsApp Client failed to authenticate for ${chatId}: ${err}`);
            pg.query('UPDATE subscribers SET wa_status = $1 WHERE telegram_chat_id = $2', ['disconnected', chatId]);
        });

        client.on('ready', async () => {
            console.log(`[spawnClient] Client for ${chatId} is ready!`);
            await bot.telegram.sendMessage(chatId, '📶 WhatsApp Client is ready!');
            pg.query('UPDATE subscribers SET wa_status = $1 WHERE telegram_chat_id = $2', ['connected', chatId]);
        });

        client.on('disconnected', async (reason) => {
            console.log(`[spawnClient] Client for ${chatId} has disconnected!`, reason);
            pg.query('UPDATE subscribers SET wa_status = $1 WHERE telegram_chat_id = $2', ['disconnected', chatId]);
            bot.telegram.sendMessage(chatId, `WhatsApp Client has disconnected! Reason: ${reason}`);
        });

        client.on('message_create', async (msg) => {
            try {
                await handleMessage(msg, chatId, client);
            } catch (err) {
                console.error('[clientPool] message_create error for ${chatId}:', err.message);
            }
        });

        clientPool.set(chatId, client);
        client.initialize();
        return client;
    }
}

const getClient = async (chatId) => {
    if (clientPool.has(chatId)) {
        return clientPool.get(chatId);
    } else {
        return null;
    }
}

function getAllClients() {
    return Array.from(clientPool.values());
}

const destroyClient = async (chatId) => {
    if (clientPool.has(chatId)) {
        const client = clientPool.get(chatId);
        client.destroy();
        clientPool.delete(chatId);
        await pg.query(
            'UPDATE subscribers SET wa_status = $1 WHERE telegram_chat_id = $2',
            ['disconnected', chatId]
        );
    } else {
        console.log(`Client for ${chatId} not found, nothing to destroy.`);
    }
}

async function restoreAllSessions() {
    const { rows } = await pool.query(
        'SELECT telegram_chat_id, phone_number FROM subscribers WHERE wa_status = $1',
        ['connected']
    );    

    for (const row of rows) {
        await spawnClient(row.telegram_chat_id, row.phone_number);
        console.log(`[clientPool] Restored session for ${row.telegram_chat_id}`);
        await new Promise(r => setTimeout(r, 3000));
    }
}

module.exports = {
    spawnClient,
    getClient,
    destroyClient,
    restoreAllSessions,
    getAllClients
};