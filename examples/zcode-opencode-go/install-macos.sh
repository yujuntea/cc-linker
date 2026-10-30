#!/usr/bin/env bash
# install-macos.sh — 安装 opencode_relay 为 macOS 开机常驻服务（LaunchAgent）
#
# 用法:
#   bash install-macos.sh                 # 默认端口 8787
#   bash install-macos.sh 8899             # 指定端口
#
# 装完会:
#   1. 复制代理脚本到 ~/.zcode/opencode-relay/opencode_relay.py
#   2. 写 LaunchAgent plist（~/.zcode/opencode-relay/com.user.zcode-opencode-relay.plist）
#   3. launchctl 加载并启动（开机自启 + 崩溃自动拉起）
#   4. 打印 ZCode 侧需要填的 baseUrl
#
# 卸载: bash uninstall-macos.sh

set -euo pipefail

PORT="${1:-8787}"
HOME_DIR="$HOME/.zcode/opencode-relay"
LABEL="com.user.zcode-opencode-relay"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SRC_DIR/opencode_relay.py"

PY=""
for cand in python3 /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "✗ 找不到 python3，请先安装 Python 3.8+" >&2
  exit 1
fi

echo "→ 使用 Python: $PY ($("$PY" -V 2>&1))"
echo "→ 端口: $PORT"

mkdir -p "$HOME_DIR"
cp "$SRC" "$HOME_DIR/opencode_relay.py"
chmod +x "$HOME_DIR/opencode_relay.py"

PLIST="$HOME_DIR/$LABEL.plist"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PY</string>
        <string>$HOME_DIR/opencode_relay.py</string>
        <string>--port</string>
        <string>$PORT</string>
        <string>--log-file</string>
        <string>$HOME_DIR/relay.log</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>$HOME_DIR/relay.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME_DIR/relay.log</string>
</dict>
</plist>
PLIST_EOF

# 停掉可能存在的旧实例
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2

if curl -sS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "✓ 代理已启动: http://127.0.0.1:$PORT"
else
  echo "✗ 代理未就绪，看日志: tail -20 $HOME_DIR/relay.log" >&2
  exit 1
fi

cat <<EOF

下一步（ZCode 侧）:
  1. 设置 → 模型供应商 → 新增/编辑供应商:
       名称        : OpenCode-OpenApi
       接口类型    : OpenAI 兼容 (openai-chat-completions)
       Base URL    : http://127.0.0.1:$PORT/v1
       API Key     : 你的 OpenCode Go key（console 里取）
  2. 添加模型 gemini-4-argon（模型规则见 README.md §配置）
  3. 点「测试」验证；日志看: tail -f $HOME_DIR/relay.log

EOF
