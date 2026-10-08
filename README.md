# 棋間 Gomoku

Vite + React 五子棋，使用 Supabase Anonymous Auth、Edge Function、PostgreSQL 與 Realtime。瀏覽器只送出操作意圖；Edge Function 驗證身份，資料庫交易負責落子、回合與勝負。

## 本機啟動

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

在 Supabase Dashboard 啟用 **Authentication → Sign In / Providers → Anonymous Sign-Ins**。`.env.local` 只放前端公開設定；不要放 Secret Key。

| 變數 | 用途 |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser 公開 API key，資料權限由 RLS 控制 |
| `VITE_API_BASE` | `https://<PROJECT_REF>.supabase.co/functions/v1/gomoku` |
| `VITE_BASE_PATH` | 本機 `/`；GitHub Repository Pages 為 `/<REPOSITORY>/` |
| `SUPABASE_PROJECT_REF` | Supabase CLI 專案識別碼 |

## Supabase 部署

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
npx supabase functions deploy gomoku
```

Migration 只建立本遊戲的 `gomoku_games` 與 `gomoku_moves`，不修改其他資料表。兩表啟用 RLS：只有參賽者可讀取；寫入由 Edge Function 的管理 RPC 執行。落子 RPC 會鎖定遊戲列，避免並發請求造成回合錯亂。兩表也已加入 `supabase_realtime` publication。

Edge Function 以登入者 JWT 驗證玩家身份，使用 Supabase runtime 提供的 server-side key；Secret Key 不需複製到前端或 GitHub。專案不使用 `SUPABASE_DB_URL`：此應用透過 Supabase API 存取 PostgreSQL，不直接使用資料庫連線字串。

## API

所有路徑都位於 `VITE_API_BASE` 下，並要求 Supabase 使用者 JWT。

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| `POST` | `/create-room` | 建立房間，建立者執黑 |
| `POST` | `/join-room` | 依 6 位代碼加入，第二位玩家執白 |
| `GET` | `/game?gameId=<uuid>` | 讀取遊戲與落子 |
| `POST` | `/move` | 驗證並提交落子 |
| `POST` | `/rematch` | 建立同一對玩家的新局 |

## GitHub Pages

在 GitHub repository 的 **Settings → Secrets and variables → Actions → Variables** 設定 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`、`VITE_API_BASE`。在 **Settings → Pages** 選擇 **GitHub Actions**，推送到 `main` 即會建置及部署。Workflow 會自動使用 `/<repository>/` 作為 base path。自訂網域或使用者網站請將 workflow 的 `VITE_BASE_PATH` 改為 `/`。

## 本機檢查

```bash
npm test
npm run build
```

測試涵蓋四種連線方向、四連與六連，以及回合、佔位、邊界、遊戲結束和非參賽者的落子檢查。
