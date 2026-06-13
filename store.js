// store.js — 輕量 JSON 檔案資料庫（零原生依賴，朋友規模足夠）
const fs = require('fs');
const path = require('path');

const FILE = process.env.DB_PATH || path.join(__dirname, 'data.json');

let data = { users: [], saves: {}, tokens: {}, battles: [], pvp: {}, worldBoss: null, nextUserId: 1 };
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

// 角色欄位：第 1 格沿用原本 key（userId），第 2~4 格用 userId:slot（純新增、不動到原存檔）
function slotKey(userId, slot) {
    const n = Number(slot) || 1;
    return n === 1 ? userId : (userId + ':' + n);
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
        for (let sl = 2; sl <= 4; sl++) delete data.saves[u.id + ':' + sl];
        for (const t in data.tokens) if (data.tokens[t] === u.id) delete data.tokens[t];
        flush(); return true;
    },
    // tokens
    addToken(token, userId) { data.tokens[token] = userId; flush(); },
    removeToken(token) { delete data.tokens[token]; flush(); },
    // saves
    getSave(userId, slot) { return data.saves[slotKey(userId, slot)] || null; },
    putSave(userId, json, slot) { data.saves[slotKey(userId, slot)] = { data: json, updated_at: new Date().toISOString() }; flush(); },
    slotsInfo(userId) { const o = {}; for (let s = 1; s <= 4; s++) o[s] = !!data.saves[slotKey(userId, s)]; return o; },
    // battles
    addBattle(a, b, winner) {
        data.battles.push({ a_name: a, b_name: b, winner, created_at: new Date().toISOString() });
        if (data.battles.length > 500) data.battles = data.battles.slice(-500);
        flush();
    },
    battlesFor(username) {
        return data.battles.filter(x => x.a_name === username || x.b_name === username).slice(-20).reverse();
    },
    // PvP 積分資料（每帳號一筆）
    getPvp(userId) { if (!data.pvp) data.pvp = {}; return data.pvp[userId] || null; },
    putPvp(userId, rec) { if (!data.pvp) data.pvp = {}; data.pvp[userId] = rec; flush(); return rec; },
    allPvp() { return data.pvp || {}; },
    // 世界王（每日活動）：全服共用一筆 { dayKey, scores: { userId: {name, dmg} } }
    getWB() { return data.worldBoss || null; },
    putWB(rec) { data.worldBoss = rec; flush(); return rec; },
    // 全域遊戲設定（所有玩家生效）：經驗倍率 / 攻速倍率
    getConfig() { return data.config || {}; },
    setConfig(cfg) { data.config = Object.assign({}, data.config, cfg); flush(); return data.config; }
};
