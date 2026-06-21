const NOISE_PHRASES = [ 
    'good morning', 'gm', 'good night', 'gn', 'hi', 'hello',
    'ok', 'okay', 'thanks', 'thank you', 'noted', 'lol', 'lmao'
]
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const URL_PATTERN = /https?:\/\/\S+/g;


function isBareURL(rawText) {
    // url detection
    const withoutUrls = rawText.replace(URL_PATTERN, '').trim();
    const hasUrl = rawText.match(URL_PATTERN) !== null;
    return hasUrl && withoutUrls === '';
}

function isObviousNoise(rawText) { 
    // random ahh noise detector
    const normalized = rawText.trim().toLowerCase();
    if (NOISE_PHRASES.includes(normalized)) return true;

    // emoji detector
    if (rawText.replace(EMOJI_PATTERN, '').trim() === '') return true;
    
    return false;
}


function classifyMessage(rawText, hasMedia, messageType) {
    // istg if this fires
    if (messageType === 'sticker') return 'noise'
    
    // 1. real Listing and Photo Recognition Check
    if (hasMedia) return 'candidate';

    // 2. nothing to evaluate
    if (!rawText || !rawText.trim()) return 'noise';

    // 3. bare URL
    if (isBareURL(rawText)) return 'link_only';

    // 4. deny List
    if (isObviousNoise(rawText)) return 'noise';

    // 5. default
    return 'candidate'
}

module.exports = { classifyMessage }