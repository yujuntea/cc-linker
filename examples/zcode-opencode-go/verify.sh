#!/usr/bin/env bash
# verify.sh — 一键验证「代理 → OpenCode Go → Gemini 4 Argon」链路
#
# 用法:
#   bash verify.sh                 # 用默认端口 8787
#   bash verify.sh 8899            # 指定端口
#   OPENCODE_API_KEY=xxx bash verify.sh   # 也可从环境变量取 key
#
# 每项都会打印 PASS/FAIL；全绿即可去 ZCode 面板点「测试」。

set -uo pipefail
PORT="${1:-8787}"
KEY="${OPENCODE_API_KEY:-}"
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
ok()   { echo "  ✅ PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ FAIL  $1"; FAIL=$((FAIL+1)); }

echo "=== 1. 代理存活 (/healthz) ==="
if curl -sS -m 5 "$BASE/healthz" | grep -q '"status": *"ok"'; then ok "代理在 $BASE 运行中"; else bad "代理未响应（先跑 install-macos.sh）"; fi

if [ -z "$KEY" ]; then
  echo "=== 需要 API Key：请用 OPENCODE_API_KEY=xxx bash verify.sh 或直接编辑本脚本 ==="
  exit 1
fi

echo "=== 2. 模型列表 (/v1/models，含 gemini-4-argon) ==="
if curl -sS -m 20 -H "Authorization: Bearer $KEY" "$BASE/v1/models" | grep -q 'gemini-4-argon'; then
  ok "网关可达且模型存在"
else
  bad "模型列表未拿到 gemini-4-argon（检查 key / 网络）"
fi

echo "=== 3. ZCode 真实方言 body（四方言 + max_completion_tokens）==="
# 这份 body 复刻 ZCode 实发形态：修复前必 503 "Endpoint is unavailable"
BODY='{"model":"gemini-4-argon","messages":[{"role":"system","content":"You are ZCode connectivity probe."},{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":true},"thinking":{"type":"enabled"},"enable_thinking":true,"reasoning_effort":"low","reasoning":{"effort":"low"},"max_completion_tokens":64}'
CODE=$(curl -sS -m 90 -o /tmp/verify_chat.out -w '%{http_code}' \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "$BODY" "$BASE/v1/chat/completions")
if [ "$CODE" = "200" ]; then ok "四方言 body → 200（字段归一化生效）"; else
  bad "四方言 body → HTTP $CODE（503=方言未归一化；401=key 不对）"; head -c 200 /tmp/verify_chat.out; echo
fi

echo "=== 4. 非流式 + 标准字段（对照组：不该被改坏）==="
CODE=$(curl -sS -m 90 -o /tmp/verify_plain.out -w '%{http_code}' \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-4-argon","max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}' \
  "$BASE/v1/chat/completions")
if [ "$CODE" = "200" ] && grep -q '"content":"OK"' /tmp/verify_plain.out; then
  ok "标准 body → 200 且内容正确"
else
  bad "标准 body → HTTP $CODE（代理可能改坏了正常请求）"; head -q -c 200 /tmp/verify_plain.out; echo
fi

echo "=== 5. 缺 Authorization 应 401（证明凭证确实透传给网关）==="
CODE=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-4-argon","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' \
  "$BASE/v1/chat/completions")
if [ "$CODE" = "401" ]; then ok "无 key → 401（网关鉴权生效）"; else bad "无 key → HTTP $CODE（预期 401）"; fi

echo
echo "=== 结果: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 全部通过。现在去 ZCode 面板对 gemini-4-argon 点「测试」。"
  echo "   若面板测试不通过，看代理日志里的 REWRITE / UPSTREAM 行定位。"
else
  echo "❌ 有失败项，按上面提示排查（常见：key 不对 / 代理没起 / 网络不通）。"
fi
exit $((FAIL > 0 ? 1 : 0))
