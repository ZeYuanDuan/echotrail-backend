# 事件持久化與 Dashboard API 實作計畫

> **供實作代理參考：** 必須使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans，依序完成本計畫各任務。步驟以核取方塊（`- [ ]`）追蹤。

**目標：** 依暱稱使用者保存已確認的 Echo Card，依建立順序提供 My Trail，並只在明確要求重算時儲存完整的 Dashboard 快照。

**架構：** Fastify 路由呼叫 PostgreSQL 儲存層。確認事件時，於同一交易寫入對話、訊息、事件、洞見及有原文證據的訊號。Dashboard 重算會讀取全部已確認洞見，請 Gemini 產生整體敘述，根據保存的訊號聚合圖表，再確認使用者事件版本未變後，發布單一 JSON 快照。

**技術：** Node 22、TypeScript、Fastify 5、`pg`、PostgreSQL、Gemini API、Vitest。

**規格：** `../../../../echotrail-project-management/EchoTrail-MVP-SPEC.md`（同層其他 repository；資料持久化契約、A-5、B-1、C-10）。**前置計畫：** [Cloud Build 資料庫 migration](2026-09-25-cloud-build-migrations.md)。**後續計畫：** `../../../../echotrail-frontend/docs/superpowers/plans/2026-09-25-persisted-echo-flow.md`。

**範圍：** 本計畫只實作已確認卡片與 Dashboard 的持久化 API。A-1／A-2 匯入、A-4 收斂規則、A-5「Please Generate my insight」特殊指令、B-2 與既有 Persona 的匹配分數，以及 C-7～C-9 最終計分規則，仍須依產品規格另外規劃；目前的 `/api/llm/insight` 繼續提供預覽。

## 全域限制

- 暱稱對應一筆穩定的 `users.id`；這是一次性展示，不要求身分驗證。
- 未確認的 Echo Card 只是預覽，不建立 `events` 或 `event_insights` 資料列。
- 確認卡片時，以單一交易寫入一筆事件及一筆洞見；更新 Dashboard 前，My Trail 就能讀到。
- 一段對話可確認多張卡片。每次確認只上傳這張卡片新增的對話片段；後端將片段接在同一 `conversation_id` 的訊息末尾，並在事件記錄其訊息序號範圍。
- `events.created_at` 由 PostgreSQL 產生。排序為 `created_at ASC, id ASC`；不儲存事件發生時間，也不從敘述推算日期。
- 重算讀取該使用者**全部**已確認洞見。Dashboard GET 只讀取最新成功保存的 `dashboard_runs`，不呼叫 Gemini。
- 重算失敗或過程中新增卡片時，保留先前成功的快照。
- C-7／C-8／C-9 聚合規則尚未拍板時，框架分數明確標為展示預覽；保留證據並將聚合函式獨立封裝。

## 審查重點

1. 相同 `clientEventId` 因回應遺失而重試：回傳原事件，不重複寫入訊息、洞見、訊號，也不增加版本。
2. 同一裝置切換兩位使用者：事件與 Dashboard 查詢都只回傳指定使用者的資料。
3. 兩筆事件有相同資料庫時間戳：以 `id` 作為次要排序鍵，My Trail 順序保持穩定。
4. Gemini 重算期間確認新卡片：以 409 拒絕過時結果，保留舊快照，讓使用者重試。
5. Gemini 回傳格式錯誤或沒有原文依據的 Dashboard 證據：拒絕重算並保留舊快照。
6. 同一段對話確認第二張卡片：四則訊息只存四列，兩張卡片各自指向自己的訊息範圍，引用不得跨到前一張卡片的片段。

---

## API 契約與檔案分工

