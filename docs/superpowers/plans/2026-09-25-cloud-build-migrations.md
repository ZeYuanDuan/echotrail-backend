# Cloud Build 資料庫遷移實作計畫

> **供實作代理參考：** 必須使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans，依序完成本計畫各任務。步驟以核取方塊（`- [ ]`）追蹤。

**目標：** 每次後端 Cloud Build 部署都先執行有版本記錄的 PostgreSQL migration；成功後才能部署新的 Cloud Run 服務版本。

**架構：** 將編號 SQL 檔與小型 Node migration runner 一起放入 API 映像。Cloud Build 建置並推送映像後，以同一映像部署單一任務的 Cloud Run migration job，同步等待執行完成，成功才部署服務。Job 與服務共用現有的 `echotrail-backend-runtime` 服務帳號、PostgreSQL 登入帳號 `echotrail_app` 及同一個資料庫密碼 Secret。

**技術：** Node 22、TypeScript、`pg`、Cloud SQL PostgreSQL、Docker、Cloud Build、Cloud Run jobs、Secret Manager、Vitest。

**規格：** `../../../../echotrail-project-management/EchoTrail-MVP-SPEC.md`（同層其他 repository；「資料持久化契約（MVP）」與 C-10）。後續依序執行[後端持久化計畫](2026-09-25-persistence-api.md)，再執行前端 repository 的計畫。

**範圍：** 本計畫只建立持久化 schema 與部署時的 migration 門檻；A-1／A-2 匯入、A-4／A-5 對話規則、B-2 匹配分數及 C-7～C-9 最終計分規則不由本計畫實作。

## 全域限制

- 專案 ID 為 `echotrail-dev-508500-k6`；區域為 `asia-east1`；執行個體連線名稱為 `echotrail-dev-508500-k6:asia-east1:echotrail-postgres`；資料庫名稱為 `echotrail`。
- 資料庫產生 `events.created_at`；My Trail 依 `created_at, event_id` 排序，不另存事件發生時間。
- 資料表分為 `users`、`conversations`、`conversation_messages`、`events`、`event_insights`、`framework_signals` 與 `dashboard_runs`。
- 確認一張卡片時須原子性建立一筆事件與一筆洞見。Dashboard 快照須保存、以使用者為範圍，且只在明確要求時重算。
- 資料庫密碼及 API key 不得出現在 Git、建置紀錄、前端 bundle 或 Cloud Build substitutions。
- 目前 `dev` 會觸發後端部署；Cloud SQL 執行個體、`echotrail` 資料庫、`echotrail_app`、啟用的密碼 Secret 與執行身分的 Cloud SQL／Secret IAM 都已查到。推送前仍須在 Cloud SQL Studio 確認 PostgreSQL 角色／建表權及密碼相符，並先完成本計畫的 migration runner 與 Cloud Build 門檻。

## 審查重點

1. 兩次建置同時執行 migration：各自使用綁定固定映像的 `et-mig-$BUILD_ID` job；第二個 runner 等待 PostgreSQL advisory lock，然後略過已記錄版本。
2. Migration 中途失敗：交易回滾，Cloud Build 停止，舊 Cloud Run 服務維持運作。
3. 已套用的 SQL 檔遭修改：checksum 不一致時停止部署，不可默默接受 schema 漂移。
4. Job 無法讀取 Secret 或連線 Cloud SQL：新服務部署前即失敗，紀錄中不得印出 Secret。
5. 同一映像再次執行：略過全部已套用的 migration，job 成功結束。

---

## 檔案分工與固定介面

