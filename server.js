// server.js — 放置天堂 線上對戰伺服器
// 功能：帳號註冊/登入、雲端存檔、WebSocket 在線狀態與即時對戰、管理員 API、遊戲靜態檔案
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const { simulate, clampProfile, simulateBossDps } = require('./battle');
const store = require('./store');

// ====== App ======
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        // 讓瀏覽器每次都向伺服器確認 js/html 是否更新，避免改版後讀到舊快取
        if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// 後備：部分素材檔名被解壓工具轉成 #Uxxxx 跳脫形式（中文檔名）。
// 當遊戲用「中文檔名」要圖、static 找不到時，自動轉成 #Uxxxx 形式再找一次。
app.use('/assets', (req, res, next) => {
    let decoded;
    try { decoded = decodeURIComponent(req.path); } catch (e) { return next(); }
    if (!/[^\x00-\x7F]/.test(decoded)) return next();   // 純 ASCII 檔名不處理
    let escaped = '';
    for (const ch of decoded) {
        const code = ch.codePointAt(0);
        escaped += code > 127 ? '#U' + code.toString(16).padStart(4, '0') : ch;
    }
    const filePath = path.join(__dirname, 'public', 'assets', escaped);
    fs.access(filePath, fs.constants.R_OK, err => err ? next() : res.sendFile(filePath));
});

function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function isAdminUser(u) {
    return !!(u && (u.is_admin || (process.env.ADMIN_USERNAME && u.username === process.env.ADMIN_USERNAME)));
}
// ===== 防作弊：上傳存檔時夾限可被竄改的數值（金幣/強化）=====
const EN_CAP = 30;       // 裝備強化上限（+501 之類為作弊，可調整）
// 金幣不設上限：玩家可透過潘朵拉抽獎賣道具合法累積大量金幣，難判斷；只擋非法值（負/NaN/Infinity）
function clampNum(v, lo, hi, dflt) {
    v = Number(v);
    if (!isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
}
function sanitizeSaveObj(obj) {
    try {
        const p = obj && obj.p;
        if (!p || typeof p !== 'object') return obj;
        if ('gold' in p) { var _g = Number(p.gold); p.gold = (isFinite(_g) && _g >= 0) ? Math.min(_g, 1e11) : 0; }   // 金幣上限 1000億
        const cEn = it => { if (it && typeof it === 'object' && 'en' in it) it.en = clampNum(it.en, 0, EN_CAP, 0); };
        if (p.eq && typeof p.eq === 'object') Object.keys(p.eq).forEach(k => cEn(p.eq[k]));
        if (Array.isArray(p.inv)) p.inv.forEach(cEn);
    } catch (e) { }
    return obj;
}
function sanitizeSaveStr(str) {
    try { return JSON.stringify(sanitizeSaveObj(JSON.parse(str))); } catch (e) { return str; }
}
function auth(req, res, next) {
    const tok = req.headers['x-token'];
    if (!tok) return res.status(401).json({ error: '未登入' });
    const row = store.findUserByToken(tok);
    if (!row) return res.status(401).json({ error: '登入已失效，請重新登入' });
    req.user = row;
    next();
}

// 註冊（第一個註冊的帳號自動成為管理員）
app.post('/api/register', (req, res) => {
    let { username, password } = req.body || {};
    username = String(username || '').trim();
    if (!/^[\w\u4e00-\u9fff]{2,16}$/.test(username)) return res.status(400).json({ error: '帳號需 2~16 字（中英數字或底線）' });
    if (!password || String(password).length < 4) return res.status(400).json({ error: '密碼至少 4 碼' });
    if (store.findUser(username)) return res.status(400).json({ error: '帳號已存在' });
    // 指定了 ADMIN_USERNAME → 只有該帳號是管理員；否則沿用「第一個註冊＝管理員」
    const makeAdmin = process.env.ADMIN_USERNAME ? (username === process.env.ADMIN_USERNAME) : (store.userCount() === 0);
    const u = store.createUser(username, bcrypt.hashSync(String(password), 10), makeAdmin);
    const token = makeToken();
    store.addToken(token, u.id);
    res.json({ token, username, isAdmin: isAdminUser(u) });
});

// 登入
app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const u = store.findUser(String(username || '').trim());
    if (!u || !bcrypt.compareSync(String(password || ''), u.pass_hash)) return res.status(401).json({ error: '帳號或密碼錯誤' });
    const token = makeToken();
    store.addToken(token, u.id);
    res.json({ token, username: u.username, isAdmin: isAdminUser(u) });
});

app.post('/api/logout', auth, (req, res) => {
    store.removeToken(req.headers['x-token']);
    res.json({ ok: true });
});

