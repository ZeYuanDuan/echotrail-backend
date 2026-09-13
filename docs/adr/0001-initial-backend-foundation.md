# ADR 0001：後端最小部署基線

- Status: Accepted，2026-09-13 修訂
- Date: 2026-09-13

## 目標與限制

EchoTrail Backend 的第一個里程碑是用 TypeScript、Node.js、Fastify 與 Docker 建立可部署至 Cloud Run 的最小服務，並用公開健康檢查驗證建置、啟動及 HTTP 連線。

登入、資料模型、LLM 與 Dashboard 規則尚未定案，因此本 ADR 不預先把它們寫進程式。

## 修訂決策：`dev` 自動部署

2026-09-13 起，`dev` 分支的變更會觸發 Cloud Build。Cloud Build 以 commit SHA 建置及推送 Docker 映像，然後部署 `asia-east1` 的 Cloud Run service `echotrail-backend`。

Cloud Build trigger 使用的服務帳號必須取得 Cloud Run 部署權限，以及 Cloud Run 執行身分的 Service Account User 權限。此設定由公司帳號在 Google Cloud Console 管理。本機不使用 `gcloud` CLI。

公開存取僅用於目前的 `GET /health`。新增其他路由前，必須重新確認服務的存取控制。

## 閱讀方式

以下 Q01–Q05 為此基線的子問題。選項字母只表示呈現順序，**不表示推薦程度**；已選決策一律同時列出選項字母與完整方案名稱。本 ADR 刻意讓已選方案分散在 B、C、B、C、B，避免字母位置造成錨定。

## Q01：首次建置與部署途徑

### 選項 A：Cloud Run Console 從原始碼直接部署

- 做法：交由 Cloud Run 的原始碼部署流程建置與發布。
- 優點 / 代價：最快取得服務 URL；實際建置流程不一定等同未來要驗證的 Docker／Cloud Build 路徑。
- 關鍵假設：平台建置器符合目前 Node.js 專案需求。
- 可逆性 / 成本：雙向門；數十分鐘至數小時。

### 選項 B：Cloud Build 手動觸發，再以映像部署 Cloud Run

- 做法：repository 納入 `Dockerfile` 與 `cloudbuild.yaml`；從 Console 手動執行 Cloud Build，輸出映像到 Artifact Registry，再在 Cloud Run Console 選取映像建立服務。
- 優點 / 代價：完整驗證 Docker 與未來 CI/CD 的建置路徑；首次需要連接原始碼、建立映像倉庫與啟用服務。
- 關鍵假設：公司 GCP project 可使用 Cloud Build、Artifact Registry 與 Cloud Run。
- 可逆性 / 成本：雙向門；數小時。

### 選項 C：本機 Docker 建置並推送映像

- 做法：在本機建置 Docker 映像、推送 Artifact Registry，然後在 Console 部署。
- 優點 / 代價：本機 Docker 除錯直觀；需要 `gcloud` 帳號與 Artifact Registry 驗證，與 Console 優先的偏好不符。
- 關鍵假設：本機 Docker 與 GCP CLI 均已正確設定。
- 可逆性 / 成本：雙向門；數小時。

**原始決策：選項 B — Cloud Build 手動觸發，再以映像部署 Cloud Run。** 此決策已由「修訂決策：`dev` 自動部署」取代。現行流程由 `dev` trigger 建置、推送並部署 Cloud Run。

## Q02：區域與 Artifact Registry

Cloud Run 與 Docker Artifact Registry 應位於同一區域，避免跨區映像取得與額外管理複雜度。

### 選項 A：公司既有核准區域

- 優點 / 代價：最符合既有 IAM、網路、稽核與資料政策；可能增加台灣使用者延遲。
- 關鍵假設：公司已有指定區域。
- 可逆性 / 成本：雙向門；數小時。

### 選項 B：`asia-northeast1`（東京）

- 優點 / 代價：是常見亞太替代區域；比台灣更遠，若沒有相依服務或公司政策優勢，不應只因慣例選擇。
- 關鍵假設：該區域具有實際營運優勢。
- 可逆性 / 成本：雙向門；數小時。

### 選項 C：`asia-east1`（台灣）

- 優點 / 代價：接近團隊與可能的首批使用者，設定單純；須確認公司政策與未來相依服務允許此區域。
- 關鍵假設：公司 project 允許 `asia-east1`。
- 可逆性 / 成本：雙向門；數小時。

