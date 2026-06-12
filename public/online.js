// online.js — 線上模式前端（登入 / 雲端存檔 / 競技場即時對戰 / 管理員面板）
// 以外掛方式注入，不改動原遊戲邏輯；依賴遊戲全域：player, DB, saveGame, loadGame, calcStats, updateUI, gainItem
(function () {
    'use strict';
    const LS_TOKEN = 'lineage_online_token';
    const LS_USER = 'lineage_online_user';
    let token = localStorage.getItem(LS_TOKEN) || null;
    let myName = localStorage.getItem(LS_USER) || null;
    let isAdmin = false;
    let ws = null, wsReady = false;
    let onlineUsers = [];
    let saveTimer = null;

    // 遊戲用 let 宣告 player/DB（不掛在 window 上），用存取器安全取得
    function getPlayer() { try { return (typeof player !== 'undefined' && player) ? player : (typeof window !== 'undefined' ? window.player : null) || null; } catch (e) { return null; } }
    function getDB() { try { return (typeof DB !== 'undefined' && DB) ? DB : (typeof window !== 'undefined' ? window.DB : null) || null; } catch (e) { return null; } }

    // ============ 小工具 ============
    const $ = (id) => document.getElementById(id);
    function el(tag, attrs, html) {
        const e = document.createElement(tag);
        if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
        if (html !== undefined) e.innerHTML = html;
        return e;
    }
    async function api(path, method, body) {
        const res = await fetch(path, {
            method: method || 'GET',
            headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-token': token } : {}),
            body: body ? JSON.stringify(body) : undefined
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
        return j;
    }
    // ============ 全服設定（經驗倍率 / 攻速倍率）：所有玩家定期同步並套用 ============
    window.__GAME_CONFIG = window.__GAME_CONFIG || { expMult: 1, spdMult: 1 };
    async function syncGameConfig() {
        try {
            const r = await fetch('/api/config');
            if (!r.ok) return;
            const j = await r.json();
            window.__GAME_CONFIG = { expMult: j.expMult || 1, spdMult: j.spdMult || 1 };
            try { if (typeof calcStats === 'function') calcStats(); if (typeof updateUI === 'function') updateUI(); } catch (e) { }
        } catch (e) { }
    }
    syncGameConfig();
    setInterval(syncGameConfig, 60000);
    function toast(msg, color) {
        const t = el('div', { style: `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;background:${color || '#1e293b'};color:#fff;padding:8px 18px;border-radius:8px;border:1px solid #475569;box-shadow:0 4px 16px rgba(0,0,0,.5);font-size:14px;` }, msg);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3500);
    }

    // ============ 戰鬥數值打包（calcStats 之後的衍生值）============
    function buildProfile() {
        try { if (typeof calcStats === 'function') calcStats(); } catch (e) { }
        const p = getPlayer(); if (!p) return null; const d = p.d;
        const _DB = getDB();
        // 武器
        let weapon = null;
        if (p.eq && p.eq.wpn && _DB && _DB.items[p.eq.wpn.id]) {
            const w = _DB.items[p.eq.wpn.id];
            weapon = { dice: w.dmgS || 2, spd: w.spd || 1.5, ranged: !!w.ranged };
        }
        // 最強攻擊魔法（取階級最高者）
        let spell = null;
        (p.skills || []).forEach(id => {
            const s = _DB && _DB.skills[id];
            if (!s || s.dmgType === 'physical') return;
            if (!(s.dmgDice || s.multiDmg)) return;
            if (!spell || (s.tier || 1) > (spell.tier || 1)) {
                spell = { name: s.n || id, dmgDice: s.dmgDice || null, multiDmg: s.multiDmg || null, dmgBase: s.dmgBase || 0, tier: s.tier || 1, mp: s.mp || 10, ele: s.ele || null };
            }
        });
        // 治癒魔法
        let heal = null;
        (p.skills || []).forEach(id => {
            const s = _DB && _DB.skills[id];
            if (!s) return;
            const dice = s.healDice || (s.type === 'heal' && s.valDice) || null;
            if (dice && (!heal || (s.tier || 1) > (heal.tier || 1))) heal = { name: s.n || id, dice: dice, mp: s.mp || 5, tier: s.tier || 1 };
        });
        return {
            name: p.name || myName, cls: p.cls, lv: p.lv, avatar: p.avatar || null, darkelf: !!p.darkelf,
            mhp: p.mhp, mmp: p.mmp,
            ac: d.ac, mr: d.mr, er: d.er, dr: d.dr || 0,
            meleeHit: d.meleeHit, meleeDmg: d.meleeDmg, meleeCrit: d.meleeCrit, meleeCritDmg: d.meleeCritDmg,
            rangedHit: d.rangedHit, rangedDmg: d.rangedDmg, rangedCrit: d.rangedCrit, rangedCritDmg: d.rangedCritDmg,
            extraHit: d.extraHit, extraDmg: d.extraDmg,
            magicDmg: d.magicDmg, magicCrit: d.magicCrit, magicCritDmg: d.magicCritDmg, extraMp: d.extraMp,
            hpR: d.hpR, mpR: d.mpR, spdMult: d.spdMult || 1,
            weapon, spell, heal
        };
    }

    // ============ 雲端存檔 ============
    function hookSave() {
        if (typeof window.saveGame !== 'function' || window.__cloudHooked) return;
        window.__cloudHooked = true;
        const orig = window.saveGame;
        window.saveGame = function () {
            const r = orig.apply(this, arguments);
            if (token) {
                clearTimeout(saveTimer);
                saveTimer = setTimeout(uploadSave, 4000); // 防抖：4 秒內多次存檔只上傳一次
            }
            return r;
        };
    }
    // 對接遊戲原生欄位系統：用遊戲全域 currentSlot（1~3）與 lineage_idle_save_<slot>
    function activeSlot() { try { return (typeof currentSlot !== 'undefined' && currentSlot) ? currentSlot : 1; } catch (e) { return 1; } }
    function slotKey() { return 'lineage_idle_save_' + activeSlot(); }
    async function uploadSave() {
        try {
            const raw = localStorage.getItem(slotKey());
            if (!raw) return;
            await api('/api/save?slot=' + activeSlot(), 'PUT', { data: JSON.parse(raw) });
            setStatus('☁️ 已同步（角色' + activeSlot() + '）');
        } catch (e) { setStatus('☁️ 同步失敗', true); }
    }
    async function downloadSave() {
        const j = await api('/api/save?slot=' + activeSlot());
        if (j.data) {
            localStorage.setItem(slotKey(), typeof j.data === 'string' ? j.data : JSON.stringify(j.data));
            return true;
        }
        return false;
    }

    // ============ WebSocket ============
    function connectWS() {
        if (!token) return;
        const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
        ws = new WebSocket(url);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.type === 'auth_ok') { wsReady = true; isAdmin = m.isAdmin; setStatus('🟢 ' + m.username); refreshAdminBtn(); }
            if (m.type === 'auth_fail') { logout(true); }
            if (m.type === 'kicked') { toast('此帳號已在其他視窗登入', '#7f1d1d'); wsReady = false; }
            if (m.type === 'online_list') { onlineUsers = m.users; renderOnline(); }
            if (m.type === 'error') toast(m.error, '#7f1d1d');
            if (m.type === 'challenge_sent') toast('已向 ' + m.to + ' 發出挑戰，等待對方接受…');
            if (m.type === 'challenge_declined') toast(m.by + ' 拒絕了你的挑戰', '#7f1d1d');
            if (m.type === 'challenge_received') showIncoming(m);
            if (m.type === 'battle_start') playBattle(m);
            if (m.type === 'admin_updated') {
                // 自動重新載入雲端最新存檔（管理員的修改），避免線上玩家的自動存檔把修改蓋回去
                toast('管理員更新了你的角色資料，正在重新載入…', '#1e3a5f');
                downloadSave().then(ok => {
                    if (ok && typeof loadGame === 'function') { loadGame(); toast('✅ 角色資料已更新', '#14532d'); }
                }).catch(() => { });
            }
        };
        ws.onclose = () => {
            wsReady = false;
            setStatus('🔌 連線中斷', true);
            if (token) setTimeout(connectWS, 3000);
        };
    }

    // ============ UI：浮動按鈕 + 狀態 ============
    const fab = el('div', { id: 'online-fab', style: 'position:fixed;right:14px;bottom:14px;z-index:9990;display:flex;flex-direction:column;gap:8px;align-items:flex-end;' });
    const statusEl = el('div', { style: 'background:rgba(15,23,42,.9);color:#cbd5e1;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid #334155;display:none;' });
    const btnArena = el('button', { style: btnStyle('#b45309') }, '⚔️ 競技場');
    const btnLoginFab = el('button', { style: btnStyle('#1d4ed8') }, '🌐 線上登入');
    const btnSlots = el('button', { style: btnStyle('#0f766e') + 'display:none;' }, '👤 角色欄位');
    const btnAdmin = el('button', { style: btnStyle('#7c3aed') + 'display:none;' }, '🛠️ 管理員');
    function btnStyle(bg) { return `background:${bg};color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:bold;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.45);`; }
    fab.append(statusEl, btnAdmin, btnSlots, btnArena, btnLoginFab);
    function setStatus(s, bad) { statusEl.style.display = 'block'; statusEl.textContent = s; statusEl.style.color = bad ? '#fca5a5' : '#86efac'; }
    function refreshAdminBtn() {
        // 雙重隱藏：必須是管理員帳號，且網址結尾加上 #admin 才顯示按鈕（朋友與一般情況都看不到）
        const wantAdmin = (location.hash || '').toLowerCase().indexOf('admin') !== -1;
        btnAdmin.style.display = (isAdmin && wantAdmin) ? 'block' : 'none';
    }
    window.addEventListener('hashchange', refreshAdminBtn);

    // ============ 通用 Modal ============
    function modal(title, bodyEl, opts) {
        const ov = el('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9995;display:flex;align-items:center;justify-content:center;padding:12px;' });
        const box = el('div', { style: `background:#0f172a;border:1px solid #475569;border-radius:14px;width:100%;max-width:${(opts && opts.w) || '420px'};max-height:90vh;overflow:auto;color:#e2e8f0;` });
        const head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #334155;' });
        head.append(el('div', { style: 'font-weight:bold;color:#fbbf24;font-size:16px;' }, title));
        const x = el('button', { style: 'background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;' }, '✕');
        x.onclick = () => ov.remove();
        head.append(x);
        const body = el('div', { style: 'padding:16px 18px;' });
        body.append(bodyEl);
        box.append(head, body);
        ov.append(box);
        if (!(opts && opts.noClose)) ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
        document.body.appendChild(ov);
        return ov;
    }
    function input(ph, type) { return el('input', { placeholder: ph, type: type || 'text', style: 'width:100%;background:#1e293b;border:1px solid #475569;border-radius:8px;padding:10px;color:#fff;margin-bottom:10px;font-size:14px;box-sizing:border-box;' }); }
    function bigBtn(txt, bg) { return el('button', { style: `width:100%;background:${bg};color:#fff;border:none;border-radius:8px;padding:11px;font-weight:bold;cursor:pointer;font-size:14px;margin-bottom:8px;` }, txt); }

    // 可搜尋 + 可分類瀏覽的道具清單；onGive(id, item) 由呼叫端決定給誰
    function buildItemBrowser(onGive) {
        const _DB = getDB();
        const box = el('div');
        const search = input('搜尋道具名（或往下展開分類瀏覽全部）'); search.style.marginBottom = '6px';
        const out = el('div', { style: 'max-height:300px;overflow-y:auto;font-size:13px;' });
        box.append(search, out);
        if (!_DB || !_DB.items) { out.textContent = '讀取不到物品資料'; return box; }
        const all = Object.entries(_DB.items);
        const CATS = [['wpn', '武器'], ['arm', '防具'], ['acc', '飾品'], ['pot', '藥水'], ['scroll', '卷軸'], ['skillbk', '技能書']];
        const known = CATS.map(c => c[0]);
        function itemRow(id, it) {
            const r = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:3px 8px;background:#1e293b;border-radius:6px;margin-bottom:3px;' });
            r.append(el('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, `${it.n} <span style="color:#475569">${id}</span>`));
            const qty = el('input', { type: 'number', value: '1', min: '1', style: 'width:54px;flex:none;margin:0 6px 0 0;padding:3px 6px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;text-align:center;' });
            const b = el('button', { style: 'background:#15803d;color:#fff;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;white-space:nowrap;flex:none;' }, '給予');
            b.onclick = () => { let n = parseInt(qty.value) || 1; if (n < 1) n = 1; onGive(id, it, n); };
            r.append(qty, b); return r;
        }
        function group(t) {
            return t === 'misc' ? all.filter(([id, it]) => known.indexOf(it.type) === -1) : all.filter(([id, it]) => it.type === t);
        }
        function renderCats() {
            out.innerHTML = '';
            CATS.concat([['misc', '其他']]).forEach(([t, label]) => {
                const items = group(t);
                if (!items.length) return;
                const d = el('details', { style: 'margin-bottom:5px;' });
                d.append(el('summary', { style: 'cursor:pointer;color:#fbbf24;font-weight:bold;padding:4px 0;' }, `${label}（${items.length}）`));
                let loaded = false;
                d.addEventListener('toggle', () => { if (d.open && !loaded) { loaded = true; items.forEach(([id, it]) => d.append(itemRow(id, it))); } });
                out.append(d);
            });
        }
        function renderSearch(q) {
            out.innerHTML = '';
            const hits = all.filter(([id, it]) => (it.n || '').includes(q)).slice(0, 80);
            if (!hits.length) { out.append(el('div', { style: 'color:#64748b;padding:8px;' }, '找不到符合的道具')); return; }
            hits.forEach(([id, it]) => out.append(itemRow(id, it)));
        }
        search.oninput = () => { const q = search.value.trim(); q ? renderSearch(q) : renderCats(); };
        renderCats();
        return box;
    }

    // ============ 登入 / 註冊 ============
    function showLogin() {
        const wrap = el('div');
        const u = input('帳號（2~16 字）'), p = input('密碼（至少 4 碼）', 'password');
        const msg = el('div', { style: 'color:#fca5a5;font-size:13px;min-height:18px;margin-bottom:6px;' });
        const bLogin = bigBtn('登入', '#1d4ed8'), bReg = bigBtn('註冊新帳號', '#15803d');
        wrap.append(u, p, msg, bLogin, bReg,
            el('div', { style: 'color:#64748b;font-size:12px;line-height:1.6;' }, '登入後：進度自動雲端同步，可在「競技場」挑戰在線好友即時對戰。第一個註冊的帳號自動成為管理員。'));
        const ov = modal('🌐 線上模式', wrap);
        async function go(path) {
            msg.textContent = '';
            try {
                const j = await api('/api/' + path, 'POST', { username: u.value, password: p.value });
                token = j.token; myName = j.username; isAdmin = j.isAdmin;
                localStorage.setItem(LS_TOKEN, token); localStorage.setItem(LS_USER, myName);
                ov.remove();
                await afterLogin(path === 'register');
            } catch (e) { msg.textContent = e.message; }
        }
        bLogin.onclick = () => go('login');
        bReg.onclick = () => go('register');
    }
    async function afterLogin(isNew) {
        toast('歡迎，' + myName + '！', '#14532d');
        btnLoginFab.textContent = '🚪 登出';
        refreshAdminBtn();
        hookSave();
        connectWS();
        try {
            const hasCloud = await downloadSave();
            const hasLocal = !!localStorage.getItem(slotKey());
            if (hasCloud) {
                if (confirm('雲端發現你的存檔，要立即載入嗎？\n（取消＝保留目前畫面，下次自行按「載入進度」）')) {
                    if (typeof loadGame === 'function') loadGame();
                }
            } else if (hasLocal) {
                await uploadSave();
                toast('已將本機存檔上傳到雲端 ☁️');
            }
        } catch (e) { toast('雲端存檔同步失敗：' + e.message, '#7f1d1d'); }
    }
    function logout(silent) {
        if (token) api('/api/logout', 'POST').catch(() => { });
        token = null; myName = null; isAdmin = false; wsReady = false;
        localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER);
        if (ws) try { ws.close(); } catch (e) { }
        btnLoginFab.textContent = '🌐 線上登入';
        btnSlots.style.display = 'none';
        localStorage.removeItem('de_active_slot');
        statusEl.style.display = 'none';
        refreshAdminBtn();
        if (!silent) toast('已登出');
    }
    btnLoginFab.onclick = () => token ? (confirm('確定登出？') && logout()) : showLogin();

    // ============ 競技場 ============
    let arenaListEl = null;
    function showArena() {
        if (!token || !wsReady) { toast('請先登入線上模式', '#7f1d1d'); if (!token) showLogin(); return; }
        const _p = getPlayer(); if (!_p || !_p.cls) { toast('請先建立或載入角色再進入競技場', '#7f1d1d'); return; }
        const wrap = el('div');
        wrap.append(el('div', { style: 'color:#94a3b8;font-size:13px;margin-bottom:10px;' }, '點選在線玩家發起挑戰，雙方將即時觀看同一場自動對戰。'));
        arenaListEl = el('div');
        wrap.append(arenaListEl);
        modal('⚔️ 競技場（在線玩家）', wrap);
        renderOnline();
    }
    function renderOnline() {
        if (!arenaListEl || !document.body.contains(arenaListEl)) return;
        arenaListEl.innerHTML = '';
        const others = onlineUsers.filter(u => u !== myName);
        if (others.length === 0) {
            arenaListEl.append(el('div', { style: 'color:#64748b;text-align:center;padding:18px 0;' }, '目前沒有其他玩家在線'));
            return;
        }
        others.forEach(u => {
            const row = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 14px;margin-bottom:8px;' });
            row.append(el('div', {}, '🟢 ' + u));
            const b = el('button', { style: 'background:#b45309;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:bold;' }, '挑戰');
            b.onclick = () => ws.send(JSON.stringify({ type: 'challenge', to: u, profile: buildProfile() }));
            row.append(b);
            arenaListEl.append(row);
        });
    }
    async function switchSlot(n) {
        const cur = activeSlot();
        if (n === cur) return;
        if (!confirm('要切換到「角色欄位 ' + n + '」嗎？\n目前的角色會先自動存檔。')) return;
        try {
            toast('切換中…請稍候');
            if (typeof window.saveGame === 'function') { try { window.saveGame(); } catch (e) { } }
            const raw = localStorage.getItem('lineage_idle_save');
            if (raw) { try { await api('/api/save?slot=' + cur, 'PUT', { data: JSON.parse(raw) }); } catch (e) { } }
            localStorage.setItem('de_active_slot', String(n));
            let j = {};
            try { j = await api('/api/save?slot=' + n); } catch (e) { }
            if (j && j.data) localStorage.setItem('lineage_idle_save', typeof j.data === 'string' ? j.data : JSON.stringify(j.data));
            else localStorage.removeItem('lineage_idle_save');
            location.reload();   // 乾淨重開，載入該欄位的角色
        } catch (e) { toast('切換失敗：' + e.message, '#7f1d1d'); }
    }
    async function showSlots() {
        if (!token) { showLogin(); return; }
        let info = {};
        try { const r = await api('/api/slots'); info = r.slots || {}; } catch (e) { toast('讀取角色欄位失敗', '#7f1d1d'); return; }
        const cur = activeSlot();
        const wrap = el('div');
        wrap.append(el('div', { style: 'color:#94a3b8;font-size:13px;margin-bottom:10px;' }, '一個帳號最多 4 個角色，切換時會自動存檔。'));
        for (let s = 1; s <= 4; s++) {
            const occ = !!info[s];
            const row = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;background:#0f172a;border:1px solid #334155;border-radius:10px;margin-bottom:8px;' });
            const left = el('div', {});
            left.append(el('div', { style: 'font-weight:bold;color:#e2e8f0;' }, '角色欄位 ' + s + (s === 1 ? '（原本角色）' : '')));
            left.append(el('div', { style: 'font-size:12px;color:' + (s === cur ? '#fbbf24' : (occ ? '#86efac' : '#64748b')) + ';' }, s === cur ? '✅ 目前使用中' : (occ ? '有角色' : '空格')));
            row.append(left);
            if (s !== cur) {
                const b = el('button', { style: 'background:' + (occ ? '#0f766e' : '#475569') + ';color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;white-space:nowrap;font-weight:bold;' }, occ ? '切換' : '建新角色');
                b.onclick = () => switchSlot(s);
                row.append(b);
            }
            wrap.append(row);
        }
        modal('👤 角色欄位', wrap);
    }
    btnSlots.onclick = showSlots;
    btnArena.onclick = showArena;

    function showIncoming(m) {
        const wrap = el('div');
        wrap.append(el('div', { style: 'font-size:15px;margin-bottom:14px;' }, `<b style="color:#fbbf24">${m.from}</b> 向你發起對戰挑戰！`));
        const acc = bigBtn('⚔️ 接受挑戰', '#15803d'), dec = bigBtn('拒絕', '#475569');
        wrap.append(acc, dec);
        const ov = modal('收到挑戰', wrap, { noClose: true });
        acc.onclick = () => {
            const _p = getPlayer(); if (!_p || !_p.cls) { toast('你還沒有角色，無法應戰', '#7f1d1d'); return; }
            ws.send(JSON.stringify({ type: 'challenge_accept', id: m.id, profile: buildProfile() }));
            ov.remove();
        };
        dec.onclick = () => { ws.send(JSON.stringify({ type: 'challenge_decline', id: m.id })); ov.remove(); };
    }

    // ============ 對戰播放（雙方依伺服器時間軸同步）============
    let battleTimers = [];
    function injectBattleCSS() {
        if (document.getElementById('battle-css')) return;
        const s = document.createElement('style'); s.id = 'battle-css';
        s.textContent = `
@keyframes dmgPop { 0%{opacity:1;transform:translate(-50%,0) scale(.8);} 25%{opacity:1;transform:translate(-50%,-14px) scale(1.25);} 100%{opacity:0;transform:translate(-50%,-52px) scale(1);} }
@keyframes bShake { 0%,100%{transform:translateX(0);} 20%{transform:translateX(-6px);} 40%{transform:translateX(6px);} 60%{transform:translateX(-4px);} 80%{transform:translateX(4px);} }
@keyframes bHitFlash { 0%,100%{box-shadow:0 0 0 0 rgba(248,113,113,0);} 35%{box-shadow:0 0 22px 6px rgba(248,113,113,.95);} }
@keyframes bCritShake { 0%,100%{transform:translateX(0);box-shadow:0 0 0 0 rgba(251,191,36,0);} 20%{transform:translateX(-7px);box-shadow:0 0 26px 7px rgba(251,191,36,.95);} 40%{transform:translateX(7px);} 60%{transform:translateX(-5px);box-shadow:0 0 26px 7px rgba(251,191,36,.95);} 80%{transform:translateX(5px);} }
@keyframes healFlash { 0%,100%{box-shadow:0 0 0 0 rgba(134,239,172,0);} 40%{box-shadow:0 0 20px 5px rgba(134,239,172,.9);} }
@keyframes bGlow { 0%,100%{box-shadow:0 0 0 0 rgba(251,191,36,0);} 50%{box-shadow:0 0 18px 4px rgba(251,191,36,.85);} }
@keyframes winPulse { 0%,100%{box-shadow:0 0 14px 3px rgba(251,191,36,.7);} 50%{box-shadow:0 0 30px 9px rgba(251,191,36,1);} }`;
        document.head.appendChild(s);
    }

    function playBattle(m) {
        injectBattleCSS();
        battleTimers.forEach(t => clearTimeout(t)); battleTimers = [];
        const emoji = { knight: '⚔️', mage: '🪄', elf: '🏹' };
        const clsZh = { knight: '騎士', mage: '法師', elf: '妖精' };
        const wrap = el('div');

        function card(s, color) {
            const box = el('div', { style: `flex:1;min-width:0;position:relative;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:10px 8px;text-align:center;` });
            const av = el('div', { style: `width:64px;height:64px;border-radius:50%;margin:0 auto 6px;overflow:hidden;border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:30px;background:#1e293b;` });
            if (s.avatar) {
                const img = el('img', { src: 'assets/character/' + encodeURIComponent(s.avatar) + '.jpg', style: 'width:100%;height:100%;object-fit:cover;object-position:top;' });
                img.onerror = () => { av.innerHTML = ''; av.textContent = emoji[s.cls] || '⚔️'; };
                av.append(img);
            } else av.textContent = emoji[s.cls] || '⚔️';
            box.append(av);
            box.append(el('div', { style: `font-weight:bold;color:${color};font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` }, s.name));
            box.append(el('div', { style: 'font-size:11px;color:#94a3b8;margin-bottom:6px;' }, `Lv.${s.lv}・${s.darkelf ? '黑妖' : (clsZh[s.cls] || '')}`));
            const hpOut = el('div', { style: 'background:#1e293b;border-radius:6px;height:14px;overflow:hidden;border:1px solid #334155;' });
            const hpIn = el('div', { style: 'background:linear-gradient(90deg,#dc2626,#f87171);height:100%;width:100%;transition:width .25s;' });
            hpOut.append(hpIn);
            const hpTxt = el('div', { style: 'font-size:10px;color:#cbd5e1;margin:1px 0 4px;' }, `HP ${s.mhp}/${s.mhp}`);
            const mpOut = el('div', { style: 'background:#1e293b;border-radius:6px;height:9px;overflow:hidden;border:1px solid #334155;' });
            const mpIn = el('div', { style: 'background:linear-gradient(90deg,#2563eb,#60a5fa);height:100%;width:100%;transition:width .25s;' });
            mpOut.append(mpIn);
            const mpTxt = el('div', { style: 'font-size:10px;color:#93c5fd;margin-top:1px;' }, `MP ${s.mmp}/${s.mmp}`);
            box.append(hpOut, hpTxt, mpOut, mpTxt);
            return { box, hpIn, hpTxt, mpIn, mpTxt };
        }
        const A = card(m.a, '#38bdf8'), B = card(m.b, '#f87171');
        const top = el('div', { style: 'display:flex;gap:10px;align-items:stretch;margin-bottom:10px;' });
        top.append(A.box, el('div', { style: 'color:#fbbf24;font-weight:bold;display:flex;align-items:center;font-size:18px;' }, 'VS'), B.box);
        const banner = el('div', { style: 'text-align:center;color:#fbbf24;font-weight:bold;font-size:16px;min-height:22px;margin-bottom:6px;' }, '');
        const log = el('div', { style: 'background:#020617;border:1px solid #334155;border-radius:8px;height:190px;overflow-y:auto;padding:10px;font-size:13px;line-height:1.7;' });
        const count = el('div', { style: 'text-align:center;color:#fbbf24;font-weight:bold;font-size:22px;margin-bottom:8px;' }, '即將開始…');
        wrap.append(count, top, banner, log);
        const ov = modal('⚔️ 競技場對戰', wrap, { w: '560px', noClose: true });

        const sideObj = { A, B };
        const refMhp = { A: m.a.mhp, B: m.b.mhp }, refMmp = { A: m.a.mmp || 1, B: m.b.mmp || 1 };
        const colors = { attack: '#e2e8f0', crit: '#fbbf24', magic: '#67e8f9', heal: '#86efac', miss: '#64748b', evade: '#64748b', start: '#fbbf24', end: '#f0abfc' };

        function anim(node, name, dur) { node.style.animation = 'none'; void node.offsetWidth; node.style.animation = `${name} ${dur}`; }
        function popNum(box, text, color, big) {
            const n = el('div', { style: `position:absolute;left:50%;top:34%;font-weight:bold;color:${color};font-size:${big ? 30 : 21}px;text-shadow:0 2px 5px #000;pointer-events:none;z-index:6;animation:dmgPop 1.1s ease-out forwards;` }, text);
            box.appendChild(n); setTimeout(() => n.remove(), 1100);
        }
        function addLog(e) {
            const d = el('div', { style: `color:${colors[e.kind] || '#e2e8f0'};${e.kind === 'end' ? 'font-weight:bold;font-size:15px;margin-top:6px;' : ''}` },
                (e.kind === 'start' || e.kind === 'end' ? '' : `<span style="color:#475569">[${(e.t / 10).toFixed(1)}s]</span> `) + e.text);
            log.append(d); log.scrollTop = log.scrollHeight;
            A.hpIn.style.width = Math.max(0, e.hpA / refMhp.A * 100) + '%';
            B.hpIn.style.width = Math.max(0, e.hpB / refMhp.B * 100) + '%';
            A.hpTxt.textContent = `HP ${Math.max(0, e.hpA)}/${refMhp.A}`;
            B.hpTxt.textContent = `HP ${Math.max(0, e.hpB)}/${refMhp.B}`;
            A.mpIn.style.width = Math.max(0, e.mpA / refMmp.A * 100) + '%';
            B.mpIn.style.width = Math.max(0, e.mpB / refMmp.B * 100) + '%';
            A.mpTxt.textContent = `MP ${Math.max(0, e.mpA)}/${refMmp.A}`;
            B.mpTxt.textContent = `MP ${Math.max(0, e.mpB)}/${refMmp.B}`;
            if (e.side !== 'A' && e.side !== 'B') return;
            const actor = sideObj[e.side];
            const target = e.kind === 'heal' ? sideObj[e.side] : sideObj[e.side === 'A' ? 'B' : 'A'];
            if (e.kind === 'heal') { anim(target.box, 'healFlash', '.5s'); popNum(target.box, '+' + e.dmg, '#86efac', false); }
            else if (e.kind === 'crit') { anim(actor.box, 'bGlow', '.5s'); anim(target.box, 'bCritShake', '.5s'); popNum(target.box, '-' + e.dmg, '#fbbf24', true); banner.textContent = '💥 爆擊！'; setTimeout(() => { if (banner.textContent === '💥 爆擊！') banner.textContent = ''; }, 900); }
            else if (e.kind === 'magic') { anim(actor.box, 'bGlow', '.5s'); anim(target.box, 'bHitFlash', '.4s'); popNum(target.box, '-' + e.dmg, '#67e8f9', false); }
            else if (e.kind === 'attack') { anim(actor.box, 'bGlow', '.4s'); anim(target.box, 'bShake', '.35s'); popNum(target.box, '-' + e.dmg, '#fca5a5', false); }
            else if (e.kind === 'miss') { popNum(target.box, 'MISS', '#64748b', false); }
            else if (e.kind === 'evade') { popNum(target.box, '閃避', '#94a3b8', false); }
        }
        const wait = Math.max(0, m.startAt - Date.now());
        let cd = Math.ceil(wait / 1000);
        const cdT = setInterval(() => { cd--; count.textContent = cd > 0 ? `${cd}…` : '開戰！'; if (cd <= 0) { clearInterval(cdT); count.style.color = '#f87171'; } }, 1000);
        count.textContent = cd > 0 ? `${cd}…` : '開戰！';
        m.events.forEach(e => {
            battleTimers.push(setTimeout(() => {
                addLog(e);
                if (e.kind === 'end') {
                    count.textContent = e.text; count.style.fontSize = '20px'; count.style.color = '#fbbf24'; banner.textContent = '';
                    if (m.winner === 'A' || m.winner === 'B') {
                        const win = sideObj[m.winner], lose = sideObj[m.winner === 'A' ? 'B' : 'A'];
                        win.box.style.animation = 'winPulse 1.2s infinite'; win.box.style.borderColor = '#fbbf24';
                        win.box.insertAdjacentHTML('afterbegin', '<div style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);font-size:26px;z-index:7;">👑</div>');
                        lose.box.style.opacity = '0.45'; lose.box.style.filter = 'grayscale(70%)';
                    }
                    const close = bigBtn('關閉', '#475569'); close.onclick = () => ov.remove(); wrap.append(close);
                }
            }, wait + e.t * 100));
        });
    }

    // ============ 管理員面板 ============
    async function openPlayerEditor(username, forceSlot) {
        let j;
        try { j = await api('/api/admin/player/' + encodeURIComponent(username)); }
        catch (e) { return toast(e.message, '#7f1d1d'); }
        if (!j.data) return toast(username + ' 還沒有雲端存檔（對方要先在遊戲裡存過檔）', '#7f1d1d');
        const slotsInfo = j.slots || {};
        const slotNums = Object.keys(slotsInfo).map(Number).sort((a, b) => a - b);
        const targetSlot = forceSlot || j.slot || slotNums[0] || 1;   // 要編輯/寫回的角色欄位
        const slotData = (slotsInfo[targetSlot] && slotsInfo[targetSlot].data) ? slotsInfo[targetSlot].data : j.data;
        let save;
        try { save = JSON.parse(typeof slotData === 'string' ? slotData : JSON.stringify(slotData)); }
        catch (e) { return toast('存檔解析失敗', '#7f1d1d'); }
        const p = save.p || (save.p = {});
        const wrap = el('div');
        const clsName = (p.darkelf ? '黑妖' : { knight: '騎士', mage: '法師', elf: '妖精' }[p.cls]) || p.cls || '?';
        wrap.append(el('div', { style: 'color:#cbd5e1;font-size:13px;margin-bottom:10px;line-height:1.7;' },
            `帳號：<b style="color:#fbbf24">${username}</b>　職業：${clsName}　等級：${p.lv || 1}<br>金幣：${(p.gold || 0).toLocaleString()}　HP：${p.mhp || 0}　MP：${p.mmp || 0}`));
        // 角色欄位(格)選擇：玩家可能有多個角色，必須改到他「正在玩」的那一格才看得到
        if (slotNums.length > 0) {
            const sr = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px;padding:8px;background:#0f172a;border:1px solid #334155;border-radius:6px;' });
            sr.append(el('div', { style: 'font-size:13px;color:#fbbf24;font-weight:bold;white-space:nowrap;' }, '角色欄位'));
            const sel = el('select', { style: 'flex:1;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;font-size:13px;' });
            slotNums.forEach(s => {
                const info = slotsInfo[s] || {};
                const o = el('option', { value: String(s) }, `格 ${s}　(${info.bytes || 0}B　${(info.updatedAt || '').replace('T', ' ').slice(5, 16)})${s === (j.slot || 1) ? ' ★最近遊玩' : ''}`);
                if (s === targetSlot) o.selected = true;
                sel.append(o);
            });
            sel.onchange = () => { ov.remove(); openPlayerEditor(username, parseInt(sel.value)); };
            sr.append(sel); wrap.append(sr);
            if (slotNums.length > 1) wrap.append(el('div', { style: 'font-size:12px;color:#f59e0b;margin:-2px 0 8px;line-height:1.5;' }, '⚠️ 此玩家有多個角色欄位，請選到他「正在玩」的那一格（通常是 ★最近遊玩）再給道具/存檔，否則改了也看不到。'));
        }
        function field(label, val) {
            const r = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px;' });
            r.append(el('div', { style: 'flex:1;font-size:14px;color:#cbd5e1;' }, label));
            const i = input(''); i.type = 'number'; i.value = val; i.style.margin = '0'; i.style.width = '130px'; i.style.flex = 'none';
            r.append(i); wrap.append(r); return i;
        }
        const fGold = field('金幣', p.gold || 0);
        const fLv = field('等級', p.lv || 1);
        const fExp = field('經驗', p.exp || 0);
        const fBonus = field('可分配屬性點', p.bonus || 0);

        wrap.append(el('div', { style: 'color:#fbbf24;font-weight:bold;margin:10px 0 6px;' }, '🎁 給這位玩家道具（點分類展開，或搜尋）'));
        wrap.append(buildItemBrowser((id, it, qty) => {
            if (!Array.isArray(p.inv)) p.inv = [];
            qty = parseInt(qty) || 1; if (qty < 1) qty = 1;
            const mkUid = () => (typeof uid === 'function') ? uid() : Math.random().toString(36).slice(2, 11);
            const stackable = ['wpn', 'arm', 'acc'].indexOf(it.type) === -1;   // 裝備不可疊，拆成多件
            if (stackable) {
                p.inv.push({ id: id, uid: mkUid(), cnt: qty, en: 0, bless: false, anc: false, attr: false, lock: false, junk: false });
            } else {
                for (let i = 0; i < qty; i++) p.inv.push({ id: id, uid: mkUid(), cnt: 1, en: 0, bless: false, anc: false, attr: false, lock: false, junk: false });
            }
            toast('待加入 ' + it.n + ' ×' + qty + '（記得按下方儲存）', '#1e3a5f');
        }));

        const adv = el('details', { style: 'margin-bottom:10px;' });
        adv.append(el('summary', { style: 'cursor:pointer;color:#94a3b8;font-size:13px;' }, '進階：直接編輯存檔 JSON（會覆蓋上面欄位）'));
        const ta = el('textarea', { style: 'width:100%;height:170px;background:#020617;color:#cbd5e1;border:1px solid #334155;border-radius:6px;padding:8px;font-size:11px;font-family:monospace;box-sizing:border-box;margin-top:6px;' });
        ta.value = JSON.stringify(save, null, 2);
        adv.append(ta); wrap.append(adv);

        const saveBtn = bigBtn('💾 儲存變更到這位玩家', '#15803d');
        wrap.append(saveBtn, el('div', { style: 'font-size:12px;color:#94a3b8;margin-top:4px;' }, '註：對方若正在線上遊玩，需重新整理才會看到變更。'));
        const ov = modal('✏️ 編輯玩家：' + username, wrap, { w: '520px' });
        saveBtn.onclick = async () => {
            let out = save;
            if (adv.open) { try { out = JSON.parse(ta.value); } catch (e) { return toast('JSON 格式錯誤，無法儲存', '#7f1d1d'); } }
            else {
                out.p = out.p || {};
                out.p.gold = parseInt(fGold.value) || 0;
                out.p.lv = parseInt(fLv.value) || 1;
                out.p.exp = parseFloat(fExp.value) || 0;
                out.p.bonus = parseInt(fBonus.value) || 0;
            }
            try { await api('/api/admin/player/' + encodeURIComponent(username), 'PUT', { data: out, slot: targetSlot }); toast('已儲存 ' + username + ' 的變更', '#14532d'); ov.remove(); }
            catch (e) { toast(e.message, '#7f1d1d'); }
        };
    }

    btnAdmin.onclick = () => {
        const wrap = el('div');
        function section(t) { wrap.append(el('div', { style: 'color:#fbbf24;font-weight:bold;margin:12px 0 6px;' }, t)); }
        function row(label, btnTxt, fn, withInput, ph) {
            const r = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px;align-items:center;' });
            let inp = null;
            if (withInput) { inp = input(ph || ''); inp.style.marginBottom = '0'; inp.style.flex = '1'; r.append(inp); }
            else r.append(el('div', { style: 'flex:1;font-size:14px;' }, label));
            const b = el('button', { style: 'background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;white-space:nowrap;font-weight:bold;' }, btnTxt);
            b.onclick = () => fn(inp && inp.value);
            r.append(b); wrap.append(r);
        }
        function refreshGame() {
            try { calcStats(); updateUI(); saveGame(); } catch (e) { }
        }
        section('💰 角色作弊（直接改本機角色，改完自動同步雲端）');
        row(null, '＋金幣', v => { const n = parseInt(v) || 100000; player.gold += n; refreshGame(); toast(`金幣 +${n}`); }, true, '金額（預設 100000）');
        row(null, '＋屬性點', v => { const n = parseInt(v) || 10; player.bonus = (player.bonus || 0) + n; refreshGame(); toast(`可分配屬性點 +${n}`); }, true, '點數（預設 10）');
        row('補滿 HP / MP', '執行', () => { player.hp = player.mhp; player.mp = player.mmp; refreshGame(); toast('已補滿'); });
        row(null, '攻速加快', v => { const n = Math.max(1, parseFloat(v) || 5); player.adminSpdMult = n; refreshGame(); toast(n > 1 ? `攻速 ×${n}（加速中）` : '攻速已恢復正常', n > 1 ? '#14532d' : '#1e3a5f'); }, true, '倍數（預設 5，輸入 1 取消）');
        section('🌍 全服設定（所有玩家生效，立即同步）');
        const cfgStatus = el('div', { style: 'font-size:12px;color:#94a3b8;margin:-2px 0 8px;line-height:1.7;' }, '目前全服設定：讀取中…');
        wrap.append(cfgStatus);
        const fmtCfg = c => `目前全服：經驗 ×${c.expMult || 1}　攻速 ×${c.spdMult || 1}<br>競技場傷害 ×${c.pvpDmgMult != null ? c.pvpDmgMult : 1}　競技場魔法 ×${c.pvpMagicMult != null ? c.pvpMagicMult : 1}`;
        fetch('/api/config').then(r => r.json()).then(j => { cfgStatus.innerHTML = fmtCfg(j); }).catch(() => { cfgStatus.textContent = '（需登入線上模式才能讀取/設定）'; });
        const setCfg = async (key, n, label) => {
            try { const j = await api('/api/admin/config', 'POST', { [key]: n }); await syncGameConfig(); cfgStatus.innerHTML = fmtCfg(j.config); toast(label + ' = ×' + n, '#14532d'); }
            catch (e) { toast(e.message, '#7f1d1d'); }
        };
        row(null, '設定經驗倍率', v => setCfg('expMult', Math.max(0, parseFloat(v) || 1), '全服經驗倍率'), true, '經驗倍率（例 2＝雙倍、1＝正常）');
        row(null, '設定攻速倍率', v => setCfg('spdMult', Math.max(1, parseFloat(v) || 1), '全服攻速倍率'), true, '攻速倍率（例 3＝3倍、1＝正常）');
        row(null, '競技場傷害倍率', v => setCfg('pvpDmgMult', Math.max(0.05, parseFloat(v) || 1), '競技場傷害倍率'), true, '全部PvP傷害（例 0.6＝6折、1＝正常）');
        row(null, '競技場魔法倍率', v => setCfg('pvpMagicMult', Math.max(0.05, parseFloat(v) || 1), '競技場魔法倍率'), true, '法師魔法再乘（例 0.4＝壓低法師、1＝不變）');
        section('🎁 取得物品（點分類展開瀏覽，或搜尋）');
        wrap.append(buildItemBrowser((id, it, qty) => {
            try { gainItem(id, qty || 1, true, true); refreshGame(); toast('已取得 ' + it.n + ' ×' + (qty || 1)); } catch (e) { toast('失敗：' + e.message, '#7f1d1d'); }
        }));
        section('👥 玩家管理（檢視 / 編輯其他人）');
        const userList = el('div', { style: 'font-size:13px;margin-bottom:8px;max-height:170px;overflow-y:auto;' });
        api('/api/admin/users').then(j => {
            j.users.forEach(u => {
                const r = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:4px 6px;background:#1e293b;border-radius:6px;margin-bottom:4px;' });
                r.append(el('span', { style: 'color:#cbd5e1;' }, `${u.is_admin ? '👑 ' : ''}${u.username}`));
                const eb = el('button', { style: 'background:#2563eb;color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-weight:bold;white-space:nowrap;' }, '✏️ 編輯角色');
                eb.onclick = () => openPlayerEditor(u.username);
                r.append(eb); userList.append(r);
            });
        }).catch(e => userList.textContent = e.message);
        wrap.append(userList);
        section('🔍 雲端存檔診斷');
        row('列出所有帳號的雲端存檔狀態', '檢查', async () => {
            let j;
            try { j = await api('/api/admin/saves'); } catch (e) { return toast(e.message, '#7f1d1d'); }
            const box = el('div', { style: 'font-size:12px;line-height:1.6;max-height:60vh;overflow:auto;' });
            if (!j.users || !j.users.length) { box.textContent = '雲端沒有任何帳號。'; }
            else j.users.forEach(u => {
                const parts = [];
                for (let s = 1; s <= 4; s++) {
                    const d = u.slots[s];
                    if (d) parts.push(`格${s}: ${d.bytes}B (${(d.updatedAt || '').replace('T', ' ').slice(5, 16)})`);
                }
                const has = parts.length > 0;
                box.append(el('div', { style: `padding:5px 8px;border-radius:6px;margin-bottom:4px;background:${has ? '#14532d' : '#7f1d1d'};color:#e2e8f0;` },
                    `${u.username}　${has ? parts.join('　') : '（雲端無存檔）'}`));
            });
            modal('🔍 雲端存檔診斷（綠=有存檔 紅=沒有）', box, { w: '520px' });
        });
        row(null, '重設密碼', async v => {
            const parts = (v || '').split(/\s+/);
            if (parts.length < 2) return toast('格式：帳號 新密碼', '#7f1d1d');
            try { await api('/api/admin/reset-password', 'POST', { username: parts[0], newPassword: parts[1] }); toast('已重設'); } catch (e) { toast(e.message, '#7f1d1d'); }
        }, true, '帳號 新密碼（空格分隔）');
        row(null, '刪除帳號', async v => {
            if (!v || !confirm(`確定刪除帳號 ${v}？此動作無法復原`)) return;
            try { await api('/api/admin/delete-user', 'POST', { username: v }); toast('已刪除'); } catch (e) { toast(e.message, '#7f1d1d'); }
        }, true, '要刪除的帳號');
        modal('🛠️ 管理員面板', wrap, { w: '480px' });
    };

    // ============ 啟動 ============
    function makeCollapsible() {
        // 只在手機尺寸啟用收合
        if (!window.matchMedia || !window.matchMedia('(max-width: 860px)').matches) return;
        document.querySelectorAll('.panel > .panel-header').forEach(h => {
            if (h.dataset.collapsible) return;       // 避免重複綁定
            h.dataset.collapsible = '1';
            h.addEventListener('click', (e) => {
                // 點到標題裡的按鈕/輸入/可點元素時不收合，避免誤觸（例如改名）
                if (e.target.closest('button, input, select, a, [onclick]')) return;
                h.parentElement.classList.toggle('collapsed');
            });
        });
    }

    function injectMobileCSS() {
        const css = `
@media (max-width: 860px) {
  html, body { height: auto !important; min-height: 100%; overflow-x: hidden !important; }
  body { display: block !important; padding: 8px !important; }

  /* 創角畫面：原本固定 1000px，改成佔滿手機寬、內容直排 */
  #creation-screen { position: relative !important; width: 100% !important; max-width: 100% !important; margin: 0 auto !important; padding: 16px !important; }
  #creation-panel { flex-direction: column !important; }
  #creation-panel > * { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }

  /* 主畫面三欄：改成上下堆疊、各佔滿寬 */
  #game-screen { flex-direction: column !important; width: 100% !important; max-width: 100% !important; height: auto !important; gap: 10px !important; }
  #game-screen > div { width: 100% !important; max-width: 100% !important; min-width: 0 !important; flex: 0 0 auto !important; }

  /* 內部固定寬的小區塊不要撐爆畫面 */
  #game-screen [class*="w-["], #creation-screen [class*="w-["] { max-width: 100% !important; }

  /* 可捲動面板給合理高度，避免被壓扁或無限長 */
  #game-screen [id^="tab-"], #game-screen .panel.flex-1 { max-height: 65vh; }

  /* 右下浮動按鈕縮小一點，手機才不擋畫面 */
  #online-fab button { padding: 9px 13px !important; font-size: 13px !important; }

  /* 會拉很長的面板：給高度上限，超出就在框內捲動（不再撐長整頁） */
  #game-screen [id^="tab-"], #game-screen .panel.flex-1, #log-container, #town-npc-container { max-height: 48vh !important; overflow-y: auto !important; }

  /* 可收合面板：點標題收合，畫面馬上變短 */
  .panel > .panel-header { cursor: pointer; user-select: none; }
  .panel > .panel-header::after { content: " ▾"; float: right; color: #94a3b8; font-weight: normal; }
  .panel.collapsed > .panel-header::after { content: " ▸"; }
  .panel.collapsed > :not(.panel-header) { display: none !important; }
  .panel.collapsed { flex: 0 0 auto !important; min-height: 0 !important; height: auto !important; }
}`;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    }
    function injectLogSkin() {
        if (document.getElementById('log-skin-css')) return;
        const s = document.createElement('style'); s.id = 'log-skin-css';
        s.textContent = `
#combat-log {
  background-image: linear-gradient(rgba(8,10,22,.80), rgba(8,10,22,.90)), url('assets/background/battlelog_bg.jpg') !important;
  background-size: cover !important;
  background-position: center !important;
  background-repeat: no-repeat !important;
}`;
        document.head.appendChild(s);
    }
    function init() {
        injectMobileCSS();
        injectLogSkin();
        makeCollapsible();
        document.body.appendChild(fab);
        hookSave();
        if (token) {
            btnLoginFab.textContent = '🚪 登出';
            connectWS();
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
