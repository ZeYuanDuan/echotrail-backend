# Cloud SQL 設定（GCP Console）

本文件對應 `cloudbuild.yaml` 中的 Cloud Run 連線設定。它只準備 PostgreSQL 與 Cloud Run 的連線通道；目前後端沒有資料庫程式碼，完成這些步驟後仍不會儲存事件。

## 固定名稱

- GCP project：`echotrail-dev-508500-k6`
- Cloud Run service：`echotrail-backend`，區域 `asia-east1`
- Cloud SQL PostgreSQL instance ID：`echotrail-postgres`
- Instance connection name：`echotrail-dev-508500-k6:asia-east1:echotrail-postgres`
- 應用程式資料庫：`echotrail`
- Cloud Run 執行身分：`echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com`

若 instance ID 選用別的名稱，須在首次部署前同步修改 `cloudbuild.yaml` 的 `--add-cloudsql-instances` 值。Cloud SQL 建立完成後，請以 Overview 上的 **Connection name** 核對完整值。

## Console 步驟

1. 在 Console 切到 `echotrail-dev-508500-k6`，確認專案已啟用計費。到 **APIs & Services → Library** 啟用 **Cloud SQL Admin API**。
2. 到 **Cloud SQL → Create instance → Choose PostgreSQL**。將 instance ID 設為 `echotrail-postgres`，區域選 `asia-east1`；PostgreSQL 版本選 Console 目前支援的版本，並記錄所選版本。先檢視 Console 顯示的預估費用，再依 Demo 可接受的費用與可用性需求選擇機型及單區或高可用設定。
3. 在建立頁確認連線方式。此部署設定使用 Cloud Run 內建的 Cloud SQL 連線與 Unix socket；對 MVP 可先採預設的 public IP 路徑，無需把資料庫密碼或 IP 寫入 Git。若決定僅使用 private IP，先完成 Cloud Run 的 VPC egress 與 Cloud SQL 私網設定，再部署。確認自動備份與保留設定符合資料保留需求，然後建立 instance。
4. 在 instance 的 **Databases → Create database** 建立 `echotrail`。不要把應用資料放進預設 `postgres` 資料庫。
5. 到 **IAM & Admin → IAM**，為上述 Cloud Run **執行身分**授予 **Cloud SQL Client** (`roles/cloudsql.client`)。這是應用執行時的身分，不是 Cloud Build 部署身分。
6. 確認 instance 的 Overview 顯示的 Connection name 與上方一致後，才讓 backend Cloud Build trigger 執行更新後的 `cloudbuild.yaml`。在 **Cloud Run → echotrail-backend → Revisions** 確認新 revision 就緒，並在其 Cloud SQL connections 設定看到該 instance。`GET /health` 只能驗證服務啟動，不能證明資料庫可讀寫。

## 接上資料庫程式碼時

- 建立專用 PostgreSQL 帳號與必要的資料庫權限，勿讓應用使用 `postgres` 管理帳號。Cloud SQL Console 建立的 built-in 使用者預設可能取得 `cloudsqlsuperuser`；在決定資料表遷移與權限策略時，一併處理最小權限。
- 把資料庫密碼放在 Secret Manager，授予 Cloud Run 執行身分對該 secret 的 **Secret Manager Secret Accessor**，再透過 Cloud Run secret 環境變數提供給後端；不要放入 `cloudbuild.yaml`、前端或 Git。應用連線的 socket 目錄為 `/cloudsql/echotrail-dev-508500-k6:asia-east1:echotrail-postgres`。
- 後端加入實際資料庫連線、migration 及可驗證的讀寫路徑後，再以測試使用者寫入一筆事件、重新載入、讀回同一筆，並確認 My Trail 與 Dashboard 只讀該使用者資料。

參考：[建立 PostgreSQL instance](https://docs.cloud.google.com/sql/docs/postgres/create-instance)、[建立資料庫](https://docs.cloud.google.com/sql/docs/postgres/create-manage-databases)、[Cloud Run 連接 Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)、[Cloud Run 管理 secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)。
