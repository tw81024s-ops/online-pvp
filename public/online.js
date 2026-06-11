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
    function toast(msg, color) {
        const t = el('div', { style: `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;background:${color || '#1e293b'};color:#fff;padding:8px 18px;border-radius:8px;border:1px solid #475569;box-shadow:0 4px 16px rgba(0,0,0,.5);font-size:14px;` }, msg);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3500);
    }

    // ============ 戰鬥數值打包（calcStats 之後的衍生值）============
    function buildProfile() {
        try { if (typeof calcStats === 'function') calcStats(); } catch (e) { }
        const p = window.player, d = p.d;
        // 武器
        let weapon = null;
        if (p.eq && p.eq.wpn && window.DB && DB.items[p.eq.wpn.id]) {
            const w = DB.items[p.eq.wpn.id];
            weapon = { dice: w.dmgS || 2, spd: w.spd || 1.5, ranged: !!w.ranged };
        }
        // 最強攻擊魔法（取階級最高者）
        let spell = null;
        (p.skills || []).forEach(id => {
            const s = window.DB && DB.skills[id];
            if (!s || s.dmgType === 'physical') return;
            if (!(s.dmgDice || s.multiDmg)) return;
            if (!spell || (s.tier || 1) > (spell.tier || 1)) {
                spell = { name: s.n || id, dmgDice: s.dmgDice || null, multiDmg: s.multiDmg || null, dmgBase: s.dmgBase || 0, tier: s.tier || 1, mp: s.mp || 10, ele: s.ele || null };
            }
        });
        // 治癒魔法
        let heal = null;
        (p.skills || []).forEach(id => {
            const s = window.DB && DB.skills[id];
            if (!s) return;
            const dice = s.healDice || (s.type === 'heal' && s.valDice) || null;
            if (dice && (!heal || (s.tier || 1) > (heal.tier || 1))) heal = { name: s.n || id, dice: dice, mp: s.mp || 5, tier: s.tier || 1 };
        });
        return {
            name: p.name || myName, cls: p.cls, lv: p.lv,
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
    async function uploadSave() {
        try {
            const raw = localStorage.getItem('lineage_idle_save');
            if (!raw) return;
            await api('/api/save', 'PUT', { data: JSON.parse(raw) });
            setStatus('☁️ 已同步');
        } catch (e) { setStatus('☁️ 同步失敗', true); }
    }
    async function downloadSave() {
        const j = await api('/api/save');
        if (j.data) {
            localStorage.setItem('lineage_idle_save', typeof j.data === 'string' ? j.data : JSON.stringify(j.data));
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
        };
        ws.onclose = () => {
            wsReady = false;
            setStatus('🔌 連線中斷', true);
            if (token) setTimeout(connectWS, 3000);
        };
    }

    // ============ UI：浮動按鈕 + 狀態 ============
    const fab = el('div', { style: 'position:fixed;right:14px;bottom:14px;z-index:9990;display:flex;flex-direction:column;gap:8px;align-items:flex-end;' });
    const statusEl = el('div', { style: 'background:rgba(15,23,42,.9);color:#cbd5e1;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid #334155;display:none;' });
    const btnArena = el('button', { style: btnStyle('#b45309') }, '⚔️ 競技場');
    const btnLoginFab = el('button', { style: btnStyle('#1d4ed8') }, '🌐 線上登入');
    const btnAdmin = el('button', { style: btnStyle('#7c3aed') + 'display:none;' }, '🛠️ 管理員');
    function btnStyle(bg) { return `background:${bg};color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:bold;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.45);`; }
    fab.append(statusEl, btnAdmin, btnArena, btnLoginFab);
    function setStatus(s, bad) { statusEl.style.display = 'block'; statusEl.textContent = s; statusEl.style.color = bad ? '#fca5a5' : '#86efac'; }
    function refreshAdminBtn() { btnAdmin.style.display = isAdmin ? 'block' : 'none'; }

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
            const hasLocal = !!localStorage.getItem('lineage_idle_save');
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
        statusEl.style.display = 'none';
        refreshAdminBtn();
        if (!silent) toast('已登出');
    }
    btnLoginFab.onclick = () => token ? (confirm('確定登出？') && logout()) : showLogin();

    // ============ 競技場 ============
    let arenaListEl = null;
    function showArena() {
        if (!token || !wsReady) { toast('請先登入線上模式', '#7f1d1d'); if (!token) showLogin(); return; }
        if (!window.player || !player.cls) { toast('請先建立或載入角色再進入競技場', '#7f1d1d'); return; }
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
    btnArena.onclick = showArena;

    function showIncoming(m) {
        const wrap = el('div');
        wrap.append(el('div', { style: 'font-size:15px;margin-bottom:14px;' }, `<b style="color:#fbbf24">${m.from}</b> 向你發起對戰挑戰！`));
        const acc = bigBtn('⚔️ 接受挑戰', '#15803d'), dec = bigBtn('拒絕', '#475569');
        wrap.append(acc, dec);
        const ov = modal('收到挑戰', wrap, { noClose: true });
        acc.onclick = () => {
            if (!window.player || !player.cls) { toast('你還沒有角色，無法應戰', '#7f1d1d'); return; }
            ws.send(JSON.stringify({ type: 'challenge_accept', id: m.id, profile: buildProfile() }));
            ov.remove();
        };
        dec.onclick = () => { ws.send(JSON.stringify({ type: 'challenge_decline', id: m.id })); ov.remove(); };
    }

    // ============ 對戰播放（雙方依伺服器時間軸同步）============
    let battleTimers = [];
    function playBattle(m) {
        battleTimers.forEach(t => clearTimeout(t)); battleTimers = [];
        const wrap = el('div');
        function sidePanel(s, color) {
            const box = el('div', { style: 'flex:1;min-width:0;' });
            box.append(el('div', { style: `font-weight:bold;color:${color};text-align:center;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` }, `${s.name}（Lv.${s.lv}）`));
            const hpOut = el('div', { style: 'background:#1e293b;border-radius:6px;height:16px;overflow:hidden;border:1px solid #334155;' });
            const hpIn = el('div', { style: `background:${color};height:100%;width:100%;transition:width .25s;` });
            hpOut.append(hpIn);
            const hpTxt = el('div', { style: 'font-size:11px;color:#94a3b8;text-align:center;margin-top:2px;' }, `${s.mhp} / ${s.mhp}`);
            box.append(hpOut, hpTxt);
            return { box, hpIn, hpTxt };
        }
        const A = sidePanel(m.a, '#38bdf8'), B = sidePanel(m.b, '#f87171');
        const top = el('div', { style: 'display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;' });
        top.append(A.box, el('div', { style: 'color:#fbbf24;font-weight:bold;padding-top:14px;' }, 'VS'), B.box);
        const log = el('div', { style: 'background:#020617;border:1px solid #334155;border-radius:8px;height:260px;overflow-y:auto;padding:10px;font-size:13px;line-height:1.7;' });
        const count = el('div', { style: 'text-align:center;color:#fbbf24;font-weight:bold;font-size:15px;margin-bottom:8px;' }, '即將開始…');
        wrap.append(count, top, log);
        const ov = modal('⚔️ 競技場對戰', wrap, { w: '560px', noClose: true });

        const colors = { attack: '#e2e8f0', crit: '#fbbf24', magic: '#67e8f9', heal: '#86efac', miss: '#64748b', evade: '#64748b', start: '#fbbf24', end: '#f0abfc' };
        function addLog(e) {
            const d = el('div', { style: `color:${colors[e.kind] || '#e2e8f0'};${e.kind === 'end' ? 'font-weight:bold;font-size:15px;margin-top:6px;' : ''}` },
                (e.kind === 'start' || e.kind === 'end' ? '' : `<span style="color:#475569">[${(e.t / 10).toFixed(1)}s]</span> `) + e.text);
            log.append(d); log.scrollTop = log.scrollHeight;
            A.hpIn.style.width = Math.max(0, e.hpA / m.a.mhp * 100) + '%';
            B.hpIn.style.width = Math.max(0, e.hpB / m.b.mhp * 100) + '%';
            A.hpTxt.textContent = `${Math.max(0, e.hpA)} / ${m.a.mhp}`;
            B.hpTxt.textContent = `${Math.max(0, e.hpB)} / ${m.b.mhp}`;
        }
        const wait = Math.max(0, m.startAt - Date.now());
        let cd = Math.ceil(wait / 1000);
        const cdT = setInterval(() => { cd--; count.textContent = cd > 0 ? `${cd}…` : '開戰！'; if (cd <= 0) clearInterval(cdT); }, 1000);
        count.textContent = cd > 0 ? `${cd}…` : '開戰！';
        m.events.forEach(e => {
            battleTimers.push(setTimeout(() => {
                addLog(e);
                if (e.kind === 'end') {
                    count.textContent = e.text;
                    const close = bigBtn('關閉', '#475569');
                    close.onclick = () => ov.remove();
                    wrap.append(close);
                }
            }, wait + e.t * 100));
        });
    }

    // ============ 管理員面板 ============
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
        section('🎁 取得物品');
        const search = input('輸入關鍵字搜尋物品（例：魔杖）'); search.style.marginBottom = '6px';
        const results = el('div', { style: 'max-height:160px;overflow-y:auto;font-size:13px;margin-bottom:8px;' });
        search.oninput = () => {
            results.innerHTML = '';
            const q = search.value.trim();
            if (!q || !window.DB) return;
            Object.entries(DB.items).filter(([id, it]) => (it.n || '').includes(q)).slice(0, 30).forEach(([id, it]) => {
                const r = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:#1e293b;border-radius:6px;margin-bottom:4px;' });
                r.append(el('span', {}, `${it.n} <span style="color:#64748b">(${id})</span>`));
                const b = el('button', { style: 'background:#15803d;color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;' }, '取得');
                b.onclick = () => { try { gainItem(id, 1, true, true); refreshGame(); toast('已取得 ' + it.n); } catch (e) { toast('失敗：' + e.message, '#7f1d1d'); } };
                r.append(b); results.append(r);
            });
        };
        wrap.append(search, results);
        section('👥 帳號管理（伺服器）');
        const userList = el('div', { style: 'font-size:13px;margin-bottom:8px;max-height:120px;overflow-y:auto;' });
        api('/api/admin/users').then(j => {
            j.users.forEach(u => userList.append(el('div', { style: 'padding:3px 0;color:#cbd5e1;' }, `${u.is_admin ? '👑 ' : ''}${u.username} <span style="color:#475569">（${u.created_at}）</span>`)));
        }).catch(e => userList.textContent = e.message);
        wrap.append(userList);
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
    function init() {
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
