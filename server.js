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
const { simulate, clampProfile } = require('./battle');
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
    const data = JSON.stringify(req.body && req.body.data ? req.body.data : null);
    if (!data || data === 'null') return res.status(400).json({ error: '存檔資料為空' });
    if (data.length > 4 * 1024 * 1024) return res.status(400).json({ error: '存檔過大' });
    store.putSave(req.user.id, data, reqSlot(req));
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
        pvpMagicMult: c.pvpMagicMult != null ? c.pvpMagicMult : 1
    });
});
app.post('/api/admin/config', auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const cfg = {};
    if (b.expMult !== undefined) cfg.expMult = Math.max(0, Math.min(1000, parseFloat(b.expMult) || 1));
    if (b.spdMult !== undefined) cfg.spdMult = Math.max(1, Math.min(20, parseFloat(b.spdMult) || 1));
    if (b.pvpDmgMult !== undefined) cfg.pvpDmgMult = Math.max(0.05, Math.min(5, parseFloat(b.pvpDmgMult) || 1));
    if (b.pvpMagicMult !== undefined) cfg.pvpMagicMult = Math.max(0.05, Math.min(5, parseFloat(b.pvpMagicMult) || 1));
    const out = store.setConfig(cfg);
    res.json({ ok: true, config: {
        expMult: out.expMult || 1, spdMult: out.spdMult || 1,
        pvpDmgMult: out.pvpDmgMult != null ? out.pvpDmgMult : 1,
        pvpMagicMult: out.pvpMagicMult != null ? out.pvpMagicMult : 1
    } });
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

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { } }
function broadcastOnline() {
    const list = [...online.keys()];
    for (const ws of online.values()) send(ws, { type: 'online_list', users: list });
}

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
            online.set(row.username, ws);
            send(ws, { type: 'auth_ok', username: row.username, isAdmin: isAdminUser(row) });
            broadcastOnline();
            return;
        }
        if (!ws.username) return;

        // 發起挑戰：帶上自己的戰鬥數值
        if (msg.type === 'challenge') {
            const target = String(msg.to || '').trim();
            const tw = online.get(target);
            if (!tw) return send(ws, { type: 'error', error: `${target} 不在線上` });
            if (target === ws.username) return send(ws, { type: 'error', error: '不能挑戰自己' });
            const id = makeToken().slice(0, 12);
            pending.set(id, { from: ws.username, to: target, fromProfile: clampProfile(msg.profile || {}), ts: Date.now() });
            send(tw, { type: 'challenge_received', id, from: ws.username });
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
                pvpMagicMult: _cfg.pvpMagicMult != null ? _cfg.pvpMagicMult : 1
            });
            store.addBattle(c.from, ws.username, result.winner === 'draw' ? '平手' : (result.winner === 'A' ? c.from : ws.username));

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
    for (const [id, c] of pending) if (now - c.ts > 60000) pending.delete(id);
    for (const [id, c] of pendingTrade) if (now - c.ts > 60000) pendingTrade.delete(id);
}, 30000);

server.listen(PORT, () => console.log(`放置天堂線上版啟動： http://localhost:${PORT}`));
