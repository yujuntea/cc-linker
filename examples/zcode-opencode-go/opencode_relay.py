#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
opencode_relay.py — ZCode → OpenCode Go 的本地桥接代理（零依赖，仅标准库）

为什么需要它
------------
OpenCode Go 网关（https://opencode.ai/zen/go）有两道硬性要求，而 ZCode 的
"自定义 api-key provider" 路径都过不去：

1. 对话端点强制要求 `x-opencode-session` 头，缺失即 400 MissingSessionID。
   ZCode 里注头的逻辑挂在"账号凭证刷新"通道上，只为 `account:` 开头的订阅型
   provider 生效；自定义 provider 永远拿不到这个头 → 请求 400 → 客户端退避
   重试 → 会话表现为"一直转圈、只能手动停止"。

2. 网关只认标准字段名：ZCode（Vercel AI SDK）发的 `max_completion_tokens` /
   `max_output_tokens`、以及 `thinking` / `enable_thinking` / `reasoning`
   对象形式的思考参数，网关一律回 503 "Endpoint is unavailable"。

本代理做三件事，正好对应上面两条 + 一个流式坑：
  A. 注入 `x-opencode-session`（固定值，便于服务端路由与 prompt 缓存）
  B. 归一化请求体字段方言（别名→max_tokens、剥离三种思考方言、保留 reasoning_effort）
  C. 逐块 flush 的 SSE 透传，且**不设读超时**（Gemini 深思考期首字节可达 50s+）

用法
----
    python3 opencode_relay.py --port 8787
    # ZCode provider baseUrl 设为: http://127.0.0.1:8787/v1

    python3 opencode_relay.py --help

日志
----
标准错误输出每行一条：REQ / REWRITE / UPSTREAM / UPSTREAM-ERR / CLIENT-DISCONNECT。
用 --log-file 可同时落盘（不会记录 Authorization）。

自检
----
    curl -s http://127.0.0.1:8787/healthz
    curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/models

