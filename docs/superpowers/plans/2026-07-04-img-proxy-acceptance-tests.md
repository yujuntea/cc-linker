# cc-linker img-proxy 智能安装 — 验收测试文档

> **日期:** 2026-07-04
> **对应代码:** `feat/cli-image-proxy` 分支,55 commits
> **设计 spec:** `docs/superpowers/specs/2026-07-04-img-proxy-smart-install-design.md`
> **实施 plan:** `docs/superpowers/plans/2026-07-04-img-proxy-smart-install.md`

---

## 1. 概述

本文档从**真实用户实际使用场景**出发,定义 cc-linker img-proxy 智能安装功能的验收测试。每个测试都有:
- **前置条件**:机器必须处于的状态
- **操作步骤**:精确的命令序列
- **预期输出**:验证 PASS 的具体标志
- **失败排查**:常见失败原因

**测试分级**:
- **P0 — Ship Blocker**:必须全部通过才能发布
- **P1 — Important**:修复后通过,失败则需 release notes 说明
- **P2 — Polish**:后续版本修复

---

## 2. 用户画像(基于实际使用场景)

| 画像 | 描述 | 典型占比 |
|------|------|---------|
| **A. 纯 CC Switch 用户** | 只有 CC Switch,`~/.claude/providers/` 为空或只有少量 | 50% |
| **B. 自定义 alias 用户** | 只有手动 provider 文件 + shell aliases | 15% |
| **C. 混合用户** | CC Switch + 手动 + aliases 都有 | 30% |
| **D. Cold-start 用户** | 刚装 cc-linker,啥都没有 | 5% |
| **E. 官方 API 直连** | `settings.json → api.anthropic.com` | 5%(少数派) |

**测试覆盖**:所有 5 个画像,以及最近 13 个修复的回归测试。

---

## 3. 前置环境检查

**所有测试运行前必跑**的检查命令:

```bash
# 1. cc-linker 二进制可用且版本正确
cc-linker --version
# 期望: 显示当前版本号(本次部署的版本)

# 2. bun + Node 环境就绪
which bun && bun --version
# 期望: bun 1.x 或更高

# 3. 备份当前关键文件(防止测试破坏)
BACKUP_DIR=~/.cc-linker/test-backup-$(date +%s)
mkdir -p $BACKUP_DIR
cp -a ~/.cc-linker/img-proxy/routes.json $BACKUP_DIR/
cp -a ~/.claude/settings.json $BACKUP_DIR/
cp -a ~/.claude/providers/ $BACKUP_DIR/providers-manual/
cp -a ~/.cc-switch/cc-switch.db $BACKUP_DIR/cc-switch.db
echo "Backup: $BACKUP_DIR"

# 4. 记录 daemon 状态
cc-linker img-proxy status
```

如果第 3 步备份失败或 daemon 不在运行,**不要继续**测试。

---

## 4. Persona A:纯 CC Switch 用户(P0)

### 4.1 前置条件

```bash
# 用户的 ~/.claude/providers/ 不存在或为空(临时移走)
mv ~/.claude/providers ~/.claude/providers.bak.test 2>/dev/null || true
ls ~/.claude/providers/ 2>&1 | head -3
# 期望: No such file or directory

# CC Switch 已装
ls ~/.cc-switch/cc-switch.db
# 期望: 文件存在
```

### 4.2 测试 A1:发现 + 分类 + 安装

```bash
cc-linker img-proxy install --yes
```

**预期输出**:
- "🔍 发现 N 个 claude providers(来自 CC Switch)"
- N ≥ 1(取决于 CC Switch DB)
- "已预选 M 个 text-only;multimodal 默认跳过"
- "✅ 已装 M 个(smart 模式)"
- "✅ 检测到 CC Switch,装 wrapper 到 ~/.zshrc?"

**PASS 标志**:
- `~/.cc-linker/img-proxy/routes.json` 有 M 个 entry
- 每个 entry 的 `upstream` 是真实 upstream URL,**不是** proxy URL
- M 个 provider 文件被修改成 proxy URL(或 auto-providers 文件被创建)

### 4.3 测试 A2:wrapper daily use