// 雲端存檔
function reqSlot(req) {
    const n = parseInt(req.query.slot || (req.body && req.body.slot)) || 1;
    return Math.min(4, Math.max(1, n));   // 限制 1~4
}
app.get('/api/save', auth, (req, res) => {
    const row = store.getSave(req.user.id, reqSlot(req));
    if (!row) return res.json({ data: null });
    res.json({ data: row.data, updatedAt: row.updated_at });
});
app.put('/api/save', auth, (req, res) => {
    let body = req.body && req.body.data ? req.body.data : null;
    if (body && !isAdminUser(req.user)) body = sanitizeSaveObj(body);   // 管理員不夾限（方便測試）
    const data = JSON.stringify(body);
    if (!data || data === 'null') return res.status(400).json({ error: '存檔資料為空' });
    if (data.length > 4 * 1024 * 1024) return res.status(400).json({ error: '存檔過大' });
    store.putSave(req.user.id, data, reqSlot(req));
    const _r = store.getSave(req.user.id, reqSlot(req));
    res.json({ ok: true, updatedAt: _r ? _r.updated_at : null });
});
app.delete('/api/save', auth, (req, res) => {
    store.deleteSave(req.user.id, reqSlot(req));
    res.json({ ok: true });
});
// 角色欄位：回傳哪些格子有角色
app.get('/api/slots', auth, (req, res) => {
    res.json({ slots: store.slotsInfo(req.user.id) });
});

// 對戰紀錄
app.get('/api/battles', auth, (req, res) => {
    res.json({ battles: store.battlesFor(req.user.username) });
});

// ====== 管理員 API ======
function adminOnly(req, res, next) {
    if (!isAdminUser(req.user)) return res.status(403).json({ error: '需要管理員權限' });
    next();
}

// 全域遊戲設定：所有玩家讀取套用（經驗倍率 / 攻速倍率 / 競技場傷害倍率）
app.get('/api/config', (req, res) => {
    const c = store.getConfig();
    res.json({
        expMult: c.expMult || 1, spdMult: c.spdMult || 1,
        pvpDmgMult: c.pvpDmgMult != null ? c.pvpDmgMult : 1,
        pvpMagicMult: c.pvpMagicMult != null ? c.pvpMagicMult : 1,
        goldDropMult: c.goldDropMult != null ? c.goldDropMult : 1, dropMult: c.dropMult != null ? c.dropMult : 1,
        synthRateMult: c.synthRateMult != null ? c.synthRateMult : 1,
        enhanceRateMult: c.enhanceRateMult != null ? c.enhanceRateMult : 1,
        pandoraLuckMult: c.pandoraLuckMult != null ? c.pandoraLuckMult : 1,
        towerDiff: c.towerDiff != null ? c.towerDiff : 1.5,
        synthGao: c.synthGao!=null?c.synthGao:null, synthRare: c.synthRare!=null?c.synthRare:null, synthHero: c.synthHero!=null?c.synthHero:null, synthLegend: c.synthLegend!=null?c.synthLegend:null, synthMyth: c.synthMyth!=null?c.synthMyth:null, synthUniq: c.synthUniq!=null?c.synthUniq:null, dollT5: c.dollT5!=null?c.dollT5:null, dollT6: c.dollT6!=null?c.dollT6:null, dollT7: c.dollT7!=null?c.dollT7:null, dollT8: c.dollT8!=null?c.dollT8:null, mageDmgMult: c.mageDmgMult!=null?c.mageDmgMult:1, meleeDmgMult: c.meleeDmgMult!=null?c.meleeDmgMult:1, rangedDmgMult: c.rangedDmgMult!=null?c.rangedDmgMult:1,
        eventZongzi: c.eventZongzi ? 1 : 0
    });
});
app.post('/api/admin/config', auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const cfg = {};
    if (b.expMult !== undefined) cfg.expMult = Math.max(0, Math.min(1000, parseFloat(b.expMult) || 1));
    if (b.spdMult !== undefined) cfg.spdMult = Math.max(1, Math.min(20, parseFloat(b.spdMult) || 1));
    if (b.pvpDmgMult !== undefined) cfg.pvpDmgMult = Math.max(0.05, Math.min(5, parseFloat(b.pvpDmgMult) || 1));
    if (b.pvpMagicMult !== undefined) cfg.pvpMagicMult = Math.max(0.05, Math.min(5, parseFloat(b.pvpMagicMult) || 1));
    if (b.goldDropMult !== undefined) cfg.goldDropMult = Math.max(0, Math.min(100, parseFloat(b.goldDropMult) || 1));
    if (b.dropMult !== undefined) cfg.dropMult = Math.max(0, Math.min(100, parseFloat(b.dropMult) || 1));
    if (b.synthRateMult !== undefined) cfg.synthRateMult = Math.max(0, Math.min(100, parseFloat(b.synthRateMult) || 1));
    if (b.enhanceRateMult !== undefined) cfg.enhanceRateMult = Math.max(0, Math.min(100, parseFloat(b.enhanceRateMult) || 1));
    if (b.pandoraLuckMult !== undefined) cfg.pandoraLuckMult = Math.max(0, Math.min(100, parseFloat(b.pandoraLuckMult) || 1));
    if (b.towerDiff !== undefined) cfg.towerDiff = Math.max(0.5, Math.min(50, parseFloat(b.towerDiff) || 1.5));
    ['synthGao','synthRare','synthHero','synthLegend','synthMyth','synthUniq'].forEach(k => { if (b[k] !== undefined) cfg[k] = Math.max(0, Math.min(100, parseFloat(b[k]) || 0)); });
    ['dollT5','dollT6','dollT7','dollT8'].forEach(k => { if (b[k] !== undefined) cfg[k] = Math.max(0, Math.min(100, parseFloat(b[k]) || 0)); });
    ['mageDmgMult','meleeDmgMult','rangedDmgMult'].forEach(k => { if (b[k] !== undefined) cfg[k] = Math.max(0.1, Math.min(10, parseFloat(b[k]) || 1)); });
    if (b.eventZongzi !== undefined) cfg.eventZongzi = b.eventZongzi ? 1 : 0;
    const out = store.setConfig(cfg);
    res.json({ ok: true, config: {
        expMult: out.expMult || 1, spdMult: out.spdMult || 1,
        pvpDmgMult: out.pvpDmgMult != null ? out.pvpDmgMult : 1,
        pvpMagicMult: out.pvpMagicMult != null ? out.pvpMagicMult : 1,
        goldDropMult: out.goldDropMult != null ? out.goldDropMult : 1, dropMult: out.dropMult != null ? out.dropMult : 1,
        synthRateMult: out.synthRateMult != null ? out.synthRateMult : 1,
        enhanceRateMult: out.enhanceRateMult != null ? out.enhanceRateMult : 1,
        pandoraLuckMult: out.pandoraLuckMult != null ? out.pandoraLuckMult : 1,
        towerDiff: out.towerDiff != null ? out.towerDiff : 1.5,
        synthGao: out.synthGao!=null?out.synthGao:null, synthRare: out.synthRare!=null?out.synthRare:null, synthHero: out.synthHero!=null?out.synthHero:null, synthLegend: out.synthLegend!=null?out.synthLegend:null, synthMyth: out.synthMyth!=null?out.synthMyth:null, synthUniq: out.synthUniq!=null?out.synthUniq:null, dollT5: out.dollT5!=null?out.dollT5:null, dollT6: out.dollT6!=null?out.dollT6:null, dollT7: out.dollT7!=null?out.dollT7:null, dollT8: out.dollT8!=null?out.dollT8:null, mageDmgMult: out.mageDmgMult!=null?out.mageDmgMult:1, meleeDmgMult: out.meleeDmgMult!=null?out.meleeDmgMult:1, rangedDmgMult: out.rangedDmgMult!=null?out.rangedDmgMult:1,
        eventZongzi: out.eventZongzi ? 1 : 0
    } });
});

