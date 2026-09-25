# Cloud Run 健康檢查服務實作計畫

> **歷史里程碑：** 本計畫記錄 2026-09-13 建立後端基礎服務時的限制與步驟；核取方塊未同步標示現況。現在的持久化與 Cloud Build migration 工作請依 2026-09-25 的計畫及目前程式碼執行，不要把本文件的「無資料庫／無 LLM／無 trigger」限制套用到新工作。

> **供實作代理參考：** 必須使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans，依序完成本計畫各任務。步驟以核取方塊（`- [ ]`）追蹤。

**目標：** 建立可用 Cloud Build 手動建置並部署到 Cloud Run 的 Docker 化 TypeScript／Fastify 服務，提供公開的 `GET /health` 端點。

**架構：** `src/app.ts` 建立 Fastify 路由，不開啟 TCP 監聽也能用 Fastify injection 測試。`src/config.ts` 驗證 Cloud Run 連接埠；`src/server.ts` 是精簡的程序入口，將應用程式綁定到 `0.0.0.0`。Docker 建置一次 TypeScript，執行階段映像只包含編譯後檔案及正式環境依賴套件。

**技術：** Node.js 22 LTS、npm、TypeScript strict 模式、Fastify 5、Vitest、Docker、Cloud Build、Artifact Registry、Cloud Run。

**規格：** `docs/adr/0001-initial-backend-foundation.md`

## 全域限制

- 此階段僅透過 Google Cloud Console 操作公司 GCP 專案 `echotrail-dev-508500-k6`，不呼叫 `gcloud` CLI。
- Artifact Registry 與 Cloud Run 使用 `asia-east1`。
- Docker Artifact Registry repository 名稱為 `echotrail`，映像名稱為 `echotrail-backend`。
- 不建立由 GitHub 分支觸發的建置或其他 CI/CD 自動化。
- 使用 Node.js 22 LTS、npm lockfile、TypeScript `strict` 及 Fastify。
- 此里程碑唯一的應用程式端點是無須驗證的 `GET /health`，須回傳 HTTP 200 且內容恰為 `{ "status": "ok" }`。
- 此階段不加入身分驗證、資料庫、LLM client、環境 Secret 處理或業務路由。

---

## 預計檔案結構

| 檔案 | 職責 |
| --- | --- |
| `package.json` | Node 版本限制、腳本、正式與開發依賴。 |
| `package-lock.json` | 可重現的 npm 依賴關係。 |
| `tsconfig.json` | 將 `src/` 以 TypeScript strict 模式編譯到 `dist/`。 |
| `src/app.ts` | 建立 Fastify 應用程式並註冊健康檢查路由。 |
| `src/config.ts` | 將選填的 `PORT` 環境變數轉成有效 TCP 連接埠。 |
| `src/server.ts` | 在 Cloud Run 指定連接埠及 `0.0.0.0` 啟動應用程式。 |
| `test/health.test.ts` | 使用 Fastify injection 測試 HTTP 健康檢查契約。 |
| `test/config.test.ts` | 測試連接埠解析行為。 |
| `Dockerfile` | 多階段 Node 22 建置與正式環境映像。 |
| `.dockerignore` | 排除 Docker 建置目錄中的本機產物。 |
| `cloudbuild.yaml` | 建置映像並推送到核准的 Artifact Registry 路徑。 |
| `README.md` | 本機指令與只使用 Console 的部署操作說明。 |

### 任務 1：建立可測試的 TypeScript 專案

**檔案：**
- 新增：`package.json`
- 新增：`tsconfig.json`
- 新增：`test/health.test.ts`
- 新增：`src/app.ts`
- 新增：`package-lock.json`

**介面：**
- 提供：`src/app.ts` 的 `buildApp(): FastifyInstance`。
- 提供：`npm run build`、`npm start` 與 `npm test` 腳本。

- [ ] **步驟 1：建立 npm manifest 與 TypeScript 編譯器設定**

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

- [ ] **步驟 2：安裝 manifest 所列依賴並建立 lockfile**

執行：`npm install`

預期：建立 `package-lock.json`，且 Node.js 22 下的 `npm` 以狀態碼 0 結束。

- [ ] **步驟 3：先寫會失敗的 HTTP 契約測試**

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

- [ ] **步驟 4：執行測試，確認實作前會失敗**

執行：`npm test -- test/health.test.ts`

預期：`src/app.ts` 尚不存在，因此測試失敗。