环境要求：Python 3.8+（macOS 自带 3.9；Linux 3.8+）。无第三方依赖。
"""

import argparse
import http.client
import http.server
import json
import os
import socketserver
import sys
import time

DEFAULT_PORT = 8787
DEFAULT_UPSTREAM = "opencode.ai"
DEFAULT_PREFIX = "/zen/go"
DEFAULT_UA = "zcode-opencode-relay/1.0"

# 网关不认的思考参数方言（保留 reasoning_effort —— 唯一受支持的标准字段）
DROPPED_THINKING_FIELDS = ("thinking", "enable_thinking", "reasoning")
# max_tokens 的两种方言别名
MAX_TOKENS_ALIASES = ("max_output_tokens", "max_completion_tokens")

# 转发给上游时保留的请求头（Authorization 必须原样带上）
FORWARD_HEADERS = ("authorization", "content-type", "accept", "user-agent")


def log(msg, log_file=None):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    sys.stderr.write(line + "\n")
    sys.stderr.flush()
    if log_file:
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


def normalize_body(body):
    """归一化 OpenAI 兼容请求体。

    返回 (新 body bytes, 变更说明列表)。fail-open：解析失败/非对象则原样返回。
    幂等：已是标准形态则不重序列化（字节级不变）。
    """
    if not body:
        return body, []
    try:
        obj = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return body, []
    if not isinstance(obj, dict):
        return body, []
    changed = []

    # 1) 先剔 max_tokens:null —— 必须在别名搬运之前，
    #    否则 {"max_tokens":null,"max_completion_tokens":128} 会把 128 吞掉。
    if "max_tokens" in obj and obj["max_tokens"] is None:
        del obj["max_tokens"]
        changed.append("drop max_tokens:null")

    # 2) 别名字段无条件剥离（它们本身就是 503 触发器）；仅当标准 max_tokens
    #    缺席且别名值非空时把值搬过去，且只搬一次（双别名时第二个必须也剥）。
    moved = False
    for src in MAX_TOKENS_ALIASES:
        if src in obj:
            value = obj[src]
            if not moved and "max_tokens" not in obj and value is not None:
                obj["max_tokens"] = value
                moved = True
                changed.append("%s->max_tokens" % src)
            else:
                changed.append("drop %s" % src)
            del obj[src]

    # 3) 剥思考方言（reasoning_effort 保留）
    for bad in DROPPED_THINKING_FIELDS:
        if bad in obj:
            del obj[bad]
            changed.append("drop %s" % bad)

    if not changed:
        return body, []
    new_body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return new_body, changed


class RelayHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # 由 main 注入
    upstream_host = DEFAULT_UPSTREAM
    upstream_prefix = DEFAULT_PREFIX
    session_id = "zcode-relay"
    upstream_timeout = 600
    log_file = None

    def log_message(self, fmt, *args):
        """屏蔽 BaseHTTPRequestHandler 默认 stderr 噪音（我们自己记日志）。"""

    # ---------- 基础工具 ----------

    def _read_body(self):
        """读请求体，兼容 Content-Length 与 chunked 两种编码。"""
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            body = b""
            while True:
                size_line = self.rfile.readline().strip()
                try:
                    size = int(size_line.split(b";")[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline()
                    break
                body += self.rfile.read(size)
                self.rfile.read(2)
            return body
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    # ---------- 主处理 ----------

    def _relay(self):
        path = self.path
        base_path = path.split("?", 1)[0]

        # 健康检查
        if base_path in ("/healthz", "/health"):
            self._send_json(200, {"status": "ok", "upstream": "https://%s%s" % (self.upstream_host, self.upstream_prefix)})
            return

        # 裸路径 /v1、/v1/：上游返回的是 404 HTML 网页，某些客户端会拿它做
        # "URL 可达性"判断而误判连不通 —— 这里直接回一个 JSON 状态。
        if self.command in ("GET", "HEAD") and base_path.rstrip("/") in ("", "/v1"):
            self._send_json(200, {
                "object": "relay.status",
                "status": "ok",
                "models": "/v1/models",
                "chat": "/v1/chat/completions",
            })
            return

        started = time.time()
        try:
            body = self._read_body()
        except Exception as exc:  # 读体失败：回 400，不阻塞上游
            log("BODY-READ-ERR %s %s %s" % (self.command, path, type(exc).__name__), self.log_file)
            self._send_json(400, {"error": {"type": "RelayBodyReadError", "message": type(exc).__name__}})
            return

        # 字段方言归一化：只作用于 POST …/completions
        if body and self.command == "POST" and base_path.endswith("/completions"):
            new_body, changed = normalize_body(body)
            if changed:
                body = new_body
                log("REWRITE %s %s changed=%s" % (self.command, path, ",".join(changed)), self.log_file)

        headers = {}
        for key, value in self.headers.items():
            if key.lower() in FORWARD_HEADERS:
                headers[key] = value
        headers.setdefault("User-Agent", DEFAULT_UA)
        headers["x-opencode-session"] = self.session_id
        if body:
            headers["Content-Length"] = str(len(body))
        else:
            headers.pop("Content-Length", None)

        preview = body[:400].decode("utf-8", "ignore") if body else "-"
        log("REQ %s %s len=%s ua=%r body=%s" % (
            self.command, path, len(body) if body else 0,
            (self.headers.get("User-Agent") or "-")[:60], preview), self.log_file)

        # 转发到上游
        try:
            conn = http.client.HTTPSConnection(self.upstream_host, timeout=self.upstream_timeout)
            conn.request(self.command, self.upstream_prefix + path, body=body or None, headers=headers)
            resp = conn.getresponse()
        except Exception as exc:
            log("UPSTREAM-ERR %s %s %s (%.1fs)" % (
                self.command, path, type(exc).__name__, time.time() - started), self.log_file)
            self._send_json(502, {"error": {"type": "RelayUpstreamError", "message": type(exc).__name__}})
            return

        # 回写状态码与响应头（去掉逐跳头与长度，让本地连接自己处理）
        self.send_response(resp.status)
        for key, value in resp.getheaders():
            if key.lower() in ("transfer-encoding", "connection", "content-length"):
                continue
            self.send_header(key, value)
        self.send_header("Connection", "close")
        self.end_headers()

        error_preview = ""
        if resp.status >= 400:
            try:
                error_preview = " resp=%r" % resp.read(300)
            except Exception:
                error_preview = ""

        try:
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()   # SSE 逐块刷出（流式不缓冲）
        except (BrokenPipeError, ConnectionResetError):
            log("CLIENT-DISCONNECT %s %s (%.1fs)" % (self.command, path, time.time() - started), self.log_file)
        finally:
            try:
                conn.close()
            except Exception:
                pass

        log("UPSTREAM %s %s -> %d (%.1fs)%s" % (
            self.command, path, resp.status, time.time() - started, error_preview), self.log_file)
        self.close_connection = True

    do_GET = _relay
    do_POST = _relay
    do_HEAD = _relay
    do_PUT = _relay
    do_DELETE = _relay
    do_PATCH = _relay


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(
        description="ZCode → OpenCode Go 本地桥接代理（补 session 头 + 字段方言归一化）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 8787，仅 127.0.0.1）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1，勿改 0.0.0.0）")
    parser.add_argument("--upstream-host", default=DEFAULT_UPSTREAM, help="上游主机（默认 opencode.ai）")
    parser.add_argument("--upstream-prefix", default=DEFAULT_PREFIX, help="上游路径前缀（默认 /zen/go）")
    parser.add_argument("--session", default=None,
                        help="x-opencode-session 的值（默认按主机名派生；保持固定可复用服务端 prompt 缓存）")
    parser.add_argument("--timeout", type=int, default=600,
                        help="上游读超时秒数（默认 600；深思考期首字节可达 50s+，不要调小）")
    parser.add_argument("--log-file", default=None, help="额外把日志写入该文件")
    args = parser.parse_args()

    session_id = args.session or ("zcode-relay-" + os.uname().nodename.split(".")[0])

    RelayHandler.upstream_host = args.upstream_host
    RelayHandler.upstream_prefix = args.upstream_prefix
    RelayHandler.session_id = session_id
    RelayHandler.upstream_timeout = args.timeout
    RelayHandler.log_file = args.log_file

    server = ThreadingHTTPServer((args.host, args.port), RelayHandler)
    log("opencode relay listening on http://%s:%d -> https://%s%s (session=%s)" % (
        args.host, args.port, args.upstream_host, args.upstream_prefix, session_id), args.log_file)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("relay stopped by user", args.log_file)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