app.post('/api/admin/sweep-saves', auth, adminOnly, (req, res) => {
    const cleaned = store.sweepSaves(sanitizeSaveStr);
    res.json({ ok: true, cleaned });
});
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
    res.json({ users: store.allUsers() });
});
app.post('/api/admin/reset-password', auth, adminOnly, (req, res) => {
    const { username, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '密碼至少 4 碼' });
    res.json({ ok: store.setPassword(username, bcrypt.hashSync(String(newPassword), 10)) });
});
app.post('/api/admin/delete-user', auth, adminOnly, (req, res) => {
    const name = req.body && req.body.username;
    if (name === req.user.username) return res.status(400).json({ error: '不能刪除自己' });
    if (!store.deleteUser(name)) return res.status(404).json({ error: '找不到帳號' });
    res.json({ ok: true });
});

// 取得某玩家的存檔（管理員檢視/編輯用）
app.get('/api/admin/player/:username', auth, adminOnly, (req, res) => {
    const u = store.findUser(req.params.username);
    if (!u) return res.status(404).json({ error: '找不到帳號' });
    // 掃描 4 個角色欄位，挑「有資料且最近更新」的那個（玩家可能在欄位 2~4）
    // 同時把每個有資料的欄位都回傳，讓管理員能自己選要改哪一格
    let best = null, bestSlot = 1;
    const slots = {};
    for (let s = 1; s <= 4; s++) {
        const sv = store.getSave(u.id, s);
        if (sv && sv.data) {
            slots[s] = { data: sv.data, updatedAt: sv.updated_at, bytes: String(sv.data).length };
            if (!best || (sv.updated_at || '') > (best.updated_at || '')) { best = sv; bestSlot = s; }
        }
    }
    res.json({ username: u.username, data: best ? best.data : null, updatedAt: best ? best.updated_at : null, slot: bestSlot, slots });
});

