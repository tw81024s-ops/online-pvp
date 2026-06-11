# 放置天堂 — 線上對戰版

單機版《放置天堂》加上：**帳號註冊/登入、雲端存檔、即時同步競技場（好友對戰）、管理員面板**。

## 架構
- `server.js` — Node.js 伺服器：帳號（bcrypt 雜湊）、SQLite 資料庫、WebSocket 即時連線、提供遊戲網頁
- `battle.js` — 伺服器權威戰鬥模擬器（公式 1:1 移植自遊戲本體：d20 命中、重擊/擦傷/爆擊、魔攻係數、魔防減傷、攻速）
- `public/` — 遊戲本體（index.html + assets）＋ `online.js`（登入介面、雲端同步、競技場、管理員面板）

## 本機測試（任何電腦）
```bash
npm install
npm start
# 瀏覽器開 http://localhost:3000
```

## 部署到雲端（GitHub + Render，免費）
1. 把整個資料夾推上 GitHub：
   ```bash
   git init
   git add .
   git commit -m "online pvp v1"
   # 到 GitHub 建一個新 repo，然後：
   git remote add origin https://github.com/你的帳號/repo名.git
   git push -u origin main
   ```
2. 到 [render.com](https://render.com) → New → **Web Service** → 連結你的 GitHub repo
3. 設定：
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - 方案選 **Free**
4. 部署完成後 Render 會給你一個網址（如 `https://xxx.onrender.com`），朋友開這個網址就能玩。

> ⚠️ Render 免費方案兩個注意事項：
> - 閒置 15 分鐘會休眠，第一個人連上要等約 30~60 秒喚醒。
> - **免費方案磁碟不持久**：重新部署或重啟後 SQLite 資料（帳號/存檔）會消失。
>   解法：Render 加一個 **Persistent Disk**（最低月費約 $0.25/GB），掛載到 `/data`，
>   並在環境變數設 `DB_PATH=/data/data.sqlite`。或改用 Railway。

## 之後怎麼改遊戲內容
1. 在電腦上改 `public/index.html`（跟單機版改法一樣）
2. `git add . && git commit -m "改了xxx" && git push`
3. Render 自動重新部署，1~2 分鐘後全伺服器生效

## 管理員
- **第一個註冊的帳號自動成為管理員**（請你自己先註冊！）
- 登入後右下角會出現「🛠️ 管理員」按鈕：
  - 加金幣、加屬性點、補滿 HP/MP
  - 搜尋並取得任意物品
  - 查看所有帳號、重設密碼、刪除帳號

## 對戰怎麼玩
1. 兩人都登入後，右下角「⚔️ 競技場」可看到在線玩家
2. 點「挑戰」→ 對方按「接受」
3. 伺服器以雙方角色數值模擬整場戰鬥，兩邊**依同一時間軸即時播放**，結果完全一致

## 已知限制（v1）
- 角色數值由前端上傳，朋友圈遊玩 OK，但無法防止有心人作弊（伺服器有做基本數值上限防呆）
- 對戰為「自動戰鬥」互打（符合本作放置玩法），不含中途手動操作
- 對戰中暫不計算：藥水、寵物/召喚、變身、武器特效（吸魔/穿透/即死等）、狀態異常 — 之後可逐步加入