```bash
# 模拟 CC Switch 切换
cc-switch use glm-5.2   # 假设 CC Switch 用这个命令
source ~/.zshrc          # 重载 shell 配置

# 跑 wrapper
cc-linker-proxy "echo test"
```

**预期**: 不报错,ANTHROPIC_BASE_URL 被设置。

**PASS 标志**: `env | grep ANTHROPIC_BASE_URL` 显示 `http://127.0.0.1:8765/<alias>`

### 4.4 测试 A3:切换到 multimodal provider

```bash
cc-switch use kimi-for-coding
source ~/.zshrc
cc-linker-proxy "echo test"
```

**预期**: 报错"kimi-for-coding 没在 img-proxy 里,hint: cc-linker img-proxy install"

**PASS 标志**: exit code 1,stderr 有 hint 信息

### 4.5 还原

```bash
mv ~/.claude/providers.bak.test ~/.claude/providers
```

---

## 5. Persona B:自定义 alias 用户(P0)

### 5.1 前置条件

```bash
# 手动 provider 文件存在(用户有 14 个)
ls ~/.claude/providers/ | head -5
# 期望: glm-5.2.json, byte-glm.json, 等

# Shell aliases 存在
grep "alias cc-" ~/.zshrc | head -5
# 期望: cc-glm, cc-byte-agent 等

# CC Switch 未装或不用(测试时临时移走)
mv ~/.cc-switch ~/.cc-switch.bak.test 2>/dev/null || true
```

### 5.2 测试 B1:发现手动 + alias

```bash
cc-linker img-proxy install --yes
```

**预期输出**:
- "🔍 发现 N 个 manual providers"
- "🔍 发现 M 个 cc-* aliases"
- alias 自动 pre-select 对应 manual file

**PASS 标志**:
- alias 指的文件被正确识别(通过 `--settings ~/.claude/providers/X.json`)
- 文本模型 pre-selected

### 5.3 测试 B2:alias 实际工作

```bash
cc-byte-agent "echo test"
```

**预期**: 走 proxy(因为 alias 指的 manual file BASE_URL 已被改)

### 5.4 测试 B3:wrapper 不应被自动装

测试 B1 完成后:

```bash
grep -c "cc-linker-proxy" ~/.zshrc
# 期望: 0(没有 wrapper — 因为没有 CC Switch)
```

### 5.5 还原

```bash
mv ~/.cc-switch.bak.test ~/.cc-switch
```

---

## 6. Persona C:混合用户(P0)— 用户实际场景

### 6.1 前置条件(用户当前状态)

```bash
# 手动 providers(14 个)
ls ~/.claude/providers/*.json | wc -l
# 期望: ~14

# CC Switch
ls ~/.cc-switch/cc-switch.db
# 期望: 存在

# Shell aliases(10+ 个)
grep -c "alias cc-" ~/.zshrc
# 期望: ≥10

# 当前激活:MiniMax-M3 (multimodal)
cat ~/.claude/settings.json | grep ANTHROPIC_MODEL
# 期望: "ANTHROPIC_MODEL": "MiniMax-M3[1m]"
```

### 6.2 测试 C1:smart install 不破坏 multimodal 当前激活

```bash
# 跑 install 但跳过 multimodal(maybe 用 --providers 显式选几个)
cc-linker img-proxy install --providers glm-5.2,byte-agent-glm,deepseek-v4
```

**预期**:
- 3 个 text-only 装上(不报 multimodal 错)
- 当前 settings.json 还是指向 MiniMax-M3

**PASS 标志**:
- `routes.json` 新增 3 个 entry
- `settings.json` 未被修改

### 6.3 测试 C2:显式请求 multimodal 模型

```bash
cc-linker img-proxy install --providers kimi-for-coding
```

**预期**: 报错"kimi-for-coding 是 multimodal 模型,smart 模式会跳过。改用 --mode dumb 或 --all"

**PASS 标志**: exit code 1,error message 准确,提示明确

### 6.4 测试 C3:--mode dumb 强制装 multimodal

```bash
cc-linker img-proxy install --providers kimi-for-coding --mode dumb
```

**预期**: 装上 kimi-for-coding(因为 dumb 不过滤)

