const pool =  require('../db/connection');
const state = require('./state');
const { spawnClient } = require('../whatsapp/clientPool');
const { bot } = require('../alerts/telegram');
const { buildGroupPicker } = require('./keyboards');
const { getClient } = require('../whatsapp/clientPool');

const PHONE_REGEX = /^\d{10,15}$/;

function registerCommands() {
    bot.command('start', async (ctx) => {
        const chatId = String(ctx.chat.id);
        const username = ctx.from?.username ?? null;
        pool.query(
            'INSERT INTO subscribers (telegram_chat_id, telegram_username, wa_status) VALUES ($1,$2,$3) ON CONFLICT (telegram_chat_id) DO NOTHING',
            [chatId, username, 'pending']
        );

        const { rows } = await pool.query('SELECT wa_status FROM subscribers WHERE telegram_chat_id = $1', [chatId]);
        if (rows[0]?.wa_status === 'connected') {
            await bot.telegram.sendMessage(chatId, 'You are already linked to WhatsApp!');
            return;
        }
        state.set(chatId, { step: 'awaitingPhone', data: {} });
        ctx.reply('Welcome to XenoDeal! Please enter your phone number to link your WhatsApp account and start setup.');
    });

    bot.command('addgroup', async (ctx) => {
        const chatId = String(ctx.chat.id);
        const client = await getClient(chatId);

        if (!client) {
            await bot.telegram.sendMessage(chatId, '❌ No WhatsApp session found. Run /start first.');
            return;
        }

        ctx.reply("⏳ Fetching your groups...");

        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup);

        if (groups.length === 0) {
            await bot.telegram.sendMessage(chatId, '🫗 You don\'t have any groups. Make sure your in some groups, then try again.');
            return;
        }

        state.set(chatId, { step: 'awaiting_group', data: { chats, selected: new Set(), page: 0 } });

        ctx.reply('🔍 Select a group for XenoDeal to monitor.\nTap to Toggle, then tap Done.', {
            reply_markup: buildGroupPicker(chats, new Set(), 0)
        });
    });

    bot.on('callback_query', async (ctx) => {
        const chatId = String(ctx.chat.id);
        const data = ctx.callbackQuery.data;
        const current = state.get(chatId);

        await ctx.answerCbQuery();

        if (data.startsWith('toggle:')) {
            if (!current) {
                return;
            }

            const jid = data.split(':')[1];

            if (current.data.selected.has(jid)) {
                current.data.selected.delete(jid);
            } else {
                current.data.selected.add(jid);
            }

            state.set(chatId, current);

            try {
                ctx.editMessageReplyMarkup(
                    buildGroupPicker(current.data.chats, current.data.selected, current.data.page)
                )
            } catch (err) {
                if (!err.message.includes('not modified')) {
                    throw err;
                }
            }
        }

        if (data.startsWith('page:')) {
            if (!current) {
                return;
            }

            const page = parseInt(data.split(':')[1]);
            current.data.page = page;
            state.set(chatId, current);

            try {
                ctx.editMessageReplyMarkup(
                    buildGroupPicker(current.data.chats, current.data.selected, current.data.page)
                )
            } catch (err) {
                if (!err.message.includes('not modified')) {
                    throw err;
                }
            }
        }

        if (data === 'addgroup:done') {
            if (!current) {
                return;
            }

            const selected = current.data.selected;

            if (selected.size === 0) {
                await bot.telegram.sendMessage(chatId, '🤔 You didn\'t select any groups. Please select one and try again.');
                return;
            }
            
            for (const jid of selected) {
                const group = current.data.chats.find(c => c.id._serialized === jid);
                
                pool.query(
                    'INSERT INTO groups (group_id, friendly_name) VALUES ($1, $2) ON CONFLICT (group_id) DO NOTHING',
                    [group.id._serialized, group.name]
                );

                pool.query(
                    'INSERT INTO user_groups (subscriber_id, group_jid, friendly_name) VALUES ($1, $2, $3) ON CONFLICT (subscriber_id, group_jid) DO NOTHING',
                    [chatId, group.id._serialized, group.name]
                );
            }

            state.delete(chatId);

            await ctx.editMessageText(
                '🎊 Groups Added!\n✅ Now monitoring ' + selected.size + ' group(s):\n' +
                [...selected].map(jid =>
                    '• ' + current.data.chats.find(c => c.id._serialized === jid)?.name
                ).join('\n') +
                '\n\nSet your alert threshold with /threshold'
            )
        }
    });

    bot.on('text', (ctx) => {
        if (ctx.message.text.startsWith('/')) {
            return;
        }

        const chatId = String(ctx.chat.id);
        const current = state.get(chatId);
        if (!current) {
            return;
        }

        if (current.step === 'awaitingPhone') {
            const phone = ctx.message.text.trim();

            if (!PHONE_REGEX.test(phone)) {
                ctx.reply('Please enter a valid phone number.');
                ctx.reply('Example: 12345678901');
                return;
            }

            pool.query(
                'UPDATE subscribers SET phone_number = $1 WHERE telegram_chat_id = $2',
                [phone, chatId]
            );

            state.set(chatId, { step: 'awaiting_pairing', data: { phone } });
            spawnClient(chatId, phone)
            return;
        }
    });
}

module.exports = {
    registerCommands
};