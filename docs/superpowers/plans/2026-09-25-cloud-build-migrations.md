# Cloud Build Database Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every backend Cloud Build deployment a versioned PostgreSQL migration gate that must succeed before the new Cloud Run service revision is deployed.

**Architecture:** Bundle numbered SQL files and a small Node migration runner in the same image as the API. Cloud Build builds and pushes the image, deploys a one-task Cloud Run migration job from that image, executes it synchronously, then deploys the service only after success. The job and service use separate database credentials from Secret Manager.

**Tech Stack:** Node 22, TypeScript, `pg`, PostgreSQL on Cloud SQL, Docker, Cloud Build, Cloud Run jobs, Secret Manager, Vitest.

**Spec:** `../../../../echotrail-project-management/EchoTrail-MVP-SPEC.md` (repository sibling; see “資料持久化契約（MVP）” and C-10). Follow with [backend persistence plan](2026-09-25-persistence-api.md), then the frontend plan in the frontend repository.

## Global Constraints

- Project ID `echotrail-dev-508500-k6`; region `asia-east1`; instance connection name `echotrail-dev-508500-k6:asia-east1:echotrail-postgres`; database `echotrail`.
- Database generates `events.created_at`; My Trail orders by `created_at, event_id`; no event occurrence timestamp.
- Schema separates `users`, `conversations`, `conversation_messages`, `events`, `event_insights`, `framework_signals`, and `dashboard_runs`.
- A confirmed card creates one event and one insight atomically. Dashboard snapshots are stored, user scoped, and rebuilt only on explicit request.
- No database password or API key in Git, build logs, frontend bundle, or Cloud Build substitutions.
- `dev` currently triggers backend deployment; do not push until the Cloud SQL instance, database, database roles, secrets, and IAM are provisioned.

## Review Focus

1. Two builds attempt a migration simultaneously: each uses its own immutable-image job `et-mig-$BUILD_ID`; the second runner waits on the PostgreSQL advisory lock, then skips already recorded migrations.
2. A migration fails halfway: transaction rolls back, Cloud Build stops, and the old Cloud Run service remains deployed.
3. A previously applied SQL file changes: checksum mismatch stops deployment instead of silently accepting schema drift.
4. The job cannot read its secret or connect to Cloud SQL: deployment fails before new service rollout, with no secret printed in logs.
5. Rerunning the same image: all migrations are skipped and the job exits successfully.

---

## File map and fixed interface

| File | Responsibility |
| --- | --- |
| `migrations/001_initial_schema.sql` | Transaction-safe baseline schema, keys, user scoping, and indexes. |
| `src/db.ts` | `createPool(): Pool` from `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`. |
| `src/migrate.ts` | `applyMigrations(client, directory)` and CLI entry point. |
| `test/migrate.test.ts` | Real-PostgreSQL rollback, checksum, lock, and rerun tests. |
| `Dockerfile` | Copy SQL into the runtime image. |
| `cloudbuild.yaml` | Build → push → deploy migration job → execute `--wait` → deploy service. |
| `docs/cloud-sql-setup.md` | Console provisioning, IAM, role grants, secrets, and verification. |

Migration command: `node dist/migrate.js`. Use `PGHOST=/cloudsql/echotrail-dev-508500-k6:asia-east1:echotrail-postgres`, `PGPORT=5432`, `PGDATABASE=echotrail`, `PGUSER=echotrail_migrator`, with `PGPASSWORD` bound to Secret Manager secret `echotrail-db-migration-password:latest`. Runtime service uses `echotrail_app` and secret `echotrail-db-app-password:latest`. Database migrator is the schema owner; app user has DML privileges only. `GEMINI_API_KEY` must remain bound to its existing secret/configuration when adding service flags; inspect deployed service settings before changing `--set-secrets` because that flag replaces the set.

### Task 1: Baseline schema and versioned migration runner

**Files:** Create `migrations/001_initial_schema.sql`, `src/db.ts`, `src/migrate.ts`, `test/migrate.test.ts`; modify `package.json`, `package-lock.json`.