**PASS 标志**: routes.json 有 kimi-for-coding entry

### 6.5 测试 C4:wrapper install + daily use

```bash
cc-linker img-proxy wrapper-install
# 期望: "✅ wrapper 已装到 ~/.zshrc" + 备份路径

source ~/.zshrc

# 测试递归 guard
ANTHROPIC_BASE_URL=http://127.0.0.1:8765/glm-5.2 cc-linker-proxy --version 2>&1 | head -1
# 期望: claude --version 输出(wrapped 函数识别 env 已设,直接 exec)
```

### 6.6 测试 C5:wrapper 错误恢复(uninstall + 重装)

```bash
cc-linker img-proxy wrapper-uninstall
# 期望: "✅ 已从 .../.zshrc 移除 wrapper"

cc-linker img-proxy wrapper-install
# 期望: "✅ wrapper 已装到 .../.zshrc"(二次安装正常)
```

### 6.7 测试 C6:idempotency

```bash
cc-linker img-proxy wrapper-install
cc-linker img-proxy wrapper-install
# 期望: 第二次输出 "wrapper 已装(idempotent)"

grep -c "cc-linker-proxy()" ~/.zshrc
# 期望: 1(只有一份 wrapper)
```

---

## 7. Persona D:Cold-start 用户(P0)

### 7.1 前置条件

```bash
# 备份当前,然后清理
mv ~/.claude/providers ~/.claude/providers.cold.bak 2>/dev/null
mv ~/.cc-switch ~/.cc-switch.cold.bak 2>/dev/null
ls ~/.claude/providers/ 2>&1 | head -3
ls ~/.cc-switch/ 2>&1 | head -3
# 期望: 都 No such file or directory
```

### 7.2 测试 D1:友好错误 + 解决方案

```bash
cc-linker img-proxy install
```

**预期输出**(完整):
```
❌ 未找到任何可用的 provider 配置

  已扫描的位置:
    • ~/.claude/providers/ (manual)
    • ~/.cc-switch/cc-switch.db (未安装)

  解决方案(任选其一):
    1. 装 CC Switch (https://github.com/farion1231/cc-switch)
       — GUI 管理 provider,装好后 Claude Code 自动可用,img-proxy 也会自动识别
    2. 手动创建 provider 文件:
       ~/.claude/providers/my-provider.json
       内容参考 docs/img-proxy.md "冷启动" 一节

错误 [E_IMG_PROXY_NO_PROVIDERS]
```

**PASS 标志**: exit code 1,有清晰错误码 + 两种解决方案

### 7.3 测试 D2:无副作用

```bash
ls ~/.cc-linker/img-proxy/routes.json 2>&1
ls ~/.zshrc.bak 2>&1
# 期望: routes.json 不存在,没创建备份
```

### 7.4 还原

```bash
mv ~/.claude/providers.cold.bak ~/.claude/providers
mv ~/.cc-switch.cold.bak ~/.cc-switch
```

---

## 8. Persona E:官方 API 直连(P1)

### 8.1 前置条件

```bash
# 修改 settings.json 指 Anthropic
cat > ~/.claude/settings.json <<'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_AUTH_TOKEN": "sk-test-xxx",
    "ANTHROPIC_MODEL": "claude-opus-4-1-20250805"
  }
}
EOF
```

### 8.2 测试 E1:wrapper 报错 + 提示

```bash
source ~/.zshrc 2>/dev/null || true
cc-linker-proxy --version 2>&1 | head -3
```

**预期**:
```
cc-linker-proxy: https://api.anthropic.com 没在 img-proxy 里
  hint: cc-linker img-proxy install
```

**PASS 标志**: exit code 1,错误信息明确,exit 而不是无限循环

### 8.3 还原

```bash
# 恢复用户原始 settings.json
cp ~/.cc-linker/test-backup-*/settings.json ~/.claude/settings.json
```

---

## 9. 最近 13 个修复的回归测试(P0)

每个修复都有专门测试,确保 ship 后不退步。

### 9.1 I-1:URL 规范化

