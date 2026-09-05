# EchoTrail Backend

「曼陀號 PM x ENG 合作專案 EchoTrail」的後端 Repository。

## 技術選型

本專案採用 **TypeScript + Node.js + Fastify**，並部署至 Cloud Run。

- 與前端共用 TypeScript 生態系，便於維護 API contract 與協作開發。
- 適合處理 LLM 串接與串流回覆等 I/O 密集流程。
- Fastify 內建良好的 schema 驗證、結構化 logging 與 plugin 架構，適合建立可維護的 API。

## 分支規範

- `dev` 會觸發持續部署（Continuous Deployment）。
- 請先將改動推送至個人分支，再透過 Pull Request 合併至 `dev`。