**Interfaces:** Produces `createPool(): Pool`; `applyMigrations(client: Pick<PoolClient, 'query'>, directory: string): Promise<number>` returns applied-file count. The backend persistence plan uses the schema and `createPool()`.

- [ ] **Step 1: Write failing integration tests.** Use a local throwaway PostgreSQL database selected by `TEST_DATABASE_URL`; tests must refuse to run against `echotrail` by checking `current_database()`. Test first run, rerun (zero applied), a modified checksum, and a deliberately failing second migration followed by inspection that its table and version row are absent. For the concurrency case, run two clients against the same test database and assert only one inserts version `001`.

```ts
const first = await applyMigrations(client, migrationDirectory);
expect(first).toBe(1);
expect(await applyMigrations(client, migrationDirectory)).toBe(0);
await expect(applyMigrations(client, changedCopy)).rejects.toThrow(/checksum/i);
```

- [ ] **Step 2: Run failure.** `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/echotrail_test npm test -- test/migrate.test.ts`; expect missing module/function. Start a disposable PostgreSQL container before this step, for example `docker run --rm -d --name echotrail-migration-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=echotrail_test -p 55432:5432 postgres:16` and remove it after verification.
- [ ] **Step 3: Add `pg` and `@types/pg`, then implement `src/db.ts`.** Run `npm install pg` and `npm install -D @types/pg`; `createPool()` must reject absent `PGPASSWORD`, set `host: process.env.PGHOST`, `port: Number(process.env.PGPORT ?? 5432)`, `database`, `user`, `password`, `max: 5`, and `connectionTimeoutMillis: 5000`. Use a literal Unix socket directory in Cloud Run, never a URI assembled with a password.

```ts
import { Pool } from 'pg';
export function createPool(): Pool {
  const { PGHOST, PGDATABASE, PGUSER, PGPASSWORD } = process.env;
  if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) throw new Error('PostgreSQL configuration is incomplete');
  return new Pool({ host: PGHOST, port: Number(process.env.PGPORT ?? 5432), database: PGDATABASE, user: PGUSER, password: PGPASSWORD, max: 5, connectionTimeoutMillis: 5000 });
}
```

- [ ] **Step 4: Write `001_initial_schema.sql`.** Use `uuid` values supplied by Node (`crypto.randomUUID()`), not an extension. Define `users(id uuid primary key, display_name text not null, normalized_name text not null unique, insight_revision bigint not null default 0, created_at timestamptz not null default now())`; `conversations(id uuid primary key, user_id uuid not null references users, created_at timestamptz not null default now(), unique(user_id,id))`; `conversation_messages(id bigserial primary key, user_id uuid not null, conversation_id uuid not null, seq integer not null, role text not null check(role in ('user','model')), body text not null, foreign key(user_id,conversation_id) references conversations(user_id,id), unique(conversation_id,seq))`; `events(id uuid primary key, user_id uuid not null references users, conversation_id uuid, client_event_id uuid not null, request_hash text not null, title text not null, source text not null default 'conversation', created_at timestamptz not null default now(), unique(user_id,id), unique(user_id,client_event_id), foreign key(user_id,conversation_id) references conversations(user_id,id))`; `event_insights(event_id uuid primary key references events(id), happen jsonb not null, emotion text not null, likes text not null, dislikes text not null, value_claim text not null, quote text not null, quote_source text not null check(quote_source in ('user_message','user_edit')), anchor_type text)`; `framework_signals(id bigserial primary key, user_id uuid not null, event_id uuid not null, framework text not null, dimension text not null, strength smallint not null check(strength between 1 and 10), evidence_quote text not null, extraction_version integer not null default 1, foreign key(user_id,event_id) references events(user_id,id), unique(event_id,framework,dimension,evidence_quote,extraction_version))`; `dashboard_runs(id bigserial primary key, user_id uuid not null references users, source_revision bigint not null, source_event_count integer not null, result jsonb not null, created_at timestamptz not null default now())`. Index `events(user_id,created_at,id)`, `framework_signals(user_id,event_id)`, and `dashboard_runs(user_id,id desc)`.
- [ ] **Step 5: Implement runner.** Enumerate `^[0-9]{3}_[a-z0-9_]+\.sql$` in sorted order; read bytes and SHA-256 each file. On one client, `BEGIN`, `SELECT pg_advisory_xact_lock(hashtext('echotrail-schema-migrations'))`, create `schema_migrations(version text primary key, checksum text not null, applied_at timestamptz not null default now())`, compare applied checksums, execute each new SQL, insert version/checksum, then `COMMIT`. On any error `ROLLBACK` and rethrow. Log version names only. CLI connects with `createPool()`, calls `applyMigrations(client, fileURLToPath(new URL('../migrations/', import.meta.url)))`, releases and closes pool, exits nonzero on failure. The function body is:

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

