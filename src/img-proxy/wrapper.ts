import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export const WRAPPER_START_MARKER = '# >>> cc-linker img-proxy wrapper (do not edit this block) >>>';
export const WRAPPER_END_MARKER = '# <<< cc-linker img-proxy wrapper <<<';

const WRAPPER_BLOCK_RE = new RegExp(
  `^${escapeRegex(WRAPPER_START_MARKER)}[\\s\\S]*?${escapeRegex(WRAPPER_END_MARKER)}\\n?`,
  'm',
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 生成 wrapper 函数代码块(含 markers),可直接追加到 shell rc 文件。
 * 含递归防护:`ANTHROPIC_BASE_URL` 已设则直接 exec claude(避免 alias 链 + 多余 sub-shell)。
 */
export function generateWrapperBlock(): string {
  return `${WRAPPER_START_MARKER}
cc-linker-proxy() {
  # === 递归防护(验收 §14.7 E7) ===
  if [ -n "\${ANTHROPIC_BASE_URL:-}" ]; then
    command claude "\$@"
    return \$?
  fi

  local real_url="\$(command cc-linker img-proxy current-url)"
  if [ -z "\$real_url" ]; then
    echo "cc-linker-proxy: 找不到当前 provider URL" >&2
    echo "  检查 ~/.claude/settings.json 是否含 env.ANTHROPIC_BASE_URL" >&2
    return 1
  fi
  local proxy_url
  proxy_url="\$(command cc-linker img-proxy resolve "\$real_url")"
  if [ -z "\$proxy_url" ]; then
    echo "cc-linker-proxy: \$real_url 没在 img-proxy 里" >&2
    echo "  hint: cc-linker img-proxy install" >&2
    return 1
  fi
  ANTHROPIC_BASE_URL="\$proxy_url" command claude "\$@"
}
${WRAPPER_END_MARKER}
`;
}

/** 检测 rc 文件是否含 wrapper(start marker 出现)。 */
export function isWrapperInstalled(rcFile: string): boolean {
  if (!existsSync(rcFile)) return false;
  try {
    return readFileSync(rcFile, 'utf8').includes(WRAPPER_START_MARKER);
  } catch {
    return false;
  }
}

/**
 * 把 wrapper 追加到 rc 文件。幂等:已装直接返回 installed:false。
 * 返回 { installed, reason?, backupPath? }。
 */
export function installWrapper(
  rcFile: string,
  backupDir: string,
): { installed: boolean; reason?: string; rcFile: string; backupPath?: string } {
  const content = existsSync(rcFile) ? readFileSync(rcFile, 'utf8') : '';
  if (content.includes(WRAPPER_START_MARKER)) {
    return { installed: false, reason: 'wrapper 已装(idempotent)', rcFile };
  }

  let backupPath: string | undefined;
  if (content) {
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `wrapper-backup-${Date.now()}`);
    copyFileSync(rcFile, backupPath);
  }

  const block = generateWrapperBlock();
  const newContent = content + (content.endsWith('\n') ? '' : '\n') + block + '\n';
  mkdirSync(dirname(rcFile), { recursive: true });
  writeFileSync(rcFile, newContent, { mode: 0o644 });

  return { installed: true, rcFile, backupPath };
}

/**
 * 从 rc 文件移除 wrapper。幂等:没找到 marker 返回 removed:false。
 */
export function uninstallWrapper(
  rcFile: string,
  backupDir: string,
): { removed: boolean; rcFile: string; backupPath?: string } {
  if (!existsSync(rcFile)) return { removed: false, rcFile };
  const content = readFileSync(rcFile, 'utf8');
  const match = content.match(WRAPPER_BLOCK_RE);
  if (!match) return { removed: false, rcFile };

  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `wrapper-backup-removed-${Date.now()}`);
  copyFileSync(rcFile, backupPath);

  const newContent = content.replace(WRAPPER_BLOCK_RE, '');
  writeFileSync(rcFile, newContent, { mode: 0o644 });
  return { removed: true, rcFile, backupPath };
}

/** 检测用户当前 shell(zsh/bash)。返回 null 表示不支持。 */
export function detectShell(): 'zsh' | 'bash' | null {
  if (process.env.ZSH_VERSION) return 'zsh';
  if (process.env.BASH_VERSION) return 'bash';
  return null;
}

/** 获取指定 shell 的 rc 文件路径。 */
export function getRcFilePath(shell: 'zsh' | 'bash', home?: string): string {
  const h = home ?? process.env.HOME ?? '';
  return join(h, shell === 'zsh' ? '.zshrc' : '.bashrc');
}