// 覆寫某玩家的存檔（管理員編輯）
app.put('/api/admin/player/:username', auth, adminOnly, (req, res) => {
    const u = store.findUser(req.params.username);
    if (!u) return res.status(404).json({ error: '找不到帳號' });
    const slot = Math.min(4, Math.max(1, parseInt(req.body && req.body.slot) || 1));   // 寫回 admin 載入時的同一個角色欄位
    const data = JSON.stringify(req.body && req.body.data ? req.body.data : null);
    if (!data || data === 'null') return res.status(400).json({ error: '資料為空' });
    if (data.length > 4 * 1024 * 1024) return res.status(400).json({ error: '存檔過大' });
    store.putSave(u.id, data, slot);
    // 若該玩家正在線上，立即通知他重新載入（讓管理員的修改即時生效）
    try { const tw = online.get(u.username); if (tw) send(tw, { type: 'admin_updated' }); } catch (e) { }
    res.json({ ok: true, slot });
});

// 管理員診斷：列出所有帳號在雲端各格存檔的狀態（看雲端到底有沒有收到存檔）
app.get('/api/admin/saves', auth, adminOnly, (req, res) => {
    const out = store.allUsers().map(u => {
        const slots = {};
        for (let s = 1; s <= 4; s++) {
            const sv = store.getSave(u.id, s);
            slots[s] = (sv && sv.data) ? { bytes: String(sv.data).length, updatedAt: sv.updated_at } : null;
        }
        return { username: u.username, id: u.id, slots };
    });
    res.json({ users: out, total: out.length });
});

// ====== WebSocket：在線、挑戰、即時對戰 ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const online = new Map();      // username -> ws
const pending = new Map();     // challengeId -> {from, to, fromProfile, ts}
const pendingTrade = new Map(); // tradeReqId -> {from, to, ts}
const trades = new Map();       // tradeId -> {a,b,offerA,offerB,confA,confB}
const userTrade = new Map();    // username -> tradeId（同時只能進行一場交換）
const userNames = new Map();    // username -> 角色名字（競技場顯示）

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { } }
function broadcastOnline() {
    const list = [...online.keys()];
    const names = {}; for (const u of list) names[u] = userNames.get(u) || '';
    for (const ws of online.values()) send(ws, { type: 'online_list', users: list, names });
}

// ===== PvP 積分系統 =====
const PVP_TIERS = [
    { n: '青銅', min: 0 }, { n: '白銀', min: 1000 }, { n: '黃金', min: 1200 },
    { n: '白金', min: 1400 }, { n: '鑽石', min: 1600 }, { n: '大師', min: 1800 }
];
const PVP_WEEK_TICKETS = [2, 3, 5, 8, 12, 20];
function pvpTierIdx(score) { let i = 0; for (let k = 0; k < PVP_TIERS.length; k++) if (score >= PVP_TIERS[k].min) i = k; return i; }
function pvpTierName(score) { return PVP_TIERS[pvpTierIdx(score)].n; }
function _tzNow() { return new Date(Date.now() + 8 * 3600 * 1000); } // 台灣 UTC+8
function pvpDayKey(d) { d = d || _tzNow(); return d.toISOString().slice(0, 10); }
function pvpWeekKey(d) {
    d = d || _tzNow();
    const day = (d.getUTCDay() + 6) % 7;          // 0=週一
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - day);
    return mon.toISOString().slice(0, 10);
}
function pvpDefault(username) {
    return {
        username, name: '', score: 1000, dayNet: 0, weekNet: 0,
        dayKey: pvpDayKey(), weekKey: pvpWeekKey(), wins: 0, losses: 0, streak: 0,
        oppToday: {}, rewardedToday: 0, pendingGold: 0, pendingTickets: 0
    };
}
function pvpGet(userId, username) {
    let r = store.getPvp(userId);
    if (!r) r = pvpDefault(username);
    if (r.score == null) r.score = 1000;
    if (!r.oppToday) r.oppToday = {};
    if (r.pendingGold == null) r.pendingGold = 0;
    if (r.pendingTickets == null) r.pendingTickets = 0;
    if (username) r.username = username;
    return r;
}
// 跨日/跨週結算 → 累積到 pending，重置 net 與每日防刷計數
function pvpRollover(r) {
    const dk = pvpDayKey(), wk = pvpWeekKey();
    if (r.dayKey !== dk) {
        const g = Math.max(0, r.dayNet) * 100;
        if (g > 0) r.pendingGold += g;
        r.dayNet = 0; r.dayKey = dk; r.oppToday = {}; r.rewardedToday = 0;
    }
    if (r.weekKey !== wk) {
        const g = Math.max(0, r.weekNet) * 1000;
        const t = PVP_WEEK_TICKETS[pvpTierIdx(r.score)] || 0;
        if (g > 0) r.pendingGold += g;
        if (t > 0) r.pendingTickets += t;
        r.weekNet = 0; r.weekKey = wk;
    }
    return r;
}
// 把待領獎勵推給在線玩家（客戶端套用到當前角色）；成功推送才清空
function pvpFlushPending(r) {
    if ((r.pendingGold || 0) <= 0 && (r.pendingTickets || 0) <= 0) return;
    const ws = online.get(r.username);
    if (ws) {
        send(ws, { type: 'pvp_reward', gold: r.pendingGold || 0, tickets: r.pendingTickets || 0, reason: 'settle' });
        r.pendingGold = 0; r.pendingTickets = 0;
    }
}
// 一場結果記分＋發即時獎勵（勝利獎勵已 ×2）；含防刷
function pvpScoreMatch(rA, rB, winner) {
    if (winner === 'draw') return;
    const winR = winner === 'A' ? rA : rB;
    const loseR = winner === 'A' ? rB : rA;
    const oppCnt = winR.oppToday[loseR.username] || 0;
    const ranked = (oppCnt < 3) && (winR.rewardedToday < 20);   // 防刷：同對手每日3場、每日有獎20場
    if (!ranked) return;                                         // 超過：不計分不發獎
    winR.oppToday[loseR.username] = oppCnt + 1;
    winR.rewardedToday++;
    winR.score += 25; loseR.score = Math.max(0, loseR.score - 15);
    winR.dayNet += 25; winR.weekNet += 25;
    loseR.dayNet -= 15; loseR.weekNet -= 15;
    winR.wins++; loseR.losses++;
    winR.streak = (winR.streak || 0) + 1; loseR.streak = 0;
    const oppTier = pvpTierIdx(loseR.score);
    const gold = (500 + oppTier * 250) * 2;
    const chance = Math.min(0.8, (0.15 + oppTier * 0.05) * 2);
    const tickets = Math.random() < chance ? 1 : 0;
    const wWs = online.get(winR.username);
    if (wWs) send(wWs, { type: 'pvp_reward', gold, tickets, reason: 'win', score: winR.score, tier: pvpTierName(winR.score), delta: 25 });
    const lWs = online.get(loseR.username);
    if (lWs) send(lWs, { type: 'pvp_reward', gold: 100, tickets: 0, reason: 'lose', score: loseR.score, tier: pvpTierName(loseR.score), delta: -15 });
}

