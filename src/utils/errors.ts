export class CCLinkerError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'CCLinkerError';
  }

  override toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}

export function handleError(err: unknown): never {
  if (err instanceof CCLinkerError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) {
      console.error(`详情: ${JSON.stringify(err.details)}`);
    }

    const suggestions: Record<string, string[]> = {
      'E001': ['运行 cc-linker init 初始化 registry'],
      'E002': ['会话已被清理，无法恢复', '运行 cc-linker sync 重新扫描'],
      'E007': ['等待其他进程完成', '或删除 ~/.cc-linker/registry.json.lock'],
      'E008': ['会话创建目录已被删除，使用 --cwd 指定替代目录'],
      'E010': ['会话处于降级状态，执行 cc-linker start 触发自动修复'],
      'E011': ['会话仍在创建中，请稍后重试'],
      'E012': ['会话已损坏，请使用 /switch 切换到其他会话'],
      'E013': ['服务正在运行，请先执行 cc-linker stop 后再执行此命令'],
      'E_SDK_NO_CLAUDE': [
        '安装 Claude Code CLI: npm install -g @anthropic-ai/claude-code',
        '或在 config.toml 的 [sdk] section 显式设置 claude_executable',
      ],
      'E_CONFIG_WECOM_AUTH': [
        '检查 config.toml [wecom] 节的 bot_id 和 secret 是否正确',
        '运行 cc-linker init-wecom 重新配置企微凭证',
        '确认企业微信管理后台该智能机器人未被停用/删除',
      ],
      'E_CONFIG_WECOM_NETWORK': [
        '检查本机网络是否可达 wss://openws.work.weixin.qq.com',
        '如持续失败，launchd 会自动重启 bot 进程',
        '查看日志 ~/.cc-linker/logs/ 定位具体重连失败原因',
      ],
    };

    if (suggestions[err.code]) {
      console.error('建议:');
      suggestions[err.code].forEach(s => console.error(`  - ${s}`));
    }

    process.exit(1);
  }

  console.error(`未知错误: ${err}`);
  process.exit(1);
}
