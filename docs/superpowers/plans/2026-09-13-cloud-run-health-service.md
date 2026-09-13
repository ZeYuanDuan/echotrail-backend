# Cloud Run Health Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Dockerized TypeScript/Fastify service with a public `GET /health` endpoint that can be manually built by Cloud Build and deployed to Cloud Run.

**Architecture:** `src/app.ts` owns Fastify route registration and can be tested through Fastify injection without opening a TCP listener. `src/config.ts` validates the Cloud Run port contract; `src/server.ts` is the thin process entrypoint which binds the app to `0.0.0.0`. Docker builds TypeScript once, and the runtime image contains only compiled application files plus production dependencies.

**Tech Stack:** Node.js 22 LTS, npm, TypeScript strict mode, Fastify 5, Vitest, Docker, Cloud Build, Artifact Registry, Cloud Run.

**Spec:** `docs/adr/0001-initial-backend-foundation.md`

## Global Constraints

- Use the company GCP project `echotrail-dev-508500-k6` only through Google Cloud Console; do not invoke `gcloud` CLI.
- Use `asia-east1` for Artifact Registry and Cloud Run.
- Use the Docker Artifact Registry repository `echotrail` and image name `echotrail-backend`.
- Do not create a GitHub branch-triggered build or any CI/CD automation.
- Use Node.js 22 LTS, npm lockfile, TypeScript `strict`, and Fastify.
- The only application endpoint in this milestone is unauthenticated `GET /health`, returning HTTP 200 with exactly `{ "status": "ok" }`.
- Do not add authentication, databases, LLM clients, environment-secret handling, or business routes.

---

## Planned file structure

| File | Responsibility |
| --- | --- |
| `package.json` | Node engine, scripts, production and development dependencies. |
| `package-lock.json` | Reproducible npm dependency graph. |
| `tsconfig.json` | Strict TypeScript compilation from `src/` to `dist/`. |
| `src/app.ts` | Construct the Fastify app and register the health route. |
| `src/config.ts` | Convert the optional `PORT` environment value into a valid TCP port. |
| `src/server.ts` | Start the app on Cloud Run's port and `0.0.0.0`. |
| `test/health.test.ts` | HTTP-level health contract test using Fastify injection. |
| `test/config.test.ts` | Port-resolution behavior tests. |
| `Dockerfile` | Multi-stage Node 22 build and production runtime image. |
| `.dockerignore` | Exclude local artifacts from Docker build context. |
| `cloudbuild.yaml` | Build and publish the image to the approved Artifact Registry path. |
| `README.md` | Local commands and the Console-only deployment runbook. |

### Task 1: Establish the testable TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `test/health.test.ts`
- Create: `src/app.ts`
- Create: `package-lock.json`

**Interfaces:**
- Produces: `buildApp(): FastifyInstance` from `src/app.ts`.
- Produces: `npm run build`, `npm start`, and `npm test` scripts.

- [ ] **Step 1: Create the npm manifest and TypeScript compiler configuration**

```json
{
  "name": "echotrail-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "test": "vitest run"
  },
  "dependencies": { "fastify": "^5.12.4" },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.20.6",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Install the manifest dependencies and create the lockfile**

Run: `npm install`

Expected: `package-lock.json` is created and `npm` exits 0 under Node.js 22.

- [ ] **Step 3: Write the failing HTTP contract test**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('returns the public service status', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails before implementation**

Run: `npm test -- test/health.test.ts`

Expected: FAIL because `src/app.ts` does not exist.

- [ ] **Step 5: Implement the minimal Fastify app**

```ts
import Fastify, { type FastifyInstance } from 'fastify';

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
};
```

- [ ] **Step 6: Run the health test and TypeScript compiler**

Run: `npm test -- test/health.test.ts && npm run build`

Expected: PASS; compilation creates `dist/app.js` with no TypeScript errors.

- [ ] **Step 7: Commit the testable health application**

```bash
git add package.json package-lock.json tsconfig.json src/app.ts test/health.test.ts
git commit -m "feat: add Fastify health endpoint"
```

### Task 2: Add the Cloud Run server entrypoint

**Files:**
- Create: `src/config.ts`
- Create: `src/server.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Consumes: `buildApp(): FastifyInstance` from `src/app.ts`.
- Produces: `resolvePort(value?: string): number` from `src/config.ts`.
- Produces: executable `dist/server.js` for `npm start` and Docker `CMD`.