app.get('/api/pvp/me', auth, (req, res) => {
    const u = req.user; const r = pvpGet(u.id, u.username); pvpRollover(r); store.putPvp(u.id, r);
    const arr = Object.values(store.allPvp()).map(x => ({ username: x.username, score: x.score || 1000 })).sort((a, b) => b.score - a.score);
    const rank = arr.findIndex(x => x.username === u.username) + 1;
    res.json({
        score: r.score, tier: pvpTierName(r.score), dayNet: r.dayNet, weekNet: r.weekNet,
        wins: r.wins || 0, losses: r.losses || 0, streak: r.streak || 0, rank: rank || null,
        pendingGold: r.pendingGold || 0, pendingTickets: r.pendingTickets || 0
    });
});
app.get('/api/pvp/leaderboard', auth, (req, res) => {
    const arr = Object.values(store.allPvp())
        .map(x => ({ name: x.name || x.username, username: x.username, score: x.score || 1000, tier: pvpTierName(x.score || 1000) }))
        .sort((a, b) => b.score - a.score).slice(0, 10);
    res.json({ top: arr });
});

// 帳號變身圖鑑（所有角色共用）：讀取 / 合併上傳
app.get('/api/polydex', auth, (req, res) => {
    res.json({ dex: store.getPolyDex(req.user.id) });
});
app.post('/api/polydex', auth, (req, res) => {
    const dex = (req.body && req.body.dex) || {};
    const merged = store.mergePolyDex(req.user.id, dex);
    res.json({ dex: merged });
});
// 管理員：給予指定變身（推送給在線玩家，由客戶端寫入圖鑑＋存檔）
app.post('/api/admin/grant-poly', auth, adminOnly, (req, res) => {
    const { username, formName } = req.body || {};
    if (!formName) return res.status(400).json({ error: '缺少變身名稱' });
    const tw = online.get(username);
    if (!tw) return res.status(400).json({ error: '該玩家需在線上才能發放' });
    send(tw, { type: 'admin_grant_poly', formName: String(formName) });
    res.json({ ok: true });
});

