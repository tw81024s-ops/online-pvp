// store.js — 輕量 JSON 檔案資料庫（零原生依賴，朋友規模足夠）
const fs = require('fs');
const path = require('path');

const FILE = process.env.DB_PATH || path.join(__dirname, 'data.json');

let data = { users: [], saves: {}, tokens: {}, battles: [], nextUserId: 1 };
try {
    if (fs.existsSync(FILE)) data = Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch (e) { console.error('讀取資料檔失敗，使用空白資料庫：', e.message); }

let flushTimer = null;
function flush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        try {
            const tmp = FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data));
            fs.renameSync(tmp, FILE); // 原子寫入，避免寫到一半斷電壞檔
        } catch (e) { console.error('寫入資料檔失敗：', e.message); }
    }, 300);
}

module.exports = {
    // users
    findUser(username) { return data.users.find(u => u.username === username) || null; },
    findUserByToken(token) {
        const uid = data.tokens[token];
        return uid ? data.users.find(u => u.id === uid) || null : null;
    },
    createUser(username, passHash, isAdmin) {
        const u = { id: data.nextUserId++, username, pass_hash: passHash, is_admin: isAdmin ? 1 : 0, created_at: new Date().toISOString() };
        data.users.push(u); flush(); return u;
    },
    userCount() { return data.users.length; },
    allUsers() { return data.users.map(u => ({ id: u.id, username: u.username, is_admin: u.is_admin, created_at: u.created_at })); },
    setPassword(username, passHash) {
        const u = this.findUser(username); if (!u) return false;
        u.pass_hash = passHash; flush(); return true;
    },
    deleteUser(username) {
        const u = this.findUser(username); if (!u) return false;
        data.users = data.users.filter(x => x.id !== u.id);
        delete data.saves[u.id];
        for (const t in data.tokens) if (data.tokens[t] === u.id) delete data.tokens[t];
        flush(); return true;
    },
    // tokens
    addToken(token, userId) { data.tokens[token] = userId; flush(); },
    removeToken(token) { delete data.tokens[token]; flush(); },
    // saves
    getSave(userId) { return data.saves[userId] || null; },
    putSave(userId, json) { data.saves[userId] = { data: json, updated_at: new Date().toISOString() }; flush(); },
    // battles
    addBattle(a, b, winner) {
        data.battles.push({ a_name: a, b_name: b, winner, created_at: new Date().toISOString() });
        if (data.battles.length > 500) data.battles = data.battles.slice(-500);
        flush();
    },
    battlesFor(username) {
        return data.battles.filter(x => x.a_name === username || x.b_name === username).slice(-20).reverse();
    }
};
