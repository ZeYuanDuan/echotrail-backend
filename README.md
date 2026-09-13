# EchoTrail Backend

EchoTrail 的後端服務。

## 技術棧

本專案使用 TypeScript、Node.js 22 與 Fastify 建立 HTTP API。Docker 產生執行映像。

## 雲端架構

服務與 Artifact Registry 位於 GCP project `echotrail-dev-508500-k6` 的 `asia-east1`。`dev` 分支合併後會觸發 Cloud Build。Cloud Build 建置映像、推送至 Artifact Registry，並部署新的 Cloud Run revision。

## 健康檢查

目前服務只提供公開的 `GET /health`。成功時回傳 HTTP 200 與 `{"status":"ok"}`。它不連線資料庫、LLM 或其他外部服務。

## 本機開發

需要 Node.js 22。執行下列指令啟動服務並驗證端點：

```bash
npm ci
npm test
npm run build
npm start
curl --fail http://127.0.0.1:8080/health
```

## 開發注意事項

- 將改動透過 Pull Request 合併到 `dev`。不要在未驗證的分支變更部署設定。
- Cloud Build 使用 commit SHA 作為映像標籤。Cloud Run revision 會固定使用該次部署的映像版本。
- 若部署因 IAM 失敗，請由 project 管理員檢查 Cloud Build trigger 使用的服務帳號權限。不要使用本機 `gcloud` CLI 或服務帳號金鑰繞過權限。
- 新增公開路由前，先確認認證與授權需求。`/health` 是目前唯一允許公開存取的端點。
