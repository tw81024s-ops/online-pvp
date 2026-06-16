// store.js — 輕量 JSON 檔案資料庫（零原生依賴，朋友規模足夠）
const fs = require('fs');
const path = require('path');

const FILE = process.env.DB_PATH || path.join(__dirname, 'data.json');

let data = { users: [], saves: {}, tokens: {}, battles: [], pvp: {}, worldBoss: null, polyDex: {}, dolls: {}, nextUserId: 1 };
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
        if (data.polyDex) delete data.polyDex[u.id];
        if (data.dolls) delete data.dolls[u.id];
        for (const t in data.tokens) if (data.tokens[t] === u.id) delete data.tokens[t];
        flush(); return true;
    },
    // tokens
    addToken(token, userId) { data.tokens[token] = userId; flush(); },
    removeToken(token) { delete data.tokens[token]; flush(); },
    // saves
    getSave(userId, slot) { return data.saves[slotKey(userId, slot)] || null; },
    putSave(userId, json, slot) { data.saves[slotKey(userId, slot)] = { data: json, updated_at: new Date().toISOString() }; flush(); },
    deleteSave(userId, slot) { delete data.saves[slotKey(userId, slot)]; flush(); },
    sweepSaves(fn) {
        let changed = 0;
        for (const k in data.saves) {
            const rec = data.saves[k];
            if (!rec || typeof rec.data !== 'string') continue;
            const out = fn(rec.data);
            if (out != null && out !== rec.data) { rec.data = out; changed++; }
        }
        if (changed) flush();
        return changed;
    },
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
    // 帳號變身圖鑑（每帳號一筆：{ formName: count }，所有角色共用）
    getPolyDex(userId) { if (!data.polyDex) data.polyDex = {}; return data.polyDex[userId] || {}; },
    // 娃娃（帳號層級共用，合併 union 取較高星/碎片，永不掉資料）
    getDolls(userId) { if (!data.dolls) data.dolls = {}; return data.dolls[userId] || null; },
    putDolls(userId, obj) {
        if (!data.dolls) data.dolls = {};
        const cur = data.dolls[userId] || { dolls: {}, dollEquip: [], dollDraws: 0 };
        const inc = obj || {};
        const md = Object.assign({}, cur.dolls || {});
        const ind = inc.dolls || {};
        for (const id in ind) {
            const a = md[id], b = ind[id] || {};
            if (!a) md[id] = { star: b.star || 1, shards: b.shards || 0 };
            else md[id] = { star: Math.max(a.star || 1, b.star || 1), shards: Math.max(a.shards || 0, b.shards || 0) };
        }
        const rec = {
            dolls: md,
            dollEquip: (Array.isArray(inc.dollEquip) && inc.dollEquip.length) ? inc.dollEquip : (cur.dollEquip || []),
            dollDraws: Math.max(cur.dollDraws || 0, inc.dollDraws || 0),
            updated_at: new Date().toISOString()
        };
        data.dolls[userId] = rec; flush(); return rec;
    },
    mergePolyDex(userId, dexObj) {
        if (!data.polyDex) data.polyDex = {};
        const cur = data.polyDex[userId] || {};
        if (dexObj && typeof dexObj === 'object') {
            for (const k in dexObj) { const v = Number(dexObj[k]) || 0; if ((cur[k] || 0) < v) cur[k] = v; }
        }
        data.polyDex[userId] = cur; flush(); return cur;
    },
    // PvP 積分資料（每帳號一筆）
    getPvp(userId) { if (!data.pvp) data.pvp = {}; return data.pvp[userId] || null; },
    putPvp(userId, rec) { if (!data.pvp) data.pvp = {}; data.pvp[userId] = rec; flush(); return rec; },
    allPvp() { return data.pvp || {}; },
    // 世界王（每日活動）：全服共用一筆 { dayKey, scores: { userId: {name, dmg} } }
    getWB() { return data.worldBoss || null; },
    putWB(rec) { data.worldBoss = rec; flush(); return rec; },
    getTower() { if (!data.tower) data.tower = {}; return data.tower; },
    putTower(t) { data.tower = t; flush(); return t; },
    // 全域遊戲設定（所有玩家生效）：經驗倍率 / 攻速倍率
    getConfig() { return data.config || {}; },
    setConfig(cfg) { data.config = Object.assign({}, data.config, cfg); flush(); return data.config; }
};