- [ ] **Step 1: Write failing port-resolution tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolvePort } from '../src/config.js';

describe('resolvePort', () => {
  it('uses Cloud Run default port when PORT is absent', () => {
    expect(resolvePort()).toBe(8080);
  });

  it('uses an explicit valid PORT value', () => {
    expect(resolvePort('9090')).toBe(9090);
  });

  it('rejects invalid port values', () => {
    expect(() => resolvePort('not-a-port')).toThrow('PORT must be an integer from 1 to 65535');
  });
});
```

- [ ] **Step 2: Run the config test to verify it fails**

Run: `npm test -- test/config.test.ts`

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Implement port resolution and the server entrypoint**

```ts
// src/config.ts
export const resolvePort = (value = process.env.PORT): number => {
  if (value === undefined) return 8080;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  return port;
};
```

```ts
// src/server.ts
import { buildApp } from './app.js';
import { resolvePort } from './config.js';

const app = buildApp();

try {
  await app.listen({ host: '0.0.0.0', port: resolvePort() });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
```

- [ ] **Step 4: Run all unit tests and compile**

Run: `npm test && npm run build`

Expected: PASS; `dist/server.js` imports `dist/app.js` and `dist/config.js` using `.js` module specifiers.

- [ ] **Step 5: Perform a local HTTP smoke test**

Run: `npm start`

Expected: Fastify reports that it is listening on `http://0.0.0.0:8080`; in a second terminal run `curl --fail http://127.0.0.1:8080/health`, which prints `{"status":"ok"}`. Stop the server after the request.

- [ ] **Step 6: Commit the Cloud Run process entrypoint**

```bash
git add src/config.ts src/server.ts test/config.test.ts
git commit -m "feat: listen on Cloud Run port"
```

### Task 3: Containerize and publish the service configuration

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `cloudbuild.yaml`

**Interfaces:**
- Consumes: `package-lock.json`, `tsconfig.json`, `src/`, and `npm run build`.
- Produces: OCI image `asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:$BUILD_ID`.

- [ ] **Step 1: Create Docker build exclusions**

```gitignore
node_modules
dist
.git
.DS_Store
coverage
docs
```

- [ ] **Step 2: Create the multi-stage Node 22 Dockerfile**

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

- [ ] **Step 3: Create the Cloud Build configuration**

```yaml
steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - --tag
      - asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:$BUILD_ID
      - .
images:
  - asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:$BUILD_ID
```

- [ ] **Step 4: Build the image locally and check its public contract**

Run: `docker build --tag echotrail-backend:local .`

Expected: Docker finishes with exit code 0. Then run `docker run --rm --publish 8080:8080 echotrail-backend:local`; in a second terminal run `curl --fail http://127.0.0.1:8080/health`, which prints `{"status":"ok"}`. Stop the container after the request.

- [ ] **Step 5: Verify no private data is embedded in the image configuration**

Run: `docker image inspect echotrail-backend:local --format '{{json .Config.Env}}'`

Expected: output includes `NODE_ENV=production` and contains no credentials, token, database URL, or GCP service-account key.

- [ ] **Step 6: Commit container and Cloud Build configuration**

```bash
git add Dockerfile .dockerignore cloudbuild.yaml
git commit -m "build: add Cloud Run container configuration"
```

### Task 4: Document local validation and Console-only deployment

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: image name and project/region constants from `cloudbuild.yaml`.
- Produces: an operator runbook with no `gcloud` commands and no GitHub branch-trigger setup.

- [ ] **Step 1: Add local development and test commands**

Add a `## Local development` section containing exactly these commands:

```bash
npm ci
npm test
npm run build
npm start
curl --fail http://127.0.0.1:8080/health
```

State that `PORT` overrides `8080`, and that the expected response body is `{"status":"ok"}`.

- [ ] **Step 2: Add Docker validation commands**

Add a `## Docker validation` section containing:

```bash
docker build --tag echotrail-backend:local .
docker run --rm --publish 8080:8080 echotrail-backend:local
curl --fail http://127.0.0.1:8080/health
```

- [ ] **Step 3: Add the manual Google Cloud Console runbook**

Document these actions in order:

1. Sign in to Google Cloud Console with the company account and select project `echotrail-dev-508500-k6`.
2. Enable Cloud Build, Artifact Registry, and Cloud Run if Console prompts for them.
3. In Artifact Registry, create `echotrail` only if absent: format **Docker**, mode **Standard**, location type **Region**, region **asia-east1**.
4. In Cloud Build, configure a **manual** build from the chosen source revision using repository-root `cloudbuild.yaml`; do not configure a push, pull-request, or tag event. Wait for the build to show `SUCCESS`, then copy the emitted Artifact Registry image URI.
5. In Cloud Run, select **Deploy one revision from an existing container image**, choose that URI, name the service `echotrail-backend`, select **asia-east1**, and choose **Allow public access**.
6. After the service is ready, open `<Cloud Run service URL>/health` and verify HTTP 200 with `{"status":"ok"}`.

- [ ] **Step 4: State the required permission escalation path**

Add that missing Console permissions must be requested from the company project administrator; do not attempt to bypass them with a personal account, service-account key, Cloud Shell, or local `gcloud` CLI.

- [ ] **Step 5: Review the README commands against repository scripts and image path**

Run: `rg -n 'npm ci|npm test|npm run build|npm start|asia-east1-docker.pkg.dev|gcloud|trigger' README.md package.json cloudbuild.yaml`

Expected: local commands match `package.json`; the image path matches `cloudbuild.yaml`; README has no `gcloud` command and says no branch trigger is configured.

- [ ] **Step 6: Commit the operator documentation**

```bash
git add README.md
git commit -m "docs: add Cloud Run deployment runbook"
```

### Task 5: Final verification and delivery

**Files:**
- Verify: all files listed in the planned file structure.

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: a verified local and containerized service ready for the user's Console deployment.

- [ ] **Step 1: Verify the clean TypeScript and test checks**

Run: `npm ci && npm test && npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Verify the Docker image and endpoint one final time**

Run: `docker build --tag echotrail-backend:verify .`

Expected: exit 0. Run the image, call `curl --fail http://127.0.0.1:8080/health`, confirm HTTP 200 and `{"status":"ok"}`, then stop the container.

- [ ] **Step 3: Review the final Git state**

Run: `git status --short && git log --oneline -5`

Expected: only intentional changes are present; each implementation task has its focused commit.

- [ ] **Step 4: Hand off the Console deployment checklist**

Report the exact Artifact Registry image URI format, the Cloud Run service name, the target region, the `/health` URL suffix, and any Console permission error verbatim. Do not perform Cloud Console operations or use `gcloud` CLI.

## Plan self-review

- **Spec coverage:** Task 1 delivers Fastify and public `/health`; Task 2 implements the `PORT` and `0.0.0.0` Cloud Run process contract; Task 3 delivers Node 22 Docker and Cloud Build publishing; Task 4 documents the manual Console-only workflow and no-trigger constraint; Task 5 verifies the requested outcomes.
- **Placeholder scan:** No incomplete marker, deferred implementation instruction, or unspecified interface remains.
- **Type consistency:** `buildApp()` is produced by Task 1 and consumed by Task 2; `resolvePort()` is produced by Task 2 and used only by `src/server.ts`; Docker executes the `dist/server.js` produced by TypeScript compilation.
