# Cloud SQL：接上 Cloud Run 與 Migration

這份文件從**資料庫已建立**的狀態開始。照順序完成帳號、權限與 Secret Manager 設定；最後才讓 Cloud Build 執行 migration 並部署後端。這裡的「migration」是建立或更新資料表的版本化 SQL，不是搬移 Cloud SQL instance。

## 目前現況（2026-09-25 唯讀 `gcloud` 查詢）

| 項目 | 現況 |
| --- | --- |
| GCP 專案 | `echotrail-dev-508500-k6` |
| Cloud SQL | `echotrail-postgres`，`asia-east1`，PostgreSQL 18，狀態 `RUNNABLE`；連線名稱 `echotrail-dev-508500-k6:asia-east1:echotrail-postgres` |
| 資料庫 | `echotrail` 已建立；資料庫使用者目前只有 `postgres` |
| Cloud Run service | `echotrail-backend` 已部署，執行身分為 `echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com`；目前**沒有** Cloud SQL 連線設定 |
| Gemini secret | `echotrail-gemini-api-key` 已存在，後端執行身分已有讀取權限；後續部署須保留這項設定 |
| Cloud Build | `asia-east1` 的 `echotrail-backend-build` trigger 監看 `dev`，讀取 `cloudbuild.yaml`；建置身分已有 Cloud Run Admin、Artifact Registry Writer，以及使用現有後端執行身分的權限 |
| Migration | 尚無 migration job、SQL migration、資料庫密碼 secrets；目前 `cloudbuild.yaml` 只有建置、推送映像、部署服務三步 |

本機 `gcloud` 的**預設專案不是 EchoTrail**。自行查詢或下指令時，請明確指定 `--project=echotrail-dev-508500-k6`；Console 右上角也先確認目前專案。

## 先理解四種身分

| 身分 | 做什麼 | 需要什麼 |
| --- | --- | --- |
| `echotrail-backend-build@...` | Cloud Build 部署 job 和 service | 已有 Cloud Run Admin、Artifact Registry Writer；還要能使用新建的 migration 執行身分 |
| `echotrail-db-migrator@...` | Cloud Run **job** 執行 migration | Cloud SQL Client、讀取 migration 密碼 secret |
| `echotrail-backend-runtime@...` | Cloud Run **service** 處理前端 API | Cloud SQL Client、讀取應用密碼 secret；現有 Gemini secret 權限保留 |
| PostgreSQL 的 `echotrail_migrator` / `echotrail_app` | 真正登入資料庫 | 前者建表，後者只讀寫業務資料；兩者使用不同密碼 |

