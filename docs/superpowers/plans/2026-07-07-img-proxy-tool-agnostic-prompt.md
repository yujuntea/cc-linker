# img-proxy: 去硬编码图片识别工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 img-proxy 默认 `prompt_template` 中硬编码的 `mcp__MiniMax__understand_image` 替换为工具无关的提示(Read / 任意图片 MCP / Bash 调用本地 CLI 如 mmx-cli),让模型按自身能力自选识别路径。

**Architecture:** 仅修改 5 个文件中的默认字符串。无新模块、无 schema bump、无 dep 变化、无 install 流程改动。`{path}` 占位符语义保留(现有 fallback 逻辑依赖)。两处默认文本(transform.ts export + config.ts DEFAULTS)字面一致。

**Tech Stack:** Bun + TypeScript + bun:test。所有改动均在前端 / 字符串常量层。

**Spec:** `docs/superpowers/specs/2026-07-07-img-proxy-tool-agnostic-prompt-design.md`(commit `2fcaef1` on `feat/cli-image-proxy`)

## Global Constraints

- **Bun 项目** — 用 `bun test` / `bun run typecheck`,不用 npm/node
- **测试用 bun:test**(`describe / it / expect`)— 已熟练
- **{path} 必须保留** — `transform.ts:stripImagesToPaths` 用 `template.includes('{path}')` 判定,缺失会回退到 DEFAULT,可能导致循环逻辑
- **两处字面一致** — `src/img-proxy/transform.ts:5-7` 与 `src/utils/config.ts:200` 的 DEFAULT_PROMPT_TEMPLATE 字符串必须 byte-for-byte 一致(测试会锁)
- **中文文案** — 项目内 prompt_template 现有文案已是中文,沿用同一语言风格
- **不引入 MCP 探测** — 不读 `~/.claude.json`、不列用户 MCP、不弹 install 时 picker(YAGNI)
- **不修改用户已配置的 prompt_template** — `[img_proxy].prompt_template` config 字段用户已自配的不动,只在 DEFAULTS 改
- **commit message 用 `feat / fix / docs` 前缀** — 已建立的项目习惯
- **改动每个独立 commit** — 5 文件改动分 4 次 commit,便于 reviewer / 回滚

## 新 DEFAULT_PROMPT_TEMPLATE 完整字面值(全部 task 引用此段)

```
[用户粘贴的图片已保存到本地文件: {path}]
当前模型为纯文本模型,请用以下方式之一查看该图片内容:
1. 调用 Read 工具读取该本地路径(若 Read 支持图片)
2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)
3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)
```

**完全字符串(用于 transform.ts / config.ts;测试断言也以这段为基准)**:

```
'[用户粘贴的图片已保存到本地文件: {path}]\n当前模型为纯文本模型,请用以下方式之一查看该图片内容:\n1. 调用 Read 工具读取该本地路径(若 Read 支持图片)\n2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)\n3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)'
```

---

## File Structure

| 文件 | 改动 | 内容 |
|---|---|---|
| `src/img-proxy/transform.ts:5-7` | MODIFY | `DEFAULT_PROMPT_TEMPLATE` export 值 |
| `src/utils/config.ts:200` | MODIFY | `DEFAULTS.img_proxy.prompt_template` 字面值(必须一致) |
| `src/cli/commands/setup.ts:216` | MODIFY | runImgProxyWizard 灰字提示("如 mcp__MiniMax__..." → "...(Read 工具 / 图片识别 MCP / mmx-cli 等本地 CLI)...") |
| `docs/img-proxy.md` 第 5 / 63 / 702 / 750 / 870 行 | MODIFY | 心智模型 + 前置依赖 + 自定义 prompt + 故障排除 + FAQ 段 |
| `tests/unit/img-proxy/transform.test.ts` 行 83 附近 | ADD | 4 个新断言,锁新行为 |

无 new files,无 new modules。

---

## Task 1: 锁新行为到测试(TDD:写失败测试)

**Files:**
- Modify: `tests/unit/img-proxy/transform.test.ts`(在现有 `it('falls back to DEFAULT_PROMPT_TEMPLATE when template lacks {path}')` 之后追加新 `describe`)

