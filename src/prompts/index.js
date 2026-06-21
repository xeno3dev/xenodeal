const fs = require('fs');
const path = require('path');

const prompts = {};

fs.readdirSync(__dirname)
    .filter(file => file.endsWith('.txt'))
    .forEach(file => {
        const name = path.basename(file, '.txt');
        prompts[name] = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    });

module.exports = prompts;