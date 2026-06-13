【部署說明】放置天堂 — 轉生秘境 + 席琳套裝獵場

1) public/index.html   → 覆蓋到 repo 的 public/index.html
2) thebes_*.png（9張） → 放到 public/assets/icons/monsters/
3) patch_notes.md      → 公告內容（遊戲內已內建「📢更新公告」按鈕，可不上傳）

內容：
- 新地圖（需轉生1轉）：遺忘之島、底比斯①②③、底比斯·神壇；經驗 ×8~16。
- 這兩張地圖掉落的裝備有機率附帶「席琳套裝效果」（8 套，頭目機率更高）。
- 機率可調：killMob 內 (mob.boss?0.4:0.08) 為載體掉率；
  _sherineLootCtx rate (mob.boss?1.0:0.6) 為附效果機率。
- 還原：先前誤改的 11 套 DB 套裝 ×2 已復原為原數值。