**IAM 的 Cloud SQL Client 只准許服務連到 instance；PostgreSQL 帳號和資料表權限是另一層。** 兩層都完成，程式才能讀寫資料。[Cloud Run 連接 Cloud SQL 的權限說明](https://docs.cloud.google.com/sql/docs/postgres/connect-run)。

## 步驟 1：準備兩個 PostgreSQL 權限角色

1. Console 選 `echotrail-dev-508500-k6` → **Cloud SQL** → `echotrail-postgres` → **Cloud SQL Studio**。
2. 以資料庫 `echotrail`、使用者 `postgres` 和你建立 instance 時設定的密碼登入。
3. 執行下列 SQL **一次**。它建立兩個不登入的權限角色：migration 角色可在 `public` schema 建表，應用角色只能使用該 schema。

```sql
CREATE ROLE echotrail_migration_role NOLOGIN;
CREATE ROLE echotrail_app_role NOLOGIN;

GRANT CONNECT ON DATABASE echotrail TO echotrail_migration_role, echotrail_app_role;
GRANT USAGE, CREATE ON SCHEMA public TO echotrail_migration_role;
GRANT USAGE ON SCHEMA public TO echotrail_app_role;
```

如果角色已存在，不要重新執行 `CREATE ROLE`；先在 Cloud SQL Studio 查 `SELECT rolname FROM pg_roles WHERE rolname LIKE 'echotrail_%';`。Cloud SQL Studio 可以用 PostgreSQL 帳號執行 SQL。[Cloud SQL Studio 使用說明](https://docs.cloud.google.com/sql/docs/postgres/manage-data-using-studio)。

## 步驟 2：建立兩個資料庫登入帳號

1. 在同一個 instance 的 **Users → Add user account**，選 **Built-in authentication**。
2. 建立 `echotrail_migrator`，設定一組新密碼；在 **Database roles** 指派 `echotrail_migration_role`。
3. 再建立 `echotrail_app`，設定另一組新密碼；只指派 `echotrail_app_role`。
4. 確認兩個帳號都**沒有** `cloudsqlsuperuser`。Cloud SQL 的 built-in 使用者若未指定自訂角色，預設會得到這個較高權限的角色；因此不要省略第 2、3 步的角色選擇。[Cloud SQL 建立使用者說明](https://docs.cloud.google.com/sql/docs/postgres/create-manage-users)。

可在 Cloud SQL Studio 用 `postgres` 查證，兩筆 `has_cloudsqlsuperuser` 都應為 `false`：

```sql
SELECT rolname,
       pg_has_role(rolname, 'cloudsqlsuperuser', 'member') AS has_cloudsqlsuperuser
FROM pg_roles
WHERE rolname IN ('echotrail_migrator', 'echotrail_app');
```

回到 Cloud SQL Studio，以 `echotrail_migrator` 登入 `echotrail`，執行以下 SQL。它讓**之後由 migration 建立的表格與序號**自動授權給應用角色；不需要在每次新增表格後手動授權。

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO echotrail_app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO echotrail_app_role;
```

這兩段必須以 `echotrail_migrator` 執行，因為 migration 將以它的身分建表。若未來發現已建的表格缺少權限，再以此帳號補執行 `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO echotrail_app_role;` 和 `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO echotrail_app_role;`。

## 步驟 3：將兩組密碼放入 Secret Manager

到 **Security → Secret Manager → Create secret**，分別建立：

| Secret 名稱 | Secret 值 | 唯一應授權讀取的執行身分 |
| --- | --- | --- |
| `echotrail-db-migration-password` | `echotrail_migrator` 的資料庫密碼 | `echotrail-db-migrator@echotrail-dev-508500-k6.iam.gserviceaccount.com` |
| `echotrail-db-app-password` | `echotrail_app` 的資料庫密碼 | `echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com` |

先建立 secret 與第一個版本；下一步建立 migration 服務帳號後，再到各 secret 的 **Permissions / Grant access** 授予對應身分 **Secret Manager Secret Accessor** (`roles/secretmanager.secretAccessor`)。不要把密碼寫進 Git、`cloudbuild.yaml` 或前端程式。[Cloud Run job 使用 secrets](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets)、[Cloud Run service 使用 secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)。

## 步驟 4：補齊 GCP IAM 權限

在 **IAM & Admin → Service Accounts** 建立 `echotrail-db-migrator`，電子郵件應為 `echotrail-db-migrator@echotrail-dev-508500-k6.iam.gserviceaccount.com`。接著依表操作：

| 在哪裡授權 | 授權對象 | 角色 |
| --- | --- | --- |
| **IAM & Admin → IAM → Grant access** | `echotrail-backend-runtime@...` | **Cloud SQL Client** (`roles/cloudsql.client`) |
| **IAM & Admin → IAM → Grant access** | `echotrail-db-migrator@...` | **Cloud SQL Client** (`roles/cloudsql.client`) |
| **Secret Manager → `echotrail-db-app-password` → Permissions** | `echotrail-backend-runtime@...` | **Secret Manager Secret Accessor** |
| **Secret Manager → `echotrail-db-migration-password` → Permissions** | `echotrail-db-migrator@...` | **Secret Manager Secret Accessor** |
| **Service Accounts → `echotrail-db-migrator` → Permissions / Grant access** | `echotrail-backend-build@...` | **Service Account User** (`roles/iam.serviceAccountUser`) |

目前建置身分已有 Cloud Run Admin、Artifact Registry Writer，以及對既有後端執行身分的 Service Account User；不用重新建立建置身分或授予重複角色。`echotrail-gemini-api-key` 也已授權給後端執行身分，請勿移除。

## 步驟 5：把 migration 接進 Cloud Build，然後才部署

**目前還不能直接執行 migration。** 現有 [`cloudbuild.yaml`](../cloudbuild.yaml) 只把 Cloud SQL instance 附加到即將部署的 service；映像內沒有 migration runner，也沒有將資料庫密碼接入 job/service。請先照 [migration 實作計畫](superpowers/plans/2026-09-25-cloud-build-migrations.md) 完成程式碼、版本化 SQL、Dockerfile 與 Cloud Build 步驟，再推送觸發 `dev` 建置。預期的順序是：

```text
建置並推送同一個映像
  → 建立本次 build 專屬的 Cloud Run migration job（et-mig-$BUILD_ID）
  → job 使用 echotrail_migrator，執行尚未套用的 SQL migration
  → Cloud Build 等 job 成功（--wait）
  → 部署 echotrail-backend service，使用 echotrail_app
```

Migration job 和 service 都使用 Cloud SQL Unix socket：`/cloudsql/echotrail-dev-508500-k6:asia-east1:echotrail-postgres`。job 用 `echotrail-db-migration-password`，service 用 `echotrail-db-app-password`，都透過 `PGPASSWORD` secret 環境變數注入。Cloud Build 的部署指令要保留原本的 `GEMINI_API_KEY` secret；更新服務 secret 時使用 `--update-secrets`，避免覆蓋既有設定。若 migration 失敗，Cloud Build 必須停止，不能繼續部署新 service。不要為了測試而手動把 `001_initial_schema.sql` 貼到 Cloud SQL Studio：那樣會繞過版本紀錄，下一次 job 無法可靠判斷哪些 migration 已套用。

## 步驟 6：部署後怎麼確認

1. **Cloud Build → History**：確認本次 build 依序出現建置、推送、migration job、等待執行、部署 service，且 migration step 成功。
2. **Cloud Run → Jobs**：找到該次 `et-mig-...`，確認最新 execution 成功。失敗時先看 job log；舊 service 應仍可使用。
3. **Cloud SQL → `echotrail-postgres` → Cloud SQL Studio**：登入 `echotrail`，執行 `SELECT version, applied_at FROM schema_migrations ORDER BY version;`，確認初始 migration 有紀錄。再檢查 `users`、`events`、`event_insights`、`dashboard_runs` 等表已建立。
4. **Cloud Run → `echotrail-backend` → 最新 Revision**：確認 Cloud SQL connection 指向 `echotrail-postgres`，執行身分仍為 `echotrail-backend-runtime@...`，且保留 Gemini secret。`GET /health` 只能證明服務啟動；待持久化 API 完成後，還要實際寫入一張 Echo Card、重新載入 My Trail、再讀回同一筆資料。

已套用的 migration 檔不可直接修改；下一次資料表變更要新增下一個編號的 SQL 檔。重跑同一個建置時，migration runner 應跳過已記錄的版本。[Cloud Build 步驟順序](https://docs.cloud.google.com/build/docs/configuring-builds/configure-build-step-order)、[Cloud Run job 執行與等待](https://docs.cloud.google.com/run/docs/execute/jobs)。
