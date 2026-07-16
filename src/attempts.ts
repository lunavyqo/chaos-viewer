/**
 * Match attempt tree (experimental) — loaded from the decomp's published log.
 *
 * Sources (first hit wins):
 *  1. Next to chaos-db.json:  <dataDir>/match_attempts.jsonl  (chaos-data CI)
 *  2. Repo main:  raw…/main/config/match_attempts.jsonl
 *  3. Repo chaos-data: raw…/chaos-data/match_attempts.jsonl
 */

export type AttemptRow = {
  schemaVersion?: number
  functionId: string
  id?: string
  attemptId?: string
  parentAttemptId?: string | null
  loggedAt?: string
  ts?: string
  module?: string
  addr?: number | string
  name?: string
  status?: string
  kind?: string
  model?: string
  reasoning?: string
  harness?: string
  author?: string
  divergences?: number | null
  prevBestDivergences?: number | null
  improvedNearMiss?: boolean
  srcPath?: string
  note?: string
  sessionScope?: string
  batchSize?: number
  base?: { kind?: string; attemptId?: string; divergences?: number }
  usedNearMissDraft?: boolean
  usedGhidraDraft?: boolean
}

export type AttemptTreeNode = {
  row: AttemptRow
  children: AttemptTreeNode[]
}

function bust(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}t=${Date.now()}`
}

/** Parse append-only JSONL into rows (skips bad lines). */
export function parseAttemptsJsonl(text: string): AttemptRow[] {
  const out: AttemptRow[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    try {
      const r = JSON.parse(t) as AttemptRow
      const fid = r.functionId || r.id
      if (!fid) continue
      out.push({ ...r, functionId: fid })
    } catch {
      /* skip */
    }
  }
  return out
}

function githubParts(github: string): { owner: string; name: string } | null {
  const m = github.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!m) return null
  return { owner: m[1], name: m[2] }
}

/** Candidate URLs for the attempt log. */
export function attemptLogUrls(opts: {
  dataUrl?: string | null
  github?: string | null
  branch?: string | null
}): string[] {
  const urls: string[] = []
  if (opts.dataUrl) {
    // sibling of chaos-db.json on whatever host serves the atlas
    urls.push(opts.dataUrl.replace(/[^/]*$/, 'match_attempts.jsonl'))
  }
  const gh = opts.github ? githubParts(opts.github) : null
  if (gh) {
    const br = (opts.branch || 'main').replace(/^\/+|\/+$/g, '')
    urls.push(
      `https://raw.githubusercontent.com/${gh.owner}/${gh.name}/${br}/config/match_attempts.jsonl`,
    )
    urls.push(
      `https://raw.githubusercontent.com/${gh.owner}/${gh.name}/chaos-data/match_attempts.jsonl`,
    )
    if (br !== 'main') {
      urls.push(
        `https://raw.githubusercontent.com/${gh.owner}/${gh.name}/main/config/match_attempts.jsonl`,
      )
    }
  }
  return [...new Set(urls)]
}

export async function fetchAttemptsLog(urls: string[]): Promise<{
  rows: AttemptRow[]
  source: string | null
}> {
  for (const url of urls) {
    try {
      const r = await fetch(bust(url))
      if (!r.ok) continue
      const text = await r.text()
      const rows = parseAttemptsJsonl(text)
      if (rows.length) return { rows, source: url }
      // empty file is still a hit
      return { rows: [], source: url }
    } catch {
      /* try next */
    }
  }
  return { rows: [], source: null }
}

/** All rows for one function, chronological. */
export function rowsForFunction(all: AttemptRow[], functionId: string): AttemptRow[] {
  return all
    .filter(r => r.functionId === functionId)
    .sort((a, b) => {
      const ta = a.loggedAt || a.ts || ''
      const tb = b.loggedAt || b.ts || ''
      return ta.localeCompare(tb)
    })
}

/**
 * Build forest of attempt trees. Parent links by attemptId; orphans become roots.
 * Chronological siblings under each parent.
 */
export function buildAttemptForest(rows: AttemptRow[]): AttemptTreeNode[] {
  if (!rows.length) return []
  const byId = new Map<string, AttemptTreeNode>()
  for (const row of rows) {
    const id = row.attemptId || `${row.functionId}:${row.loggedAt || row.ts || Math.random()}`
    byId.set(id, { row: { ...row, attemptId: id }, children: [] })
  }
  const roots: AttemptTreeNode[] = []
  for (const node of byId.values()) {
    const parentId = node.row.parentAttemptId
    if (parentId && byId.has(parentId) && parentId !== node.row.attemptId) {
      byId.get(parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortRec = (nodes: AttemptTreeNode[]) => {
    nodes.sort((a, b) => {
      const ta = a.row.loggedAt || a.row.ts || ''
      const tb = b.row.loggedAt || b.row.ts || ''
      return ta.localeCompare(tb)
    })
    for (const n of nodes) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

export function shortAttemptId(id?: string | null): string {
  if (!id) return '?'
  return id.length > 10 ? id.slice(0, 8) : id
}

export function formatAttemptWhen(row: AttemptRow): string {
  const raw = row.loggedAt || row.ts
  if (!raw) return ''
  try {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return raw
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
  } catch {
    return raw
  }
}

export function attemptStatusLabel(row: AttemptRow): string {
  const st = row.status || '?'
  if (st === 'near_miss' && row.divergences != null) return `near_miss div=${row.divergences}`
  if (st === 'matched') return 'matched'
  return st
}

export function attemptHowLine(row: AttemptRow): string {
  if (row.kind === 'human') return 'human'
  if (row.kind === 'ai') {
    const bits = [row.model, row.reasoning, row.harness].filter(Boolean)
    return bits.length ? `ai · ${bits.join(' · ')}` : 'ai'
  }
  return row.kind || ''
}
