const Claude = require('@anthropic-ai/sdk');
const fs = require('fs/promises');
const prompts = require('../prompts');

const client = new Claude();

const dealSchema = {
    type: 'object',
    properties: {
        deal_score: { type: 'integer', description: '0-100, overall how good a deal this is' },
        price: { type: ['number', 'null'] },
        is_trade: { type: 'boolean' },
        category: {
            type: 'string',
            enum: ['electronics', 'phones_tablets', 'computers', 'appliances',
                   'furniture', 'vehicles', 'clothing_footwear', 'tickets_events',
                   'services', 'home_garden', 'tools', 'sports_outdoors',
                   'baby_kids', 'pets', 'other']
        },
        condition: { type: ['string', 'null'], description: 'e.g. new, like_new, good, fair, poor — null if not assessable' },
        fix_score: { type: ['integer', 'null'] },
        is_noise: { type: 'boolean', description: '...' },
        notes: { type: 'string', description: '...' }
    },
    required: ['deal_score', 'price', 'is_trade', 'category', 'is_noise']
};

async function classifyDeal(rawText, mediaRef) {
    const content = [];

    if (mediaRef) {
        const imageBuffer = await fs.readFile(mediaRef);
        content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') }
        });
    }
    content.push({ type: 'text', text: rawText });

    const response = await client.messages.create({
        model: process.env.AI_MODEL,
        max_tokens: 1024,
        system: prompts.classification,
        tools: [{ name: 'extract_deal', description: 'Extract structured deal info from a marketplace listing.', input_schema: dealSchema }],
        tool_choice: { type: 'tool', name: 'extract_deal' },
        messages: [{ role: 'user', content }]
    });

    const toolBlock = response.content.find(b => b.type === 'tool_use');
    return toolBlock.input;
}

module.exports = { classifyDeal };