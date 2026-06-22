const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const groups = require('../config/groups.json')
const pg = require('../db/connection.js');
const tg = require('../alerts/telegram.js');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');

const client = new Client({
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    },
    authStrategy: new LocalAuth({ dataPath: 'auth_data' }),
    webVersion: '2.3000.1041871181-alpha',
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1041871181-alpha.html'
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('Client is ready!');
    await tg.sendSystemAlert('WhatsApp Client is ready!');

    require('../cron/classifier');
});

client.on('disconnected', async (reason) => {
    console.log('Client has disconnected!', reason);
    await tg.sendSystemAlert(`WhatsApp Client has disconnected! Reason: ${reason}`);
});

async function loglisting(message_id, group_id, sender, timestamp, raw_text, has_media, media_ref, processed) {
    console.log(typeof timestamp, timestamp)
    try {
        await pg.query(
            'INSERT INTO messages (message_id, group_id, sender, timestamp, raw_text, has_media, media_ref, processed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [message_id, group_id, sender, timestamp, raw_text, has_media, media_ref, processed]
        );
        console.log('Logged Listing from Group ID:', group_id);
    } catch (err) {
        console.error('Error making listing entry:', err);
        await tg.sendSystemAlert(`Error making listing entry for Group ID ${group_id}: ${err.message}`);
    }
}

async function resolveLidToNumber(client, lid) {
    try {
        const result = await client.pupPage.evaluate((lidStr) => {
            const wid = window.require('WAWebWidFactory').createWid(lidStr);
            const phone = window.require('WAWebApiContact').getPhoneNumber(wid);
            return phone ? phone._serialized : null;
        }, lid);
        return result;
    } catch (e) {
        return null;
    }
}  

client.on('message_create', async (msg) => {
    const incomingId = msg.from;

    const match = groups.find(g => g.group_id === incomingId);
    if (!match) {
        return;
    }

    try {
        if (msg.hasMedia) {
            try {
                const imgbuffer = await msg.downloadMedia();

                const processed = await sharp(Buffer.from(imgbuffer.data, 'base64'))
                    .resize({
                        width: 1280,
                        height: 1280,
                        fit: 'inside',
                        withoutEnlargement: true
                })
                    .jpeg({ quality: 82, mozjpeg: true })
                    .toBuffer();

                const dir = path.join('media', match.group_id);
                const filePath = path.join(dir, `${msg.id._serialized}.jpg`);

                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(filePath, processed);
                console.log(`Received message w/ media in group ${match.friendly_name} (${match.group_id})`);
                let sender = msg.author || msg.from;

                if (sender?.includes('@lid')) {
                    try {
                        const resolved = await client.pupPage.evaluate((lid) => {
                            try {
                                const wid   = window.require('WAWebWidFactory').createWid(lid);
                                const phone = window.require('WAWebApiContact').getPhoneNumber(wid);
                                return phone ? phone._serialized : null;
                            } catch (e) {
                                return null;
                            }
                        }, sender);

                        if (resolved) sender = resolved;
                        // if null, keep original @lid as fallback
                    } catch (err) {
                        console.error('[client] @lid resolution failed:', err.message);
                        // non-fatal — keep @lid, continue insert
                    }
                }
                await loglisting(msg.id._serialized, match.group_id, sender, new Date(msg.timestamp * 1000), msg.body, true, filePath, false);
            } catch (mediaErr) {
                console.error('Failed to retrieve/process media, treating as no-media:', mediaErr);
                console.log(`Received message in group ${match.friendly_name} (${match.group_id})`);
                await loglisting(msg.id._serialized, match.group_id, msg.author || msg.from, new Date(msg.timestamp * 1000), msg.body, true, null, false);
            }
        }
        else {
            console.log(`Received message in group ${match.friendly_name} (${match.group_id})`);
            await loglisting(msg.id._serialized, match.group_id, msg.author || msg.from, new Date(msg.timestamp * 1000), msg.body, false, null, false);
        }
    } catch (err) {
        console.error('Error processing incoming message:', err);
        try {
            await tg.sendSystemAlert(`Error processing WhatsApp message from ${incomingId}: ${err.message}`);
        } catch (alertErr) {
            console.error('Failed to send Telegram alert for WhatsApp error:', alertErr);
        }
    }
});

process.on('SIGINT', async () => {
    await client.destroy();
    process.exit(0);
});

module.exports = {
    client,
    resolveLidToNumber
};