- [ ] **Step 6: Run tests and build.** `npm test -- test/migrate.test.ts` and `npm run build`; expect pass. Verify `node dist/migrate.js` against the throwaway database twice (first applies, second skips). The test suite must cover Review Focus cases 1, 2, 3, and 5, including Promise.all on two clients; case 4 is checked in the Cloud Run job/Cloud Build verification path.
- [ ] **Step 7: Commit.** `git add migrations src/db.ts src/migrate.ts test/migrate.test.ts package.json package-lock.json && git commit -m "feat: add versioned PostgreSQL migrations"`.

### Task 2: Gate deployment on Cloud Run migration job

**Files:** Modify `Dockerfile`, `cloudbuild.yaml`; create `test/cloudbuild-migration.test.ts`.

**Interfaces:** Consumes `node dist/migrate.js` and the SQL directory. Produces a sequential Cloud Build gate; no backend service revision is deployed when `gcloud run jobs execute --wait` fails.

- [ ] **Step 1: Write a failing configuration test.** Parse YAML using a test-only YAML parser (`npm install -D yaml`) or inspect structured build steps. Assert order `docker build`, `docker push`, `gcloud run jobs deploy`, `gcloud run jobs execute --wait`, `gcloud run deploy`. Assert job name `et-mig-$BUILD_ID` in both job steps (43 characters after substitution, under Cloud Run's 49-character job-name limit), job image equals service image, one task, zero retries, Cloud SQL attachment, migrator service account and secret binding, and runtime SQL directory copied by Dockerfile.

```ts
expect(stepNames).toEqual(['build', 'push', 'migrate-job', 'migrate', 'deploy']);
expect(migrate.args).toContain('--wait');
expect(migrate.args).toContain('et-mig-$BUILD_ID');
expect(migrateJob.args).toContain('echotrail-db-migration-password:latest');
```

- [ ] **Step 2: Run `npm test -- test/cloudbuild-migration.test.ts`; expect FAIL because no job steps exist.**
- [ ] **Step 3: Add `COPY migrations ./migrations` to Docker runtime stage.** Add IDs to the five Cloud Build steps. Between push and service deploy, insert these exact `gcloud` invocations as YAML `args` arrays (one argument per item; use the existing image tag):

```text
gcloud run jobs deploy et-mig-$BUILD_ID --image asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:$COMMIT_SHA --region asia-east1 --command node --args dist/migrate.js --tasks 1 --max-retries 0 --service-account echotrail-db-migrator@echotrail-dev-508500-k6.iam.gserviceaccount.com --set-cloudsql-instances echotrail-dev-508500-k6:asia-east1:echotrail-postgres --set-env-vars PGHOST=/cloudsql/echotrail-dev-508500-k6:asia-east1:echotrail-postgres,PGPORT=5432,PGDATABASE=echotrail,PGUSER=echotrail_migrator --set-secrets PGPASSWORD=echotrail-db-migration-password:latest --quiet
gcloud run jobs execute et-mig-$BUILD_ID --region asia-east1 --wait --quiet
```

Cloud Build steps execute serially by default when no `waitFor` overrides are supplied; the next deploy step is reached only after a zero exit from `--wait`. A per-build job name prevents a concurrent build from changing the image between deploy and execute. Also add service `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` using `--update-env-vars` and `PGPASSWORD=echotrail-db-app-password:latest` using `--update-secrets` so existing Gemini settings are preserved. Inspect the current service's Gemini secret binding before deployment. Use `--set-cloudsql-instances` for the job. Keep the service’s existing connection attachment. Retain failed jobs for inspection and document periodic cleanup of old successful `et-mig-*` jobs.
- [ ] **Step 4: Run `npm test -- test/cloudbuild-migration.test.ts`, `npm run build`, and YAML parsing; expect pass.** Test a simulated failing migration step in a disposable Cloud Build config or documented manual test; verify the service deploy step is not reached.
- [ ] **Step 5: Commit.** `git add Dockerfile cloudbuild.yaml test/cloudbuild-migration.test.ts package.json package-lock.json && git commit -m "build: gate Cloud Run deploy on migrations"`.

### Task 3: Provisioning and operator verification

**Files:** Modify `docs/cloud-sql-setup.md`, `docs/cloud-architecture.md`, `README.md`; test `test/cloudbuild-migration.test.ts`.

**Interfaces:** Documents all prerequisites before a `dev` push and a console verification path after deployment.

- [ ] **Step 1: Add a failing docs assertion.** Verify the setup document names the migration job, both database users and Secret Manager secrets, and says Cloud Build stops on failed migrations.
- [ ] **Step 2: Run `npm test -- test/cloudbuild-migration.test.ts`; expect FAIL on missing document text.**
- [ ] **Step 3: Document Console sequence.** Use the exact current-state guide in `docs/cloud-sql-setup.md`: create custom NOLOGIN PostgreSQL roles first, then built-in `echotrail_migrator` (owner of migration-created tables) and `echotrail_app` (DML only) with those custom roles assigned. Cloud SQL otherwise grants built-in users `cloudsqlsuperuser` by default. Create the two Secret Manager secrets, migration service identity, and scoped secret access; grant Cloud SQL Client to both runtime identities and Service Account User on the new migrator identity to the existing Cloud Build identity. The existing build identity already has Cloud Run Admin and Artifact Registry Writer. Set app default table/sequence privileges while logged into Cloud SQL Studio as `echotrail_migrator`, before first migration. Do not grant app DDL.
- [ ] **Step 4: Add exact verification path.** In Cloud Build confirm job execution precedes service deploy; in Cloud Run Jobs confirm `et-mig-$BUILD_ID` execution succeeds; inspect `schema_migrations`; call `/health`; run later persistence smoke test from its plan. Show rerun behavior and rollback policy: fix a new failed migration and redeploy, never edit already applied migrations; create a new numbered file for later changes. Future migrations must be additive while the prior service revision is still live. Explain how to delete old successful `et-mig-*` jobs from the Console after inspection.
- [ ] **Step 5: Run docs test and `git diff --check`; expect pass. Commit.** `git add docs/cloud-sql-setup.md docs/cloud-architecture.md README.md test/cloudbuild-migration.test.ts && git commit -m "docs: describe migration prerequisites and verification"`.

## Self-review and handoff

This plan covers initial schema, concurrency, rollback, checksum drift, Cloud Build failure gate, runtime image contents, IAM, secrets, and rerun procedure. The backend API plan must use these exact table and environment names. Before any deployment, inspect the existing service’s Gemini secret binding and keep it in the updated `gcloud run deploy` arguments. Validate against official [Cloud Run job deploy flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy), [job execution `--wait`](https://docs.cloud.google.com/run/docs/execute/jobs), [Cloud Run job name limit](https://docs.cloud.google.com/run/docs/create-jobs), [Cloud SQL socket connection](https://docs.cloud.google.com/sql/docs/postgres/connect-run), and [Cloud Build step ordering](https://docs.cloud.google.com/build/docs/configuring-builds/configure-build-step-order).
