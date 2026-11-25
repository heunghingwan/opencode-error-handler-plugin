# AGENTS.md

## opencode-error-handler-plugin

OpenCode v2 插件：按供應商客製錯誤處理（智慧重試、額度感知等待、RPC 通知）。

## 開始任何工作前

如果本地存在 `HANDOFF.md`（未追蹤的交接文件），**先完整讀取**。它包含：

- 已對源碼驗證的 OpenCode 重試機制與 `session.retry` hook 事實（勿重複調查）
- zhipuai-coding-plan 錯誤格式（1302/1308/1305）
- 與用戶定案的設計（A＋分段、RPC 通知）
- 本機參考路徑（OpenCode 源碼 checkout、模板插件）

## ⚠️ 目錄結構紅線

**插件源碼絕不放在 `.opencode/plugins/` 下。**

OpenCode 會自動載入任何設定目錄（專案的 `.opencode/`、全域 `~/.config/opencode/`）下的
`plugin/` 或 `plugins/` 子目錄裡的所有 `.ts`/`.js`（`packages/core/src/plugin/source-directory.ts`）。
remote-notifier 之前放在 `.opencode/plugins/` 才會「在倉庫裡開發就自己載入」。
本插件會改動重試行為，開發中的半成品絕不能自動生效。

```
opencode-error-handler-plugin/
├── package.json            # main 指向 src/ 進入點；依賴 @opencode/plugin
├── src/                    # 插件源碼（index.ts + 模組）
├── test/                   # bun test
├── HANDOFF.md              # 僅本地，不入庫（見 .gitignore）
└── README.md
```

## 載入方式（三個階段）

1. **開發中（不自動生效）**：本倉庫內不放任何指向自己的設定。
2. **實機測試**：在一個**拋棄式測試目錄**（不在本倉庫內）放 `opencode.jsonc`：
   `"plugins": ["file:///path/to/opencode-error-handler-plugin"]`，
   在那裡開 session 觸發／模擬錯誤驗證。原始碼修改會熱重載。
3. **正式使用**：全域 `~/.config/opencode/opencode.jsonc` 加
   `"opencode-error-handler-plugin@git+https://github.com/heunghingwan/opencode-error-handler-plugin.git"`。

## 慣例

- TypeScript，_logger／檔案式設定模式_ 比照 remote-notifier，但目錄結構照上面的紅線
- 測試用 bun test（`test/`）
- 用戶設定檔放 `~/.config/opencode/`，repo 內只放範本
- 通知一律走 remote-notifier 的 RPC，本插件不自建通知系統
