# EchoTrail 後端雲端架構

## 範圍

本文件說明後端的建置、migration、部署與執行流程。服務提供對話與產卡預覽，並在確認卡片後保存事件與洞見；Cloud SQL 連線與部署前檢查見 [Cloud SQL 設定](cloud-sql-setup.md)。

## 架構總覽

```text
GitHub 的 dev 分支
        ↓
Cloud Build
        ↓
Artifact Registry
        ↓
Cloud Run migration job（成功才繼續）
        ↓
Cloud Run service
        ├─ HTTP API：健康檢查、LLM 預覽、使用者、事件、Dashboard
        ├─ Gemini API：對話、預覽、明確重算時的整體摘要
        └─ Cloud SQL：事件、洞見、訊號與 Dashboard 快照
```

Artifact Registry 與 Cloud Run 使用相同區域。這可讓部署流程保持單純。

## 元件責任

| 元件 | 責任 |
| --- | --- |
| GitHub | 保存原始碼。`dev` 分支是目前的部署來源。 |
| Cloud Build | 在 `dev` 有新變更時建置並推送映像，等待 migration job 成功後才部署 service。 |
| Artifact Registry | 保存可部署的容器映像。每個映像以對應的 commit 版本識別。 |
| Cloud Run | 執行後端服務。每次部署建立新的 revision。 |
| 執行身分 | 代表 Cloud Run 中的應用程式存取 GCP 資源。它與 Cloud Build 的建置身分分離。 |

## 部署流程

1. 開發者將 Pull Request 合併至 `dev`。
2. Cloud Build 讀取 repository 中的部署設定與 Dockerfile。
3. Cloud Build 建置容器映像，並推送至 Artifact Registry。
4. Cloud Build 用同一映像部署本次建置專屬的 `et-mig-$BUILD_ID` job，並以 `--wait` 執行。
5. Job 成功後，Cloud Build 才部署 Cloud Run 的新 revision。失敗時舊 service 繼續運作。

## 存取邊界

目前 Cloud Run service 允許未驗證請求。這表示公開設定套用於整個 service，而不只套用於 `/health`。

所有 API 路由都受 service 的公開設定影響。暱稱與 user ID 只提供一次性展示的資料分隔，並非認證。正式公開使用前須加入可驗證的身分及授權。

## 驗證方式

每次部署後，依序確認：

1. Cloud Build 的建置、推送、migration job 與部署步驟皆成功。
2. Cloud Run 顯示最新 revision 已就緒。
3. 呼叫 `<Cloud Run URL>/health`，取得 HTTP 200 與 `{"status":"ok"}`。
4. 確認一張卡片後讀取 `/api/events?userId=...`；未按更新前 `/api/dashboard` 應保持舊快照，更新成功後應讀到新的 `dashboard_runs`。

若 Cloud Build 的部署步驟失敗，先檢查建置身分是否具有部署 Cloud Run 與使用執行身分的權限。