| 檔案 | 職責 |
| --- | --- |
| `migrations/001_initial_schema.sql` | 可在交易中執行的初始 schema、鍵、使用者範圍與索引。 |
| `src/db.ts` | 由 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD` 建立 `createPool(): Pool`。 |
| `src/migrate.ts` | `applyMigrations(client, directory)` 與 CLI 入口。 |
| `test/database.ts` | 由測試 PostgreSQL 連線建立每個測試檔獨立的暫時性資料庫，結束時刪除。 |
| `test/migrate.test.ts` | 使用真實 PostgreSQL 測試回滾、checksum、鎖與重跑。 |
| `Dockerfile` | 將 SQL 複製進執行階段映像。 |
| `cloudbuild.yaml` | 建置 → 推送 → 部署 migration job → 以 `--wait` 執行 → 部署服務。 |
| `docs/cloud-sql-setup.md` | Console 建立資源、IAM、角色權限、Secret 與驗證。 |

Migration 指令為 `node dist/migrate.js`。Job 和 service 都設定 `PGHOST=/cloudsql/echotrail-dev-508500-k6:asia-east1:echotrail-postgres`、`PGPORT=5432`、`PGDATABASE=echotrail`、`PGUSER=echotrail_app`，並將 `PGPASSWORD` 綁定至 Secret Manager 的 `echotrail-db-password:latest`。同一個使用者建立並持有 migration 資料表，也處理服務的資料讀寫。兩者都使用現有的 `echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com`；無須建立另一個 GCP 服務帳號。加入服務旗標時須保留 `GEMINI_API_KEY` 的現有 Secret 設定；修改會取代整組設定的 `--set-secrets` 前，先檢查已部署服務。

### 任務 1：初始 schema 與版本化 migration runner

**檔案：** 新增 `migrations/001_initial_schema.sql`、`src/db.ts`、`src/migrate.ts`、`test/database.ts`、`test/migrate.test.ts`；修改 `package.json`、`package-lock.json`。

**介面：** 提供 `createPool(): Pool`；`applyMigrations(client: Pick<PoolClient, 'query'>, directory: string): Promise<number>` 回傳本次套用的檔案數。後端持久化計畫使用此 schema 與 `createPool()`。

- [ ] **步驟 1：先寫失敗的整合測試。** `TEST_DATABASE_URL` 提供本機 PostgreSQL 管理連線；`test/database.ts` 使用 `crypto.randomUUID()` 的十六進位字元組成 `echotrail_test_<id>` 資料庫名稱，驗證名稱僅含 `[a-z0-9_]`，以該連線對 `postgres` 執行 `CREATE DATABASE`，將測試 pool 指向新資料庫，結束後關閉 pool 並 `DROP DATABASE ... WITH (FORCE)`。每個測試檔使用獨立資料庫，避免 Vitest 並行執行時重設彼此資料。測試先用 `current_database()` 確認不是 `echotrail`，否則拒絕執行。測試首次套用、重跑（套用數為零）、checksum 改變，以及故意失敗的第二個 migration，並檢查其資料表及版本列均未留下。併發案例以兩個 client 同時連接同一測試資料庫，確認只有一個插入版本 `001`。

```ts
const first = await applyMigrations(client, migrationDirectory);
expect(first).toBe(1);
expect(await applyMigrations(client, migrationDirectory)).toBe(0);
await expect(applyMigrations(client, changedCopy)).rejects.toThrow(/checksum/i);
```

- [ ] **步驟 2：執行失敗測試。** 執行 `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/migrate.test.ts`；預期因模組或函式不存在而失敗。先以 `docker run --rm -d --name echotrail-migration-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=echotrail_test -p 55432:5432 postgres:18` 啟動可拋棄的 PostgreSQL 容器，以符合 Cloud SQL 的 PostgreSQL 18；驗證後移除。
- [ ] **步驟 3：加入 `pg`、`@types/pg`，實作 `src/db.ts`。** 執行 `npm install pg`、`npm install -D @types/pg`；`createPool()` 必須在 `PGPASSWORD` 缺失時拒絕啟動，並設定 `host: process.env.PGHOST`、`port: Number(process.env.PGPORT ?? 5432)`、`database`、`user`、`password`、`max: 5`、`connectionTimeoutMillis: 5000`。Cloud Run 使用明確的 Unix socket 目錄，不拼接含密碼的 URI。

```ts
import { Pool } from 'pg';
export function createPool(): Pool {
  const { PGHOST, PGDATABASE, PGUSER, PGPASSWORD } = process.env;
  if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) throw new Error('PostgreSQL configuration is incomplete');
  return new Pool({ host: PGHOST, port: Number(process.env.PGPORT ?? 5432), database: PGDATABASE, user: PGUSER, password: PGPASSWORD, max: 5, connectionTimeoutMillis: 5000 });
}
```

- [ ] **步驟 4：撰寫 `001_initial_schema.sql`。** UUID 由 Node 的 `crypto.randomUUID()` 產生，不依賴擴充套件。建立下列資料表及欄位：`users(id uuid primary key, display_name text not null, normalized_name text not null unique, insight_revision bigint not null default 0, created_at timestamptz not null default now())`；`conversations(id uuid primary key, user_id uuid not null references users, created_at timestamptz not null default now(), unique(user_id,id))`；`conversation_messages(id bigserial primary key, user_id uuid not null, conversation_id uuid not null, seq integer not null, role text not null check(role in ('user','model')), body text not null, foreign key(user_id,conversation_id) references conversations(user_id,id), unique(conversation_id,seq))`；`events(id uuid primary key, user_id uuid not null references users, conversation_id uuid, message_start_seq integer, message_end_seq integer, client_event_id uuid not null, request_hash text not null, title text not null, source text not null default 'conversation', created_at timestamptz not null default now(), unique(user_id,id), unique(user_id,client_event_id), foreign key(user_id,conversation_id) references conversations(user_id,id), foreign key(conversation_id,message_start_seq) references conversation_messages(conversation_id,seq), foreign key(conversation_id,message_end_seq) references conversation_messages(conversation_id,seq), check((source='conversation' AND conversation_id IS NOT NULL AND message_start_seq IS NOT NULL AND message_end_seq IS NOT NULL AND message_start_seq > 0 AND message_end_seq >= message_start_seq) OR (source<>'conversation' AND message_start_seq IS NULL AND message_end_seq IS NULL)))`；`event_insights(event_id uuid primary key references events(id), happen jsonb not null, emotion text not null, likes text not null, dislikes text not null, value_claim text not null, quote text not null, quote_source text not null check(quote_source in ('user_message','user_edit')), anchor_type text)`；`framework_signals(id bigserial primary key, user_id uuid not null, event_id uuid not null, framework text not null, dimension text not null, strength smallint not null check(strength between 1 and 10), evidence_quote text not null, extraction_version integer not null default 1, created_at timestamptz not null default now(), foreign key(user_id,event_id) references events(user_id,id), unique(event_id,framework,dimension,evidence_quote,extraction_version))`；`dashboard_runs(id bigserial primary key, user_id uuid not null references users, source_revision bigint not null, source_event_count integer not null, result jsonb not null, created_at timestamptz not null default now())`。`message_start_seq`／`message_end_seq` 指出同一段對話內每張卡片的原文範圍；本次對話事件須非空且由 API 寫入連續序號。建立 `events(user_id,created_at,id)`、`framework_signals(user_id,event_id)` 與 `dashboard_runs(user_id,id desc)` 索引。
- [ ] **步驟 5：實作 runner。** 依名稱排序列舉符合 `^[0-9]{3}_[a-z0-9_]+\.sql$` 的檔案，讀取內容並計算 SHA-256。使用同一個 client 執行 `BEGIN`、`SELECT pg_advisory_xact_lock(hashtext('echotrail-schema-migrations'))`，建立 `schema_migrations(version text primary key, checksum text not null, applied_at timestamptz not null default now())`，比對已套用檔案的 checksum，再執行新 SQL 並插入版本與 checksum，最後 `COMMIT`。錯誤時 `ROLLBACK` 並向上拋出；紀錄僅印版本名稱。CLI 以 `createPool()` 連線，呼叫 `applyMigrations(client, fileURLToPath(new URL('../migrations/', import.meta.url)))`，釋放 client 並關閉 pool；失敗時以非零狀態碼結束。函式內容如下：

```ts
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';