**Interfaces:**
- Consumes: `DEFAULT_PROMPT_TEMPLATE` from `src/img-proxy/transform`(现有 import 已含,行 2)
- Produces: 4 个新断言,验证新默认值含 `{path}`、不再含 `mcp__MiniMax__understand_image`、含三条路径关键词、与 config.ts DEFAULTS 字面一致

- [ ] **Step 1: 在 `tests/unit/img-proxy/transform.test.ts` 末尾追加新 describe 块**

在最后一个 `});`(结尾,大约行 100+ 附近)前追加:

```typescript
describe('DEFAULT_PROMPT_TEMPLATE (2026-07-07 tool-agnostic)', () => {
  // 安全闸:防止以后再有人把单一 MCP 名 hardcode 进 default
  it('does NOT hardcode a specific image-recognition MCP tool', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).not.toContain('mcp__MiniMax__understand_image');
    expect(DEFAULT_PROMPT_TEMPLATE).not.toMatch(/mcp__[A-Za-z0-9_]+__[A-Za-z_]+/);
  });

  it('仍含 {path} 占位符(不破坏 stripImagesToPaths fallback 逻辑)', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('{path}');
  });

  it('含三条工具路径关键词:Read / MCP / mmx-cli', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('Read 工具');
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('MCP');
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('mmx-cli');
  });
});
```

具体追加位置:打开文件,找到目前已有的 `describe` / `it` 块的结束 `});` —— 在文件最后那个 `});` 之后、新行起写。

- [ ] **Step 2: 跑测试,确认 3 个新增 it 现在 FAIL(老默认仍硬编码 MiniMax)**

Run:
```bash
bun test tests/unit/img-proxy/transform.test.ts -t 'tool-agnostic' 2>&1 | tail -40
```

Expected:
- 3 个新 `it` 全部失败
- 失败信息应包含 `mcp__MiniMax__understand_image` 关键字(`not.toContain` 命中老值)— 这是预期失败

如果失败信息不对(如编译错或 import 错),停下检查;不要继续。

- [ ] **Step 3: Commit 失败测试**

```bash
git add tests/unit/img-proxy/transform.test.ts
git commit -m "test(img-proxy): lock 工具无关 default prompt_template 行为"
```

---

## Task 2: 修改 `DEFAULT_PROMPT_TEMPLATE`(让测试 PASS)

**Files:**
- Modify: `src/img-proxy/transform.ts:5-7`

**Interfaces:**
- Produces: 导出常量 `DEFAULT_PROMPT_TEMPLATE`,新字面见全局约束段

- [ ] **Step 1: 改 `src/img-proxy/transform.ts` 行 5-7**

旧(行 5-7,多行字符串拼接):
```typescript
export const DEFAULT_PROMPT_TEMPLATE =
  '[用户粘贴的图片已保存到本地: {path}] 当前模型为纯文本模型,无法直接查看图片内容。' +
  '如需识别这张图片,请调用 mcp__MiniMax__understand_image 工具,image_source 参数传上述本地路径。';
```

新:
```typescript
export const DEFAULT_PROMPT_TEMPLATE =
  '[用户粘贴的图片已保存到本地文件: {path}]\n' +
  '当前模型为纯文本模型,请用以下方式之一查看该图片内容:\n' +
  '1. 调用 Read 工具读取该本地路径(若 Read 支持图片)\n' +
  '2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)\n' +
  '3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)';
```

注意:`{path}` 占位符仍在第一个 segment,且 `template.includes('{path}')` 在 `stripImagesToPaths` 中的判定继续成立 —— `includes('{path}')` 命中 `{path}` 子串,新值首段包含。

不要改 export 类型 / 名 / 行号偏移,reviewer 看了好对照。

- [ ] **Step 2: 跑测试,确认 Task 1 的 3 个新 it 现在 PASS**

Run:
```bash
bun test tests/unit/img-proxy/transform.test.ts -t 'tool-agnostic' 2>&1 | tail -20
```

Expected: 3 个新 `it` 全 PASS + 已有测试无回归。

