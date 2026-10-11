/**
 * Finds a folder's git directory and current branch by reading `.git` and
 * `HEAD` directly. No git process starts, so a repository's config, hooks, or
 * fsmonitor can never run code because the line was drawn.
 */

/** The file reads gitinfo needs, so tests can stand in for a disk. */
export type GitFs = {
  /** `'file'`, `'dir'`, or `'other'`; null when the path does not exist. */
  kind: (path: string) => Promise<'file' | 'dir' | 'other' | null>
  /** The file's text; null when it cannot be read. */
  read: (path: string) => Promise<string | null>
}

const MAX_HEAD_CHARS = 512
const MAX_BRANCH_CHARS = 32

/** Normalizes a path to forward slashes without a trailing separator. */
export function slashPath(p: string): string {
  const s = p.replaceAll('\\', '/')
  return s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s
}

function parent(p: string): string {
  const i = p.lastIndexOf('/')
  if (i < 0) return p
  if (i === 0) return '/'
  if (/^[A-Za-z]:$/.test(p.slice(0, i))) return p.slice(0, i + 1)
  return p.slice(0, i)
}

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p)

async function firstLine(fs: GitFs, path: string): Promise<string | null> {
  const text = await fs.read(path)
  if (text === null) return null
  return text.slice(0, MAX_HEAD_CHARS).split('\n')[0].replace(/\r$/, '')
}

/**
 * Returns the git directory for `dir`, walking up to the filesystem root, or
 * `''` outside a repository. In a worktree or submodule, `.git` is a file that
 * holds `gitdir: <path>`.
 */
export async function findGitDir(fs: GitFs, dir: string): Promise<string> {
  let current = slashPath(dir)
  for (;;) {
    const dotGit = join(current, '.git')
    const kind = await fs.kind(dotGit)
    if (kind === 'dir') return dotGit
    if (kind === 'file') {
      const line = await firstLine(fs, dotGit)
      if (line === null || !line.startsWith('gitdir:')) return ''
      const target = slashPath(line.slice('gitdir:'.length).trim())
      if (target === '') return ''
      return isAbsolute(target) ? target : join(current, target)
    }
    const up = parent(current)
    if (up === current) return ''
    current = up
  }
}

/**
 * Returns the branch checked out in `gitDir`, `detached <sha7>`, or `''`.
 * The result is raw repository data: clean it before drawing it.
 */
export async function branchIn(fs: GitFs, gitDir: string): Promise<string> {
  if (gitDir === '') return ''
  const head = await firstLine(fs, join(gitDir, 'HEAD'))
  if (head === null) return ''
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (ref) {
    const branch = [...ref[1].trim()]
    return branch.length > MAX_BRANCH_CHARS
      ? branch.slice(0, MAX_BRANCH_CHARS - 1).join('') + '\u2026'
      : branch.join('')
  }
  const sha = head.trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? `detached ${sha.slice(0, 7)}` : ''
}
