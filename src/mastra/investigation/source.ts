import { readFileSync, existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

// Read-only source access, scoped to the demo webapp's checkout (the Mastra Workspace
// filesystem role, done as a scoped fs read). The agent may only read under WEBAPP_SRC;
// any path outside it returns null. Widening what the agent SEES, never what it can DO.
const SRC_ROOT = process.env.WEBAPP_SRC || path.resolve(process.cwd(), 'demo-webapp')

// Lines of surrounding code shown on each side of the target line, so the snippet reads with
// enough context to explain the failure without dumping the whole file.
const CONTEXT_LINES = 3

export interface SourceSnippet { path: string; line: number; snippet: string }

export function readSourceSnippet(file: string, line: number): SourceSnippet | null {
  // Accept either an absolute path or a path relative to the source root.
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(SRC_ROOT, file)
  if (!existsSync(abs)) return null
  // Resolve real paths (defeats symlink escapes) and compare on a path BOUNDARY, so a
  // sibling dir like `<root>-secrets` cannot masquerade as in-root via a prefix match.
  let root: string
  let real: string
  try {
    root = realpathSync(SRC_ROOT)
    real = realpathSync(abs)
  } catch {
    return null // realpath throws on a missing/broken path
  }
  if (real !== root && !real.startsWith(root + path.sep)) return null // read-only, scoped
  const lines = readFileSync(real, 'utf8').split('\n')
  if (line < 1 || line > lines.length) return null
  const from = Math.max(0, line - 1 - CONTEXT_LINES) // line is 1-based; slice start is 0-based
  const to = Math.min(lines.length, line + CONTEXT_LINES)
  const snippet = lines
    .slice(from, to)
    .map((t, i) => `${from + i + 1 === line ? '> ' : '  '}${from + i + 1}: ${t}`)
    .join('\n')
  return { path: path.relative(root, real), line, snippet }
}
