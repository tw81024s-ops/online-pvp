// server.js — 放置天堂 線上對戰伺服器
// 功能：帳號註冊/登入、雲端存檔、WebSocket 在線狀態與即時對戰、管理員 API、遊戲靜態檔案
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

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
app.get('/api/save', auth, (req, res) => {
    const row = store.getSave(req.user.id);
    if (!row) return res.json({ data: null });
    res.json({ data: row.data, updatedAt: row.updated_at });
});
app.put('/api/save', auth, (req, res) => {
    const data = JSON.stringify(req.body && req.body.data ? req.body.data : null);
    if (!data || data === 'null') return res.status(400).json({ error: '存檔資料為空' });
    if (data.length > 4 * 1024 * 1024) return res.status(400).json({ error: '存檔過大' });
    store.putSave(req.user.id, data);
    res.json({ ok: true });
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
    const save = store.getSave(u.id);
    res.json({ username: u.username, data: save ? save.data : null, updatedAt: save ? save.updated_at : null });
});

// 覆寫某玩家的存檔（管理員編輯）
app.put('/api/admin/player/:username', auth, adminOnly, (req, res) => {
    const u = store.findUser(req.params.username);
    if (!u) return res.status(404).json({ error: '找不到帳號' });
    const data = JSON.stringify(req.body && req.body.data ? req.body.data : null);
    if (!data || data === 'null') return res.status(400).json({ error: '資料為空' });
    if (data.length > 4 * 1024 * 1024) return res.status(400).json({ error: '存檔過大' });
    store.putSave(u.id, data);
    res.json({ ok: true });
});

// ====== WebSocket：在線、挑戰、即時對戰 ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const online = new Map();      // username -> ws
const pending = new Map();     // challengeId -> {from, to, fromProfile, ts}

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
            const result = simulate(pA, pB);
            store.addBattle(c.from, ws.username, result.winner === 'draw' ? '平手' : (result.winner === 'A' ? c.from : ws.username));

            const payload = {
                type: 'battle_start',
                a: { name: pA.name, user: c.from, mhp: pA.mhp, mmp: pA.mmp, cls: pA.cls, lv: pA.lv },
                b: { name: pB.name, user: ws.username, mhp: pB.mhp, mmp: pB.mmp, cls: pB.cls, lv: pB.lv },
                startAt: Date.now() + 1500,   // 雙方 1.5 秒後依同一時鐘開播
                events: result.events,
                winner: result.winner
            };
            send(fromWs, payload);
            send(ws, payload);
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
}, 30000);

server.listen(PORT, () => console.log(`放置天堂線上版啟動： http://localhost:${PORT}`));