// ===== 世界王（每日活動）=====
const WB_TICKS = 600;   // 60 秒（100ms/tick）
const WB_REWARDS = [1000000000, 500000000, 300000000, 100000000, 100000000, 100000000, 100000000, 100000000, 100000000, 100000000]; // 1~10 名金幣
function wbGet() {
    let w = store.getWB();
    if (!w || typeof w !== 'object') w = { dayKey: pvpDayKey(), scores: {} };
    if (!w.scores) w.scores = {};
    return w;
}
function wbRankOf(w, username) {
    const ranked = Object.values(w.scores).sort((a, b) => (b.dmg || 0) - (a.dmg || 0));
    const idx = ranked.findIndex(x => x.username === username);
    return idx >= 0 ? idx + 1 : null;
}
function settleWorldBoss(scores) {
    const ranked = Object.keys(scores).map(uid => ({ uid: Number(uid), name: scores[uid].name, username: scores[uid].username, dmg: scores[uid].dmg || 0 }))
        .sort((a, b) => b.dmg - a.dmg);
    for (let i = 0; i < ranked.length && i < WB_REWARDS.length; i++) {
        const uid = ranked[i].uid;
        const r = pvpGet(uid, ranked[i].username);
        r.pendingGold = (r.pendingGold || 0) + WB_REWARDS[i];
        store.putPvp(uid, r);
        pvpFlushPending(r);   // 在線即時發、離線登入時補發
        store.putPvp(uid, r);
    }
}
function wbRollover() {
    const w = wbGet();
    const dk = pvpDayKey();
    if (w.dayKey !== dk) {
        if (Object.keys(w.scores).length) settleWorldBoss(w.scores);
        w.scores = {}; w.dayKey = dk;
        store.putWB(w);
    }
    return w;
}
app.post('/api/worldboss/challenge', auth, (req, res) => {
    const u = req.user;
    const w = wbRollover();
    if (w.scores[u.id]) return res.status(400).json({ error: '今日已挑戰過世界王（每日 1 次）' });
    const cfg = store.getConfig();
    const dmg = simulateBossDps(req.body && req.body.profile ? req.body.profile : {}, WB_TICKS, {
        pvpDmgMult: cfg.pvpDmgMult != null ? cfg.pvpDmgMult : 1,
        pvpMagicMult: cfg.pvpMagicMult != null ? cfg.pvpMagicMult : 1,
        mageDmgMult: cfg.mageDmgMult != null ? cfg.mageDmgMult : 1,
        meleeDmgMult: cfg.meleeDmgMult != null ? cfg.meleeDmgMult : 1,
        rangedDmgMult: cfg.rangedDmgMult != null ? cfg.rangedDmgMult : 1
    });
    const name = (req.body && req.body.name) ? String(req.body.name).slice(0, 20) : u.username;
    w.scores[u.id] = { username: u.username, name, dmg };
    store.putWB(w);
    res.json({ ok: true, dmg, rank: wbRankOf(w, u.username) });
});
app.get('/api/worldboss/me', auth, (req, res) => {
    const u = req.user; const w = wbRollover();
    const s = w.scores[u.id];
    res.json({ done: !!s, dmg: s ? s.dmg : 0, rank: s ? wbRankOf(w, u.username) : null, dayKey: w.dayKey });
});
app.get('/api/worldboss/leaderboard', auth, (req, res) => {
    const w = wbRollover();
    const top = Object.values(w.scores).map(x => ({ name: x.name || x.username, dmg: x.dmg || 0 }))
        .sort((a, b) => b.dmg - a.dmg).slice(0, 10);
    res.json({ top });
});

