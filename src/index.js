require('dns').setDefaultResultOrder('ipv4first');

const env = require('dotenv').config();
const pg = require('./db/connection.js');
const { registerCommands } = require('./bot/commands');
const { restoreAllSessions, getAllClients } = require('./whatsapp/clientPool');
const { bot } = require('./alerts/telegram');

async function pginit() {
    try {
        await pg.query('SELECT NOW()');
        console.log('Connected to PostgreSQL database');
    } catch (err) {
        console.error('Error connecting to PostgreSQL database:', err);
        process.exit(1);
    }
}

async function main() {
    await pginit();
    registerCommands();
    await restoreAllSessions();
    bot.catch((err, ctx) => {
      console.error('[bot] Error:', err.message);
    });
    launchBot();
    require('./cron/classifier.js');
}

function launchBot(attempt = 1) {
    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY_MS = 3000;
    bot.launch(() => console.log('[bot] launched, polling for updates'))
        .catch(async (err) => {
            console.error(`[bot] launch attempt ${attempt} failed: ${err.message}`);
            if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
                launchBot(attempt + 1);
            } else {
                console.error('[bot] could not start after retries; exiting');
                process.exit(1);
            }
        });
}

process.once('SIGINT', async () => {
  for (const client of getAllClients()) {
    await client.destroy()
  }
  bot.stop('SIGINT')
  process.exit(0)
})

process.once('SIGTERM', async () => {
  for (const client of getAllClients()) {
    await client.destroy()
  }
  bot.stop('SIGTERM')
  process.exit(0)
})

process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err.message);
});

main();