| 檔案 | 職責 |
| --- | --- |
| `src/persistence/types.ts` | 路由、服務與測試共用的請求／回應型別。 |
| `src/persistence/validate.ts` | 驗證暱稱、UUID、卡片、訊號及引用原文。 |
| `src/persistence/repository.ts` | SQL 交易與依使用者範圍限制的讀寫。 |
| `src/persistence/dashboard.ts` | 整體摘要的輸入資料與確定性的訊號聚合。 |
| `src/persistence/routes.ts` | HTTP 狀態碼映射與路由註冊。 |
| `src/llm.ts` | Gemini 整體 Dashboard 摘要方法及輸出驗證。 |
| `src/app.ts`、`src/server.ts` | 註冊路由，注入並關閉資料庫連線池。 |
| `test/persistence-routes.test.ts`、`test/dashboard-rebuild.test.ts` | 真實測試資料庫 API 與版本衝突案例。 |

對外使用 camelCase JSON，SQL 使用 snake_case。所有 ID 均為 UUID 字串。路由：

```ts
POST /api/users                  { name: string } -> 200 { id: string, name: string }
POST /api/events                 { userId: string, clientEventId: string, conversationId: string,
                                   messages: { role: 'user' | 'model', text: string }[],
                                   card: { title: string, happen: string[], emotion: string,
                                           like: string, dislike: string, value: string, quote: string },
                                   editedFields: Array<'title'|'happen'|'emotion'|'like'|'dislike'|'value'|'quote'>,
                                   signals: InsightSignal[] }
                                  -> 201（新建）或 200（冪等重試） EventRecord
GET /api/events?userId=<uuid>    -> 200 { events: EventRecord[] }
POST /api/dashboard/rebuild      { userId: string } -> 200 DashboardSnapshot
GET /api/dashboard?userId=<uuid> -> 200 { dashboard: DashboardSnapshot | null }
```

`messages` 是本次卡片新增的非空對話片段，不是整段累積逐字稿；前端在開始對話時產生穩定的 `conversationId` UUID，續談時沿用，按 `+New` 才換新 ID。本次 API 只接受 `source='conversation'` 的聊天事件；schema 中可選的 `conversation_id` 保留給未來匯入來源。`EventRecord = { id, userId, conversationId, messageStartSeq, messageEndSeq, createdAt, source, card, signals }`。`DashboardSnapshot = { id, userId, createdAt, sourceRevision, sourceEventCount, profile, frameworks }`；`profile` 沿用 `InsightResult['dashboard']` 型別；`frameworks` 包含 `scores: Record<'riasec'|'disc'|'schein', Record<string,number>>` 及 `evidence: Array<{eventId,eventTitle,framework,dimension,strength,evidenceQuote}>`。尚無 Dashboard 時回傳 `null`。`POST /api/dashboard/rebuild` 若沒有事件則回傳 409；使用者不存在回傳 404；輸入無效回傳 400；來源版本過時回傳 409；Gemini 失敗時沿用目前 LLM 錯誤狀態碼。前端須顯示可重試的錯誤，不得直接跳轉。

### 任務 1：暱稱使用者與資料庫接線

**檔案：** 新增 `src/persistence/types.ts`、`src/persistence/validate.ts`、`src/persistence/repository.ts`、`src/persistence/routes.ts`、`test/persistence-routes.test.ts`；修改 `src/app.ts`、`src/server.ts`。

**介面：** `registerPersistenceRoutes(app: FastifyInstance, deps: { pool: Pool; llm: LlmClient }): void`；`upsertUser(pool: Pool, name: string): Promise<{id:string;name:string}>`；`buildApp({logger,llm,pool})` 可注入測試連線池。

- [ ] **步驟 1：使用 migration 計畫任務 1 的 `test/database.ts`，先寫測試。** `test/persistence-routes.test.ts` 建立自己的暫時性資料庫並先套用 `001` migration；另一個測試檔不得共用它。分別以 `{name:'  小美  '}` 與 `{name:'小美'}` 呼叫 `POST /api/users`，確認 UUID 相同、顯示名稱與正規化名稱正確，`小華` 取得不同 ID。去除頭尾空白後的空名稱或超過 80 字，應回傳 400。正式 `server.ts` 若缺資料庫設定，啟動須失敗；既有 LLM 單元測試可不注入 pool，此時 `buildApp` 不註冊持久化路由。