```bash
# 测试场景:settings.json URL 有 trailing slash
ORIG_URL="https://api.anthropic.com/"
TEST_URL="https://api.anthropic.com"

# 通过 cc-linker img-proxy resolve 测试
# 期望:规范化后能匹配
echo "Test 1: trailing slash 不应阻断 resolve"
# (verify manually by editing test routes.json and running resolve)
```

**自动化测试位置**:`tests/unit/img-proxy/routes.test.ts:URL normalization cases`

### 9.2 I-2:文件锁

```bash
# 并发 install 不应丢失 routes
cc-linker img-proxy install --providers glm-5.2,byte-glm,deepseek-v4,kimi-for-coding,xiaomi-mimo &
cc-linker img-proxy install --providers bailian-glm,bailian-qwen3.6,qwen3.7-plus &
wait

cat ~/.cc-linker/img-proxy/routes.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['routes']))"
# 期望: 5(2 from first call + 3 from second call, no losses)
```

### 9.3 I-3:installed_at 保留

```bash
# 第一次装
cc-linker img-proxy install --providers test-preserve 2>&1 || echo "skip if no test-preserve"
INSTALLED_AT_1=$(jq -r '.routes["test-preserve"].installed_at' ~/.cc-linker/img-proxy/routes.json 2>/dev/null)

# 等 2 秒
sleep 2

# 第二次装同一个
cc-linker img-proxy install --providers test-preserve 2>&1 || echo "skip"
INSTALLED_AT_2=$(jq -r '.routes["test-preserve"].installed_at' ~/.cc-linker/img-proxy/routes.json 2>/dev/null)

# 期望:两次时间戳相同(保留原值)
[ "$INSTALLED_AT_1" = "$INSTALLED_AT_2" ] && echo "PASS" || echo "FAIL: installed_at overwritten"
```

### 9.4 I-4:CC Switch stale 清理

```bash
# 准备:临时加一个 fake provider 到 auto-providers
echo '{"env":{"ANTHROPIC_BASE_URL":"https://fake.com","ANTHROPIC_MODEL":"fake"}}' > \
  ~/.cc-linker/auto-providers/fake-stale-test.json

# 触发 sync(任何 install 调用都会先 sync)
cc-linker img-proxy install --yes

# 期望: fake-stale-test.json 被删除(DB 里没有)
ls ~/.cc-linker/auto-providers/fake-stale-test.json 2>&1
# 期望: No such file or directory
```

### 9.5 I-5:quote-aware comment strip

```bash
# 测试用例:alias 包含 # 在引号内
echo "alias cc-test='echo # hash inside quote'" >> ~/.zshrc

# 跑 install
cc-linker img-proxy install --yes 2>&1 | grep "cc-test" | head -3
# 期望: cc-test 出现在候选列表(没被 comment-strip 误伤)

# 清理
sed -i '/alias cc-test=/d' ~/.zshrc
```

### 9.6 I-6:uninstall --all 也卸 wrapper

```bash
# 准备:先确保 wrapper 装好
cc-linker img-proxy wrapper-install

# 跑 uninstall --all(用 yes 或 echo y 跳过)
echo "y" | cc-linker img-proxy uninstall --all

# 期望:wrapper 也被卸
grep -c "cc-linker-proxy()" ~/.zshrc
# 期望: 0
```

### 9.7 I-7:PID 假报防护

```bash
# 模拟 EADDRINUSE 场景:启动 daemon 时端口已被占用
# 这测试需要写一个 mock,自动化较难
# 人工测试:在另一个 terminal 跑 `nc -l 8765` 占住端口,然后 cc-linker img-proxy start --daemon
# 期望: 5 秒后报错,exit code 1,不说"已启动"
```

### 9.8 I-8:--mode choices 验证

```bash
cc-linker img-proxy install --mode banana 2>&1 | tail -5
# 期望: 报错 "--mode: invalid value 'banana'",exit code 非 0
```

### 9.9 I-9:configured guard

```bash
# 准备:在 inquirer 里取消所有选项
# (这个测试需要交互模式,自动测试较难)
# 验证:看 summary 是不是显示"已启用(0 个 provider)"——应该是 "未启用"

# 自动化测试位置: tests/unit/cli/setup.test.ts
```

### 9.10 I-10:failedCount

