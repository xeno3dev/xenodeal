const PAGE_SIZE = 10;

function buildGroupPicker(chats, selected, page = 0) {
    const groups = chats.filter(c => c.isGroup);
    const slice = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const total = groups.length;

    const buttons = slice.map(g => [{
        text: (selected.has(g.id._serialized) ? '✅' : '❌') + g.name,
        callback_data: 'toggle:' + g.id._serialized
    }]);

    const navRow = [];
    if (page > 0) {
        navRow.push({
            text: '⬅️ Previous',
            callback_data: 'page:' + (page - 1)
        });
    }

    if ((page + 1) * PAGE_SIZE < total) {
        navRow.push({
            text: 'Next ➡️',
            callback_data: 'page:' + (page + 1)
        });
    }

    if (navRow.length > 0) {
        buttons.push(navRow);
    }

    const doneRow = [{
        text: 'Done (' + selected.size + ' selected)',
        callback_data: 'addgroup:done'
    }];
    buttons.push(doneRow);

    return { inline_keyboard: buttons };
}

module.exports = {
    buildGroupPicker
};