```ts
const first = await app.inject({ method: 'POST', url: '/api/users', payload: { name: '  小美  ' } });
const second = await app.inject({ method: 'POST', url: '/api/users', payload: { name: '小美' } });
expect(first.json().id).toBe(second.json().id);
```

- [ ] **步驟 2：執行 `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/persistence-routes.test.ts`；預期 `/api/users` 回傳 404。**
- [ ] **步驟 3：實作驗證與 UPSERT。** 統一以 `name.trim().normalize('NFKC').toLowerCase()` 正規化。執行 `INSERT INTO users(id,display_name,normalized_name) VALUES($1,$2,$3) ON CONFLICT(normalized_name) DO UPDATE SET normalized_name=EXCLUDED.normalized_name RETURNING id,display_name`。路由將有型別的驗證錯誤轉成 400。`server.ts` 必須用 `createPool()` 建立連線池、傳給 `buildApp` 並在關閉時釋放；`buildApp` 僅在提供 pool 時註冊持久化路由，維持既有 LLM 路由測試可獨立執行。

```ts
const normalized = name.trim().normalize('NFKC').toLowerCase();
if (!normalized || normalized.length > 80) throw new InputError('請輸入 1 到 80 字的名稱。');
const { rows } = await pool.query('INSERT INTO users(id,display_name,normalized_name) VALUES($1,$2,$3) ON CONFLICT(normalized_name) DO UPDATE SET normalized_name=EXCLUDED.normalized_name RETURNING id,display_name', [randomUUID(), name.trim(), normalized]);
```

- [ ] **步驟 4：執行本任務及既有 LLM 路由測試；預期通過。** `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/persistence-routes.test.ts test/llm-routes.test.ts`。
- [ ] **步驟 5：提交。** `git add src/persistence src/app.ts src/server.ts test/persistence-routes.test.ts && git commit -m "feat: add named users and database wiring"`。

### 任務 2：原子性確認 Echo Card 與依時間排序的 Trail API

**檔案：** 修改 `src/persistence/types.ts`、`src/persistence/validate.ts`、`src/persistence/repository.ts`、`src/persistence/routes.ts`、`test/persistence-routes.test.ts`。

**介面：** `confirmEvent(pool: Pool, input: ConfirmEventInput): Promise<{created:boolean;event:EventRecord}>`；`listEvents(pool: Pool,userId:string): Promise<EventRecord[]>`。`ConfirmEventInput` 與 API 契約中的 `POST /api/events` payload 完全一致。

- [ ] **步驟 1：先寫失敗測試。** 確認一張卡後，`events` 與 `event_insights` 各應新增一列；訊息順序與有原文依據的訊號正確，版本值為 1。以相同客戶端事件 ID 重試時應回傳 200、同一事件、版本仍為 1；同一 ID 但卡片內容改變應回傳 409。相同 `conversationId` 再確認第二張卡時，只追加第二片段的訊息，事件範圍分別為 `1–2`、`3–4`，第一張卡的使用者原文不能充當第二張卡的證據；兩筆事件共用對話 ID，版本值為 2。UUID 格式錯誤、空片段、引用不在本事件使用者原文中、訊號證據不在本事件原文中或使用者不存在時，須回傳錯誤且不寫入。建立兩位使用者，驗證跨使用者讀取為空。於測試資料庫插入 `created_at` 相同的兩筆事件，確認 `GET /api/events` 符合 `ORDER BY created_at,id`。不得有 occurred-at 欄位或推算日期。

```ts
const saved = await app.inject({ method: 'POST', url: '/api/events', payload: validEvent });
expect(saved.statusCode).toBe(201);
const retry = await app.inject({ method: 'POST', url: '/api/events', payload: validEvent });
expect(retry.statusCode).toBe(200);
expect(retry.json().id).toBe(saved.json().id);
```

