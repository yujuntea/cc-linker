# 2026-07-07 img-proxy: 去硬编码图片识别工具

**状态**: 已批准，进入 implementation
**作者**: brainstorm session on 2026-07-07
**关联分支**: `feat/cli-image-proxy`

## 1. 背景与动机

`img-proxy` 的核心心智:模型收到粘贴图片时,代理把 `image` base64 block 落盘成 `~/.cc-linker/img-proxy/cache/<name>.{png|jpg|...}`,然后插入一段 text block 告诉模型去识别。当前实现把"用什么工具识别"硬编码成 `mcp__MiniMax__understand_image`,作为 `prompt_template` 的默认值(`src/img-proxy/transform.ts:7` + `src/utils/config.ts:200` + setup 文案举例)。

这条硬编码在三方面有问题:

1. **撒谎风险**:用户卸载了 MiniMax MCP 后,prompt 还在叫模型调一个不存在的工具,模型只在 stub 阶段才不报错,实际拿不到识别结果
2. **扩展性差**:不在白名单里的 MCP server(如 `zai-mcp-server`、未来新装的)拿不到识别能力,用户得手动改 `prompt_template`
3. **遗漏能力**:Claude Code 实际能调的不止 MCP — 还有 `Read` 工具读本地路径(多模态场景下有效)和 `Bash` 调本地图片识别 CLI(如 mmx-cli)

## 2. 设计目标

- **零可用性回归**:现有用户(`prompt_template` 没改的)装完应照常工作
- **零行为侵入**:不让 install wizard 变重,不读 `~/.claude.json`,不弹新问题
- **去掉单一供应商锁定**:prompt 不要再 `mcp__MiniMax__understand_image`

## 3. 设计

### 3.1 新默认 prompt_template

**文件**: `src/img-proxy/transform.ts`(导出常量 `DEFAULT_PROMPT_TEMPLATE`) + `src/utils/config.ts`(`DEFAULTS.img_proxy.prompt_template`)

**新值**(两处必须保持一致):

```
[用户粘贴的图片已保存到本地文件: {path}]
当前模型为纯文本模型,请用以下方式之一查看该图片内容:
1. 调用 Read 工具读取该本地路径(若 Read 支持图片)
2. 调用你已注册的任何图片识别 MCP 工具(参数名视工具而定,常见如 image_source/image_url/image_path)
3. 用 Bash 调用本地图片识别 CLI(如 mmx-cli 等,具体命令与参数名以工具文档为准)
```

**为什么这条 prompt 行**:

- `{path}` 占位符语义不变 — 实际缓存绝对路径替换回去,所有现有 fallback / 校验逻辑(`stripImagesToPaths` 里 `template.includes('{path}')` 判定)继续有效
- 三条路径覆盖了已知的 3 种识别机制;不限定哪条 — 模型按自身能力自选
- "参数名视工具而定" 提前给模型打预防针,免它单一猜 `image_source` 失败就放弃
- "具体命令与参数名以工具文档为准" 鼓励模型先 Read 工具源/查 tool spec 再调,而不是硬猜

### 3.2 setup.ts 文案改动

**文件**: `src/cli/commands/setup.ts:216`(`runImgProxyWizard` 之前的灰字提示)

**改前**:

```
模型需要配图片识别 MCP(如 mcp__MiniMax__understand_image)才能"看见"。
```

**改后**:

```
模型需要配图片识别能力(Read 工具 / 图片识别 MCP / mmx-cli 等本地 CLI)才能"看见"。
```

### 3.3 文档更新

**文件**: `docs/img-proxy.md`(用户文档)

需修改段落:

- 第 5 行"重要心智模型"blockquote:去掉 MiniMax 具体名,改为三个工具类型并列
- 第 63 行"前置依赖"段落:同步去掉 MiniMax 举例
- 第 870 行 FAQ "mcp__MiniMax__understand_image 是默认模板硬编码的" 段:**改写**为 "已不再硬编码具体 MCP — 默认 prompt 指引模型自选工具(Read / 图片 MCP / mmx-cli 等)"
- 第 702 行"自定义 prompt template"段:**保留** — 用户依旧可以覆盖;但加一句 "默认值已不绑特定工具,通常无需自定义"
- 第 750 行"模型说我看不到图片"故障排除段:补一句"检查 prompt_template 是否绑了未安装的工具名"

### 3.4 不动的部分(明确清单)

- `prompt_template` config 字段保留,env 覆盖 `CC_LINKER_IMG_PROXY_PROMPT_TEMPLATE` 保留
- `img-proxy install` / `setup` 的 UX 流不变 — 不读 `~/.claude.json`、不列 MCP、不要求确认
- `mmx-cli` 在 prompt 里是举例,不绑定安装;用户没装或装了别的 CLI,模型会按"具体命令与参数名以工具文档为准"自行处理(可能 fall back 到其它机制)
- `Docs/superpowers/specs/2026-07-04-img-proxy-smart-install-design.md` 提到的 smart_mode 行为不动

## 4. 行为变更(用户视角)

