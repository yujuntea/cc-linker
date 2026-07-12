/**
 * XML/PCDATA 转义,用于 launchd plist `<string>...</string>` 内部。
 * 把 `& < > " '` 转成对应 entity,避免 PATH 含 `&` (e.g. `node && npm` aliases
 * 或 Homebrew 路径含 `&`)时 plist 损坏 + `launchctl load` 静默失败。
 *
 * 注意 `&` 必须先转义,否则后续的 `&lt;` 等会被双重转义。
 */
export function escapePlistString(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}