const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');
const { pool } = require('../db/connection');
const { classifyMessage } = require('../intelligence/preFilter')

async function loglisting(message_id, group_id, sender, timestamp, raw_text, has_media, media_ref, processed, subscriber_id = null) {
    console.log(typeof timestamp, timestamp)
    try {
        await pool.query(
            'INSERT INTO messages (message_id, group_id, sender, timestamp, raw_text, has_media, media_ref, processed, subscriber_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (message_id) DO NOTHING',
            [message_id, group_id, sender, timestamp, raw_text, has_media, media_ref, processed, subscriber_id]
        );
        console.log('Logged Listing from Group ID:', group_id);
    } catch (err) {
        console.error('Error making listing entry:', err);
        await console.error(`[loglisting] Error making listing entry for Group ID ${group_id}: ${err.message}`);
    }
}

async function handleMessage(msg, chatId, client) {
    const groupJid = msg.from

    const { rows } = await pool.query(
        'SELECT 1 FROM user_groups WHERE subscriber_id = $1 AND group_jid = $2',
        [chatId, groupJid]
    );

    if (rows.length === 0) {    
        return;
    }

    const result = classifyMessage(msg.body, msg.hasMedia, msg.type);

    if (result === 'noise') {
        return;
    }

    let sender = msg.author || msg.from;

    if (sender.includes('@lid')) {
        try {
            const resolved = await client.pupPage.evaluate((sender) => {
                const wid = window.require('WAWebWidFactory').createWid(sender);
                const phone = window.require('WAWebApiContact').getPhoneNumber(wid);
                return phone? phone._serialized : null;
            }, sender);

            if (resolved) {
                sender = resolved;
            }
        } catch (e) {
            sender = msg.author || msg.from;
            console.log('[] Error resolving phone number of sender:', sender);
        }

    }

    let mediaRef = null;

    if (msg.hasMedia && msg.type !== 'sticker') {
        try {
            const imgBuffer = await msg.downloadMedia();
            if (imgBuffer && imgBuffer.data) {
                const mediaDir = path.join('media', groupJid);
                await fs.mkdir(mediaDir, { recursive: true });
                let mediaPath = path.join(mediaDir, msg.id.id + '.jpg');

                await sharp(Buffer.from(imgBuffer.data, 'base64'))
                    .resize(1280, 1280, { fit: 'inside' })
                    .jpeg({ quality: 82, mozjpeg: true })
                    .toFile(mediaPath);

                mediaRef = mediaPath;
            }
        } catch (e) {
            console.log(e);
            console.log('[] Error processing image from sender:', sender);
        }
    }

    await loglisting(msg.id.id, groupJid, sender, new Date(msg.timestamp * 1000), msg.body, msg.hasMedia, mediaRef, false, chatId);
}

module.exports = {
    handleMessage
};