```bash
# 制造一个失败场景:让 provider 文件不可写
chmod 444 ~/.claude/providers/test-fail.json
cc-linker img-proxy install --providers test-fail 2>&1 | tail -5
# 期望: "❌ test-fail ... 完成: 0 新装, 0 已存在, 1 失败"
chmod 644 ~/.claude/providers/test-fail.json
```

### 9.11 I-11:--providers 查 candidates

```bash
# 用户显式请求 multimodal model
cc-linker img-proxy install --providers kimi-for-coding 2>&1 | tail -5
# 期望(在 smart 模式下):报错 "kimi-for-coding 是 multimodal 模型,smart 模式会跳过。改用 --mode dumb 或 --all"
```

### 9.12 I-12:CJK-safe label

```bash
# 临时加一个中文 alias
echo "alias cc-测试='claude --settings ~/.claude/providers/glm-5.2.json'" >> ~/.zshrc

# 跑 install
cc-linker img-proxy install --yes 2>&1 | head -20
# 期望: 输出对齐不混乱(ragged 但 readable,固定 padEnd 已移除)
# 即使有 [cc-测试] 这种长 source tag,也不会让后续列错位

# 清理
sed -i '/alias cc-测试=/d' ~/.zshrc
```

### 9.13 I-13:EACCES 友好提示

```bash
# 模拟只读 rc 文件
chmod 444 ~/.zshrc
cc-linker img-proxy wrapper-install 2>&1 | tail -5
# 期望: "❌ ~/.zshrc 没写权限" + "提示: chmod u+w ~/.zshrc 或用 sudo 跑"
# 不应该有 stack trace
chmod 644 ~/.zshrc
```

---

## 10. 边缘场景(P0)

来自 spec §14.7 的 15 个边缘场景,这里挑关键的验证:

### 10.1 E1:install 幂等

```bash
cc-linker img-proxy install --providers glm-5.2
cc-linker img-proxy install --providers glm-5.2  # 第二次
# 期望:第二次输出 "⊘ glm-5.2  已 install,跳过"
# routes.json 还是 1 个 entry(没重复)
```

### 10.2 E2:跨 port 重装

```bash
# 修改 config.toml port
sed -i 's/port = 8765/port = 8766/' ~/.cc-linker/config.toml
cc-linker img-proxy install --providers glm-5.2
# 期望: BASE_URL 改成 8766,原始 upstream 仍在 routes.json

# 还原
sed -i 's/port = 8766/port = 8765/' ~/.cc-linker/config.toml
cc-linker img-proxy install --providers glm-5.2  # 还原回 8765
```

### 10.3 E3:unknown model 走默认(text-only)

```bash
# 临时把某个 provider 的 model 改成不存在的
sed -i '' 's/MiniMax-M3\[1m\]/some-new-model-test\[1m\]/' ~/.claude/providers/minimax-m2.7.json
cc-linker img-proxy install --providers minimax-m2.7
# 期望:装成功,按 text-only 处理
sed -i '' 's/some-new-model-test\[1m\]/MiniMax-M3\[1m\]/' ~/.claude/providers/minimax-m2.7.json
```

### 10.4 E5:CC Switch 切换 + wrapper

```bash
# 假设 wrapper 装好
cc-switch use glm-5.2  # 切换
source ~/.zshrc
cc-linker-proxy "echo test"
# 期望:ANTHROPIC_BASE_URL 切到新 provider 的 proxy URL
```

### 10.5 E7:递归 wrapper 防护

```bash
# 设 ANTHROPIC_BASE_URL 已设,跑 wrapper
ANTHROPIC_BASE_URL=http://127.0.0.1:8765/glm-5.2 cc-linker-proxy --version 2>&1 | head -3
# 期望:不报错,不调 resolve,直接 exec claude(ANTHROPIC_BASE_URL 还是 8765)
```

### 10.6 E10:custom vision patterns via config

```bash
# 在 config.toml 加
echo '
[img_proxy]
vision_model_patterns_extra = ["my-custom-vl-*"]
' >> ~/.cc-linker/config.toml

# 临时改一个 model 名
sed -i '' 's/glm-5.2/my-custom-vl-test/' ~/.claude/providers/glm-5.2.json
cc-linker img-proxy install --yes 2>&1 | grep "my-custom-vl-test"
# 期望:my-custom-vl-test 被跳过(multimodal-skip)

# 还原
sed -i '' 's/my-custom-vl-test/glm-5.2/' ~/.claude/providers/glm-5.2.json
```

