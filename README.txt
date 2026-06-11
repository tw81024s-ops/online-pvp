放置天堂 - 冰之女王 v1.17 + 黑妖 + 線上層　完整部署包
================================================================

【這包是什麼】
你的 v1.17 主檔，已合併「黑妖職業」+ 線上層（帳號/雲端存檔/競技場/背景圖/admin）。
你新加的內容（同伴系統、祝福系統…）全部保留。

【資料夾結構】（直接對應你的 GitHub repo / Render）
  server.js          ← 根目錄
  store.js           ← 根目錄
  battle.js          ← 根目錄
  package.json       ← 根目錄
  public/
    index.html       ← 已合併黑妖
    online.js        ← 線上層（含雲端存檔修正、給道具數量、存檔診斷）
    assets/          ← 你全部素材 + 黑妖圖（已就定位）

【部署方式】
把這整包的內容覆蓋到你的 GitHub repo 資料夾（保持上面的結構），
GitHub Desktop → Commit → Push → 等 Render 變 Live → 用無痕視窗測。

【Render 環境變數（沿用你原本的，別漏）】
  ADMIN_USERNAME = hh2yu        （你的管理員帳號）
  DB_PATH        = /data/data.json （要跟你的 Persistent Disk 掛載路徑一致）

================================================================
【還缺的東西：黑妖武器圖示（要你手動存）】
這 11 把武器的圖示我無法從我這邊下載（網站擋外連），
請開下面網址、右鍵另存，存成指定檔名，放到：
  public/assets/icons/weapons/

雙刀：
  gametsg.net/img/1/2/dacaa1b2525e70a47ee8b0271314bafa.jpg  → de_blade_gloom.jpg     (幽暗雙刀)
  gametsg.net/img/1/2/b2dbbe1d03eeed78ab851bcdcd8bf1de.jpg  → de_blade_lindr.jpg     (倫得雙刀)
  gametsg.net/img/1/2/f1289700baa6e0de6c088d6812cb6f46.jpg  → de_blade_demonlord.jpg (惡魔王雙刀)

法師魔杖：
  gametsg.net/img/1/2/2fc5acf79256bcae81d86c0cda26e21b.jpg  → mw_holycrystal.jpg (聖晶魔杖)
  gametsg.net/img/1/2/240d47cd021ae5897d1f60ffe77e4acf.jpg  → mw_aris.jpg        (艾莉絲魔杖)
  gametsg.net/img/1/2/950684b3d362ceef03e6ffc7c622ca40.jpg  → mw_giran.jpg       (吉倫的魔杖)
  gametsg.net/img/1/2/7a4100d3bfb365851a526932e5224abf.jpg  → mw_leah.jpg        (蕾雅法杖)
  gametsg.net/img/1/2/a029973d0feb0594106823d1fe13b6d5.jpg  → mw_demonking.jpg   (惡魔王魔杖)
  gametsg.net/img/1/2/2e03c1719715f8d5ba1a9f2b8f0ec728.jpg  → mw_icequeen.jpg    (冰之女王魔杖)
  gametsg.net/img/1/2/e812dabd508b8bd02a9d4af59a7ad42f.jpg  → mw_baphomet.jpg    (巴風特魔杖)
  gametsg.net/img/1/2/97e302281e1b47bad347a4514c9d21be.jpg  → mw_steelmana.jpg   (鋼鐵馬那魔杖)

（沒存圖只是該武器圖示空白，不影響功能。）

================================================================
【黑妖怎麼玩】
創角會多出「男黑妖/女黑妖」。黑妖天生高爆擊+高迴避，
用 #admin → 給道具，把黑妖裝備/雙刀/魔杖、黑魔法書給自己或玩家，
裝備、學技能即可。黑妖無法學法師魔法（純刺客）。