- [ ] **步驟 5：實作最小的 Fastify 應用程式**

```ts
import Fastify, { type FastifyInstance } from 'fastify';

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
};
```

- [ ] **步驟 6：執行健康檢查測試與 TypeScript 編譯器**

執行：`npm test -- test/health.test.ts && npm run build`

預期：測試通過；編譯建立 `dist/app.js`，沒有 TypeScript 錯誤。

- [ ] **步驟 7：提交可測試的健康檢查應用程式**

```bash
git add package.json package-lock.json tsconfig.json src/app.ts test/health.test.ts
git commit -m "feat: add Fastify health endpoint"
```

### 任務 2：加入 Cloud Run 伺服器入口

**檔案：**
- 新增：`src/config.ts`
- 新增：`src/server.ts`
- 新增：`test/config.test.ts`

**介面：**
- 使用：`src/app.ts` 的 `buildApp(): FastifyInstance`。
- 提供：`src/config.ts` 的 `resolvePort(value?: string): number`。
- 提供：可由 `npm start` 與 Docker `CMD` 執行的 `dist/server.js`。

- [ ] **步驟 1：先寫會失敗的連接埠解析測試**

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

- [ ] **步驟 2：執行設定測試，確認會失敗**

執行：`npm test -- test/config.test.ts`

預期：`src/config.ts` 尚不存在，因此測試失敗。

- [ ] **步驟 3：實作連接埠解析與伺服器入口**

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

- [ ] **步驟 4：執行全部單元測試與編譯**

執行：`npm test && npm run build`

預期：測試通過；`dist/server.js` 以 `.js` 模組路徑匯入 `dist/app.js` 與 `dist/config.js`。

- [ ] **步驟 5：執行本機 HTTP 冒煙測試**

執行：`npm start`

預期：Fastify 回報正在 `http://0.0.0.0:8080` 監聽；在另一個終端執行 `curl --fail http://127.0.0.1:8080/health`，應輸出 `{"status":"ok"}`。請求完成後停止伺服器。

- [ ] **步驟 6：提交 Cloud Run 程序入口**

```bash
git add src/config.ts src/server.ts test/config.test.ts
git commit -m "feat: listen on Cloud Run port"
```

### 任務 3：容器化並發布服務設定

**檔案：**
- 新增：`Dockerfile`
- 新增：`.dockerignore`
- 新增：`cloudbuild.yaml`

**介面：**
- 使用：`package-lock.json`、`tsconfig.json`、`src/` 與 `npm run build`。
- 提供：OCI 映像 `asia-east1-docker.pkg.dev/echotrail-dev-508500-k6/echotrail/echotrail-backend:$BUILD_ID`。

- [ ] **步驟 1：建立 Docker 建置排除清單**

```gitignore
node_modules
dist
.git
.DS_Store
coverage
docs
```

- [ ] **步驟 2：建立多階段 Node 22 Dockerfile**

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

- [ ] **步驟 3：建立 Cloud Build 設定**

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

- [ ] **步驟 4：在本機建置映像並驗證公開端點**

執行：`docker build --tag echotrail-backend:local .`

預期：Docker 以狀態碼 0 結束。接著執行 `docker run --rm --publish 8080:8080 echotrail-backend:local`，在另一個終端執行 `curl --fail http://127.0.0.1:8080/health`，應輸出 `{"status":"ok"}`。請求完成後停止容器。

- [ ] **步驟 5：確認映像設定未嵌入私人資料**

執行：`docker image inspect echotrail-backend:local --format '{{json .Config.Env}}'`

預期：輸出包含 `NODE_ENV=production`，不含憑證、token、資料庫 URL 或 GCP 服務帳號金鑰。

- [ ] **步驟 6：提交容器與 Cloud Build 設定**

```bash
git add Dockerfile .dockerignore cloudbuild.yaml
git commit -m "build: add Cloud Run container configuration"
```

### 任務 4：記錄本機驗證與 Console 部署流程

**檔案：**
- 修改：`README.md`

**介面：**
- 使用：`cloudbuild.yaml` 中的映像名稱、專案與區域常數。
- 提供：不含 `gcloud` 指令或 GitHub 分支 trigger 設定的操作指南。

- [ ] **步驟 1：加入本機開發與測試指令**

新增 `## Local development` 區塊，內容須包含以下指令：

```bash
npm ci
npm test
npm run build
npm start
curl --fail http://127.0.0.1:8080/health
```