- [ ] **Step 3: 跑整个 img-proxy 测试目录,确认无回归**

Run:
```bash
bun test tests/unit/img-proxy/ 2>&1 | tail -10
```

Expected: 全绿(包括 `aliases / classify / discover / provider-config / provider-scan / routes / routes-disable / wrapper / transform`)。如果任何红,停下,排查。

- [ ] **Step 4: Commit**

```bash
git add src/img-proxy/transform.ts
git commit -m "feat(img-proxy): default prompt_template 工具无关化"
```

---

## Task 3: 同步 `config.ts` DEFAULTS(防两处漂移)

**Files:**
- Modify: `src/utils/config.ts:200`

**Interfaces:**
- Produces: `DEFAULTS.img_proxy.prompt_template` 字段值,与 Task 2 改后的 `DEFAULT_PROMPT_TEMPLATE` 完全相同字符串

- [ ] **Step 1: 改 `src/utils/config.ts` 行 200**

旧(单行长字符串):
```typescript
    prompt_template: '[用户粘贴的图片已保存到本地: {path}] 当前模型为纯文本模型,无法直接查看图片内容。如需识别这张图片,请调用 mcp__MiniMax__understand_image 工具,image_source 参数传上述本地路径。',
```

新(同样用字符串拼接,与 Task 2 一字不差;`\n` 转义保持与上方字符串拼接对齐):
```typescript
    prompt_template:
      '[用户粘贴的图片已保存到本地文件: {path}]\n' +
      '当前模型为纯文本模型,请用以下方式之一查看该图片内容:\n' +
      '1. 调用 Read 工具读取该本地路径(若 Read 支持图片)\n' +
      '2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)\n' +
      '3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)',
```

⚠️ **字段对齐**: `prompt_template:` 后用换行 + 缩进续行,与相邻字段多行写法一致(`console_enabled: false, // Phase 2: Web 控制台` 这种风格)。下面的 `console_enabled: false,` 字段保持原位置不动。

- [ ] **Step 2: 加防漂移断言到测试**

回到 `tests/unit/img-proxy/transform.test.ts`,在 Task 1 加的 describe 块里追加一个 `it`(锁死 config.ts 同步):

在最后一个 `it(`含三条工具路径关键词`)` 后追加:

```typescript
  it('与 config.ts DEFAULTS.img_proxy.prompt_template 字面一致', async () => {
    const { config } = await import('../../../src/utils/config');
    const cfgDefault = config.get<string>('img_proxy.prompt_template', '');
    expect(cfgDefault).toBe(DEFAULT_PROMPT_TEMPLATE);
  });
```

- [ ] **Step 3: 跑测试,确认所有新断言 PASS**

Run:
```bash
bun test tests/unit/img-proxy/transform.test.ts -t '与 config.ts' 2>&1 | tail -10
```

Expected: PASS(如果 FAIL,说明两处字符串不一致,差什么补什么)

- [ ] **Step 4: 跑全量 img-proxy 测试,确认无回归**

Run:
```bash
bun test tests/unit/img-proxy/ 2>&1 | tail -5
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts tests/unit/img-proxy/transform.test.ts
git commit -m "feat(img-proxy): config DEFAULTS 与 default template 同步去硬编码"
```

---

## Task 4: setup.ts 灰字提示文案

**Files:**
- Modify: `src/cli/commands/setup.ts:216`

**Interfaces:**
- 不影响任何函数签名,纯文本提示

- [ ] **Step 1: 改 `src/cli/commands/setup.ts` 行 216**

旧:
```typescript
    console.log(chalk.gray('     模型需要配图片识别 MCP(如 mcp__MiniMax__understand_image)才能"看见"。'));
```

新:
```typescript
    console.log(chalk.gray('     模型需要配图片识别能力(Read 工具 / 图片识别 MCP / mmx-cli 等本地 CLI)才能"看见"。'));
```

仅替换这一行;前后行不动。

- [ ] **Step 2: 跑 setup 相关测试(若有)**

```bash
bun test --test-name-pattern="setup" 2>&1 | tail -10
```