| 场景 | 改前 | 改后 |
|---|---|---|
| 用户有 MiniMax MCP | prompt 显式指 MiniMax tool,模型调它 | prompt 指"任意图片 MCP",模型仍调 MiniMax(若装) |
| 用户有 `zai-mcp-server` 但没 MiniMax | 模型按字面调不到 MiniMax tool,收到 tool_use_result 错误而非识别结果 | prompt 指"任意图片 MCP",模型调到 `zai-mcp-server`(若它有图识别 tool) |
| 用户无 MCP、用的是 multimodal 模型 | prompt 指 MiniMax,模型可能绕了一圈浪费 round trip | 模型用 Read 工具一步到位 |
| 用户用 mmx-cli 做识别 | prompt 指 MiniMax tool — 绕开 | prompt 把 mmx-cli 列为合理路径,模型直接 `Bash(mmx ...)` |
| 用户卸载了 MiniMax | 模型还收含 MiniMax tool 名的 prompt(撒谎) | prompt 不撒谎,模型改用其它工具 |
| 用户已自定义 `prompt_template` | 自定义值优先 | 行为不变,自定义值继续优先 |

### 兼容性

- 已存在的 `prompt_template = "..."` 配置行不被改动;只有 DEFAULTS 才更新
- 没有 schema 变化,config reload 不变
- 没有 version bump 需要(纯 default 文案调整,不影响 v2 schema)

## 5. 测试

### 5.1 既有测试

`tests/unit/img-proxy/transform.test.ts`(已核实存在,line 2 + 83) — 当前断言:

- `expect(DEFAULT_PROMPT_TEMPLATE).toContain('{path}')`(line 83)— 改动后仍应通过,新模板含 `{path}`
- `it('falls back to DEFAULT_PROMPT_TEMPLATE when template lacks {path}')`(line 74)— 行为不变,无需改

无 hardcoded `MiniMax` 字串断言。

- 如果有:改为断言含 "图片识别 MCP" / "Read 工具" / "mmx-cli" 任一子串
- 如果没有:无需改测试

`setup.ts` 没现成测试覆盖那段灰字,跳过

### 5.2 新增测试(可选)

新增一个针对 `DEFAULT_PROMPT_TEMPLATE` 的回归测试,断言:

1. 仍含 `{path}` 占位符(保证 `stripImagesToPaths` 行为不变)
2. **不再含** `mcp__MiniMax__understand_image` 这种 vendor-lock 字串
3. 同时含 "Read"、"MCP"、"mmx-cli" 三个关键词(确保三条路径都覆盖)
4. 与 `config.ts` 的 `DEFAULTS.img_proxy.prompt_template` 字面一致(避免两处漂移)

### 5.3 验证手段

```bash
# 1. 类型检查
bun run typecheck

# 2. 现有 img-proxy 测试
bun test tests/unit/img-proxy/

# 3. grep 确认 src 里不再有 hardcoded MiniMax tool 名
grep -rn "mcp__MiniMax__understand_image" src/ | grep -v "/plans/" | grep -v "/specs/"
# 期望:零行(transform.ts 的 export 和 config.ts 的 DEFAULTS 都改)
```

docs 文件保留提及(markdown 显式说"以前硬编码 MiniMax 现在去掉了",给老用户交代)。

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 新 prompt 比旧 prompt "啰嗦",上游 token 多 | 三条 bullet 加起来 < 100 字符,影响微;且本来 v0 hardcoded 已经定长,这次只是稍长 |
| 模型选用"路径 1"(Read)但 Read 不支持图片,识别失败 | prompt 第 1 条已加"若 Read 支持图片"兜底;模型会按上下文自评;真实场景模型 (multimodal) Read 支持 |
| 模型调不存在的 CLI 报"command not found" | prompt 第 3 条举例但不绑死;模型通常会先做 ls/which 之类的存在性检查 |
| 用户已设 `prompt_template = "原 MiniMax 版本"` 没改 | 不动 — 自定义值优先,不是问题 |

**回滚**:三处 default 文案复原即可。commit 切成 revert 即恢复。

## 7. 不在范围(显式 YAGNI)

- 不读 `~/.claude.json` 扫 mcpServers
- 不在 install 时弹 picker
- 不根据 MCP tool 列表(tools/list JSON-RPC 握手)做能力发现
- 不支持按 provider 自动选不同 prompt_template
- 不加 disable_image_in_tool 之类的开关

## 8. 实施步骤

1. 改 `src/img-proxy/transform.ts` 导出常量
2. 改 `src/utils/config.ts` DEFAULTS.img_proxy.prompt_template(两值必须字面一致)
3. 改 `src/cli/commands/setup.ts:216` 文案
4. 改 `docs/img-proxy.md` 第 5/63/702/750/870 行
5. 检查并修 `tests/unit/img-proxy/transform.test.ts` 断言
6. 跑 `bun run typecheck` + `bun test tests/unit/img-proxy/`
7. `grep -rn "mcp__MiniMax__understand_image" src/` 确认零行
8. commit + push

每文件改动 < 10 行,无新 module,小 review(单 review pass + 用户验收)。
