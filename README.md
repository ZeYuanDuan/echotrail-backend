# EchoTrail Backend

EchoTrail 的後端服務。

## 技術棧

本專案使用 TypeScript、Node.js 22 與 Fastify 建立 HTTP API。Docker 產生執行映像。

## 雲端架構

服務與 Artifact Registry 位於 GCP project `echotrail-dev-508500-k6` 的 `asia-east1`。`dev` 分支合併後會觸發 Cloud Build。Cloud Build 建置映像、推送至 Artifact Registry，並部署新的 Cloud Run revision。

## API

- `GET /health`：公開健康檢查。
- `POST /api/llm/chat`：接收交替的多輪對話，回傳艾可的下一則回覆。
- `POST /api/llm/insight`：從完整對話產生 grounded Echo Card 與 Dashboard 訊號。

LLM 路由需要服務端環境變數 `GEMINI_API_KEY`；可用 `GEMINI_MODEL` 覆寫模型。金鑰不得放入前端或提交至 Git。產卡 API 會驗證卡片引證與所有圖表訊號的 `evidenceQuote` 都是使用者原文的連續片段，格式或 grounding 不合格時會將失敗 JSON 與具體驗證原因回饋給模型，最多修正重試兩次。

## 本機開發

需要 Node.js 22。複製環境範例、填入服務端 Gemini 金鑰，再啟動服務：

```bash
cp .env.example .env.local
npm ci
npm test
npm run build
npm run dev
curl --fail http://127.0.0.1:8080/health
```

## 開發注意事項

- 將改動透過 Pull Request 合併到 `dev`。不要在未驗證的分支變更部署設定。
- Cloud Build 使用 commit SHA 作為映像標籤。Cloud Run revision 會固定使用該次部署的映像版本。
- 若部署因 IAM 失敗，請由 project 管理員檢查 Cloud Build trigger 使用的服務帳號權限。不要使用本機 `gcloud` CLI 或服務帳號金鑰繞過權限。
- 新增公開路由前，先確認認證與授權需求。`/health` 是目前唯一允許公開存取的端點。
