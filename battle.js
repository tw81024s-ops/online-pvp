// battle.js — 伺服器權威戰鬥模擬器
// 公式 1:1 移植自遊戲 index.html：d20 命中 (stretchHitValue)、重擊/擦傷/爆擊、
// 魔攻係數 spCoef、魔防 mrFactor、職業隨機減傷、迴避 er、攻速 tick 制 (100ms/tick)

function rnd() { return Math.random(); }
function roll(n, s) { let r = 0; for (let i = 0; i < n; i++) r += Math.floor(rnd() * s) + 1; return r; }
function randInt(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

function stretchHitValue(raw) {
    let hv;
    if (raw >= 8) hv = Math.min(20, raw);
    else {
        let e = Math.min(30, 8 - raw);
        let frac = e / 30;
        let h = 2 * frac - frac * frac;
        hv = 8 - 7 * h;
    }
    let lo = Math.floor(hv);
    let hvInt = lo + ((rnd() < (hv - lo)) ? 1 : 0);
    return Math.max(1, Math.min(20, hvInt));
}

// 防守方職業隨機減傷上限：騎士 (10-AC)/2、妖精 (10-AC)/3、法師 (10-AC)/5
function classRandomDR(def) {
    let acGap = Math.max(0, 10 - def.ac);
    let max = 0;
    if (def.cls === 'knight') max = Math.floor(acGap / 2);
    else if (def.cls === 'elf') max = Math.floor(acGap / 3);
    else if (def.cls === 'mage') max = Math.floor(acGap / 5);
    return max > 0 ? randInt(0, max) : 0;
}

// 物理攻擊（近/遠）：回傳事件
function physicalAttack(atk, def) {
    // 迴避
    if (def.er > 0 && roll(1, 100) <= def.er) return { type: 'evade' };

    let isRanged = !!(atk.weapon && atk.weapon.ranged);
    let hitBonus = (isRanged ? atk.rangedHit : atk.meleeHit) + (atk.extraHit || 0);
    let dmgBonus = isRanged ? atk.rangedDmg : atk.meleeDmg;
    let critRate = isRanged ? atk.rangedCrit : atk.meleeCrit;
    let critDmg = isRanged ? atk.rangedCritDmg : atk.meleeCritDmg;

    let rawHitValue = atk.lv + hitBonus - def.lv + def.ac;
    let hitValue = stretchHitValue(rawHitValue);
    let rollHit = roll(1, 20);
    let hit = false, heavy = false, graze = false;
    if (rollHit === 20) { hit = true; heavy = true; }
    else if (rollHit !== 1 && hitValue >= rollHit) hit = true;
    else if (rollHit === 19) { hit = true; graze = true; }
    if (!hit) return { type: 'miss' };

    let isCrit = rnd() * 100 < critRate;
    if (graze) isCrit = false;
    let critMult = isCrit ? (1 + critDmg / 100) : 1;

    let dice = (atk.weapon && atk.weapon.dice) || 2;
    let weaponRoll = heavy ? dice : roll(1, dice);
    let inner = Math.floor((weaponRoll + dmgBonus) * critMult) + (atk.extraDmg || 0) - classRandomDR(def) - (def.dr || 0);
    inner = Math.max(1, inner);
    let dmg = graze ? Math.max(1, Math.floor(inner * 0.5)) : inner;
    return { type: 'hit', dmg, heavy, crit: isCrit, graze, ranged: isRanged };
}

// 魔法攻擊
function magicAttack(atk, def, spell) {
    // 黑妖／月光5：以身法迴避魔法（必中魔法先判定 ER 迴避）
    if (def.magicEvade && def.er > 0 && roll(1, 100) <= def.er) return { type: 'evade' };
    let effMr = def.mr || 0;
    let mrFactor;
    if (effMr <= 100) mrFactor = (100 - effMr / 2) / 100;
    else mrFactor = (50 - (effMr - 100) / 10) / 100;
    mrFactor = Math.max(0, mrFactor);

    let tier = spell.tier || 1;
    let spCoef = (1 + (3 * (atk.magicDmg || 0) / 16)) * (1 + tier / 3);
    let isCrit = rnd() * 100 < (atk.magicCrit || 0);
    let critMult = isCrit ? (1 + (atk.magicCritDmg || 50) / 100) : 1;
    let mageMult = atk.cls === 'mage' ? (1.5 + tier / 20) : 1.0;

    let diceArr = spell.multiDmg || [spell.dmgDice];
    let total = 0;
    diceArr.forEach((dd, idx) => {
        let core = roll(dd[0], dd[1]) * spCoef * critMult;
        let extra = (idx === diceArr.length - 1) ? ((spell.dmgBase || 0) + (atk.extraMp || 0)) : 0;
        let d = Math.floor((core + extra) * mrFactor) - (def.dr || 0);
        d = Math.max(1, d);
        // 屬性剋制：火剋地/地剋風/風剋水/水剋火 +6（玩家以最高抗性屬性視為其屬性，簡化版不套用）
        d = Math.floor(d * mageMult);
        total += d;
    });
    return { type: 'magic', dmg: total, crit: isCrit, spell: spell.name, ele: spell.ele || null };
}

// 治癒
function castHeal(p, heal) {
    let amount = Math.max(1, roll(heal.dice[0], heal.dice[1]) + (p.magicDmg || 0));
    return amount;
}

// ============ 模擬主程式 ============
// profileA/B 由前端產出（calcStats 後的衍生數值）
// 回傳 { winner: 'A'|'B'|'draw', events: [{t, side, kind, text, dmg, hpA, hpB, mpA, mpB}], duration }
function simulate(profileA, profileB, opts) {
    opts = opts || {};
    const PVP_DMG = Math.max(0, isFinite(opts.pvpDmgMult) ? opts.pvpDmgMult : 1);     // 競技場整體傷害倍率
    const PVP_MAGIC = Math.max(0, isFinite(opts.pvpMagicMult) ? opts.pvpMagicMult : 1); // 競技場魔法額外倍率（壓法師爆炸傷害）
    const MAGE_X = Math.max(0.1, isFinite(opts.mageDmgMult) ? opts.mageDmgMult : 1);
    const MELEE_X = Math.max(0.1, isFinite(opts.meleeDmgMult) ? opts.meleeDmgMult : 1);
    const RANGED_X = Math.max(0.1, isFinite(opts.rangedDmgMult) ? opts.rangedDmgMult : 1);
    const MAXTICKS = 1800; // 180 秒上限
    let A = initSide(profileA), B = initSide(profileB);
    let events = [];
    let push = (t, side, kind, text, dmg) => events.push({
        t, side, kind, text, dmg: dmg || 0,
        hpA: Math.max(0, A.hp), hpB: Math.max(0, B.hp),
        mpA: Math.max(0, A.mp), mpB: Math.max(0, B.mp)
    });
    push(0, '-', 'start', `${A.name} VS ${B.name}，戰鬥開始！`);

    for (let t = 1; t <= MAXTICKS; t++) {
        for (let [me, foe, side] of [[A, B, 'A'], [B, A, 'B']]) {
            if (me.hp <= 0 || foe.hp <= 0) continue;
            // 🛡️ 魔法屏障：抵擋後冷卻倒數，歸零則重新就緒（對應角色開啟的魔法屏障設定）
            if (me.magicBarrier && me.mShieldCd > 0) { me.mShieldCd--; if (me.mShieldCd <= 0) me.mShield = true; }
            // 暈眩中：本回合無法行動（冷卻照樣遞減）
            if (me.stunT > 0) { me.stunT--; me.atkCd--; me.atkSkCd--; me.healCd--; continue; }

            // 回復（每 4 秒一跳，沿用遊戲自然回復節奏的簡化）
            if (t % 40 === 0) {
                me.hp = Math.min(me.mhp, me.hp + (me.p.hpR || 0));
                me.mp = Math.min(me.mmp, me.mp + (me.p.mpR || 0));
            }

            // 治癒魔法：HP<50% 且有治癒術且 MP 夠（冷卻同攻擊魔法 20tick*spdMult）
            if (me.p.heal && me.hp > 0 && me.hp < me.mhp * 0.5 && me.healCd <= 0 && me.mp >= me.p.heal.mp) {
                me.mp -= me.p.heal.mp;
                let h = castHeal(me.p, me.p.heal);
                me.hp = Math.min(me.mhp, me.hp + h);
                me.healCd = me.castInterval;
                push(t, side, 'heal', `${me.name} 施放 ${me.p.heal.name}，恢復 ${h} 點生命。`, 0);
            }

            // 攻擊技能（魔法 or 物理；忠實採用玩家設定的攻擊技能）
            if (me.p.spell && me.atkSkCd <= 0 && me.mp >= me.p.spell.mp) {
                me.mp -= me.p.spell.mp;
                me.atkSkCd = me.castInterval;
                if (me.p.spell.phys && me.p.spell.stun) {
                    // 衝擊之暈：擲暈眩判定。暈到→1.5~2 倍傷害並暈眩；沒暈到→僅 1 點傷害
                    let r = physicalAttack(me.p, foe.p);
                    let stunOk = (r.type === 'hit') && (Math.random() * 100 < (me.p.spell.stunChance || 50));
                    if (stunOk) {
                        let mult = 1.5 + Math.random() * 0.5;                 // 1.5 ~ 2.0 倍
                        let dmg = Math.max(1, Math.floor(r.dmg * PVP_DMG * mult * (r.ranged ? RANGED_X : MELEE_X) * tkMult(foe.p)));
                        foe.hp -= dmg;
                        foe.stunT = Math.max(foe.stunT, Math.round(me.p.spell.stun / 10));
                        push(t, side, 'crit', `${me.name} 施放 ${me.p.spell.name} 命中要害！對 ${foe.name} 造成 ${dmg} 點傷害並暈眩 ${(Math.round(me.p.spell.stun / 10) / 10).toFixed(1)} 秒！`, dmg);
                    } else {
                        foe.hp -= 1;
                        push(t, side, 'attack', `${me.name} 施放 ${me.p.spell.name}，未能暈眩 ${foe.name}，僅造成 1 點傷害。`, 1);
                    }
                } else if (me.p.spell.phys) {
                    // 多段物理攻擊技能（六重矢等）：依 hits 次數連續物理攻擊（用武器骰）
                    let hits = Math.max(1, me.p.spell.hits || 1);
                    let total = 0, anyCrit = false, parts = [];
                    for (let h = 0; h < hits; h++) {
                        if (foe.hp <= 0) break;
                        let r = physicalAttack(me.p, foe.p);
                        if (r.type === 'evade' || r.type === 'miss') { parts.push('Miss'); continue; }
                        let pdmg = Math.max(1, Math.floor(r.dmg * PVP_DMG * (r.ranged ? RANGED_X : MELEE_X) * tkMult(foe.p)));
                        foe.hp -= pdmg; total += pdmg;
                        if (r.crit || r.heavy) anyCrit = true;
                        parts.push(pdmg + (r.heavy && r.crit ? '(會心)' : r.crit ? '(爆)' : r.heavy ? '(重)' : ''));
                    }
                    let detail = hits > 1 ? `[${parts.join(', ')}] 共 ${total}` : `${total}`;
                    push(t, side, anyCrit ? 'crit' : 'attack',
                        `${me.name} 施放 ${me.p.spell.name}，對 ${foe.name} 造成 ${detail} 點物理傷害。`, total);
                } else {
                    let r = magicAttack(me.p, foe.p, me.p.spell);
                    if (r.type === 'evade') {
                        push(t, side, 'evade', `${foe.name} 以身法迴避了 ${me.name} 的魔法攻擊！`, 0);
                    } else if (foe.mShield) {
                        foe.mShield = false; foe.mShieldCd = 30;   // 吸收一次，3 秒後重新就緒
                        push(t, side, 'evade', `🛡️ ${foe.name} 的魔法屏障吸收了 ${me.name} 的魔法攻擊！`, 0);
                    } else {
                        let mdmg = Math.max(1, Math.floor(r.dmg * PVP_DMG * PVP_MAGIC * MAGE_X * tkMult(foe.p)));
                        foe.hp -= mdmg;
                        push(t, side, r.crit ? 'crit' : 'magic',
                            `${me.name} 施放 ${r.spell}，對 ${foe.name} 造成 ${mdmg} 點傷害${r.crit ? '（爆擊！）' : ''}。`, mdmg);
                    }
                }
                if (foe.hp <= 0) break;
            }

            // 普通攻擊
            if (me.atkCd <= 0) {
                me.atkCd = me.atkInterval;
                let r = physicalAttack(me.p, foe.p);
                if (r.type === 'evade') push(t, side, 'evade', `${foe.name} 成功迴避了 ${me.name} 的攻擊。`);
                else if (r.type === 'miss') push(t, side, 'miss', `${me.name} 對 ${foe.name} 的攻擊未命中。`);
                else {
                    let pdmg = Math.max(1, Math.floor(r.dmg * PVP_DMG * (r.ranged ? RANGED_X : MELEE_X) * tkMult(foe.p)));
                    foe.hp -= pdmg;
                    let ext = r.heavy && r.crit ? '（會心一擊！）' : r.crit ? '（爆擊！）' : r.heavy ? '（重擊！）' : r.graze ? '（擦傷）' : '';
                    push(t, side, r.crit || r.heavy ? 'crit' : 'attack',
                        `${me.name} 命中 ${foe.name}，造成 ${pdmg} 點傷害${ext}。`, pdmg);
                }
                if (foe.hp <= 0) break;
            }

            me.atkCd--; me.atkSkCd--; me.healCd--;
        }
        if (A.hp <= 0 || B.hp <= 0) {
            let winner = A.hp <= 0 && B.hp <= 0 ? 'draw' : (B.hp <= 0 ? 'A' : 'B');
            let wn = winner === 'draw' ? null : (winner === 'A' ? A.name : B.name);
            push(t, '-', 'end', winner === 'draw' ? '兩敗俱傷，平手！' : `${wn} 獲得勝利！`);
            return { winner, events, duration: t };
        }
    }
    // 時間到：剩餘 HP% 高者勝
    let pa = A.hp / A.mhp, pb = B.hp / B.mhp;
    let winner = pa === pb ? 'draw' : (pa > pb ? 'A' : 'B');
    push(MAXTICKS, '-', 'end', winner === 'draw' ? '時間到，平手！' : `時間到，${winner === 'A' ? A.name : B.name} 以剩餘體力獲勝！`);
    return { winner, events, duration: MAXTICKS };
}

function initSide(p) {
    // 攻速：武器 spd（秒）× spdMult，換算 tick；無武器預設 1.5 秒
    let wSpd = (p.weapon && p.weapon.spd) || 1.5;
    let spdMult = p.spdMult || 1;
    return {
        p, name: sanitize(p.name || '無名氏'),
        hp: p.mhp, mhp: p.mhp, mp: p.mmp, mmp: p.mmp, stunT: 0,
        atkInterval: Math.max(1, Math.round(wSpd * 10 * spdMult)),
        castInterval: Math.max(1, Math.round(20 * spdMult)),
        atkCd: randInt(0, 5), atkSkCd: randInt(0, 5), healCd: 0,
        magicBarrier: !!p.magicBarrier, mShield: !!p.magicBarrier, mShieldCd: 0
    };
}

function sanitize(s) { return String(s).replace(/[<>&"']/g, '').slice(0, 20); }

// 基本防呆：限制 profile 數值範圍，避免明顯灌爆的封包打掛伺服器
function tkMult(p) {   // 防守方職業受傷倍率
    if (!p || !p.cls) return 1;
    if (p.cls === 'knight') return 0.5;
    if (p.cls === 'mage') return 1.5;
    if (p.darkelf) return 1.3;
    return 1.0;
}
function clampProfile(p) {
    let n = (v, lo, hi, dflt) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt; };
    return {
        name: sanitize(p.name || '無名氏'),
        avatar: (typeof p.avatar === 'string' && p.avatar) ? sanitize(p.avatar) : null,
        darkelf: !!p.darkelf,
        cls: ['knight', 'mage', 'elf'].includes(p.cls) ? p.cls : 'knight',
        lv: n(p.lv, 1, 999, 1),
        mhp: n(p.mhp, 1, 999999, 100), mmp: n(p.mmp, 0, 999999, 0),
        ac: n(p.ac, -300, 10, 10), mr: n(p.mr, 0, 500, 0),
        er: n(p.er, 0, 95, 0), dr: n(p.dr, 0, 500, 0),
        meleeHit: n(p.meleeHit, -50, 300, 0), meleeDmg: n(p.meleeDmg, -50, 500, 0),
        rangedHit: n(p.rangedHit, -50, 300, 0), rangedDmg: n(p.rangedDmg, -50, 500, 0),
        extraHit: n(p.extraHit, -50, 300, 0), extraDmg: n(p.extraDmg, -50, 500, 0),
        meleeCrit: n(p.meleeCrit, 0, 100, 0), rangedCrit: n(p.rangedCrit, 0, 100, 0),
        meleeCritDmg: n(p.meleeCritDmg, 0, 1000, 50), rangedCritDmg: n(p.rangedCritDmg, 0, 1000, 50),
        magicDmg: n(p.magicDmg, 0, 500, 0), magicCrit: n(p.magicCrit, 0, 100, 0),
        magicCritDmg: n(p.magicCritDmg, 0, 1000, 50), extraMp: n(p.extraMp, 0, 500, 0),
        hpR: n(p.hpR, 0, 500, 0), mpR: n(p.mpR, 0, 500, 0),
        spdMult: n(p.spdMult, 0.3, 2, 1),
        weapon: p.weapon ? {
            dice: n(p.weapon.dice, 1, 200, 2),
            spd: n(p.weapon.spd, 0.5, 4, 1.5),
            ranged: !!p.weapon.ranged
        } : null,
        spell: (p.spell && (p.spell.phys || p.spell.dmgDice || (Array.isArray(p.spell.multiDmg) && p.spell.multiDmg.length))) ? {
            name: sanitize(p.spell.name || '技能'),
            phys: !!p.spell.phys,                                  // 物理攻擊技能（三重矢/衝擊之暈）：用武器骰連續攻擊
            hits: n(p.spell.hits, 1, 10, 1),                       // 物理技能連擊次數
            dmgDice: Array.isArray(p.spell.dmgDice) ? [n(p.spell.dmgDice[0], 1, 50, 1), n(p.spell.dmgDice[1], 1, 100, 6)] : null,
            multiDmg: Array.isArray(p.spell.multiDmg) ? p.spell.multiDmg.slice(0, 6).map(d => [n(d[0], 1, 50, 1), n(d[1], 1, 100, 6)]) : null,
            dmgBase: n(p.spell.dmgBase, 0, 500, 0),
            tier: n(p.spell.tier, 1, 10, 1),
            mp: n(p.spell.mp, 0, 999, 10),
            ele: p.spell.ele || null
        } : null,
        heal: p.heal && p.heal.dice ? {
            name: sanitize(p.heal.name || '治癒'),
            dice: [n(p.heal.dice[0], 1, 50, 1), n(p.heal.dice[1], 1, 100, 8)],
            mp: n(p.heal.mp, 0, 999, 5)
        } : null
    };
}

// ============ 世界王：固定時間 DPS 模擬（伺服器權威，防作弊）============
// 玩家對「固定靶」全力輸出 ticks 個 tick（100ms/tick），回傳總傷害。
// 靶設為高命中（lv低、ac高、mr0），讓傷害忠實反映玩家裝備/build；技能不耗 MP（1分鐘爆發）。
function simulateBossDps(profile, ticks, opts) {
    opts = opts || {};
    const DMG = Math.max(0, isFinite(opts.pvpDmgMult) ? opts.pvpDmgMult : 1);
    const MAG = Math.max(0, isFinite(opts.pvpMagicMult) ? opts.pvpMagicMult : 1);
    const MAGE_X = Math.max(0.1, isFinite(opts.mageDmgMult) ? opts.mageDmgMult : 1);
    const MELEE_X = Math.max(0.1, isFinite(opts.meleeDmgMult) ? opts.meleeDmgMult : 1);
    const RANGED_X = Math.max(0.1, isFinite(opts.rangedDmgMult) ? opts.rangedDmgMult : 1);
    const T = Math.max(1, Math.min(6000, ticks | 0));
    const me = initSide(clampProfile(profile));
    const bossDef = { lv: 1, ac: 10, mr: 0, dr: 0, er: 0, cls: null };   // 固定靶
    let total = 0;
    for (let t = 1; t <= T; t++) {
        // 攻擊技能（不耗 MP，照冷卻放）
        if (me.p.spell && me.atkSkCd <= 0) {
            me.atkSkCd = me.castInterval;
            if (me.p.spell.phys) {
                let hits = Math.max(1, me.p.spell.hits || 1);
                for (let h = 0; h < hits; h++) { let r = physicalAttack(me.p, bossDef); if (r.type === 'hit') total += Math.max(1, Math.floor(r.dmg * DMG * (r.ranged ? RANGED_X : MELEE_X))); }
            } else {
                let r = magicAttack(me.p, bossDef, me.p.spell); total += Math.max(1, Math.floor(r.dmg * DMG * MAG * MAGE_X));
            }
        }
        // 普通攻擊
        if (me.atkCd <= 0) {
            me.atkCd = me.atkInterval;
            let r = physicalAttack(me.p, bossDef);
            if (r.type === 'hit') total += Math.max(1, Math.floor(r.dmg * DMG * (r.ranged ? RANGED_X : MELEE_X)));
        }
        me.atkCd--; me.atkSkCd--;
    }
    return Math.floor(total);
}

module.exports = { simulate, clampProfile, simulateBossDps };