export async function applyMigrations(client: Pick<PoolClient, 'query'>, directory: string): Promise<number> {
  const files = (await readdir(directory)).filter((name) => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  let applied = 0;
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('echotrail-schema-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = await readFile(join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]);
      if (prior.rows.length) {
        if (prior.rows[0].checksum !== checksum) throw new Error(`Migration ${version} checksum mismatch`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
      applied++;
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
```

- [ ] **步驟 6：執行測試與建置。** `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/migrate.test.ts` 與 `npm run build` 應通過。用 `docker exec echotrail-migration-test createdb -U postgres echotrail_smoke` 建立空白冒煙資料庫，再執行兩次 `PGHOST=127.0.0.1 PGPORT=55432 PGDATABASE=echotrail_smoke PGUSER=postgres PGPASSWORD=postgres node dist/migrate.js`；首次套用、再次略過。測試須涵蓋審查重點 1、2、3、5，包括以兩個 client 執行 Promise.all；重點 4 在 Cloud Run job／Cloud Build 驗證路徑確認。
- [ ] **步驟 7：提交。** `git add migrations src/db.ts src/migrate.ts test/database.ts test/migrate.test.ts package.json package-lock.json && git commit -m "feat: add versioned PostgreSQL migrations"`。

### 任務 2：以 Cloud Run migration job 作為部署門檻

**檔案：** 修改 `Dockerfile`、`cloudbuild.yaml`；新增 `test/cloudbuild-migration.test.ts`。

**介面：** 使用 `node dist/migrate.js` 與 SQL 目錄；提供循序執行的 Cloud Build 門檻。`gcloud run jobs execute --wait` 失敗時，不部署新的後端服務版本。

- [ ] **步驟 1：先寫失敗的設定測試。** 使用僅供測試的 YAML parser（`npm install -D yaml`）或檢查結構化建置步驟。確認順序為 `docker build`、`docker push`、`gcloud run jobs deploy`、`gcloud run jobs execute --wait`、`gcloud run deploy`。兩個 job 步驟都須使用 `et-mig-$BUILD_ID` 名稱（替換後 43 字，低於 Cloud Run 49 字限制）；job 與服務映像須相同、任務數為 1、重試數為 0，且設定 Cloud SQL、現有的 `echotrail-backend-runtime` 服務帳號、單一資料庫密碼 Secret，Dockerfile 須將 SQL 複製進執行階段。

```ts
expect(stepNames).toEqual(['build', 'push', 'migrate-job', 'migrate', 'deploy']);
expect(migrate.args).toContain('--wait');
expect(migrate.args).toContain('et-mig-$BUILD_ID');
expect(migrateJob.args).toContain('echotrail-db-password:latest');
```

- [ ] **步驟 2：執行 `npm test -- test/cloudbuild-migration.test.ts`；預期失敗，因為尚無 job 步驟。**
- [ ] **步驟 3：在 Docker 執行階段加入 `COPY migrations ./migrations`。** 為五個 Cloud Build 步驟加上 ID。在推送映像與部署服務之間，將下列 `gcloud` 指令拆成 YAML `args` 陣列，每個引數占一項；沿用現有映像標籤：

```text
gcloud run jobs deploy et-mig-$BUILD_ID --image asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:$COMMIT_SHA --region asia-east1 --command node --args dist/migrate.js --tasks 1 --max-retries 0 --service-account echotrail-backend-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com --set-cloudsql-instances echotrail-dev-508500-k6:asia-east1:echotrail-postgres --set-env-vars PGHOST=/cloudsql/echotrail-dev-508500-k6:asia-east1:echotrail-postgres,PGPORT=5432,PGDATABASE=echotrail,PGUSER=echotrail_app --set-secrets PGPASSWORD=echotrail-db-password:latest --quiet
gcloud run jobs execute et-mig-$BUILD_ID --region asia-east1 --wait --quiet
```

沒有 `waitFor` 覆寫時，Cloud Build 預設依序執行步驟；`--wait` 回傳零狀態碼後才執行下一個部署步驟。每次建置使用獨立 job 名稱，可避免並行建置在部署與執行之間改變同一 job 的映像。服務端的 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER` 用 `--update-env-vars` 加入，`PGPASSWORD=echotrail-db-password:latest` 用 `--update-secrets` 加入，以保留既有 Gemini 設定。部署前先檢查服務現有 Gemini Secret 綁定。Job 使用 `--set-cloudsql-instances`；服務保留 `cloudbuild.yaml` 中的 `--add-cloudsql-instances`，讓新 revision 首次附加 Cloud SQL instance。保留失敗 job 供檢查，並記錄定期清理舊的成功 `et-mig-*` job。
- [ ] **步驟 4：執行 `npm test -- test/cloudbuild-migration.test.ts`、`npm run build` 與 YAML 解析；預期通過。** 以可拋棄的 Cloud Build 設定或文件化手動測試模擬 migration 失敗，確認不會執行服務部署步驟。
- [ ] **步驟 5：提交。** `git add Dockerfile cloudbuild.yaml test/cloudbuild-migration.test.ts package.json package-lock.json && git commit -m "build: gate Cloud Run deploy on migrations"`。

### 任務 3：資源設定與操作驗證

**檔案：** 修改 `docs/cloud-sql-setup.md`、`docs/cloud-architecture.md`、`README.md`。

**介面：** 說明推送 `dev` 前的全部必要設定，以及部署後在 Console 的驗證路徑。

- [ ] **步驟 1：核對現有設定文件。** `docs/cloud-sql-setup.md` 已記錄 migration job、唯一資料庫登入使用者 `echotrail_app`、唯一資料庫密碼 Secret `echotrail-db-password` 及失敗時停止部署；對照實作後的旗標與順序，標記需要更新的段落。
- [ ] **步驟 2：同步 Console 操作順序。** 以 `docs/cloud-sql-setup.md` 的最新現況指南為準：資料庫登入使用者 `echotrail_app`、Secret `echotrail-db-password` 的啟用版本、Cloud SQL Client、Secret Accessor、Cloud Build 的 Cloud Run Admin／Artifact Registry Writer／Service Account User 均已存在；不要重新建立。Cloud SQL Studio 尚須確認 `echotrail_app` 在 PostgreSQL 內有 `CONNECT` 與 `public` schema 的 `USAGE,CREATE`，並確認 Secret 密碼可登入。`echotrail_app` 同時負責 DDL migration 與服務 DML，不另設轉授權限。
- [ ] **步驟 3：加入精確驗證路徑。** 在 Cloud Build 確認 job 執行先於服務部署；在 Cloud Run Jobs 確認 `et-mig-$BUILD_ID` 成功；檢查 `schema_migrations`；呼叫 `/health`；再執行持久化計畫的冒煙測試。說明重跑與回滾：新的 migration 失敗時修正並重新部署；已套用的檔案不可編輯，後續變更建立新的編號檔案。舊服務版本仍在運作時，未來 migration 須保持向後相容的增量變更。說明檢查後如何在 Console 刪除舊的成功 `et-mig-*` job。
- [ ] **步驟 4：檢查文件與提交。** 對照 `cloudbuild.yaml`、Dockerfile、`src/db.ts`、`src/migrate.ts` 與設定文件，執行 `git diff --check`；通過後執行 `git add docs/cloud-sql-setup.md docs/cloud-architecture.md README.md && git commit -m "docs: describe migration prerequisites and verification"`。

## 自我檢查與交接

本計畫涵蓋初始 schema、併發、回滾、checksum 漂移、Cloud Build 失敗門檻、執行階段映像內容、IAM、Secret 與重跑流程。後端 API 計畫須沿用此處的資料表與環境變數名稱。任何部署前，先檢查現有服務的 Gemini Secret 綁定，並在新的 `gcloud run deploy` 引數中保留。核對官方[Cloud Run job 部署旗標](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy)、[job 執行的 `--wait`](https://docs.cloud.google.com/run/docs/execute/jobs)、[Cloud Run job 名稱限制](https://docs.cloud.google.com/run/docs/create-jobs)、[Cloud SQL socket 連線](https://docs.cloud.google.com/sql/docs/postgres/connect-run)與[Cloud Build 步驟順序](https://docs.cloud.google.com/build/docs/configuring-builds/configure-build-step-order)。
