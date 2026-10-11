/**
 * Turns the model id a session reports (`claude-opus-5-5`) into the name the
 * status line shows (`Opus 5.5`). The mods API gives the id, not Claude
 * Code's display name.
 */

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']

/** Returns a model id's display name, or the id itself when it is unfamiliar. */
export function modelName(id: string): string {
  // Drop a context-size tag (`[1m]`) and a date stamp (`-20250929`).
  const bare = id
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
  const tokens = bare.toLowerCase().split('-')
  if (tokens[0] !== 'claude') return id
  const family = tokens.find(t => FAMILIES.includes(t))
  if (!family) return id
  const version = tokens.filter(t => /^\d+$/.test(t))
  const name = family[0].toUpperCase() + family.slice(1)
  return version.length > 0 ? `${name} ${version.join('.')}` : name
}