說明 `PORT` 可覆寫 `8080`，預期回應內容為 `{"status":"ok"}`。

- [ ] **步驟 2：加入 Docker 驗證指令**

新增 `## Docker validation` 區塊，內容如下：

```bash
docker build --tag echotrail-backend:local .
docker run --rm --publish 8080:8080 echotrail-backend:local
curl --fail http://127.0.0.1:8080/health
```

- [ ] **步驟 3：加入手動 Google Cloud Console 部署指南**

依下列順序記錄操作：

1. 使用公司帳號登入 Google Cloud Console，選擇 `echotrail-dev-508500-k6` 專案。
2. 如果 Console 提示，啟用 Cloud Build、Artifact Registry 與 Cloud Run。
3. 在 Artifact Registry 中，僅於 `echotrail` 不存在時建立：格式選 **Docker**、模式選 **Standard**、位置類型選 **Region**、區域選 **asia-east1**。
4. 在 Cloud Build，使用所選來源版本與 repository 根目錄的 `cloudbuild.yaml` 設定**手動**建置；不設定 push、pull request 或 tag 事件。等待建置顯示 `SUCCESS`，再複製產生的 Artifact Registry 映像 URI。
5. 在 Cloud Run 選擇 **Deploy one revision from an existing container image**，指定該 URI，服務名稱設為 `echotrail-backend`、區域設為 **asia-east1**，並選擇 **Allow public access**。
6. 服務就緒後，開啟 `<Cloud Run service URL>/health`，確認 HTTP 200 與 `{"status":"ok"}`。

- [ ] **步驟 4：說明必要的權限申請路徑**

若缺少 Console 權限，須向公司專案管理員申請；不得以個人帳號、服務帳號金鑰、Cloud Shell 或本機 `gcloud` CLI 繞過。

- [ ] **步驟 5：對照 repository 腳本與映像路徑檢查 README 指令**

執行：`rg -n 'npm ci|npm test|npm run build|npm start|asia-east1-docker.pkg.dev|gcloud|trigger' README.md package.json cloudbuild.yaml`

預期：本機指令與 `package.json` 一致；映像路徑與 `cloudbuild.yaml` 一致；README 不含 `gcloud` 指令，並說明未設定分支 trigger。

- [ ] **步驟 6：提交操作文件**

```bash
git add README.md
git commit -m "docs: add Cloud Run deployment runbook"
```

### 任務 5：最後驗證與交付

**檔案：**
- 驗證：預計檔案結構中列出的所有檔案。

**介面：**
- 使用：已完成的任務 1–4。
- 提供：經過本機及容器驗證、可供使用者透過 Console 部署的服務。

- [ ] **步驟 1：確認 TypeScript 與測試檢查結果**

執行：`npm ci && npm test && npm run build`

預期：全部指令以狀態碼 0 結束。

- [ ] **步驟 2：最後一次驗證 Docker 映像與端點**

執行：`docker build --tag echotrail-backend:verify .`

預期：建置以狀態碼 0 結束。啟動映像、呼叫 `curl --fail http://127.0.0.1:8080/health`、確認 HTTP 200 與 `{"status":"ok"}`，最後停止容器。

- [ ] **步驟 3：檢查最後的 Git 狀態**

執行：`git status --short && git log --oneline -5`

預期：僅有預定變更；每個實作任務都有獨立的提交。

- [ ] **步驟 4：交付 Console 部署檢查清單**

回報確切的 Artifact Registry 映像 URI 格式、Cloud Run 服務名稱、目標區域、`/health` URL 後綴，以及任何 Console 權限錯誤的原文。不得執行 Cloud Console 操作或使用 `gcloud` CLI。

## 計畫自我檢查

- **規格涵蓋：** 任務 1 提供 Fastify 與公開 `/health`；任務 2 實作 `PORT` 與 `0.0.0.0` 的 Cloud Run 程序契約；任務 3 提供 Node 22 Docker 與 Cloud Build 映像發布；任務 4 記錄僅使用 Console 的手動流程及不建立 trigger 的限制；任務 5 驗證要求的結果。
- **佔位內容檢查：** 沒有未完成標記、延期實作指示或未指明的介面。
- **型別一致性：** 任務 1 提供 `buildApp()`，任務 2 使用它；任務 2 提供 `resolvePort()`，只有 `src/server.ts` 使用；Docker 執行 TypeScript 編譯產生的 `dist/server.js`。
