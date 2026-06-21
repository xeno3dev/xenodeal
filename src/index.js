const env = require('dotenv').config();
const pg = require('./db/connection.js');
const wa = require('./whatsapp/client.js');
const tg = require('./alerts/telegram.js');

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
    await tg.sendSystemAlert('test');
    wa.initialize();
}

main();