const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

module.exports = {
    sendSystemAlert: async (message) => {
        try {
            await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ SYSTEM: ${message}`);
            console.log('Message sent to Telegram successfully');
        } catch (err) {
            console.error('Error sending message to Telegram:', err);
        }
    },
    bot
};