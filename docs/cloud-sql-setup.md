# Cloud SQL：接上 Cloud Run 與 Migration

本專案只使用**一個 PostgreSQL 登入帳號** `echotrail_app`。Cloud Run migration job 和後端 service 都使用現有的 `echotrail-backend-runtime` GCP 服務帳號、同一個資料庫密碼 Secret。這個資料庫帳號可以建立資料表，也可以讀寫應用資料；對一次性的工程展示已足夠。它**不使用**現有的 `postgres` 管理帳號。

## 目前現況（2026-09-25 唯讀 `gcloud` 查詢）

| 項目 | 現況 |
| --- | --- |
| GCP 專案 | `echotrail-dev-508500-k6` |
| Cloud SQL | `echotrail-postgres`，`asia-east1`，PostgreSQL 18，狀態 `RUNNABLE`；連線名稱 `echotrail-dev-508500-k6:asia-east1:echotrail-postgres` |
| 資料庫 | `echotrail` 已建立；登入使用者 `echotrail_app` 已建立。`gcloud sql users list` 無法證明該使用者在 PostgreSQL 內的角色與 schema 權限，須依步驟 1 到 Cloud SQL Studio 查證。 |
| Cloud Run service | `echotrail-backend` 已部署，執行身分為 `echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com`；目前沒有 Cloud SQL 連線設定，環境變數只有既有的 `GEMINI_API_KEY`。 |
| Cloud Build | `asia-east1` 的 `echotrail-backend-build` trigger 監看 `dev`，使用 `echotrail-backend-build@echotrail-dev-508500-k6.iam.gserviceaccount.com`；該身分已有 Cloud Run Admin、Artifact Registry Writer，以及使用現有後端執行身分的權限。 |
| Secret 與 IAM | `echotrail-db-password` 已有一個啟用的版本；現有後端執行身分已有該 Secret 的 Secret Accessor 與專案的 Cloud SQL Client。既有 `echotrail-gemini-api-key` 也有啟用版本。 |
| Migration | 目前雲端尚無 migration job；本分支的 `cloudbuild.yaml` 已加入 runner 與部署門檻，尚未觸發 `dev` 建置。 |

本機 `gcloud` 的預設專案不是 EchoTrail。自行下指令時請明確指定 `--project=echotrail-dev-508500-k6`；Console 右上角也先確認專案。

## 步驟 1：檢查已建立的資料庫帳號

1. Console 選 `echotrail-dev-508500-k6` → **Cloud SQL** → `echotrail-postgres` → **Cloud SQL Studio**。
2. 以資料庫 `echotrail`、使用者 `postgres` 和你建立 instance 時設定的密碼登入。
3. `echotrail_app` 已存在，不要重新建立。先查自訂權限角色是否存在：

```sql
SELECT rolname, rolcanlogin FROM pg_roles
WHERE rolname IN ('echotrail_app', 'echotrail_db_role', 'cloudsqlsuperuser');
```

若缺少 `echotrail_db_role`，才執行下列 SQL **一次**。這個角色只是權限集合，**不是第二個資料庫登入帳號**。

```sql
CREATE ROLE echotrail_db_role NOLOGIN;
GRANT CONNECT ON DATABASE echotrail TO echotrail_db_role;
GRANT USAGE, CREATE ON SCHEMA public TO echotrail_db_role;
```

4. 無論角色剛建立或原本就存在，以下 `GRANT` 都可重複執行；它會確保角色有連線與建表權，並授予現有的 `echotrail_app`：

```sql
GRANT CONNECT ON DATABASE echotrail TO echotrail_db_role;
GRANT USAGE, CREATE ON SCHEMA public TO echotrail_db_role;
GRANT echotrail_db_role TO echotrail_app;
```