Expected:没有 setup 测试覆盖那段 console.log 是预期(测试覆盖率本就为 0),所以 grep 验证即可。

- [ ] **Step 3: grep 确认 src/ 里 MiniMax 字串清零**

```bash
grep -rn "mcp__MiniMax__understand_image" src/ 2>&1 | grep -v "/plans/" | grep -v "/specs/"
```

Expected: **零行**。如果还有,回去看漏了哪个文件。

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(img-proxy): setup 文案去 MiniMax 举例"
```

---

## Task 5: docs 更新

**Files:**
- Modify: `docs/img-proxy.md`(5 段:5/63/702/750/870 行附近)

**Interfaces:**
- 不影响代码,纯文档

- [ ] **Step 1: 改第 5 行 "重要心智模型" 引用块**

旧:
```markdown
> **重要心智模型**:`img-proxy` 不让模型直接"看见"图片——它把图片**保存成本地文件**，然后给模型发一段**文本**(图片路径 + 调 MCP 的提示)。模型要"识别"图片,必须**主动调用图片识别 MCP**(比如 `mcp__MiniMax__understand_image`)。这是绕开纯文本模型 4xx 的核心设计。
```

新:
```markdown
> **重要心智模型**:`img-proxy` 不让模型直接"看见"图片——它把图片**保存成本地文件**，然后给模型发一段**文本**(图片路径 + 选择工具的提示)。模型按其现有能力挑选合适的工具:
> Read 工具(若支持图片)、已注册的任何图片识别 MCP(如 `mcp__MiniMax__understand_image` 之类),或 Bash 调用本地图片识别 CLI(如 mmx-cli)。这是绕开纯文本模型 4xx 的核心设计。
```

保留 `mcp__MiniMax__understand_image` 作为一个例子括号提到(向后兼容老用户的认知),但不再"必须调用"。

- [ ] **Step 2: 改第 63 行"前置依赖"段落**

打开文件,定位行 63 附近的 `**前置依赖**:你的纯文本模型必须配**图片识别 MCP**(\`mcp__MiniMax__understand_image\` 或同类)。`

旧:
```markdown
**前置依赖**:你的纯文本模型必须配**图片识别 MCP**(`mcp__MiniMax__understand_image` 或同类)。
```

新:
```markdown
**前置依赖**:你的纯文本模型必须具备某种图片识别能力(Read 工具 / 图片识别 MCP / 本地 CLI 如 mmx-cli 之一即可)。
```

- [ ] **Step 3: 改第 702 行"自定义 prompt template"段(保留并加一句)**

第 702 行附近已有 "如果你用别的图片识别 MCP(非 `mcp__MiniMax__understand_image`),改 template" 段。**保留整段**,只在段尾追加一句说明 default 已不绑特定工具:

在段尾的 ```toml 代码块结束后追加:

```markdown
> 默认 `prompt_template` 已不绑特定 MCP,通常无需自定义。仅当你模型对"图片识别 MCP"措辞不响应时再改。
```

- [ ] **Step 4: 改第 750 行"模型说我看不到图片"故障段**

旧:
```markdown
- 确认你的 `.mcp.json` 或 `claude --mcp-config` 启用了图片识别
- 看模型 response 有没有"I'll call the image recognition tool"措辞
- 没的话:调整 `prompt_template` 让它更适合你的模型措辞
```

新:
```markdown
- 确认你的 `~/.claude.json` `mcpServers`(或 `.mcp.json`)启用了图片识别能力 / 装了 mmx-cli 等 CLI
- 默认 prompt 已指引三种路径(Read / MCP / CLI),看模型 response 选了哪条
- 全没响应:调整 `prompt_template` 用更明确的措辞告诉你的模型该调哪个工具
```

- [ ] **Step 5: 改第 870 行 FAQ "硬编码" 那条**

旧(推测内容,具体以文件为准):
```markdown
3. **`mcp__MiniMax__understand_image` 是默认模板硬编码的**——用别的 MCP 必须改 `prompt_template`。
```

新(若 FAQ 中真有这一条,则改;若编号 / 措辞略有出入,以该条实际内容为准):
```markdown
3. **默认 `prompt_template` 已不再硬编码具体 MCP**——它指引模型自选工具(Read / 任何图片 MCP / mmx-cli 等本地 CLI)。若你模型没回应该提示,手动改 `prompt_template` 指定你想用的工具名。
```

- [ ] **Step 6: 跑 `markdownlint` 或纯 grep 检查**

```bash
# 检查 img-proxy.md 语法大致 OK
bun -e 'console.log(await Bun.file("docs/img-proxy.md").text()).slice(0, 1000)' 2>&1 | head -5
```

Expected: 文件能读,Markdown 标题 / 列表结构不被破坏(肉眼看一下 `##` 标题层级)。

无需 commit lint fixes,这不是项目主流程。

- [ ] **Step 7: Commit**

```bash
git add docs/img-proxy.md
git commit -m "docs(img-proxy): 心智模型 / FAQ 同步去硬编码"
```

---

## Task 6: 最终验证 + 收尾

**Files:**
- 不修改任何文件;纯命令

- [ ] **Step 1: 类型检查**

```bash
bun run typecheck 2>&1 | tail -20
```

Expected: 零 error。若有 error,看是否本任务引入;不是的话可能是 main 已有的,记下不阻塞本任务。

- [ ] **Step 2: 跑全量 img-proxy 测试**

```bash
bun test tests/unit/img-proxy/ 2>&1 | tail -10
```

Expected: 全绿,本次新增的 4 个 `it`(任务 1 + 任务 3 共 4 个)都在 PASS 列。

- [ ] **Step 3: grep 终结检查 — src/ 无 hardcoded MiniMax**

```bash
grep -rn "mcp__MiniMax__understand_image" src/ 2>&1 | grep -v "/plans/" | grep -v "/specs/"
```

Expected: **零行**。

- [ ] **Step 4: 视觉确认两处字符串字面一致**

```bash
bun -e 'console.log(JSON.stringify(await Bun.file("src/img-proxy/transform.ts").text().then(t => t.match(/DEFAULT_PROMPT_TEMPLATE = [\s\S]+?;/)?.[0])))' 2>&1
```

肉眼对比 Task 2 / Task 3 的字面值,确认 5 段字符串与 spec 文档 "新 DEFAULT_PROMPT_TEMPLATE 完整字面值" 一致。

- [ ] **Step 5: 暂不 push,也不打 PR — 等用户验收本批改动**

向用户回报:
- Task 1-5 全部 commit 已落地
- typecheck / tests / grep 验证结果(列出实际输出)
- 列出 5 个 commit hash(用 `git log --oneline -n 5 feat/cli-image-proxy`)
- 等用户决定何时 push / 开 PR / 合并

**不自动 push/不自动开 PR** —— per `~/.claude/CLAUDE.md` "Change Delivery Gate" + 用户偏好"ship 需明确确认"。

---

## Self-Review Checklist(写 plan 时自检)

- [x] Spec coverage: 行为变更表、YAGNI、测试、回滚全部覆盖 → Task 1-6 落到 5 task
- [x] 无 placeholder — 每步给出确切代码
- [x] 类型一致:`DEFAULT_PROMPT_TEMPLATE` 在 transform.ts 导出,config.ts 用 `DEFAULTS.img_proxy.prompt_template` 字符串;两处一致由 Task 3 测试锁
- [x] {path} 占位符 — Task 2 测试锁;若丢则 `stripImagesToPaths` fallback 退化,这次不改那逻辑
- [x] 两处字面一致 — Task 1-3 测试都覆;用 `expect(cfgDefault).toBe(DEFAULT_PROMPT_TEMPLATE)` 字符串相等断言
- [x] commit 5 个 — 每 task 一次,便于回滚任一阶段
- [x] YAGNI — 不写 MCP 探测 / 不装新 module / 不开 PR(用户没要求)
- [x] 验证在前 — typecheck + bun test + grep 终结检查(Task 6)
- [x] 不假设 reviewer 已知上下文 — 每个命令都给出完整路径和参数
- [x] 改动边界 — 全 plan 限定 5 个文件,无 schema bump,无 deps
