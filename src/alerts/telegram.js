const { Telegraf } = require('telegraf');
const { pool } = require('../db/connection')

const groups = require('../config/groups.json');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
    handlerTimeout: 30000
});

const CATEGORY_LABELS = {
    electronics: 'Electronics', phones_tablets: 'Phones & Tablets',
    computers: 'Computers', appliances: 'Appliances',
    furniture: 'Furniture', vehicles: 'Vehicles',
    clothing_footwear: 'Clothing & Footwear', tickets_events: 'Tickets & Events',
    services: 'Services', home_garden: 'Home & Garden',
    tools: 'Tools', sports_outdoors: 'Sports & Outdoors',
    baby_kids: 'Baby & Kids', pets: 'Pets', other: 'Other'
};

const CONDITION_LABELS = {
    new: 'New', like_new: 'Like New', good: 'Good', fair: 'Fair', poor: 'Poor'
};

function formatDate(ts) {
    return new Date(ts).toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
    });
}

async function sendDealAlert(deal) {
    if (deal.is_noise) return;

    const group = groups.find(g => g.group_id === deal.group_id);
    const groupName = group?.friendly_name ?? deal.group_id;
    const category = CATEGORY_LABELS[deal.category]  ?? deal.category;
    const condition = CONDITION_LABELS[deal.condition] ?? deal.condition ?? 'Unknown';
    const price = deal.price != null ? `$${deal.price}` : 'N/A';
    const resell = deal.potential_selling_price  != null ? `$${deal.potential_selling_price}` : 'N/A';

    const lines = [
        `🤑 <b>Deal Alert</b>`,
        ``,
        `<b>Details</b>`,
        `• <b>Deal Score:</b> ${deal.deal_score}/100`,
        `• <b>Category:</b> ${category}`,
        `• <b>Condition:</b> ${condition}`,
        `• <b>Asking Price:</b> ${price}`,
        `• <b>Resell Price:</b> ${resell}`,
        `• <b>Posted On:</b> ${formatDate(deal.first_posted_at)}`,
        deal.is_trade ? `• <b>Trade:</b> Yes 🔄` : null,
        ``,
        `─────────────────────`,
        `<b>Original Message:</b> ${deal.raw_text}`,
        `<b>Evaluation Notes:</b> ${deal.notes ?? 'N/A'}`,
        `<b>Group:</b> ${groupName}`,
    ].filter(Boolean).join('\n');

    const lidPattern = /@lid$/;
    const senderPhone = lidPattern.test(deal.sender) ? null : deal.sender;
    const number = deal.posted_numbers?.[0] ?? senderPhone ?? null;

    const { rows } = await pool.query(
        `SELECT s.telegram_chat_id
         FROM subscribers s
         JOIN user_groups ug ON ug.subscriber_id = s.telegram_chat_id
         WHERE s.status    = 'active'
           AND s.wa_status = 'connected'
           AND ug.group_jid = $1
           AND $2 >= s.threshold
           AND (s.categories IS NULL OR $3 = ANY(s.categories))`,
        [deal.group_id, deal.deal_score, deal.category]
    );

    if (rows.length === 0) return;

    for (const row of rows) {
        try {
            await bot.telegram.sendMessage(
                row.telegram_chat_id,
                lines,
                {
                    parse_mode: 'HTML',
                    ...(number && {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '📱 Contact Seller', url: `https://wa.me/${number}` }
                            ]]
                        }
                    })
                }

            );
        } catch (err) {
            console.error(`[telegram] Failed to alert ${row.telegram_chat_id}:`, err.message)
        }
    }
}

module.exports = {
    sendSystemAlert: async (message) => {
        try {
            await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ SYSTEM: ${message}`);
            console.log('Message sent to Telegram successfully');
        } catch (err) {
            console.error('Error sending message to Telegram:', err);
        }
    },
    bot,
    sendDealAlert
};