若目前已指派 `cloudsqlsuperuser`，這次工程展示仍可執行 migration；若要縮小權限，再到 **Users → echotrail_app → Database roles** 調整。[Cloud SQL 建立使用者說明](https://docs.cloud.google.com/sql/docs/postgres/create-manage-users)。

可回到 Cloud SQL Studio，以 `postgres` 查證結果：

```sql
SELECT pg_has_role('echotrail_app', 'echotrail_db_role', 'member') AS has_db_role,
       pg_has_role('echotrail_app', 'cloudsqlsuperuser', 'member') AS has_cloudsqlsuperuser;
```

至少確認 `has_db_role = true`。`has_cloudsqlsuperuser` 表示是否有額外管理權，這次展示不以它為部署門檻。因為同一個 `echotrail_app` 會建立並持有 migration 產生的表格，它本身就能讀寫那些表，不需要另做預設權限轉授。[Cloud SQL Studio 使用說明](https://docs.cloud.google.com/sql/docs/postgres/manage-data-using-studio)。

## 步驟 2：核對已建立的資料庫密碼 Secret

`echotrail-db-password` 已建立且版本 1 為 `ENABLED`，不需要再建立。到 **Security → Secret Manager → echotrail-db-password** 確認它存的是 `echotrail_app` 目前的密碼；`gcloud` 唯讀查詢只能確認 Secret 版本狀態，不能證明密碼與資料庫一致。不要把密碼寫進 Git、`cloudbuild.yaml` 或前端程式。

現有的 `echotrail-gemini-api-key` 已被後端使用，請保留；不需要為 migration 再建立另一份資料庫密碼。[Cloud Run 使用 Secret Manager](https://docs.cloud.google.com/run/docs/configuring/services/secrets)。

## 步驟 3：核對已授予的 IAM 權限

以下權限已授予**現有**的 `echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com`，不需要重複新增：

| Console 位置 | 授予角色 |
| --- | --- |
| **IAM & Admin → IAM → Grant access** | **Cloud SQL Client** (`roles/cloudsql.client`) |
| **Secret Manager → `echotrail-db-password` → Permissions / Grant access** | **Secret Manager Secret Accessor** (`roles/secretmanager.secretAccessor`) |

Cloud SQL Client 讓 Cloud Run 連到 instance；PostgreSQL 的 `echotrail_app` 帳號才負責登入資料庫。Migration job 和後端 service 都使用同一個 GCP 執行身分，因此只需授權一次。現有 Cloud Build 身分已能使用它，不必新增 migration 服務帳號，也不必再授予 Service Account User。[Cloud Run 連接 Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)。

## 步驟 4：把 migration 接進 Cloud Build

本分支已加入版本化 SQL、runner、Dockerfile 與 Cloud Build 門檻。先完成上述資料庫角色與密碼核對，再透過 PR 合併 `dev` 觸發建置。流程是：

```text
建置並推送同一個映像
  → 建立本次 build 專屬的 Cloud Run migration job（et-mig-$BUILD_ID）
  → job 以 echotrail-backend-runtime + echotrail_app 執行尚未套用的 SQL
  → Cloud Build 等 job 成功（--wait）
  → 部署 echotrail-backend service；同樣使用 echotrail-backend-runtime + echotrail_app
```

Job 和 service 都透過 Cloud SQL Unix socket `/cloudsql/echotrail-dev-508500-k6:asia-east1:echotrail-postgres` 連線；兩者的 `PGUSER` 都是 `echotrail_app`，`PGPASSWORD` 都從 `echotrail-db-password` Secret 注入。後端部署時要保留原本的 `GEMINI_API_KEY` Secret，加入資料庫 Secret 時使用 `--update-secrets`。若 migration 失敗，Cloud Build 必須停止，不能繼續部署新 service。不要手動把 migration SQL 貼到 Cloud SQL Studio 執行，否則會繞過版本紀錄。

## 步驟 5：部署後確認

1. **Cloud Build → History**：確認順序為建置、推送、migration job 執行成功、部署 service。
2. **Cloud Run → Jobs**：確認本次 `et-mig-...` execution 成功。失敗時先看 job log；舊 service 應仍可使用。
3. **Cloud SQL Studio**：登入 `echotrail`，執行 `SELECT version, applied_at FROM schema_migrations ORDER BY version;`，確認初始 migration 有紀錄，並確認 `users`、`events`、`event_insights`、`dashboard_runs` 等表已建立。
4. **Cloud Run → `echotrail-backend` → 最新 Revision**：確認 Cloud SQL connection 指向 `echotrail-postgres`，執行身分仍是 `echotrail-backend-runtime@...`，且 `GEMINI_API_KEY` Secret 仍在。呼叫 `GET /health`，再以 `POST /api/users`、`POST /api/events`、`GET /api/events` 做一張卡片的寫讀冒煙測試；重算前的 `GET /api/dashboard` 應為舊快照或 null，明確呼叫 `POST /api/dashboard/rebuild` 成功後再讀取新快照。

已套用的 migration 檔不可修改；後續資料表變更要新增下一個編號的 SQL 檔。[Cloud Build 步驟順序](https://docs.cloud.google.com/build/docs/configuring-builds/configure-build-step-order)、[Cloud Run job 的 `--wait`](https://docs.cloud.google.com/run/docs/execute/jobs)。

重跑相同映像會略過已套用的版本；新 migration 失敗時先修正未套用的檔案再重新部署。已套用檔案的 checksum 不可變，後續 migration 須保持舊 service 可運作的向後相容性。調查失敗 job 後，可在 **Cloud Run → Jobs** 刪除舊的成功 `et-mig-*` job；失敗 job 先保留供檢查。