// ===== 爬塔守護：排行榜（記錄每位玩家最高層）=====
app.post('/api/tower/submit', auth, (req, res) => {
    const u = req.user;
    const floor = Math.max(0, Math.min(100, parseInt((req.body && req.body.floor), 10) || 0));
    const name = (req.body && req.body.name) ? String(req.body.name).slice(0, 20) : u.username;
    const t = store.getTower();
    const cur = t[u.username];
    if (!cur || floor > (cur.floor || 0)) { t[u.username] = { name, floor, ts: Date.now() }; store.putTower(t); }
    const entries = Object.entries(t).map(([un, v]) => ({ un, floor: v.floor || 0 })).sort((a, b) => b.floor - a.floor);
    const rank = entries.findIndex(e => e.un === u.username) + 1;
    res.json({ ok: true, best: (t[u.username] || {}).floor || floor, rank: rank || null });
});
app.get('/api/tower/board', auth, (req, res) => {
    const t = store.getTower();
    const top = Object.values(t).map(x => ({ name: x.name, floor: x.floor || 0 }))
        .sort((a, b) => b.floor - a.floor).slice(0, 20);
    res.json({ top });
});

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch (e) { return; }

        if (msg.type === 'auth') {
            const row = store.findUserByToken(msg.token);
            if (!row) return send(ws, { type: 'auth_fail' });
            // 同帳號重複連線：踢掉舊的
            const old = online.get(row.username);
            if (old && old !== ws) { send(old, { type: 'kicked' }); try { old.close(); } catch (e) { } }
            ws.username = row.username;
            ws.userId = row.id;
            online.set(row.username, ws);
            send(ws, { type: 'auth_ok', username: row.username, isAdmin: isAdminUser(row) });
            broadcastOnline();
            // PvP：登入時做跨日/跨週結算，稍後把待領獎勵推給客戶端（等角色載入）
            try {
                const r0 = pvpGet(row.id, row.username); pvpRollover(r0); store.putPvp(row.id, r0);
                try { wbRollover(); } catch (e) { }   // 世界王跨日結算（任何人登入都會觸發一次）
                setTimeout(() => { try { const r = pvpGet(row.id, row.username); pvpFlushPending(r); store.putPvp(row.id, r); } catch (e) { } }, 2500);
            } catch (e) { }
            return;
        }
        if (!ws.username) return;

        // 回報角色名字（競技場顯示用）
        if (msg.type === 'set_name') {
            userNames.set(ws.username, String(msg.name || '').slice(0, 20));
            broadcastOnline();
            return;
        }

        // 發起挑戰：帶上自己的戰鬥數值
        if (msg.type === 'challenge') {
            const target = String(msg.to || '').trim();
            const tw = online.get(target);
            if (!tw) return send(ws, { type: 'error', error: `${target} 不在線上` });
            if (target === ws.username) return send(ws, { type: 'error', error: '不能挑戰自己' });
            const id = makeToken().slice(0, 12);
            pending.set(id, { from: ws.username, to: target, fromProfile: clampProfile(msg.profile || {}), ts: Date.now() });
            send(tw, { type: 'challenge_received', id, from: ws.username, fromName: userNames.get(ws.username) || '' });
            send(ws, { type: 'challenge_sent', to: target });
            return;
        }

        // 接受挑戰：帶上自己的戰鬥數值 → 伺服器模擬 → 雙方同步播放
        if (msg.type === 'challenge_accept') {
            const c = pending.get(msg.id);
            if (!c || c.to !== ws.username) return send(ws, { type: 'error', error: '挑戰已失效' });
            pending.delete(msg.id);
            const fromWs = online.get(c.from);
            if (!fromWs) return send(ws, { type: 'error', error: `${c.from} 已離線` });

            const pA = c.fromProfile;
            const pB = clampProfile(msg.profile || {});
            const _cfg = store.getConfig();
            const result = simulate(pA, pB, {
                pvpDmgMult: _cfg.pvpDmgMult != null ? _cfg.pvpDmgMult : 1,
                pvpMagicMult: _cfg.pvpMagicMult != null ? _cfg.pvpMagicMult : 1,
                mageDmgMult: _cfg.mageDmgMult != null ? _cfg.mageDmgMult : 1,
                meleeDmgMult: _cfg.meleeDmgMult != null ? _cfg.meleeDmgMult : 1,
                rangedDmgMult: _cfg.rangedDmgMult != null ? _cfg.rangedDmgMult : 1
            });
            store.addBattle(c.from, ws.username, result.winner === 'draw' ? '平手' : (result.winner === 'A' ? c.from : ws.username));

            // ===== PvP 積分記分＋即時獎勵 =====
            try {
                const uA = store.findUser(c.from), uB = store.findUser(ws.username);
                if (uA && uB) {
                    const rA = pvpGet(uA.id, c.from), rB = pvpGet(uB.id, ws.username);
                    rA.name = pA.name || rA.name; rB.name = pB.name || rB.name;
                    pvpRollover(rA); pvpRollover(rB);
                    pvpScoreMatch(rA, rB, result.winner);
                    store.putPvp(uA.id, rA); store.putPvp(uB.id, rB);
                }
            } catch (e) { console.error('pvp score err:', e.message); }

            const payload = {
                type: 'battle_start',
                a: { name: pA.name, user: c.from, mhp: pA.mhp, mmp: pA.mmp, cls: pA.cls, lv: pA.lv, avatar: pA.avatar, darkelf: pA.darkelf },
                b: { name: pB.name, user: ws.username, mhp: pB.mhp, mmp: pB.mmp, cls: pB.cls, lv: pB.lv, avatar: pB.avatar, darkelf: pB.darkelf },
                startAt: Date.now() + 1500,   // 雙方 1.5 秒後依同一時鐘開播
                events: result.events,
                winner: result.winner
            };
            send(fromWs, payload);
            send(ws, payload);
            return;
        }

        // ====== 玩家交換系統 ======
        if (msg.type === 'trade_request') {
            const target = String(msg.to || '').trim();
            const tw = online.get(target);
            if (!tw) return send(ws, { type: 'error', error: `${target} 不在線上` });
            if (target === ws.username) return send(ws, { type: 'error', error: '不能和自己交換' });
            if (userTrade.has(ws.username)) return send(ws, { type: 'error', error: '你正在交換中，請先完成或取消' });
            if (userTrade.has(target)) return send(ws, { type: 'error', error: `${target} 正在交換中` });
            const id = makeToken().slice(0, 12);
            pendingTrade.set(id, { from: ws.username, to: target, ts: Date.now() });
            send(tw, { type: 'trade_incoming', id, from: ws.username });
            send(ws, { type: 'trade_requested', to: target });
            return;
        }
        if (msg.type === 'trade_accept') {
            const c = pendingTrade.get(msg.id);
            if (!c || c.to !== ws.username) return send(ws, { type: 'error', error: '交換邀請已失效' });
            pendingTrade.delete(msg.id);
            const fromWs = online.get(c.from);
            if (!fromWs) return send(ws, { type: 'error', error: `${c.from} 已離線` });
            if (userTrade.has(c.from) || userTrade.has(c.to)) return send(ws, { type: 'error', error: '有一方已在其他交換中' });
            trades.set(msg.id, { a: c.from, b: c.to, offerA: { items: [], gold: 0 }, offerB: { items: [], gold: 0 }, confA: false, confB: false });
            userTrade.set(c.from, msg.id); userTrade.set(c.to, msg.id);
            send(fromWs, { type: 'trade_opened', id: msg.id, partner: c.to });
            send(ws, { type: 'trade_opened', id: msg.id, partner: c.from });
            return;
        }
        if (msg.type === 'trade_decline') {
            const c = pendingTrade.get(msg.id);
            if (c && c.to === ws.username) { pendingTrade.delete(msg.id); const fw = online.get(c.from); if (fw) send(fw, { type: 'trade_declined', by: ws.username }); }
            return;
        }
        if (msg.type === 'trade_offer') {
            const t = trades.get(msg.id); if (!t) return;
            const isA = t.a === ws.username, isB = t.b === ws.username; if (!isA && !isB) return;
            const offer = { items: Array.isArray(msg.items) ? msg.items.slice(0, 40) : [], gold: Math.max(0, Math.floor(Number(msg.gold) || 0)) };
            if (isA) t.offerA = offer; else t.offerB = offer;
            t.confA = false; t.confB = false;   // 任一方改動 → 重置雙方確認
            const aw = online.get(t.a), bw = online.get(t.b);
            const partnerWs = isA ? bw : aw;
            if (partnerWs) send(partnerWs, { type: 'trade_partner_offer', items: offer.items, gold: offer.gold });
            if (aw) send(aw, { type: 'trade_reset_confirm' });
            if (bw) send(bw, { type: 'trade_reset_confirm' });
            return;
        }
        if (msg.type === 'trade_confirm') {
            const t = trades.get(msg.id); if (!t) return;
            if (t.a === ws.username) t.confA = true; else if (t.b === ws.username) t.confB = true; else return;
            const aw = online.get(t.a), bw = online.get(t.b);
            if (t.a === ws.username && bw) send(bw, { type: 'trade_partner_confirmed' });
            if (t.b === ws.username && aw) send(aw, { type: 'trade_partner_confirmed' });
            if (t.confA && t.confB) {
                if (aw) send(aw, { type: 'trade_execute', give: t.offerA, get: t.offerB, partner: t.b });
                if (bw) send(bw, { type: 'trade_execute', give: t.offerB, get: t.offerA, partner: t.a });
                trades.delete(msg.id); userTrade.delete(t.a); userTrade.delete(t.b);
            }
            return;
        }
        if (msg.type === 'trade_cancel') {
            const id = userTrade.get(ws.username); const t = id && trades.get(id);
            if (t) {
                const other = t.a === ws.username ? t.b : t.a;
                const ow = online.get(other); if (ow) send(ow, { type: 'trade_cancelled', by: ws.username });
                trades.delete(id); userTrade.delete(t.a); userTrade.delete(t.b);
            }
            return;
        }

        if (msg.type === 'challenge_decline') {
            const c = pending.get(msg.id);
            if (c && c.to === ws.username) {
                pending.delete(msg.id);
                const fw = online.get(c.from);
                if (fw) send(fw, { type: 'challenge_declined', by: ws.username });
            }
            return;
        }

        // 發起方取消挑戰（逾時自動取消 / 手動取消）：通知對方關閉「收到挑戰」視窗
        if (msg.type === 'challenge_cancel') {
            const target = String(msg.to || '').trim();
            for (const [id, c] of pending) {
                if (c.from === ws.username && (!target || c.to === target)) {
                    pending.delete(id);
                    const tw2 = online.get(c.to);
                    if (tw2) send(tw2, { type: 'challenge_cancelled', by: ws.username });
                }
            }
            return;
        }
    });

    ws.on('close', () => {
        if (ws.username && online.get(ws.username) === ws) {
            online.delete(ws.username);
            // 交換中離線 → 通知對方取消
            const tid = userTrade.get(ws.username);
            if (tid) {
                const t = trades.get(tid);
                if (t) { const other = t.a === ws.username ? t.b : t.a; const ow = online.get(other); if (ow) send(ow, { type: 'trade_cancelled', by: ws.username }); trades.delete(tid); userTrade.delete(t.a); userTrade.delete(t.b); }
            }
            broadcastOnline();
        }
    });
});

// 心跳：清理斷線、清理過期挑戰
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false; ws.ping();
    });
    const now = Date.now();
    for (const [id, c] of pending) if (now - c.ts > 35000) pending.delete(id);   // 挑戰 35 秒未回應自動失效
    for (const [id, c] of pendingTrade) if (now - c.ts > 60000) pendingTrade.delete(id);
}, 30000);

server.listen(PORT, () => console.log(`放置天堂線上版啟動： http://localhost:${PORT}`));