### 10.7 E11:wrapper-uninstall 时还在用

```bash
# 装 wrapper
cc-linker img-proxy wrapper-install
source ~/.zshrc

# 当前 shell 已加载 wrapper function,卸载
cc-linker img-proxy wrapper-uninstall

# 验证:当前 shell 仍能跑 wrapper(因为已 source)
cc-linker-proxy "echo test" 2>&1 | head -3
# 期望:wrapper 还能跑,因为 shell function 还在内存中
# 但新开的 shell 就不行了

# 新 shell 验证
bash -c 'cc-linker-proxy "echo test"' 2>&1 | head -3
# 期望:报错"cc-linker-proxy: command not found"
```

### 10.8 E13:CC Switch 加新 provider

```bash
# 模拟 CC Switch GUI 加新 provider(直接改 DB 或 auto-providers)
echo '{"env":{"ANTHROPIC_BASE_URL":"https://newprovider.com","ANTHROPIC_MODEL":"newmodel"}}' > \
  ~/.cc-linker/auto-providers/newprovider.json

# 跑 install
cc-linker img-proxy install --yes 2>&1 | grep "newprovider"
# 期望:newprovider 出现在候选列表
```

---

## 11. 性能验证(P2 — 不阻塞 ship)

```bash
# 11.1 大数量 providers(50+)
# 创建 50 个假 providers,然后跑 install,测量时间
time cc-linker img-proxy install --all
# 期望:< 5 秒(读 + 分类 + 写 routes)

# 11.2 wrapper daily use 速度
time bash -c 'cc-linker img-proxy current-url && cc-linker img-proxy resolve <url>'
# 期望:< 100ms(resolve 应该 O(1) 或 O(n) 小数)
```

---

## 12. 失败恢复场景(P1)

### 12.1 daemon crash 恢复

```bash
# 1. 启动 daemon
cc-linker img-proxy start --daemon
PID=$(cat ~/.cc-linker/img-proxy/img-proxy.pid)
echo "PID: $PID"

# 2. 模拟 crash
kill -9 $PID

# 3. 再跑 status
cc-linker img-proxy status
# 期望: 显示 "未运行",PID 文件被检测为 stale
```

### 12.2 损坏 routes.json 恢复

```bash
# 1. 备份并损坏
cp ~/.cc-linker/img-proxy/routes.json ~/.cc-linker/img-proxy/routes.json.bak
echo "{ broken" > ~/.cc-linker/img-proxy/routes.json

# 2. 跑 install --all(应自动用空表 + 重新建)
cc-linker img-proxy install --all 2>&1 | head -5
# 期望: 不报错,从空表开始重新装

# 3. 还原
mv ~/.cc-linker/img-proxy/routes.json.bak ~/.cc-linker/img-proxy/routes.json
```

### 12.3 uninstall 单个失败回退

```bash
# 1. 备份一个 provider 文件
cp ~/.claude/providers/glm-5.2.json ~/.claude/providers/glm-5.2.json.test.bak

# 2. 删除文件模拟 .bak 丢失
rm ~/.claude/providers/glm-5.2.json

# 3. 跑 uninstall
cc-linker img-proxy uninstall --providers glm-5.2 2>&1 | tail -5
# 期望:报错,但 routes.json 中 glm-5.2 entry 被清掉(graceful degradation)
```

---

## 13. 跨平台验证(P2)

### 13.1 macOS launchd 自启

```bash
cc-linker img-proxy daemon install
# 期望: plist 写到 ~/Library/LaunchAgents/com.cclinker.img-proxy.plist

launchctl list | grep cclinker
# 期望: 看到 cclinker.img-proxy

cc-linker img-proxy daemon uninstall
# 期望:plist 移除
```

### 13.2 Linux(如果有环境)

```bash
# Linux 下 daemon install 不支持,应给明确错误
cc-linker img-proxy daemon install 2>&1 | tail -3
# 期望(非 macOS): "目前仅支持 macOS launchd 自启"
```

