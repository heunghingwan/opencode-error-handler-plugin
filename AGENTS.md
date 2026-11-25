# AGENTS.md

## opencode-error-handler-plugin

OpenCode v2 插件：按供應商客製錯誤處理（智慧重試、額度感知等待、RPC 通知）。

## ⚠️ 目錄結構紅線

**插件源碼絕不放在 `.opencode/plugins/` 下。**

OpenCode 會自動載入任何設定目錄（專案的 `.opencode/`、全域 `~/.config/opencode/`）下的
`plugin/` 或 `plugins/` 子目錄裡的所有 `.ts`/`.js`（`packages/core/src/plugin/source-directory.ts`）。
本插件會改動重試行為，開發中的半成品絕不能自動生效。

```
opencode-error-handler-plugin/
├── package.json            # main 指向 src/ 進入點；依賴 @opencode/plugin
├── src/                    # 插件源碼（index.ts + providers/ + 模組）
│   └── providers/          # 每個供應商一個獨立檔案，新增供應商＝新增檔案
├── test/                   # bun test
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

- TypeScript，logger 與檔案式設定模式比照
  `/path/to/opencode-remote-notifier-plugin`（但目錄結構照上面的紅線）
- 測試用 bun test（`test/`）
- 用戶設定檔放 `~/.config/opencode/`，repo 內只放範本
- 通知一律走 remote-notifier 的 RPC，本插件不自建通知系統
- OpenCode 源碼參考：`/path/to/opencode-source`
  - 內建重試：`packages/core/src/model-retry.ts`
  - retry hook 接線：`packages/core/src/session/runner/retry.ts`
  - 錯誤分類：`packages/ai/src/provider-error.ts`
  - hook 介面：`packages/plugin/src/promise/session.ts`
  - 官方插件文件：`services/www/src/docs/content/build/plugins/`（server.mdx、rpc.mdx）
