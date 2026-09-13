# EchoTrail 後端雲端架構

## 範圍

本文件說明目前後端的建置、部署與執行流程。現階段服務只提供公開健康檢查，不包含資料庫、LLM、登入或其他業務功能。

## 架構總覽

```text
GitHub 的 dev 分支
        ↓
Cloud Build
        ↓
Artifact Registry
        ↓
Cloud Run
        ↓
公開 HTTP API：GET /health
```

Artifact Registry 與 Cloud Run 使用相同區域。這可讓部署流程保持單純。

## 元件責任

| 元件 | 責任 |
| --- | --- |
| GitHub | 保存原始碼。`dev` 分支是目前的部署來源。 |
| Cloud Build | 在 `dev` 有新變更時建置容器映像，推送映像，並部署 Cloud Run。 |
| Artifact Registry | 保存可部署的容器映像。每個映像以對應的 commit 版本識別。 |
| Cloud Run | 執行後端服務。每次部署建立新的 revision。 |
| 執行身分 | 代表 Cloud Run 中的應用程式存取 GCP 資源。它與 Cloud Build 的建置身分分離。 |

## 部署流程

1. 開發者將 Pull Request 合併至 `dev`。
2. Cloud Build 讀取 repository 中的部署設定與 Dockerfile。
3. Cloud Build 建置容器映像，並推送至 Artifact Registry。
4. Cloud Build 將該映像部署為 Cloud Run 的新 revision。
5. Cloud Run 在新 revision 就緒後提供 HTTP 服務。

## 存取邊界

目前 Cloud Run service 允許未驗證請求。這表示公開設定套用於整個 service，而不只套用於 `/health`。

目前唯一的路由是 `GET /health`。新增其他路由前，團隊必須先確認認證與授權設計，再決定是否維持公開存取。

## 驗證方式

每次部署後，依序確認：

1. Cloud Build 的建置、推送與部署步驟皆成功。
2. Cloud Run 顯示最新 revision 已就緒。
3. 呼叫 `<Cloud Run URL>/health`，取得 HTTP 200 與 `{"status":"ok"}`。

若 Cloud Build 的部署步驟失敗，先檢查建置身分是否具有部署 Cloud Run 與使用執行身分的權限。
