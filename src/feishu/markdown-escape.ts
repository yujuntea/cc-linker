/**
 * Escape `<` and `>` for use inside Feishu interactive card markdown content.
 *
 * **Scope of this helper (deliberately narrow):**
 *
 * - **What it prevents:** Feishu card markdown renders `<` and `>` as
 *   HTML-like delimiters, so a raw `<` in user input can leak what looks like
 *   a tag into the card, and a `>` can prematurely close a code span.
 *   `esc()` blocks both.
 *
 * - **What it does NOT prevent (out of scope):** Feishu card markdown ALSO
 *   renders `*` `_` `**` `~~` `` ` `` as formatting (bold/italic/strike/code).
 *   A session title like `**URGENT**` will display as bold in the card, and
 *   `` `cmd` `` will display as inline code. `esc()` does nothing about
 *   this — if you need to neutralize markdown-style injection, you need a
 *   different helper (backslash-escape, sentinel-replace, or sanitize before
 *   the title lands in registry). This is a known and accepted gap.
 *
 * - **Why we don't escape `&`:** adding `&` → `&amp;` would force callers who
 *   re-escape to track order (`&` first, then `<`/`>`), and Feishu's renderer
 *   does not produce output where a raw `&` is unsafe in card text. Leaving
 *   it alone keeps the rule simple.
 *
 * **Caller contract:** any field that comes from a user-controlled source
 * (session title, preview, provider name from config.toml, directory path,
 * etc.) and is interpolated into a `tag: 'markdown'` content string MUST
 * pass through `esc()`. For previews that are also length-truncated, apply
 * `preview()` first and `esc()` after — see `buildListCard` for the
 * reference pattern.
 */
export function esc(text: string): string {
  return text.replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;'));
}
