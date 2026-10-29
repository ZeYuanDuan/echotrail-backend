# Budget guard：超過預算就停用計費

本專案是概念驗證作品，為避免異常支出（API 被濫用、誤開大規格資源），本月實際支出達 **400 TWD** 時，自動解除專案 `echotrail-dev-508500-k6` 的帳單綁定，所有付費服務隨即停止。

## 架構

```text
Cloud Billing 預算 echotrail-monthly-guard（每月 500 TWD，僅本專案）
  ├─ 50% / 80% / 100%：寄 email 給帳單管理員
  └─ 每次費用更新：發佈到 Pub/Sub topic budget-alerts
        → push 訂閱 budget-guard-push（OIDC，身分 budget-guard-push@）
        → Cloud Run 服務 budget-guard（不公開，身分 budget-guard-runtime@）
             costAmount >= THRESHOLD → PUT billingInfo { billingAccountName: "" }
```

- 預算 ID：`68de33c4-c27c-40f7-9e12-62a93bd866f4`，帳單帳戶 `010216-51B746-CA6978`。
- 門檻 400 TWD 而非 500 TWD：帳單數據通常延遲數小時，預留延遲期間繼續產生的費用。
- `budget-guard-runtime` 需要本專案的 **Project Billing Manager**（`roles/billing.projectManager`）才能解除綁定。
- 環境變數：`PROJECT_ID`、`THRESHOLD`、`CURRENCY`（預設 TWD）、`BUDGET_ID`（只處理此預算）、`DRY_RUN`（`true` 時只檢查權限、不解除綁定）。

## 停用計費的後果

解除綁定後 Cloud Run、Cloud SQL 等付費資源都會停止，網站失效。Google 表示計費停用過久，資源可能被刪除，因此觸發後請盡快決定要恢復還是放棄。匯出備份在 `gs://echotrail-dev-508500-k6-sql-migration/`（計費停用時同樣無法存取）。

## 恢復

1. Console → **Billing → Account management**，把 `echotrail-dev-508500-k6` 重新連結到帳單帳戶（或 `gcloud billing projects link echotrail-dev-508500-k6 --billing-account=010216-51B746-CA6978`）。
2. 確認 Cloud SQL `echotrail-pg` 為 `RUNNABLE`；若否，到實例頁啟動。
3. 若當月支出仍高於門檻，下一則預算通知會再次停用計費。要在同月恢復，先把 `THRESHOLD` 調高或暫時設 `DRY_RUN=true`。

## 部署與測試

```bash
gcloud run deploy budget-guard --source ops/budget-guard --region asia-east1 \
  --project echotrail-dev-508500-k6 \
  --service-account=budget-guard-runtime@echotrail-dev-508500-k6.iam.gserviceaccount.com \
  --no-allow-unauthenticated --max-instances=1 --memory=256Mi \
  --set-env-vars=PROJECT_ID=echotrail-dev-508500-k6,THRESHOLD=400,CURRENCY=TWD,BUDGET_ID=68de33c4-c27c-40f7-9e12-62a93bd866f4,DRY_RUN=false
```

先設 `DRY_RUN=true`，再發一則假通知，於 Cloud Logging 確認 `action: dry-run`、`canDisable: true`：

```bash
gcloud pubsub topics publish budget-alerts --project echotrail-dev-508500-k6 \
  --attribute=budgetId=68de33c4-c27c-40f7-9e12-62a93bd866f4 \
  --message='{"costAmount":450,"budgetAmount":500,"currencyCode":"TWD"}'
```

單元測試：`npx vitest run test/budget-guard.test.ts`。
