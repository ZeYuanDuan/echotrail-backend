# Dashboard rebuild 調查（2026-09-25）

## 觀察

- 使用者回報：對話、確認事件與 My Trail 均正常；按「更新至 Dashboard」顯示「Dashboard 模型產出缺少欄位。」
- 此字串只在 `src/llm.ts` 的 `parseDashboardProfile` 最外層檢查產生。JSON 必須已成功解析，但 `persona`、`anchor`、`northStar` 其中一項不是物件，或 `keywords`／`patterns` 其中一項不是陣列。
- `POST /api/dashboard/rebuild` 依序讀取使用者版本、事件及逐字訊息，呼叫 Gemini 產生 profile，驗證後才寫入 `dashboard_runs`。目前錯誤代表執行已到模型輸出驗證，快照尚未寫入。
- Migration `001_initial_schema.sql` 建立事件、訊息、訊號及 `dashboard_runs` 表；Cloud Build 先執行 migration job，成功後才部署 service。My Trail 正常也顯示事件查詢路徑可用。
- Dashboard prompt 要求「結構與單張事件 dashboard 相同」，但單張事件的範例把 profile 放在 `dashboard` 屬性下；重算解析器卻要求五項欄位直接位於最外層。請求使用 `responseMimeType: application/json`，沒有結構化 response schema；Dashboard 專用流程沒有像單張 insight 一樣做格式修正重試。
- 使用者提供的 Cloud Logging 頁面可透過已登入的 Chrome 查看。台灣時間 18:47:15 有一筆 `POST /api/dashboard/rebuild` 回傳 502（約 2.996 秒）；18:49:26 與 18:51:14 的 `GET /api/events` 均回傳 200。該視窗內的 Cloud Run 應用日誌只顯示 `incoming request` 和 `request completed`，沒有 Gemini 原始回應或缺欄位細節。

## 假設

### H1：Gemini 回傳巢狀 `dashboard`（ROOT HYPOTHESIS；實際回應未取得）

- 支持：prompt 的「結構與單張事件 dashboard 相同」可解讀成 `{ "dashboard": { ... } }`；解析器只接受 `{ "persona": ..., ... }`。
- 衝突：沒有實際模型回應，不能證明它這次確實回傳巢狀物件。
- 測試：以等價的巢狀與平面 JSON 呼叫解析器，比較錯誤類型；若只有巢狀物件觸發同一句錯誤，證明此形狀足以重現，但仍需原始回應才能確認是此次線上實例。

### H2：Gemini 回傳平面 JSON，但省略其中一項必要欄位

- 支持：只有自然語言格式指示、未指定 response schema；目前錯誤條件也涵蓋單欄缺漏或陣列型別錯誤。
- 衝突：尚無原始回應，不能辨別缺哪一欄。
- 測試：在後端安全記錄回應的最外層 key 與五個欄位的型別，不記錄使用者文字；重試後對照。

### H3：Migration 或資料庫欄位缺失

- 支持：此功能最近導入持久化與 migration。
- 衝突：此錯誤只可能由模型輸出的 JSON 驗證拋出，且它位於資料庫讀取之後、快照寫入之前；My Trail 也能讀取事件。
- 測試：追蹤呼叫順序並用正常模型 stub 執行現有整合測試；若正常輸出能寫入，排除 migration 是該錯誤的直接原因。

## 實驗

- 唯一變因為 JSON 最外層形狀。在本機呼叫 `parseDashboardProfile`：`{ "dashboard": { "persona": ..., "anchor": ..., "keywords": [], "patterns": [], "northStar": ... } }` 回傳與線上相同的「Dashboard 模型產出缺少欄位。」；將五項欄位移至最外層，則通過此檢查，進入後續「格式或原文驗證」錯誤（測試值故意為空）。H1 可完整重現錯誤字串，但不能證明線上回應確實長這樣。
- `npm test -- test/llm.test.ts test/cloudbuild-migration.test.ts`：2 個測試檔、5 項測試通過。這些測試不會呼叫真實 Gemini，也沒有驗證 Dashboard 專用模型回應。
- 嘗試讀取 Cloud Logging：本機 `gcloud` 提示需要重新驗證且不可於非互動模式進行。未進行登入或憑證操作，因此無法判定實際缺哪個欄位。
- 改從使用者提供的 Cloud Logging Chrome 分頁讀取：確認 `POST /api/dashboard/rebuild` 的 502 與正常的 `GET /api/events` 200；既有日誌沒有模型輸出形狀，無法進一步區分 H1 與 H2。

## 根因

可確認的直接原因：Dashboard 專用 Gemini 回應是有效 JSON，但未滿足後端要求的最外層五項資料契約，故 502 發生於資料庫寫入之前。巢狀 `dashboard` 是由 prompt 歧義支持、且能重現完全相同錯誤的具體候選；實際回應未取得，因此不能斷言這就是線上的精確形狀。Migration 缺失不是此訊息的直接原因。

## 修法