**已決定：選項 C — `asia-east1`（台灣）。** 所有首次部署資源均位於 `asia-east1`；Docker Artifact Registry repository 採用 `echotrail`。若 repository 尚未存在，會在 Console 部署流程中建立。

## Q03：執行環境與工具鏈

### 選項 A：目前較新的 Node.js LTS

- 優點 / 代價：維護週期可能更長；需多驗證 Docker、套件與團隊環境相容性。
- 關鍵假設：所有環境都驗證該版本。
- 可逆性 / 成本：雙向門；數小時至一天。

### 選項 B：Node.js 22 LTS、npm、TypeScript 嚴格模式

- 優點 / 代價：成熟且可重現，適合首次降低變因；之後需要另行評估 runtime 升級。
- 關鍵假設：團隊沒有衝突的公司 runtime 基線。
- 可逆性 / 成本：雙向門；數小時。

### 選項 C：不鎖定 Node.js 次版本

- 優點 / 代價：初始設定最少；本機、Cloud Build 與 Cloud Run 無法保證一致，不建議。
- 關鍵假設：平台永遠維持相容 runtime；此假設不可靠。
- 可逆性 / 成本：短期數十分鐘，長期除錯成本不確定。

**已決定：選項 B — Node.js 22 LTS、npm、TypeScript 嚴格模式。** Docker、開發文件與 Cloud Build 均固定 Node.js 22 LTS、npm lockfile、TypeScript `strict` 與 Fastify。

## Q04：GCP project 與操作身分

### 選項 A：個人 sandbox project 先試跑

- 優點 / 代價：可先驗證技術路徑；會有第二次部署，且不可放公司機密、使用者資料或正式憑證。
- 關鍵假設：組織允許 sandbox，且後續會部署到公司 project。
- 可逆性 / 成本：雙向門；數小時加一次遷移。

### 選項 B：本機 `gcloud` CLI 直接操作

- 優點 / 代價：可腳本化；不符合 Console 優先，也有誤用 active project 的風險。
- 關鍵假設：本機 active account 與 project 已仔細核對。
- 可逆性 / 成本：雙向門；數小時。

### 選項 C：公司受管 project，以公司帳號在 Console 操作

- 優點 / 代價：帳務、資源所有權、IAM 與日後 CI/CD 均在團隊邊界；可能需要管理員授權。
- 關鍵假設：可取得 Cloud Run、Cloud Build、Artifact Registry 所需權限。
- 可逆性 / 成本：雙向門；數十分鐘至數天，取決於權限流程。

**已決定：選項 C — 公司受管 project，以公司帳號在 Console 操作。** 目標 Project ID 為 `echotrail-dev-508500-k6`。本階段不允許使用或切換本機 `gcloud` CLI 帳號；所有首次測試資源均在該 project 建立。

## Q05：第一次服務範圍與健康檢查

### 選項 A：加入 readiness／版本維運端點

- 優點 / 代價：未來觀測性界線較清楚；現在沒有相依服務時，端點語意容易成為空殼。
- 關鍵假設：平台或團隊已有具體監控需求。
- 可逆性 / 成本：雙向門；數小時。

### 選項 B：只提供公開 `/health`

- 優點 / 代價：最能隔離部署問題，驗證最快；前端尚不能串接真實產品功能。
- 關鍵假設：本輪成功定義是服務建置、啟動與公開 HTTP 連線。
- 可逆性 / 成本：雙向門；數小時。

### 選項 C：預建登入、資料庫與業務 API 空框架

- 優點 / 代價：看似為未來省時；目前登入與資料模型未定，會把猜測固化成程式並拖慢部署。
- 關鍵假設：工程端可安全補完未定產品規格；此假設不成立。
- 可逆性 / 成本：部分雙向門；數天以上。

**已決定：選項 B — 只提供公開 `/health`。** `GET /health` 允許未驗證存取，建議回傳 HTTP 200 與最小 JSON `{"status":"ok"}`。它不連資料庫、不呼叫 LLM、不建立登入或業務路由，且不得回傳機密、使用者資料或內部依賴資訊。

若部署後無法取得 200，優先檢查 Cloud Run `PORT`、Docker 啟動命令、build log 與 IAM；不要增加資料庫或認證邏輯來掩蓋問題。

## 尚待執行前確認

- `asia-east1` 中的 Docker Artifact Registry repository `echotrail` 是否已存在；若不存在，首次 Console 流程建立它。
- `/health` 的最小回應採用 `{"status":"ok"}`。
