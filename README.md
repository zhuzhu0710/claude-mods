# zhuzhu-mods

zhuzhu0710 自己的 Claude Code 模組市集。

| 模組 | 用途 |
| --- | --- |
| usage-band | 輸入框上方的用量資訊條 |
| context-handoff | context 用到七成時的交接按鈕 |
| cache-timer | 提示快取剩五分鐘時提醒 |
| edit-guard | 跨對話編輯同一檔案時提醒 |

在專案的 `.claude/settings.json` 加入下面設定，雲端對話開始時就會自動安裝：

```json
{
  "extraKnownMarketplaces": {
    "zhuzhu-mods": { "source": { "source": "github", "repo": "zhuzhu0710/claude-mods" } }
  },
  "enabledPlugins": {
    "usage-band@zhuzhu-mods": true,
    "context-handoff@zhuzhu-mods": true,
    "cache-timer@zhuzhu-mods": true,
    "edit-guard@zhuzhu-mods": true
  }
}
```