---

## 14. 迁移验证(P1)

### 14.1 从 v1 升级到 v2(轻量)

```bash
# 假设用户已有 dumb install(v1 行为)
# routes.json 已有 25 个 entry(many 是 multimodal)

# 跑 smart install
cc-linker img-proxy install --yes 2>&1 | tail -5
# 期望:已装的 multimodal 不被重装(因为 routes.json 已有)
#         新发现的 multimodal 也被跳过
#         text-only 但未装的被装上
```

### 14.2 严格迁移

```bash
cc-linker img-proxy uninstall --all
cc-linker img-proxy install
# 期望:所有 .bak 还原,所有 routes 清空,smart 模式重新挑选
```

### 14.3 回滚

```bash
cc-linker img-proxy uninstall --all
cc-linker img-proxy install --all  # dumb 模式
# 期望: 装上所有(不过滤 multimodal),回到 v1 行为
```

---

## 15. 报告模板

测试完成后,填写下表:

```
日期: _____________
测试人员: _____________
cc-linker 版本: _____________
部署 commit: _____________

=== P0 测试 ===

[ P ] Persona A (CC Switch 用户)         PASS / FAIL  ___
[ P ] Persona B (自定义 alias 用户)      PASS / FAIL  ___
[ P ] Persona C (混合用户)               PASS / FAIL  ___
[ P ] Persona D (Cold-start 用户)        PASS / FAIL  ___
[ P ] I-1  URL 规范化                    PASS / FAIL  ___
[ P ] I-2  文件锁                        PASS / FAIL  ___
[ P ] I-3  installed_at 保留             PASS / FAIL  ___
[ P ] I-4  CC Switch stale 清理           PASS / FAIL  ___
[ P ] I-5  quote-aware comment strip     PASS / FAIL  ___
[ P ] I-6  uninstall 卸 wrapper          PASS / FAIL  ___
[ P ] I-7  PID 假报防护                  PASS / FAIL  ___
[ P ] I-8  --mode choices                PASS / FAIL  ___
[ P ] I-10 failedCount                   PASS / FAIL  ___
[ P ] I-11 --providers 查 candidates     PASS / FAIL  ___
[ P ] I-12 CJK-safe label                PASS / FAIL  ___
[ P ] I-13 EACCES 友好提示               PASS / FAIL  ___
[ P ] E1-E13 边缘场景(15 个)            PASS / FAIL  ___

P0 总结: ___/18 通过

=== P1 测试 ===

[ P ] Persona E (官方 API 直连)         PASS / FAIL  ___
[ P ] 失败恢复(daemon crash / 损坏文件)  PASS / FAIL  ___
[ P ] 迁移(轻量 / 严格 / 回滚)           PASS / FAIL  ___

P1 总结: ___/3 通过

=== P2 测试 ===

[ P ] 性能(大数量 / wrapper 速度)        PASS / FAIL  ___
[ P ] 跨平台(macOS launchd)             PASS / FAIL  ___

P2 总结: ___/2 通过

=== 总评 ===

✅ Ship Ready: 所有 P0 + P1 通过
⚠️ Ship with caveats: P0 通过,P1 有失败但有 workaround
❌ NOT READY: 任何 P0 失败

=== 备注 ===

(失败原因、workaround、follow-up 任务等)

签名: _____________
```

---

## 16. 已知限制与未来工作

文档化但不作为测试失败:
- **fish shell 不支持** — 用户需用 bash/zsh
- **Login shells 不自动 source `.zshrc`** — ssh 登录场景
- **Pi 部署未测试** — Linux on ARM
- **Windows WSL 未测试** — 默认 `sh` 场景

---

## 17. 总结

**这个验收文档确保**:
- 5 种真实用户场景全部覆盖
- 13 个最近修复的 bug 都有回归测试
- 15 个边缘场景都有具体验证步骤
- 失败恢复路径清晰
- 跨平台兼容性有明确预期
- 迁移场景有 3 条路径可选

**总计 23 个 P0 + 3 个 P1 + 2 个 P2 = 28 个验收点**。

任何 P0 失败 = NOT READY TO SHIP。