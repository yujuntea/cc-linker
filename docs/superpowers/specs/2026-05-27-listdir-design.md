# /listDir: Feishu Directory Browser

**Date**: 2026-05-27
**Status**: Approved
**Scope**: Single-file change in `src/feishu/bot.ts`

## Problem

Users working in Feishu cannot easily browse or switch the working directory for new Claude sessions. Currently they must type `/new /full/path` manually, which is cumbersome on mobile.

## Solution

Add a `/listDir` command that lists subdirectories of the current working directory as an interactive Feishu card. Users click a directory button to set it as the cwd for their next session.

## User Flow

```
User: /listDir
Bot:  [Card] 📂 目录浏览
      当前路径: /Users/tester/Git
      ⬆️ 上级目录 [→ 进入]
      ─────────────
      📁 cc-linker  [→ 进入]
      📁 my-project [→ 进入]
      📁 dotfiles   [→ 进入]

User: *clicks "→ 进入" on cc-linker*
Bot:  ✅ 已切换到 /Users/tester/Git/cc-linker
      发送消息即可在该目录创建新会话。

User: hello
Bot:  [creates new session in /Users/tester/Git/cc-linker]
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Click action | Switch cwd + text confirmation | Simplest, most reliable |
| Session scope | Only update pending cwd | Don't affect active session |
| Hidden dirs | Filter (`.` prefix) | Cleaner, avoids .git/.env clutter |
| Fallback cwd | `feishu_bot.default_cwd` | Consistent with /new behavior |
| Parent nav | Provide `⬆️ 上级目录` button | Essential for navigation |
| Max items | 15 subdirectories | Prevents overly long cards |
| Implementation | Inline in bot.ts | Follows /list, /model pattern |

## Architecture

### Components (all in `src/feishu/bot.ts`)

1. **`getCwdForUser(openId): string`** — resolve current cwd from user state
2. **`handleListDir(msg)`** — text command handler
3. **`doListDir(openId, messageId, msg?)`** — shared logic for text + card actions
4. **`doSelectDir(openId, path, messageId)`** — handle directory button click
5. **`buildDirListCard(cwd, entries, parent)`** — card builder function

### Routing

**Text command** in `handleCommand()`:
```
case 'listdir':
  await this.handleListDir(msg);
  return;
```

**Card action** in `handleCardAction()` switch:
```
case 'select_dir':
  return await this.doSelectDir(openId, sessionId, messageId);
```

Button value follows existing pattern: `{ tag: 'select_dir', sessionId: dirPath }`. No changes needed in `start.ts`.

### getCwdForUser — Priority Order

1. Active session: `entry.cwd || registry.get(entry.sessionUuid).cwd`
2. Pending entry: `entry.cwd`
3. Fallback: `config('feishu_bot.default_cwd', '')`
4. If empty: reply with error asking user to configure `default_cwd`

### doListDir — Directory Reading

```
cwd = getCwdForUser(openId)
validateCwd(cwd)  // security check
entries = readdir(cwd, { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.name.startsWith('.'))
  .sort(by name, case-insensitive)
  .slice(0, 15)
parent = dirname(cwd) if cwd !== dirname(cwd)
card = buildDirListCard(cwd, entries, parent)
```

### buildDirListCard — Card Structure

```
Header: 📂 目录浏览 (blue)

Markdown: **当前路径：** `/full/path`

[if parent exists]
  ⬆️ 上级目录 button → { tag: 'select_dir', sessionId: parentPath }

HR

[for each directory]
  📁 dirname
  → 进入 button → { tag: 'select_dir', sessionId: fullPath }

[if > 15 dirs]
  ... 还有 N 个子目录未显示

[if 0 dirs]
  📁 当前目录下没有子目录
```

### doSelectDir — State Update

1. `normalizeCwd(path)` — resolve `~`, make absolute
2. `validateCwd(normalized)` — check allowed/denied roots
3. `existsSync(normalized)` — verify directory exists
4. CAS update `MappingEntry`:
   - `cwd: normalized`
   - `type: 'pending_new_session'`
   - `sessionUuid: null`
5. Reply: `✅ 已切换到 /path\n发送消息即可在该目录创建新会话。`

### State Transition

```
Before: { type: 'session', sessionUuid: 'abc', cwd: '/old' }
After:  { type: 'pending_new_session', sessionUuid: null, cwd: '/new' }
```

The active session remains in the registry. User can return to it via `/switch` or `/list`.

## Error Handling

| Scenario | Response |
|----------|----------|
| No cwd configured | "请先配置 feishu_bot.default_cwd" |
| Directory not found | "❌ 目录 /path 不存在" |
| Security validation fails | validateCwd error message |
| No read permission | "❌ 无法读取目录: permission denied" |
| CAS failure | "⚠️ 操作冲突，请重试" |
| Card send failure | Fallback to text listing |

## Testing

Unit tests for:
- `getCwdForUser` — all priority cases
- `doListDir` — normal, empty dir, no permission, security rejection
- `doSelectDir` — normal, CAS failure, invalid path
- `buildDirListCard` — with parent, without parent, empty, overflow

## Files Changed

| File | Change |
|------|--------|
| `src/feishu/bot.ts` | Add ~100 lines: 5 methods + 1 card builder + command/action routing + help text |