- [ ] **步驟 2：執行聚焦測試；預期兩個新路由回傳 404。** `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/persistence-routes.test.ts`。
- [ ] **步驟 3：實作驗證。** 重用 `parseMessages({messages}, false)` 檢查本事件片段的角色交替及長度；不把累積逐字稿塞進單一事件請求。驗證卡片文字與 `happen` 的限制；每筆訊號的 `evidenceQuote` 必須是本事件片段某則 `role:'user'` 訊息的連續片段。從 `src/llm.ts` 抽出共用的維度與強度白名單。`card.quote` 也須符合本事件原文，除非 `editedFields` 含 `'quote'`；此時記錄 `quote_source='user_edit'`，並於後續 Dashboard grounding 檢查中納入這段使用者自行編輯的文字。`editedFields` 只能包含七個允許的欄位名稱。相同冪等鍵若對應不同標準化請求 JSON 的 SHA-256，應拒絕。
- [ ] **步驟 4：以單一交易實作寫入。** 先查 `(user_id,client_event_id)`，只有請求雜湊相符時才回傳既有事件。否則執行 `BEGIN`，以 `(id,user_id)` 插入對話（`ON CONFLICT DO NOTHING`），再以 `SELECT ... FOR UPDATE` 鎖定同使用者的對話列；若該 UUID 屬於別人則回傳 409。讀取 `MAX(seq)`，把本次片段逐則接在末尾，事件寫入 `message_start_seq=舊最大序號+1` 與 `message_end_seq=新最大序號`，再寫入 `request_hash`、洞見及訊號，執行 `UPDATE users SET insight_revision=insight_revision+1 WHERE id=$1`，最後 `COMMIT`。同一對話的併發寫入須由列鎖序列化；同一客戶端事件 ID 的唯一鍵競態時回滾，依 `(user_id,client_event_id)` 查既有事件並比較雜湊。重試不得增加版本。所有使用者輸入均以參數傳入 SQL。清單查詢 join `events`、`event_insights`、訊號，限制 `WHERE e.user_id=$1 ORDER BY e.created_at ASC,e.id ASC`；將資料庫 `timestamptz` 映射為 ISO 字串。

```sql
SELECT e.id,e.user_id,e.conversation_id,e.message_start_seq,e.message_end_seq,e.title,e.source,e.created_at,i.happen,i.emotion,i.likes,i.dislikes,i.value_claim,i.quote
FROM events e JOIN event_insights i ON i.event_id=e.id
WHERE e.user_id=$1 ORDER BY e.created_at ASC,e.id ASC;
```

- [ ] **步驟 5：執行測試、`npm run build`，並對暫時性 PostgreSQL 做手動 POST／GET 冒煙測試；重新啟動應用後資料仍須存在。** `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/persistence-routes.test.ts && npm run build`。
- [ ] **步驟 6：提交。** `git add src/persistence migrations test/persistence-routes.test.ts && git commit -m "feat: persist confirmed cards and serve trail"`。

### 任務 3：整體 Dashboard 摘要與已保存快照

**檔案：** 修改 `src/llm.ts`、`src/persistence/types.ts`、`src/persistence/dashboard.ts`、`src/persistence/repository.ts`、`src/persistence/routes.ts`；新增 `test/dashboard-rebuild.test.ts`。

**介面：** `LlmClient.synthesizeDashboard(evidence: DashboardEvidence[]): Promise<InsightResult['dashboard']>`；`rebuildDashboard(pool,llm,userId): Promise<DashboardSnapshot>`；`getLatestDashboard(pool,userId): Promise<DashboardSnapshot|null>`；`aggregateSignals(signals): DashboardSnapshot['frameworks']`。

- [ ] **步驟 1：先寫失敗測試。** `test/dashboard-rebuild.test.ts` 透過 `test/database.ts` 建立自己的暫時性資料庫，套用 migration 後分別保存使用者 A 與 B 的事件。重算 A 時，LLM 輸入應包含 A 的全部已確認洞見且不含 B；`dashboard_runs` 只新增一列，`source_event_count=2`；重啟應用後 GET 回傳相同 JSON，重複 GET 不得呼叫 LLM。控制 LLM 拋錯時，舊快照仍存在；LLM Promise 尚未完成時確認一筆新事件，再讓 Promise 完成，重算須回傳 409 且不新增版本。格式錯誤或缺乏原文依據的引用也不得新增版本。測試確定性分數、沒有訊號的維度，以及證據中的事件標題與 ID。

