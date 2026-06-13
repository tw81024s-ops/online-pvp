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
    // ====== 挑戰等待狀態（30 秒逾時自動取消）======
    let _waitOv = null, _waitTimer = null;   // 發起方等待視窗
    let _incOv = null, _incTimer = null;      // 受challenge方收到視窗
    function _closeWait() { if (_waitTimer) { clearInterval(_waitTimer); _waitTimer = null; } if (_waitOv) { try { _waitOv.remove(); } catch (e) { } _waitOv = null; } }
    function sendChallenge(u) {
        if (!u) return;
        if (onlineUsers.indexOf(u) === -1) { toast(u + ' 已離線，無法挑戰', '#7f1d1d'); renderOnline(); return; }
        if (_waitOv) { toast('已有進行中的挑戰，請稍候…'); return; }
        ws.send(JSON.stringify({ type: 'challenge', to: u, profile: buildProfile() }));
        const nm = onlineNames[u] ? (onlineNames[u] + '（' + u + '）') : u;
        const w = el('div', { style: 'text-align:center;' });
        w.append(el('div', { style: 'font-size:15px;margin-bottom:10px;' }, '已向 <b style="color:#fbbf24">' + nm + '</b> 發出挑戰'));
        const cd = el('div', { style: 'font-size:30px;font-weight:bold;color:#fbbf24;margin-bottom:6px;' }, '30');
        w.append(cd, el('div', { style: 'color:#94a3b8;font-size:13px;margin-bottom:14px;' }, '等待對方接受…逾時自動取消'));
        const cancel = el('button', { style: 'background:#475569;color:#fff;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-weight:bold;' }, '取消挑戰');
        w.append(cancel);
        _waitOv = modal('⏳ 等待應戰', w, { noClose: true });
        cancel.onclick = () => { _closeWait(); try { ws.send(JSON.stringify({ type: 'challenge_cancel', to: u })); } catch (e) { } toast('已取消挑戰'); };
        let left = 30;
        _waitTimer = setInterval(() => {
            left--; if (cd) cd.textContent = String(left);
            if (left <= 0) { _closeWait(); try { ws.send(JSON.stringify({ type: 'challenge_cancel', to: u })); } catch (e) { } toast(nm + ' 未在時限內回應，挑戰已取消', '#7f1d1d'); }
        }, 1000);
    }
    // ====== 交換系統狀態 ======
    let tradeId = null, tradePartner = null;
    let myOffer = { items: [], gold: 0 }, partnerOffer = { items: [], gold: 0 };
    let iConfirmed = false, partnerConfirmed = false;
    let tradeWin = null;
    const _uid = () => (typeof uid === 'function') ? uid() : ('t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    const _itemName = (e) => { const _DB = getDB(); const d = _DB && _DB.items[e.id]; return (e.en > 0 ? ('+' + e.en + ' ') : '') + ((d && d.n) || e.id) + (e.cnt > 1 ? (' ×' + e.cnt) : ''); };

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
            window.__GAME_CONFIG = {
                expMult: j.expMult || 1, spdMult: j.spdMult || 1,
                goldDropMult: j.goldDropMult || 1, synthRateMult: j.synthRateMult || 1,
                enhanceRateMult: j.enhanceRateMult || 1, pandoraLuckMult: j.pandoraLuckMult || 1,
                eventZongzi: j.eventZongzi ? 1 : 0
            };
            try { if (typeof calcStats === 'function') calcStats(); if (typeof updateUI === 'function') updateUI(); } catch (e) { }
        } catch (e) { }
    }
    syncGameConfig();
    setInterval(syncGameConfig, 60000);
    // 回報角色名字給伺服器（競技場顯示），名字有變才送
    let onlineNames = {};
    let _lastSentName = null;
    function pushName() {
        if (!ws || !wsReady) return;
        const p = getPlayer(); const nm = (p && p.name) || '';
        if (nm !== _lastSentName) { _lastSentName = nm; try { ws.send(JSON.stringify({ type: 'set_name', name: nm })); } catch (e) { } }
    }
    setInterval(pushName, 15000);
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
        // 攻擊魔法：優先採用玩家自己設定的攻擊技能（sel-atk-skill / config.selAtkSkill）；
        // 若無有效設定，才自動挑「階級最高的攻擊魔法」當後備。
        const _mkSpell = (s, id) => ({ name: s.n || id, phys: s.dmgType === 'physical', hits: s.hits || 1, dmgDice: s.dmgDice || null, multiDmg: s.multiDmg || null, dmgBase: s.dmgBase || 0, tier: s.tier || 1, mp: s.mp || 10, ele: s.ele || null, stun: s.stun || 0, stunChance: s.stunChance || 0 });
        // 玩家選定的攻擊技能：物理技（三重矢/衝擊之暈，用武器骰連擊）或魔法技（需有傷害骰）皆可
        const _validAtk = (s) => !!(s && s.type === 'atk' && !s.healSlot && (s.dmgType === 'physical' ? true : (s.dmgDice || s.multiDmg)));
        const _isMagicAtk = (s) => !!(s && s.type === 'atk' && s.dmgType !== 'physical' && (s.dmgDice || s.multiDmg));
        let _selAtk = '';
        try { const _e = document.getElementById('sel-atk-skill'); _selAtk = (_e && _e.value) || ''; } catch (e) { }
        if (!_selAtk && p.config && p.config.selAtkSkill) _selAtk = p.config.selAtkSkill;
        let spell = null;
        if (_selAtk && _DB && _validAtk(_DB.skills[_selAtk])) {
            spell = _mkSpell(_DB.skills[_selAtk], _selAtk);     // ✅ 用玩家設定的攻擊技能（物理/魔法皆可）
        } else {
            (p.skills || []).forEach(id => {                    // 後備：自動挑最高階攻擊魔法
                const s = _DB && _DB.skills[id];
                if (!_isMagicAtk(s)) return;
                if (!spell || (s.tier || 1) > (spell.tier || 1)) spell = _mkSpell(s, id);
            });
        }
        // 治癒魔法：同樣優先用玩家設定（sel-heal-skill / config.selHealSkill），否則挑最高階治癒術
        const _healDice = (s) => s ? (s.healDice || (s.type === 'heal' && s.valDice) || null) : null;
        let _selHeal = '';
        try { const _e = document.getElementById('sel-heal-skill'); _selHeal = (_e && _e.value) || ''; } catch (e) { }
        if (!_selHeal && p.config && p.config.selHealSkill) _selHeal = p.config.selHealSkill;
        let heal = null;
        if (_selHeal && _DB && _DB.skills[_selHeal] && _healDice(_DB.skills[_selHeal])) {
            const s = _DB.skills[_selHeal];
            heal = { name: s.n || _selHeal, dice: _healDice(s), mp: s.mp || 5, tier: s.tier || 1 };   // ✅ 用玩家設定的治癒術
        } else {
            (p.skills || []).forEach(id => {
                const s = _DB && _DB.skills[id];
                const dice = _healDice(s);
                if (dice && (!heal || (s.tier || 1) > (heal.tier || 1))) heal = { name: s.n || id, dice: dice, mp: s.mp || 5, tier: s.tier || 1 };
            });
        }
        return {
            name: p.name || myName, cls: p.cls, lv: p.lv, avatar: p.avatar || null, darkelf: !!p.darkelf, magicEvade: !!(p.darkelf || p._setMoon5),
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
    // ====== 帳號變身圖鑑同步（所有角色共用）======
    let _pdTimer = null;
    function pushPolyDexNow() {
        if (!token) return;
        try { const _p = getPlayer(); if (!_p || !_p.polyDex) return; api('/api/polydex', 'POST', { dex: _p.polyDex }).catch(() => { }); } catch (e) { }
    }
    async function pullMergePolyDex() {
        if (!token) return;
        try { const j = await api('/api/polydex'); if (j && j.dex && typeof window.__mergePolyDex === 'function') window.__mergePolyDex(j.dex); } catch (e) { }
        pushPolyDexNow();
    }
    window.__pushPolyDex = function () { if (!token) return; clearTimeout(_pdTimer); _pdTimer = setTimeout(pushPolyDexNow, 3000); };

    // ============ WebSocket ============
    function connectWS() {
        if (!token) return;
        const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
        ws = new WebSocket(url);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.type === 'auth_ok') { wsReady = true; isAdmin = m.isAdmin; setStatus('🟢 ' + m.username); refreshAdminBtn(); pushName(); }
            if (m.type === 'auth_fail') { logout(true); }
            if (m.type === 'kicked') { toast('此帳號已在其他視窗登入', '#7f1d1d'); wsReady = false; }
            if (m.type === 'online_list') { onlineUsers = m.users; onlineNames = m.names || {}; renderOnline(); }
            if (m.type === 'error') toast(m.error, '#7f1d1d');
            if (m.type === 'challenge_sent') toast('已向 ' + m.to + ' 發出挑戰，等待對方接受…');
            if (m.type === 'challenge_declined') { _closeWait(); toast(m.by + ' 拒絕了你的挑戰', '#7f1d1d'); }
            if (m.type === 'challenge_cancelled') { if (_incTimer) { clearInterval(_incTimer); _incTimer = null; } if (_incOv) { try { _incOv.remove(); } catch (e) { } _incOv = null; } toast((m.by || '對方') + ' 取消了挑戰', '#7f1d1d'); }
            if (m.type === 'challenge_received') showIncoming(m);
            if (m.type === 'battle_start') { _closeWait(); playBattle(m); }
            if (m.type === 'pvp_reward') { try { if (typeof window.__applyPvpReward === 'function') window.__applyPvpReward(m.gold || 0, m.tickets || 0, m.reason); } catch (e) { } }
            if (m.type === 'admin_grant_poly') { try { if (typeof window.__adminGrantPoly === 'function') { window.__adminGrantPoly(m.formName); toast('🎁 獲得變身卡：' + m.formName, '#14532d'); } } catch (e) { } }
            if (m.type === 'admin_updated') {
                // 自動重新載入雲端最新存檔（管理員的修改），避免線上玩家的自動存檔把修改蓋回去
                toast('管理員更新了你的角色資料，正在重新載入…', '#1e3a5f');
                downloadSave().then(ok => {
                    if (ok && typeof loadGame === 'function') { loadGame(); toast('✅ 角色資料已更新', '#14532d'); }
                }).catch(() => { });
            }
            if (m.type === 'trade_requested') toast('已向 ' + m.to + ' 發出交換邀請，等待對方接受…');
            if (m.type === 'trade_declined') toast((m.by || '對方') + ' 拒絕了交換', '#7f1d1d');
            if (m.type === 'trade_incoming') showTradeIncoming(m);
            if (m.type === 'trade_opened') openTradeWindow(m.id, m.partner);
            if (m.type === 'trade_partner_offer') { partnerOffer = { items: m.items || [], gold: m.gold || 0 }; iConfirmed = false; partnerConfirmed = false; renderTrade(); }
            if (m.type === 'trade_reset_confirm') { iConfirmed = false; partnerConfirmed = false; renderTrade(); }
            if (m.type === 'trade_partner_confirmed') { partnerConfirmed = true; renderTrade(); }
            if (m.type === 'trade_execute') { execTrade(m.give, m.get, m.partner); }
            if (m.type === 'trade_cancelled') { toast((m.by || '對方') + ' 取消了交換', '#7f1d1d'); closeTradeWindow(); }
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
    const btnEvents = el('button', { style: btnStyle('#9333ea') }, '🎉 每日活動');
    const btnOffline = el('button', { style: btnStyle('#0891b2') }, '🏕️ 離線練功');
    function btnStyle(bg) { return `background:${bg};color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:bold;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.45);`; }
    fab.append(statusEl, btnAdmin, btnSlots, btnOffline, btnEvents, btnArena, btnLoginFab);
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
        try { await pullMergePolyDex(); } catch (e) { }
        try { const _op = (typeof window.__offlinePending === 'function') ? window.__offlinePending() : null; if (_op && _op.active && (_op.exp > 0 || _op.gold > 0)) toast('🏕️ 離線練功獎勵可領取！點下方「離線練功」領取', '#14532d'); } catch (e) { }
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
        // 沒名字先取名，讓其他玩家看得出是誰
        if (!_p.name) {
            const nm = (prompt('幫你的角色取個名字（其他玩家在競技場會看到）：', '') || '').trim().slice(0, 20);
            if (nm) { _p.name = nm; try { if (typeof saveGame === 'function') saveGame(); } catch (e) { } try { if (typeof updateUI === 'function') updateUI(); } catch (e) { } pushName(); }
        }
        const wrap = el('div');
        const statBar = el('div', { style: 'background:#0f172a;border:1px solid #334155;border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:13px;color:#cbd5e1;line-height:1.7;' }, '積分讀取中…');
        wrap.append(statBar);
        const lbBox = el('div', { style: 'background:#0f172a;border:1px solid #334155;border-radius:10px;padding:8px 12px;margin-bottom:10px;' });
        lbBox.append(el('div', { style: 'font-weight:bold;color:#fbbf24;margin-bottom:4px;' }, '🏆 排行榜（前 10）'));
        const lbList = el('div', { style: 'font-size:12px;color:#cbd5e1;' }, '讀取中…');
        lbBox.append(lbList);
        wrap.append(lbBox);
        wrap.append(el('div', { style: 'color:#94a3b8;font-size:13px;margin-bottom:10px;' }, '點選在線玩家「挑戰」即時對戰，或按「🤝 交換」與對方交換物品／金幣。'));
        arenaListEl = el('div');
        wrap.append(arenaListEl);
        modal('⚔️ 競技場', wrap);
        renderOnline();
        refreshPvpStats(statBar, lbList);
    }
    function refreshPvpStats(statBar, lbList) {
        api('/api/pvp/me').then(me => {
            statBar.innerHTML = `段位 <b style="color:#fbbf24">${me.tier}</b>　積分 <b>${me.score}</b>　排名 <b>#${me.rank || '-'}</b><br>` +
                `今日淨分 <b>${me.dayNet}</b>（每日 00:00 結算 ×100 金）　本週淨分 <b>${me.weekNet}</b>（每週一結算 ×1000 金）<br>戰績 ${me.wins} 勝 ${me.losses} 敗　連勝 ${me.streak}`;
        }).catch(() => { statBar.textContent = '（積分讀取失敗，請重新登入）'; });
        api('/api/pvp/leaderboard').then(j => {
            lbList.innerHTML = '';
            (j.top || []).forEach((x, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
                const isOnline = onlineUsers.indexOf(x.username) !== -1;
                const isSelf = x.username === myName;
                const rowEl = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:3px 0;' });
                const lEl = el('span'); lEl.textContent = `${medal} ${isOnline ? '🟢' : '⚫'} ${x.name}`;
                const rEl = el('span', { style: 'display:flex;gap:8px;align-items:center;color:#94a3b8;' });
                const sEl = el('span'); sEl.textContent = `${x.tier}　${x.score}`; rEl.append(sEl);
                if (isOnline && !isSelf) {
                    const cb = el('button', { style: 'background:#b45309;color:#fff;border:none;border-radius:5px;padding:3px 10px;cursor:pointer;font-weight:bold;font-size:12px;white-space:nowrap;' }, '挑戰');
                    cb.onclick = () => sendChallenge(x.username);
                    rEl.append(cb);
                }
                rowEl.append(lEl, rEl); lbList.append(rowEl);
            });
            if (!(j.top || []).length) lbList.textContent = '尚無資料';
        }).catch(() => { lbList.textContent = '（排行榜讀取失敗）'; });
    }
    function renderOnline() {
        if (!arenaListEl || !document.body.contains(arenaListEl)) return;
        arenaListEl.innerHTML = '';
        const others = onlineUsers.filter(u => u !== myName);
        const dispName = u => { const n = onlineNames[u]; return n ? (n + '（' + u + '）') : u; };
        if (others.length === 0) {
            arenaListEl.append(el('div', { style: 'color:#64748b;text-align:center;padding:18px 0;' }, '目前沒有其他玩家在線'));
            return;
        }
        others.forEach(u => {
            const row = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:10px 14px;margin-bottom:8px;' });
            row.append(el('div', {}, '🟢 ' + dispName(u)));
            const btns = el('div', { style: 'display:flex;gap:6px;flex:none;' });
            const b = el('button', { style: 'background:#b45309;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:bold;' }, '挑戰');
            b.onclick = () => sendChallenge(u);
            const tb = el('button', { style: 'background:#0e7490;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:bold;' }, '🤝 交換');
            tb.onclick = () => requestTrade(u);
            btns.append(b, tb);
            row.append(btns);
            arenaListEl.append(row);
        });
    }

    // ============ 每日活動：世界王 + 端午兌換 ============
    function showEvents() {
        if (!token || !wsReady) { toast('請先登入線上模式', '#7f1d1d'); if (!token) showLogin(); return; }
        const _p = getPlayer(); if (!_p || !_p.cls) { toast('請先建立或載入角色再參加活動', '#7f1d1d'); return; }
        const _DB = getDB();
        const wrap = el('div');

        // ===== 世界王 =====
        wrap.append(el('div', { style: 'font-weight:bold;color:#f87171;font-size:15px;margin-bottom:6px;' }, '🐉 世界王 — 火龍巴拉卡斯'));
        wrap.append(el('div', { style: 'color:#94a3b8;font-size:12px;margin-bottom:8px;line-height:1.6;' }, '每日 1 次，對火龍巴拉卡斯全力輸出 60 秒比拚累積傷害。每日 00:00 結算，前 10 名發金幣：1名 10億／2名 5億／3名 3億／4–10名 各 1億。'));
        const wbStat = el('div', { style: 'background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;margin-bottom:8px;font-size:13px;color:#cbd5e1;' }, '讀取中…');
        wrap.append(wbStat);
        const wbBtn = el('button', { style: 'width:100%;background:#b91c1c;color:#fff;border:none;border-radius:8px;padding:11px;font-weight:bold;cursor:pointer;margin-bottom:10px;font-size:15px;' }, '⚔️ 挑戰世界王');
        wrap.append(wbBtn);
        wrap.append(el('div', { style: 'font-weight:bold;color:#fbbf24;margin-bottom:4px;' }, '🏆 今日傷害排行（前 10）'));
        const wbLb = el('div', { style: 'font-size:12px;color:#cbd5e1;margin-bottom:6px;' }, '讀取中…');
        wrap.append(wbLb);

        function refreshWB() {
            api('/api/worldboss/me').then(me => {
                if (me.done) { wbStat.innerHTML = `今日成績：<b style="color:#fbbf24">${(me.dmg || 0).toLocaleString()}</b> 傷害　排名 <b>#${me.rank || '-'}</b>`; wbBtn.disabled = true; wbBtn.style.opacity = '.5'; wbBtn.style.cursor = 'default'; wbBtn.textContent = '今日已挑戰（每日 1 次）'; }
                else { wbStat.textContent = '今日尚未挑戰，點下方開始！'; wbBtn.disabled = false; wbBtn.style.opacity = '1'; wbBtn.style.cursor = 'pointer'; wbBtn.textContent = '⚔️ 挑戰世界王'; }
            }).catch(() => { wbStat.textContent = '（讀取失敗）'; });
            api('/api/worldboss/leaderboard').then(j => {
                wbLb.innerHTML = '';
                (j.top || []).forEach((x, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
                    const r = el('div', { style: 'display:flex;justify-content:space-between;padding:2px 0;' });
                    const a = el('span'); a.textContent = `${medal} ${x.name}`;
                    const b = el('span', { style: 'color:#94a3b8;' }); b.textContent = (x.dmg || 0).toLocaleString();
                    r.append(a, b); wbLb.append(r);
                });
                if (!(j.top || []).length) wbLb.textContent = '尚無紀錄';
            }).catch(() => { wbLb.textContent = '（讀取失敗）'; });
        }
        wbBtn.onclick = async () => {
            if (wbBtn.disabled) return;
            wbBtn.disabled = true; wbBtn.textContent = '⚔️ 戰鬥模擬中…';
            try {
                const j = await api('/api/worldboss/challenge', 'POST', { profile: buildProfile(), name: (_p.name || myName || '') });
                toast(`🐉 造成 ${(j.dmg || 0).toLocaleString()} 傷害！目前排名 #${j.rank || '-'}`, '#14532d');
            } catch (e) { toast(e.message, '#7f1d1d'); }
            refreshWB();
        };

        // ===== 端午兌換 =====
        wrap.append(el('div', { style: 'font-weight:bold;color:#34d399;font-size:15px;margin:6px 0;border-top:1px solid #334155;padding-top:12px;' }, '🎉 端午兌換所'));
        const zc = el('div', { style: 'font-size:13px;color:#cbd5e1;margin-bottom:8px;' }, '');
        wrap.append(zc);
        const COST = 5000;
        const WEAPON_GROUPS = [
            { cls: '🗡️ 騎士', ids: ['nwp_014', 'nwp_037', 'nwp_012'] },
            { cls: '🪄 法師', ids: ['wpn_strwand', 'wpn_crystalwand', 'nwp_059'] },
            { cls: '🏹 妖精', ids: ['nwp_033', 'nwp_031', 'wpn_flaming_angel'] },
            { cls: '🦇 黑妖', ids: ['nwp_077', 'nwp_067', 'de_claw_spirit'] }
        ];
        const GEAR = ['arm_82', 'arm_83', 'arm_81', 'arm_80', 'arm_88', 'amr_dk', 'de_ring_dark', 'de_amulet_shadow', 'acc_117', 'acc_116', 'amu_str', 'amu_int', 'acc_133'];
        function refreshZ() {
            const south = window.__countItem('zongzi_south'), north = window.__countItem('zongzi_north');
            zc.innerHTML = `你的粽子：南部粽 <b style="color:#fbbf24">${south.toLocaleString()}</b>　北部粽 <b style="color:#fbbf24">${north.toLocaleString()}</b>`;
        }
        function exRow(itemId, costId) {
            const nm = (_DB && _DB.items[itemId]) ? _DB.items[itemId].n : itemId;
            const r = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:6px 10px;margin-bottom:6px;' });
            r.append(el('div', { style: 'font-size:13px;' }, nm));
            const btn = el('button', { style: 'background:#15803d;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:bold;font-size:12px;white-space:nowrap;' }, '兌換 ' + COST.toLocaleString());
            btn.onclick = () => {
                const res = window.__zongziExchange(itemId, costId, COST);
                if (res && res.ok) { toast('🎉 兌換成功：' + res.name, '#14532d'); refreshZ(); }
                else toast((res && res.msg) || '兌換失敗', '#7f1d1d');
            };
            r.append(btn); return r;
        }
        wrap.append(el('div', { style: 'font-size:13px;color:#93c5fd;margin:4px 0;' }, '🗡️ 北部粽 ×5000 → 各職業高階武器（騎士/法師/妖精/黑妖 各 3 把）'));
        WEAPON_GROUPS.forEach(grp => {
            wrap.append(el('div', { style: 'font-size:12px;color:#fbbf24;font-weight:bold;margin:4px 0 2px;' }, grp.cls));
            grp.ids.forEach(id => wrap.append(exRow(id, 'zongzi_north')));
        });
        wrap.append(el('div', { style: 'font-size:13px;color:#93c5fd;margin:8px 0 4px;' }, '🛡️ 南部粽 ×5000 → 任選高階飾品/防具'));
        GEAR.forEach(id => wrap.append(exRow(id, 'zongzi_south')));

        modal('🎉 每日活動', wrap, { w: '480px' });
        refreshWB(); refreshZ();
    }

    // ====== 交換系統 ======
    function requestTrade(target) {
        if (!token || !wsReady) { toast('請先登入線上模式', '#7f1d1d'); return; }
        if (tradeId) { toast('你已在交換中', '#7f1d1d'); return; }
        ws.send(JSON.stringify({ type: 'trade_request', to: target }));
    }
    function showTradeIncoming(m) {
        const wrap = el('div');
        wrap.append(el('div', { style: 'margin-bottom:14px;font-size:15px;' }, '🤝 <b>' + m.from + '</b> 想和你交換物品。'));
        const acc = bigBtn('接受', '#15803d'), dec = bigBtn('拒絕', '#7f1d1d');
        wrap.append(acc, dec);
        const ov = modal('🤝 交換邀請', wrap, { w: '340px' });
        acc.onclick = () => { ov.remove(); ws.send(JSON.stringify({ type: 'trade_accept', id: m.id })); };
        dec.onclick = () => { ov.remove(); ws.send(JSON.stringify({ type: 'trade_decline', id: m.id })); };
    }
    function openTradeWindow(id, partner) {
        tradeId = id; tradePartner = partner;
        myOffer = { items: [], gold: 0 }; partnerOffer = { items: [], gold: 0 };
        iConfirmed = false; partnerConfirmed = false;
        const body = el('div', { id: 'trade-body' });
        tradeWin = modal('🤝 與 ' + partner + ' 交換', body, { w: '560px', noClose: true });
        renderTrade();
    }
    function closeTradeWindow() {
        tradeId = null; tradePartner = null;
        myOffer = { items: [], gold: 0 }; partnerOffer = { items: [], gold: 0 };
        iConfirmed = false; partnerConfirmed = false;
        if (tradeWin) { try { tradeWin.remove(); } catch (e) { } tradeWin = null; }
    }
    function sendOffer() {
        iConfirmed = false;
        if (tradeId) ws.send(JSON.stringify({ type: 'trade_offer', id: tradeId, items: myOffer.items, gold: myOffer.gold }));
        renderTrade();
    }
    function renderTrade() {
        const body = document.getElementById('trade-body');
        if (!body) return;
        body.innerHTML = '';
        const cols = el('div', { style: 'display:flex;gap:10px;' });
        const mine = el('div', { style: 'flex:1;min-width:0;background:#0b1220;border:1px solid #334155;border-radius:8px;padding:8px;' });
        mine.append(el('div', { style: 'color:#86efac;font-weight:bold;margin-bottom:6px;' }, '你的提供' + (iConfirmed ? ' ✅' : '')));
        myOffer.items.forEach((it, idx) => {
            const r = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;background:#1e293b;border-radius:5px;padding:3px 7px;margin-bottom:3px;font-size:13px;cursor:pointer;', title: '點擊移除' }, _itemName(it));
            r.onclick = () => { if (iConfirmed) return; myOffer.items.splice(idx, 1); sendOffer(); };
            mine.append(r);
        });
        mine.append(el('div', { style: 'color:#fbbf24;font-size:13px;margin-top:4px;' }, '💰 金幣：' + (myOffer.gold || 0)));
        const theirs = el('div', { style: 'flex:1;min-width:0;background:#0b1220;border:1px solid #334155;border-radius:8px;padding:8px;' });
        theirs.append(el('div', { style: 'color:#93c5fd;font-weight:bold;margin-bottom:6px;' }, tradePartner + ' 的提供' + (partnerConfirmed ? ' ✅' : '')));
        (partnerOffer.items || []).forEach(it => theirs.append(el('div', { style: 'background:#1e293b;border-radius:5px;padding:3px 7px;margin-bottom:3px;font-size:13px;' }, _itemName(it))));
        theirs.append(el('div', { style: 'color:#fbbf24;font-size:13px;margin-top:4px;' }, '💰 金幣：' + (partnerOffer.gold || 0)));
        cols.append(mine, theirs);
        body.append(cols);
        if (!iConfirmed) {
            const ctrl = el('div', { style: 'display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap;' });
            const addB = el('button', { style: 'background:#15803d;color:#fff;border:none;border-radius:6px;padding:8px 12px;cursor:pointer;font-weight:bold;white-space:nowrap;' }, '＋ 加入物品');
            addB.onclick = pickInventoryItem;
            const gold = el('input', { type: 'number', min: '0', value: String(myOffer.gold || 0), style: 'width:120px;background:#1e293b;border:1px solid #475569;border-radius:6px;padding:7px;color:#fff;' });
            gold.onchange = () => { let g = Math.max(0, Math.floor(Number(gold.value) || 0)); const pp = getPlayer(); if (pp) g = Math.min(g, pp.gold || 0); myOffer.gold = g; gold.value = String(g); sendOffer(); };
            ctrl.append(addB, el('span', { style: 'color:#94a3b8;font-size:13px;' }, '金幣:'), gold);
            body.append(ctrl);
        }
        body.append(el('div', { style: 'margin-top:10px;font-size:13px;color:#cbd5e1;' },
            '你：' + (iConfirmed ? '<span style="color:#86efac">已確認</span>' : '<span style="color:#fca5a5">未確認</span>') +
            '　|　' + tradePartner + '：' + (partnerConfirmed ? '<span style="color:#86efac">已確認</span>' : '<span style="color:#fca5a5">未確認</span>')));
        const btns = el('div', { style: 'display:flex;gap:8px;margin-top:8px;' });
        const conf = el('button', { style: 'flex:1;background:' + (iConfirmed ? '#475569' : '#1d4ed8') + ';color:#fff;border:none;border-radius:8px;padding:11px;font-weight:bold;cursor:pointer;' }, iConfirmed ? '已確認，等待對方…' : '確認交換');
        conf.onclick = () => { if (iConfirmed || !tradeId) return; iConfirmed = true; ws.send(JSON.stringify({ type: 'trade_confirm', id: tradeId })); renderTrade(); };
        const cancel = el('button', { style: 'flex:1;background:#7f1d1d;color:#fff;border:none;border-radius:8px;padding:11px;font-weight:bold;cursor:pointer;' }, '取消交換');
        cancel.onclick = cancelTrade;
        btns.append(conf, cancel);
        body.append(btns);
        body.append(el('div', { style: 'color:#64748b;font-size:11px;margin-top:8px;line-height:1.6;' }, '雙方都按「確認交換」後才成交；任一方改動內容會重置雙方確認。鎖定中的道具不可交換。'));
    }
    function cancelTrade() {
        if (tradeId) ws.send(JSON.stringify({ type: 'trade_cancel', id: tradeId }));
        closeTradeWindow();
        toast('已取消交換');
    }
    function pickInventoryItem() {
        const p = getPlayer(); const _DB = getDB();
        if (!p || !Array.isArray(p.inv)) { toast('讀不到背包', '#7f1d1d'); return; }
        const wrap = el('div');
        const search = input('搜尋背包道具名'); search.style.marginBottom = '6px';
        const out = el('div', { style: 'max-height:340px;overflow-y:auto;font-size:13px;' });
        wrap.append(search, out);
        const offeredQty = (uidv) => myOffer.items.filter(x => x.uid === uidv).reduce((a, b) => a + b.cnt, 0);
        function render(q) {
            out.innerHTML = '';
            const list = p.inv.filter(e => {
                const d = _DB && _DB.items[e.id];
                if (!d) return false;
                if (e.lock) return false;
                if (!q) return true;
                return (d.n || '').includes(q);
            });
            let shown = 0;
            list.forEach(e => {
                const avail = e.cnt - offeredQty(e.uid);
                if (avail <= 0) return;
                shown++;
                const r = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;background:#1e293b;border-radius:6px;padding:4px 8px;margin-bottom:3px;' });
                r.append(el('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, _itemName(e) + (avail < e.cnt ? (' （剩' + avail + '）') : '')));
                const qty = el('input', { type: 'number', value: '1', min: '1', max: String(avail), style: 'width:52px;margin:0 6px;padding:3px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;text-align:center;' });
                const add = el('button', { style: 'background:#0e7490;color:#fff;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;white-space:nowrap;' }, '加入');
                add.onclick = () => {
                    let n = Math.max(1, Math.min(avail, parseInt(qty.value) || 1));
                    const exist = myOffer.items.find(x => x.uid === e.uid);
                    if (exist) exist.cnt = Math.min(e.cnt, exist.cnt + n);
                    else myOffer.items.push({ uid: e.uid, id: e.id, cnt: n, en: e.en || 0, bless: !!e.bless, anc: !!e.anc, attr: !!e.attr });
                    sendOffer(); render(search.value.trim());
                };
                r.append(qty, add); out.append(r);
            });
            if (!shown) out.append(el('div', { style: 'color:#64748b;padding:8px;' }, '沒有可交換的道具'));
        }
        search.oninput = () => render(search.value.trim());
        render('');
        modal('🎒 從背包選擇要給的道具', wrap, { w: '440px' });
    }
    function execTrade(give, get, partner) {
        const p = getPlayer();
        if (!p) { closeTradeWindow(); return; }
        if (!Array.isArray(p.inv)) p.inv = [];
        (give.items || []).forEach(it => {
            const e = p.inv.find(x => x.uid === it.uid);
            if (e) { e.cnt -= it.cnt; if (e.cnt <= 0) p.inv = p.inv.filter(x => x.uid !== it.uid); }
        });
        p.gold = Math.max(0, (p.gold || 0) - (give.gold || 0));
        (get.items || []).forEach(it => {
            p.inv.push({ id: it.id, uid: _uid(), cnt: it.cnt || 1, en: it.en || 0, bless: !!it.bless, anc: !!it.anc, attr: !!it.attr, lock: false, junk: false });
        });
        p.gold = (p.gold || 0) + (get.gold || 0);
        try { if (typeof saveGame === 'function') saveGame(); } catch (e) { }
        try {
            if (typeof refreshGame === 'function') refreshGame();
            else { if (typeof calcStats === 'function') calcStats(); if (typeof renderTabs === 'function') renderTabs(); if (typeof updateUI === 'function') updateUI(); }
        } catch (e) { }
        closeTradeWindow();
        toast('✅ 與 ' + (partner || '對方') + ' 交換完成！', '#14532d');
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
    btnEvents.onclick = showEvents;
    btnOffline.onclick = () => showOffline();
    function showOffline() {
        const _p = getPlayer(); if (!_p || !_p.cls) { toast('請先建立或載入角色再使用離線練功', '#7f1d1d'); return; }
        if (typeof window.__offlinePending !== 'function') { toast('離線練功尚未就緒，請重新整理', '#7f1d1d'); return; }
        const wrap = el('div');
        const body = el('div'); wrap.append(body);
        function syncCloud() { if (token) { clearTimeout(saveTimer); uploadSave(); } }
        function render() {
            body.innerHTML = '';
            const p = window.__offlinePending();
            if (!p || !p.ok) { body.append(el('div', { style: 'color:#94a3b8;text-align:center;padding:14px;' }, '無法使用（請先載入角色）')); return; }
            if (!p.active) {
                body.append(el('div', { style: 'color:#cbd5e1;font-size:14px;line-height:1.9;margin-bottom:14px;text-align:center;' },
                    '開始後依你的等級自動累積<b style="color:#fbbf24">經驗與金幣</b>。<br>每次最多累積 <b style="color:#fbbf24">4 小時</b>，回來領取後即可再次開始。'));
                const start = el('button', { style: 'width:100%;background:#0891b2;color:#fff;border:none;border-radius:14px;padding:18px;font-size:19px;font-weight:bold;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);' }, '🏕️ 開始離線練功');
                start.onclick = () => { if (window.__offlineStart()) { syncCloud(); toast('已開始離線練功，離開遊戲也會累積！', '#14532d'); render(); } };
                body.append(start);
            } else {
                const h = Math.floor(p.hours), mi = Math.floor((p.hours - h) * 60);
                body.append(el('div', { style: 'background:#0f172a;border:1px solid #334155;border-radius:14px;padding:16px;margin-bottom:14px;text-align:center;font-size:15px;line-height:1.9;' },
                    '已離線 <b style="color:#fbbf24">' + h + ' 小時 ' + mi + ' 分</b>' + (p.capped ? '（已達 4 小時上限）' : '') + '<br><br>可領取<br>📘 經驗 <b style="color:#86efac">+' + p.exp.toLocaleString() + '</b><br>💰 金幣 <b style="color:#fbbf24">+' + p.gold.toLocaleString() + '</b>'));
                const claim = el('button', { style: 'width:100%;background:#15803d;color:#fff;border:none;border-radius:14px;padding:18px;font-size:19px;font-weight:bold;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);' }, '🎁 領取獎勵');
                claim.onclick = () => { const r = window.__offlineClaim(); if (r) { syncCloud(); toast('領取成功！經驗 +' + r.exp.toLocaleString() + '、金幣 +' + r.gold.toLocaleString(), '#14532d'); render(); } };
                body.append(claim);
                body.append(el('div', { style: 'color:#94a3b8;font-size:12px;margin-top:8px;text-align:center;' }, '領取後可再次開始離線練功'));
            }
        }
        render();
        modal('🏕️ 離線練功', wrap, { w: '380px' });
    }
    window.showOffline = showOffline;
    window.showEvents = showEvents;

    function showIncoming(m) {
        // 已有舊的收到視窗先清掉
        if (_incTimer) { clearInterval(_incTimer); _incTimer = null; }
        if (_incOv) { try { _incOv.remove(); } catch (e) { } _incOv = null; }
        const wrap = el('div');
        const fromNm = (m.fromName ? (m.fromName + '（' + m.from + '）') : m.from);
        wrap.append(el('div', { style: 'font-size:15px;margin-bottom:8px;' }, `<b style="color:#fbbf24">${fromNm}</b> 向你發起對戰挑戰！`));
        const cd = el('div', { style: 'text-align:center;font-size:13px;color:#94a3b8;margin-bottom:12px;' }, '30 秒內未回應將自動拒絕');
        const acc = bigBtn('⚔️ 接受挑戰', '#15803d'), dec = bigBtn('拒絕', '#475569');
        wrap.append(cd, acc, dec);
        _incOv = modal('收到挑戰', wrap, { noClose: true });
        const close = () => { if (_incTimer) { clearInterval(_incTimer); _incTimer = null; } if (_incOv) { try { _incOv.remove(); } catch (e) { } _incOv = null; } };
        acc.onclick = () => {
            const _p = getPlayer(); if (!_p || !_p.cls) { toast('你還沒有角色，無法應戰', '#7f1d1d'); return; }
            ws.send(JSON.stringify({ type: 'challenge_accept', id: m.id, profile: buildProfile() }));
            close();
        };
        dec.onclick = () => { ws.send(JSON.stringify({ type: 'challenge_decline', id: m.id })); close(); };
        let left = 30;
        _incTimer = setInterval(() => {
            left--; if (cd) cd.textContent = left + ' 秒內未回應將自動拒絕';
            if (left <= 0) { try { ws.send(JSON.stringify({ type: 'challenge_decline', id: m.id })); } catch (e) { } close(); toast('超過 30 秒未回應，已自動拒絕', '#7f1d1d'); }
        }, 1000);
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
        // 🛡️ 目前裝備（管理員檢視）
        (function () {
            const SLOT_LABEL = { wpn: '武器', helm: '頭盔', armor: '盔甲', shield: '盾牌', cloak: '披風', tshirt: '內衣', gloves: '手套', boots: '鞋子', ring1: '戒指1', ring2: '戒指2', amulet: '項鍊', belt: '腰帶' };
            const _DB = (typeof getDB === 'function') ? getDB() : (window.DB || null);
            const eq = (p && p.eq) || {};
            const box = el('div', { style: 'background:#0f172a;border:1px solid #334155;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#cbd5e1;' });
            box.append(el('div', { style: 'font-weight:bold;color:#7dd3fc;margin-bottom:4px;' }, '🛡️ 目前裝備'));
            let any = false;
            Object.keys(SLOT_LABEL).forEach(k => {
                const it = eq[k]; if (!it || !it.id) return; any = true;
                const nm = (_DB && _DB.items[it.id]) ? _DB.items[it.id].n : it.id;
                const tags = []; if (it.en) tags.push('+' + it.en); if (it.bless) tags.push('祝'); if (it.anc) tags.push('遠'); if (it.attr) tags.push('屬');
                const eRow = el('div', { style: 'display:flex;justify-content:space-between;padding:1px 0;' });
                const eLab = el('span', { style: 'color:#94a3b8;' }); eLab.textContent = SLOT_LABEL[k];
                const eVal = el('span'); eVal.textContent = nm + (tags.length ? ('　' + tags.join('')) : '');
                eRow.append(eLab, eVal); box.append(eRow);
            });
            if (!any) box.append(el('div', { style: 'color:#64748b;' }, '（未穿戴任何裝備）'));
            wrap.append(box);
        })();
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
        let _secBody = wrap;   // 目前展開區塊的內容容器
        function section(t) {
            const d = el('details', { style: 'margin:6px 0;border:1px solid #334155;border-radius:8px;background:#0f172a;overflow:hidden;' });
            const sm = el('summary', { style: 'cursor:pointer;color:#fbbf24;font-weight:bold;padding:10px 12px;font-size:14px;user-select:none;' }, t);
            const bd = el('div', { style: 'padding:6px 12px 10px;' });
            d.append(sm, bd); wrap.append(d); _secBody = bd;
        }
        function row(label, btnTxt, fn, withInput, ph) {
            const r = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px;align-items:center;' });
            let inp = null;
            if (withInput) { inp = input(ph || ''); inp.style.marginBottom = '0'; inp.style.flex = '1'; r.append(inp); }
            else r.append(el('div', { style: 'flex:1;font-size:14px;' }, label));
            const b = el('button', { style: 'background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;white-space:nowrap;font-weight:bold;' }, btnTxt);
            b.onclick = () => fn(inp && inp.value);
            r.append(b); _secBody.append(r);
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
        _secBody.append(cfgStatus);
        const fmtCfg = c => `目前全服：經驗 ×${c.expMult || 1}　攻速 ×${c.spdMult || 1}<br>競技場傷害 ×${c.pvpDmgMult != null ? c.pvpDmgMult : 1}　競技場魔法 ×${c.pvpMagicMult != null ? c.pvpMagicMult : 1}<br>金幣掉落 ×${c.goldDropMult != null ? c.goldDropMult : 1}　合卡 ×${c.synthRateMult != null ? c.synthRateMult : 1}　衝裝 ×${c.enhanceRateMult != null ? c.enhanceRateMult : 1}　潘朵拉 ×${c.pandoraLuckMult != null ? c.pandoraLuckMult : 1}　端午活動 ${c.eventZongzi ? '🟢開啟' : '⚪關閉'}`;
        fetch('/api/config').then(r => r.json()).then(j => { cfgStatus.innerHTML = fmtCfg(j); }).catch(() => { cfgStatus.textContent = '（需登入線上模式才能讀取/設定）'; });
        const setCfg = async (key, n, label) => {
            try { const j = await api('/api/admin/config', 'POST', { [key]: n }); await syncGameConfig(); cfgStatus.innerHTML = fmtCfg(j.config); toast(label + ' = ×' + n, '#14532d'); }
            catch (e) { toast(e.message, '#7f1d1d'); }
        };
        row(null, '設定經驗倍率', v => setCfg('expMult', Math.max(0, parseFloat(v) || 1), '全服經驗倍率'), true, '經驗倍率（例 2＝雙倍、1＝正常）');
        row(null, '設定攻速倍率', v => setCfg('spdMult', Math.max(1, parseFloat(v) || 1), '全服攻速倍率'), true, '攻速倍率（例 3＝3倍、1＝正常）');
        row(null, '競技場傷害倍率', v => setCfg('pvpDmgMult', Math.max(0.05, parseFloat(v) || 1), '競技場傷害倍率'), true, '全部PvP傷害（例 0.6＝6折、1＝正常）');
        row(null, '競技場魔法倍率', v => setCfg('pvpMagicMult', Math.max(0.05, parseFloat(v) || 1), '競技場魔法倍率'), true, '法師魔法再乘（例 0.4＝壓低法師、1＝不變）');
        row(null, '金幣掉落率', v => setCfg('goldDropMult', Math.max(0, parseFloat(v) || 1), '金幣掉落率'), true, '打怪金幣倍率（例 2＝雙倍、1＝正常）');
        row(null, '合卡成功率', v => setCfg('synthRateMult', Math.max(0, parseFloat(v) || 1), '合卡成功率'), true, '變身合成倍率（例 2＝兩倍成功率）');
        row(null, '衝裝成功率', v => setCfg('enhanceRateMult', Math.max(0, parseFloat(v) || 1), '衝裝成功率'), true, '強化成功率倍率（例 1.5＝1.5倍）');
        row(null, '潘朵拉機率', v => setCfg('pandoraLuckMult', Math.max(0, parseFloat(v) || 1), '潘朵拉機率'), true, '稀有物加權倍率（例 3＝稀有更易中）');
        {
            const er = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px;align-items:center;' });
            er.append(el('div', { style: 'flex:1;font-size:14px;' }, '🎉 端午活動（全怪 50% 掉粽子）'));
            const onB = el('button', { style: 'background:#15803d;color:#fff;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;font-weight:bold;' }, '開啟');
            const offB = el('button', { style: 'background:#7f1d1d;color:#fff;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;font-weight:bold;' }, '關閉');
            onB.onclick = () => setCfg('eventZongzi', 1, '端午活動');
            offB.onclick = () => setCfg('eventZongzi', 0, '端午活動');
            er.append(onB, offB); _secBody.append(er);
        }
        // 🎁 給予指定變身（對方需在線上，由其客戶端寫入圖鑑）
        section('🎁 給予指定變身（對方需在線上）');
        {
            const gr = el('div', { style: 'display:flex;gap:6px;margin-bottom:8px;align-items:center;flex-wrap:wrap;' });
            const gUser = input('玩家帳號'); gUser.style.marginBottom = '0'; gUser.style.flex = '1'; gUser.style.minWidth = '90px';
            const gSel = el('select', { style: 'flex:1;min-width:110px;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px;font-size:13px;' });
            let forms = []; try { forms = (typeof window.__polyFormList === 'function') ? window.__polyFormList() : []; } catch (e) { }
            if (!forms.length) gSel.append(el('option', { value: '' }, '（無變身清單）'));
            forms.forEach(f => gSel.append(el('option', { value: f.name }, `[${f.tier}] ${f.name}`)));
            const gBtn = el('button', { style: 'background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;white-space:nowrap;font-weight:bold;' }, '發放');
            gBtn.onclick = async () => {
                const u = (gUser.value || '').trim(); const fn = gSel.value;
                if (!u) return toast('請輸入玩家帳號', '#7f1d1d');
                if (!fn) return toast('請選擇變身', '#7f1d1d');
                try { await api('/api/admin/grant-poly', 'POST', { username: u, formName: fn }); toast('已發放「' + fn + '」給 ' + u, '#14532d'); }
                catch (e) { toast(e.message, '#7f1d1d'); }
            };
            gr.append(gUser, gSel, gBtn); _secBody.append(gr);
        }
        section('🎁 取得物品（點分類展開瀏覽，或搜尋）');
        _secBody.append(buildItemBrowser((id, it, qty) => {
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
        _secBody.append(userList);
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
