/**
 * Strip ANSI escape sequences from terminal output.
 * Covers: CSI (ESC [ ...), OSC (ESC ] ... BEL/ST),
 * DCS/SOS/PM/APC (ESC P/X/^/_ ... ST), single-char ESC sequences.
 * UTF-8 safe: 中文字节不会被误切(只在字节边界匹配控制序列)。
 */
export function stripAnsi(input: string): string {
  return input
    // CSI: \x1b\[ + 可选参数(数字/;/?/=) + 可选中间字符(空格-/) + 终止字符(@-~)
    .replace(/\x1b\[[0-9;?=]*[ -/]*[@-~]/g, '')
    // OSC: \x1b\] + 非 BEL/ESC 字符 + 终止符(BEL 或 ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS/SOS/PM/APC: \x1b[PX^_] + 非 ESC/BEL 字符 + 终止符
    .replace(/\x1b[PX^_][^\x1b\x07]*(?:\x1b\\|\x07)/g, '')
    // 单字符 ESC 序列(ESC + 任意字符)
    .replace(/\x1b[@-Z\\-_]/g, '');
}
