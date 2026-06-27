const Claude = require('@anthropic-ai/sdk');
const fs = require('fs/promises');
const prompts = require('../prompts');

const client = new Claude();

const dealSchema = {
    type: 'object',
    properties: {
        deal_score: { type: 'integer', description: '0-100, resale margin for a flipper — not buyer fairness' },
        price: { type: ['number', 'null'], description: 'Asking price in EC$. null if no price or trade.' },
        is_trade: { type: 'boolean' },
        category: {
            type: 'string',
            enum: ['electronics', 'phones_tablets', 'computers', 'appliances',
                   'furniture', 'vehicles', 'clothing_footwear', 'tickets_events',
                   'services', 'home_garden', 'tools', 'sports_outdoors',
                   'baby_kids', 'pets', 'other']
        },
        condition: { type: ['string', 'null'], description: 'new, like_new, good, fair, or poor. null ONLY if zero evidence — do not default to good.' },
        potential_selling_price: { type: ['number', 'null'],  description: 'Estimated local resale value in EC$, based on US market price + Dominica scarcity premium. null if item unidentifiable.' },
        fix_score: { type: ['integer', 'null'], description: '0-100 repair effort if broken/damaged. null if not applicable.' },
        is_noise: { type: 'boolean', description: 'true if NOT a sale listing — buyer inquiry, chatter, off-topic.' },
        notes: { type: 'string', description: 'One short sentence on resale potential or anything a reviewer should know.' }
    },
    required: ['deal_score', 'price', 'is_trade', 'category', 'is_noise', 'potential_selling_price']
};

const TOOLS_BOTH    = [
    { type: 'web_search_20250305', name: 'web_search' },
    { name: 'extract_deal', description: 'Extract structured deal info from a marketplace listing.', input_schema: dealSchema }
];
const TOOLS_EXTRACT = [
    { name: 'extract_deal', description: 'Extract structured deal info from a marketplace listing.', input_schema: dealSchema }
];

function sanitizeNumbers(result) {
    const numOrNull = v => (typeof v === 'number' && isFinite(v)) ? v : null;
    return {
        ...result,
        price: numOrNull(result.price),
        potential_selling_price: numOrNull(result.potential_selling_price),
        fix_score: numOrNull(result.fix_score),
        deal_score: numOrNull(result.deal_score),
    };
}

async function withRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            const is429 = err.status === 429 || err.message?.includes('rate_limit');
            if (!is429 || i === retries - 1) throw err;

            const retryAfter = Number(err.headers?.['retry-after']);
            const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : (2 ** i * 5000);
            console.warn(`[aiClient] Rate limited, retrying in ${wait / 1000}s...`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
}

async function classifyDeal(rawText, mediaRef) {
    const content = [];
    const skipSearch = !rawText || rawText.trim().length < 30; // if message is short and has no brand/model keywords, skip search

    if (mediaRef) {
        try {
            const imageBuffer = await fs.readFile(mediaRef);
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') }
            });
        } catch (err) {
            console.warn(`[aiClient] Could not read media ${mediaRef}:`, err.message);
        }
    }

    content.push({ type: 'text', text: rawText?.trim() || '[media-only listing, no text]' });

    const searchPass = skipSearch ? null : await withRetry(() => client.messages.create({
        model: process.env.AI_MODEL,
        max_tokens: 4096,
        system: prompts.classification,
        temperature: 0.2,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content }]
    }));

    const extractMessages = [
        { role: 'user', content },
        ...(skipSearch ? [] : [{ role: 'assistant', content: searchPass.content }]),
        { role: 'user', content: [{ type: 'text', text: 'Now call extract_deal with your analysis.' }] }
    ];

    const extractPass = await withRetry(() => client.messages.create({
        model: process.env.AI_MODEL,
        max_tokens: 1024,
        system: prompts.classification,
        temperature: 0.2,
        tools: TOOLS_EXTRACT,
        tool_choice: { type: 'tool', name: 'extract_deal' },
        messages: extractMessages
    }));

    const dealBlock = extractPass.content.find(b => b.type === 'tool_use' && b.name === 'extract_deal');
    if (!dealBlock) throw new Error('[aiClient] extract_deal not returned');

    const result = sanitizeNumbers(dealBlock.input);
    await new Promise(r => setTimeout(r, 2000));
    return result;
}

module.exports = { classifyDeal };