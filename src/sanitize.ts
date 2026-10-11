/**
 * Makes untrusted text safe to draw.
 *
 * Folder names, branch names, model names, and progress labels come from
 * outside paceline. A cloned repo controls its folder and branch names, and
 * control characters, zero-width characters, and bidi overrides can hide text
 * or reorder what follows it, so every such string passes through `clean`.
 */

const ELLIPSIS = '\u2026'

function isUnsafe(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff ||
    // U+FFFD stands in for bytes that were not valid UTF-8, and a lone
    // surrogate is the same problem in a JavaScript string: drop both.
    cp === 0xfffd ||
    (cp >= 0xd800 && cp <= 0xdfff)
  )
}

/**
 * Strips unsafe characters and caps the result at `maxChars` code points,
 * ending in an ellipsis when it was cut.
 */
export function clean(text: string, maxChars: number): string {
  const kept: string[] = []
  for (const ch of text) {
    if (isUnsafe(ch.codePointAt(0) ?? 0)) continue
    if (kept.length === maxChars) {
      return kept.slice(0, maxChars - 1).join('') + ELLIPSIS
    }
    kept.push(ch)
  }
  return kept.join('')
}