```ts
expect(llm.synthesizeDashboard).toHaveBeenCalledWith(expect.arrayContaining([
  expect.objectContaining({ eventId: firstEventId }),
  expect.objectContaining({ eventId: secondEventId }),
]));
expect((await app.inject({ method: 'GET', url: `/api/dashboard?userId=${userId}` })).json().dashboard.id).toBe(runId);
```

- [ ] **步驟 2：執行 `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/dashboard-rebuild.test.ts`；預期因路由或方法尚不存在而失敗。**
- [ ] **步驟 3：擴充 Gemini client。** 在 `LlmClient` 與所有既有測試 stub 加入 `synthesizeDashboard()`。送出結構化 JSON prompt，包含每筆已確認事件的標題、六個欄位、引用原文與保存訊號；要求沿用 `DashboardProfile` 格式，只使用整體歷史資料的證據，不捏造事實。用全部已保存使用者訊息或使用者自行編輯的卡片證據驗證 persona／pattern 引用。格式錯誤時拋出 `LlmError(502,...)`。不能把原本逐事件的 `result.dashboard` 當成最後聚合結果。
- [ ] **步驟 4：聚合訊號並發布。** 每個框架／維度的分數為訊號強度算術平均乘 10、四捨五入並限制在 0–100（目前展示預覽規則）。缺少訊號的維度存 0，並保留每筆訊號的事件來源、標題與引用。呼叫 Gemini 前讀取使用者的 `insight_revision` 及全部相關資料。Gemini 回傳後開啟交易，以 `FOR UPDATE` 鎖定 `users` 列並比較版本；不同則 `ROLLBACK`、回傳 409。相同則將 profile 與框架聚合結果一起寫入一筆 `dashboard_runs`。GET 使用 `WHERE user_id=$1 ORDER BY id DESC LIMIT 1`，無資料時回傳 `null`，不得重新呼叫模型。

```sql
SELECT insight_revision FROM users WHERE id=$1 FOR UPDATE;
INSERT INTO dashboard_runs(user_id,source_revision,source_event_count,result)
VALUES($1,$2,$3,$4::jsonb) RETURNING id,created_at;
```

- [ ] **步驟 5：執行聚焦測試、完整後端測試與建置；預期通過。** `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test && npm run build`。驗證新增事件不會改變舊 GET 快照，直到 POST 重算成功；重新載入後能取得已保存的新快照。
- [ ] **步驟 6：提交。** `git add src/llm.ts src/persistence test/dashboard-rebuild.test.ts && git commit -m "feat: rebuild and persist dashboard snapshots"`。

### 任務 4：文件與部署冒煙驗證

**檔案：** 修改 `README.md`、`docs/cloud-architecture.md`、`docs/cloud-sql-setup.md`。

**介面：** 對前端實作發布五個持久化 API 路由及兩階段使用流程。

- [ ] **步驟 1：按上述精確 API 契約、使用者可見流程、`insight_revision` 衝突處理、目前預覽分數規則與暫時性暱稱的操作冒煙指令更新文件。** 移除「後端沒有資料庫讀寫」的過時敘述。說明暱稱只是展示識別、歷史資料列採附加式保存，Dashboard run 是衍生快照。
- [ ] **步驟 2：對照 API 整合結果檢查文件並執行 `git diff --check`，再提交。** `git add README.md docs/cloud-architecture.md docs/cloud-sql-setup.md && git commit -m "docs: describe persisted event and dashboard APIs"`。

## 自我檢查與交接

六項審查重點均由任務 2 或 3 的測試涵蓋。API 契約是前端計畫的交接邊界。Migration 計畫負責資料表與 Cloud Build，必須先完成。產品規格尚未決定 C-7／C-8／C-9 分數公式，因此維持明確標示的預覽；聚合函式獨立封裝，之後決策只需改一處，若資料形狀改變才建立新 migration。
