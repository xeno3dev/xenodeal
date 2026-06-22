const NANP_PATTERN = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const DM_7_DIGIT = /\b\d{3}[-.\s]?\d{4}\b/g;

const LOCAL_AREA_CODE = process.env.LOCAL_AREA_CODE;

function normalize(rawMatch) {
    const digitsOnly = rawMatch.replace(/\D/g, '');
    return digitsOnly.length === 11 && digitsOnly.startsWith('1')
        ? digitsOnly.slice(1)
        : digitsOnly
}

function extractPostedNumbers(rawText) { 
    if (!rawText) return [];

    const nanpMatches = rawText.match(NANP_PATTERN) || [];
    const fullNumbers = nanpMatches.map(normalize)

    const remainder = rawText.replace(NANP_PATTERN, '');

    let localNumbers = [];
    if (LOCAL_AREA_CODE && /^\d{3}$/.test(LOCAL_AREA_CODE)) {
        const localMatches = remainder.match(DM_7_DIGIT) || [];
        localNumbers = localMatches.map(m => normalize(LOCAL_AREA_CODE + m));
    }

    return [...fullNumbers, ...localNumbers];
}

module.exports = { extractPostedNumbers }