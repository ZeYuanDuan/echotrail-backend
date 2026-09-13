# EchoTrail Backend

「曼陀號 PM x ENG 合作專案 EchoTrail」的後端 Repository。

## 技術選型

本專案採用 **TypeScript + Node.js + Fastify**，並部署至 Cloud Run。

- 與前端共用 TypeScript 生態系，便於維護 API contract 與協作開發。
- 適合處理 LLM 串接與串流回覆等 I/O 密集流程。
- Fastify 內建良好的 schema 驗證、結構化 logging 與 plugin 架構，適合建立可維護的 API。

## 分支規範

- `dev` 會觸發持續部署（Continuous Deployment）。
- 請先將改動推送至個人分支，再透過 Pull Request 合併至 `dev`。

## 首次部署範圍

這個里程碑只提供公開的 `GET /health`。成功時回傳 HTTP 200 與：

```json
{"status":"ok"}
```

它不會連線資料庫、LLM 或其他外部服務，也不包含登入或業務 API。

## Local development

需要 Node.js 22 LTS。安裝依賴、執行測試與啟動服務：

```bash
npm ci
npm test
npm run build
npm start
curl --fail http://127.0.0.1:8080/health
```

服務預設監聽 `0.0.0.0:8080`；若平台提供 `PORT` 環境變數，會優先使用該值。

## Docker validation

```bash
docker build --tag echotrail-backend:local .
docker run --rm --publish 8080:8080 echotrail-backend:local
curl --fail http://127.0.0.1:8080/health
```

第二個指令會持續執行；請在另一個終端呼叫 `curl`，完成後以 `Ctrl-C` 停止容器。

## Manual Google Cloud Console deployment

這是首次手動部署流程；目前**不**建立 GitHub branch 的 push、pull request 或 tag trigger，也不使用本機 `gcloud` CLI。

1. 以公司帳號登入 [Google Cloud Console](https://console.cloud.google.com/)，選擇 project `echotrail-dev-508500-k6`。
2. 依 Console 提示啟用 Cloud Build、Artifact Registry 與 Cloud Run API。
3. 開啟 **Artifact Registry → Repositories**。若 `echotrail` 不存在，選擇 **Create repository**，填入：
   - Name: `echotrail`
   - Format: **Docker**
   - Mode: **Standard**
   - Location type: **Region**
   - Region: **asia-east1**
4. 在 **Cloud Build** 建立或執行一個**人工觸發**的 build，來源為本 repository 的指定 revision，設定檔選 repository 根目錄的 `cloudbuild.yaml`。不要設定 push、pull request 或 tag event。等待狀態為 **SUCCESS**，並從結果頁複製輸出的映像 URI。
5. 開啟 **Cloud Run → Services → Deploy container**，選擇 **Deploy one revision from an existing container image**，貼上 Cloud Build 的映像 URI。
6. Service name 填 `echotrail-backend`，Region 選 **asia-east1**，Authentication 選 **Allow public access**，然後建立服務。
7. 部署完成後，在瀏覽器開啟 `<Cloud Run service URL>/health`，確認得到 HTTP 200 與 `{"status":"ok"}`。

Cloud Build 會把映像發布到：

```text
asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:<build-id>
```

若 Console 顯示缺少權限，請向公司 project 管理員申請，不要以個人帳號、服務帳號金鑰、Cloud Shell 或本機 `gcloud` CLI 繞過權限。

相關 Console 說明可參考 Google Cloud 官方文件：[建立 Artifact Registry repository](https://cloud.google.com/artifact-registry/docs/repositories/create-repos)、[使用 Cloud Build 建置容器](https://cloud.google.com/build/docs/building/build-containers)、[從既有映像部署 Cloud Run](https://cloud.google.com/run/docs/deploying)。
