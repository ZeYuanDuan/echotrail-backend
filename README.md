# EchoTrail Backend

EchoTrail 的後端服務。

## 技術棧

本專案使用 TypeScript、Node.js 22 與 Fastify 建立 HTTP API。Docker 產生執行映像。

## 雲端架構

服務與 Artifact Registry 位於 GCP project `echotrail-dev-508500-k6` 的 `asia-east1`。`dev` 分支合併後會觸發 Cloud Build。Cloud Build 建置並推送映像，執行版本化 migration job 並等待成功後，才部署新的 Cloud Run revision。

Cloud SQL PostgreSQL 的部署前檢查與 Cloud Run 連線設定見 [Cloud SQL 設定](docs/cloud-sql-setup.md)。

## API

- `GET /health`：公開健康檢查。
- `POST /api/llm/chat`：接收交替的多輪對話，回傳艾可的下一則回覆。
- `POST /api/llm/insight`：從完整對話產生 grounded Echo Card 與事件層級框架訊號，不產生 Dashboard profile。
- `POST /api/users`：以正規化暱稱查找或建立展示使用者，回傳 `{id,name}`。
- `POST /api/events`：確認卡片，原子寫入事件、洞見、對話片段及訊號；新建為 201，冪等重試為 200。
- `GET /api/events?userId=<uuid>`：依資料庫 `created_at,id` 順序讀取該使用者的已確認事件。
- `POST /api/dashboard/rebuild`：以 `{userId}` 明確要求全量重算，成功後保存新快照；無事件或來源版本變更為 409。
- `GET /api/dashboard?userId=<uuid>`：只讀取最新成功快照，尚無快照時回傳 `{dashboard:null}`。

暱稱只用於工程展示，**不提供認證**；知道 user ID 的呼叫者可讀取該使用者資料。公開部署前須依產品需求加上真正的認證與授權。卡片預覽不寫入資料庫；確認後 My Trail 可立即讀取，前端會接著重算 Dashboard，失敗時仍保留事件供使用者重試。事件是附加式資料，Dashboard run 是可重算的衍生快照。框架分數目前是訊號強度平均乘 10 的展示預覽，非 C-7～C-9 最終計分。

LLM 路由需要服務端環境變數 `GEMINI_API_KEY`；可用 `GEMINI_MODEL` 覆寫模型。金鑰不得放入前端或提交至 Git。產卡 API 會驗證卡片與每個事件訊號的引證都是使用者原文的連續片段。Dashboard rebuild 會先為已驗證的使用者原文建立 `quoteOptions`，模型只能回傳其中的 `quoteId`，再由後端還原 Persona 與行為模式引文；模型無法直接寫入任意引文。Gemini structured output schema 會在生成階段限制必要欄位、陣列數量、權重及可選 quote ID，後端仍在儲存前執行獨立驗證；可安全修正的超量清單會確定性截斷。格式或 grounding 不合格時會將具體原因回饋給模型，最多修正重試兩次，每次請求使用獨立逾時。

## 本機開發

需要 Node.js 22、PostgreSQL 18。複製環境範例，填入服務端 Gemini 金鑰與 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`，先執行 migration，再啟動服務：

```bash
cp .env.example .env.local
npm ci
npm run build
node dist/migrate.js
npm test
npm run dev
curl --fail http://127.0.0.1:8080/health
```

## 開發注意事項

- 將改動透過 Pull Request 合併到 `dev`。不要在未驗證的分支變更部署設定。
- Cloud Build 使用 commit SHA 作為映像標籤。Cloud Run revision 會固定使用該次部署的映像版本。
- 若部署因 IAM 失敗，請由 project 管理員檢查 Cloud Build trigger 使用的服務帳號權限。不要使用本機 `gcloud` CLI 或服務帳號金鑰繞過權限。
- 目前 Cloud Run service 允許未驗證請求，公開設定涵蓋所有路由；暱稱與 user ID 只提供展示資料分隔，不能證明身分。