- `src/llm.ts`：明示 Dashboard 回應最外層五欄契約；也接受單層 `dashboard` 包裝的有效 profile（包含舊格式的 `card`、`signals` 旁欄），仍逐項執行格式及原文驗證。
- Dashboard 專用 Gemini 流程在 502 格式／引文驗證失敗時最多修正重試兩次；每次驗證失敗都只記錄固定欄位的型別與錯誤類型，不記錄使用者內容或模型原文，避免後續重試另行失敗時遺失最初的輸出形狀。
- `test/llm.test.ts`：先新增三項失敗測試，覆蓋巢狀回應、缺欄修正重試與安全診斷；再實作修正，確認測試轉綠。完整測試以一次性 PostgreSQL 18 容器執行，8 個測試檔、22 項測試通過；容器已停止並自動移除。
- 線上 Gemini 的精確回應形狀仍未取得；程式修正涵蓋 H1 與 H2 的常見情況。需部署後用原本事件重試，才能確認線上案例已消除。

# 聊天模型逾時調查（2026-09-28）

## 觀察

- Cloud Logging 在 20:31:06、20:31:54、20:33:15、20:33:30、20:34:07（台灣時間）記錄多筆 `POST /api/llm/chat` 504，耗時皆為 25.00～25.01 秒。相同視窗的 `/api/users`、`/api/events` 與 `/api/dashboard` 為 200，耗時約 5～30 毫秒。
- 已登入瀏覽器的 Network 面板另顯示聊天請求 504，耗時 25.13 秒，頁面顯示「模型回覆逾時，請重試。」
- `requestGemini` 在 `src/llm.ts` 對單次 Gemini 呼叫使用 `AbortSignal.timeout(25_000)`；前端 `chatLlm` 等待 30 秒。現有應用日誌沒有 Gemini 上游的回應時間或狀態，無法確定它何時會回應。
- Cloud Run 官方文件表示服務預設請求逾時為 300 秒；Firebase Hosting 到 Cloud Run 的 rewrite 另有 60 秒上限。本例的 25 秒與應用端中止值完全一致。`gcloud` 目前無法在非互動執行環境刷新登入，故以已登入 Cloud Console 與原始碼查證。

## 假設

### H1：應用端 25 秒中止先於 Gemini 回應（ROOT HYPOTHESIS）

- 支持：所有聊天 504 均在 25.00 秒，且訊息與 `requestGemini` 的 timeout 分支一致。
- 衝突：尚無 Gemini 實際完成時間，不能保證延長等待就能成功。
- 測試：以受控延遲的 fetch 模擬第 25 秒後才回應；比較目前與較長 deadline 的聊天結果。

### H2：前端 30 秒 timeout 先行中止

- 支持：前端設有 30 秒上限。
- 衝突：Cloud Run 已回傳 504，耗時 25 秒；Network 面板有 504 回應而非只有 Axios timeout。
- 測試：比較前端 Network 耗時與 Cloud Run HTTP 狀態。

### H3：Cloud Run 或資料庫 25 秒限制

- 支持：錯誤是在 Cloud Run 服務上出現。
- 衝突：其他 API 快速成功；Cloud Run 預設為 300 秒，原始碼明確設 25 秒中止。
- 測試：比對 HTTP latency、應用 `responseTime` 與原始碼 deadline。

## 實驗

- H2、H3 的比對結果：Network 與 Cloud Logging 都記錄後端 504 約 25 秒；資料庫相關 API 同時正常。因此可排除它們是這批聊天 504 的直接發生點。
- H1 的受控延遲實驗：新增測試，以 fake clock 保留 AbortSignal 的中止語意，讓 Gemini 模擬回應在第 26 秒完成。現行 `GeminiClient.chat` 於第 25 秒回傳 `LlmError(504, '模型回覆逾時，請重試。')`；`npm test -- test/llm.test.ts` 顯示該測試紅燈（18 通過、1 失敗），與線上觀察一致。此實驗證明應用中止能直接造成症狀，不代表真實 Gemini 必定在第 26 秒回覆。

## 根因

聊天 API 的單次模型請求被應用固定在 25 秒取消，正是線上多筆 25.00 秒 504 的直接原因。Gemini 上游超過 25 秒的原因與最終耗時，現有日誌無法辨別；因此修正後仍需用線上請求確認是否能在新上限內完成。

## 修法

- 僅將聊天模型呼叫 deadline 延至 50 秒；產卡與 Dashboard 的每次呼叫仍為 25 秒。前端聊天等待上限同步延至 58 秒，避免瀏覽器先中止，並維持在 Firebase Hosting 的 60 秒上限內。
- 後端測試以第 26 秒模型回覆重現修正前 504、修正後成功，並確認第 59 秒的上游回覆會先被應用中止。前端測試以第 52 秒服務回覆重現修正前 Axios 逾時、修正後成功，並確認第 59 秒才抵達的回覆會在 Firebase Hosting 上限之前由前端逾時。兩者均使用 fake clock，不觸及真實 Gemini 或使用者資料。
- 線上驗證待部署後補充；若 Gemini 在 50 秒仍無回應，需透過上游診斷再判斷服務或模型狀態。
