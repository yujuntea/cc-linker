# job-state fixtures

15 个合成 `~/.claude/jobs/<short>/state.json` 文件 + 3 个负面样本。

文件名约定:`NN-<state>-<short-name>.json`
- 01..15 是 happy path(state 取值覆盖 running / working / blocked / done / stopped)
- neg-* 是负面 case

## 用途

供 `src/agent-view/job-state.ts` 的单元/集成测试使用,验证:
- 各种 state 枚举值(running / working / blocked / done / stopped)的解析
- `needs` / `linkScanPath` / `mtimeMs` 等关键字段透传
- 文件损坏、缺失、未知 state 等错误路径
- 撕写竞争(race retry, v2.3.1)的恢复行为

## 字段覆盖

每个 happy fixture 包含:
- `state`: envelope 顶层 state 值
- `tempo`: idle / active / blocked
- `detail` / `needs` / `output`: 业务内容
- `inFlight`: 任务队列快照
- `linkScanPath` / `linkScanOffset`: 关联 JSONL 路径 + 偏移
- `name` / `nameSource` / `intent`: 会话命名来源
- `respawnFlags`: respawn 命令行参数
- `providerEnv`: ANTHROPIC_MODEL 等环境变量
- `cwd` / `sessionId` / `resumeSessionId` / `daemonShort` / `cliVersion` / `backend`
- `createdAt` / `updatedAt` / `firstTerminalAt`: 时间戳

## 合成特性

- 所有路径前缀为 `/Users/tester/`,不绑定任何真实用户环境
- provider / model 名称为占位符(`provider-a` / `provider-c-model[1m]` 等)
- 时间戳在 2026-06-06 至 2026-06-09 范围内,保留 state 转换的时序关系
- 8 字符 short hashes 与 sessionId 复用上游测试场景的命名,便于 diff
