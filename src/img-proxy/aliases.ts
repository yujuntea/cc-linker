import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { HOME } from '../utils/paths';

export interface DiscoveredAlias {
  name: string;
  providerPath: string | null;
  providerAlias: string | null;
  command: string;
}

const SHELL_RC_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile'];
const ALIAS_LINE_RE = /^alias\s+(cc-[\w-]+)\s*=\s*['"]?([^'"\n]*)['"]?\s*$/;
const SETTINGS_RE = /--settings\s+(\S+\.json)/;

export function discoverShellAliases(rcFiles?: string[]): DiscoveredAlias[] {
  const files = (rcFiles ?? defaultRcFiles()).filter(existsSync);
  const seen = new Set<string>();
  const result: DiscoveredAlias[] = [];

  for (const file of files) {
    const lines = safeReadLines(file);
    for (const rawLine of lines) {
      if (rawLine.trim().startsWith('#')) continue;
      // Strip trailing # comment(尊重引号)
      const line = stripTrailingComment(rawLine);
      const m = line.match(ALIAS_LINE_RE);
      if (!m) continue;
      const name = m[1]!;
      const cmd = m[2]!.trim();

      if (seen.has(name)) continue;
      seen.add(name);

      const settingsMatch = cmd.match(SETTINGS_RE);
      const providerPath = settingsMatch ? settingsMatch[1]! : null;
      const providerAlias = providerPath
        ? basename(providerPath, '.json')
        : null;

      result.push({ name, command: cmd, providerPath, providerAlias });
    }
  }
  return result;
}

function defaultRcFiles(): string[] {
  return SHELL_RC_FILES.map(f => join(HOME, f));
}

/**
 * Silent on missing/unreadable file — discovery function tolerates individual file failures.
 * If file is unreadable due to permissions, treat as empty (don't crash discovery).
 */
function safeReadLines(file: string): string[] {
  try { return readFileSync(file, 'utf8').split('\n'); }
  catch { return []; }
}

/**
 * Strip trailing # comment, respecting single/double-quoted strings.
 * Returns the line with any trailing comment removed.
 *
 * 用例:`alias cc-x='echo # hash' # 实际注释` → 把第一个 `# hash` 当 cmd 字符串保留,
 * 只删后面的 `# 实际注释`。比原来的 `\s+#.*$` 正则更稳。
 */
// Internal for testability — strip a # comment from a shell-rc line, knowing
// about quoted spans.  Kept package-internal (not in the public DiscoveredAlias
// surface) but exported via the test-hooks bag below for direct coverage.
export function stripTrailingComment(line: string): string {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      i++; // skip escaped char
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      if (i > 0 && /\s/.test(line[i - 1]!)) {
        return line.slice(0, i).replace(/\s+$/, '');
      }
    }
  }
  return line;
}
