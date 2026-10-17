// Pure decision functions. No engine calls here, so the tests can call them directly.

const RS = '\x1e'
const US = '\x1f'

// The git log format the module asks for: hash, author, subject, body, separated so any text is safe.
export const LOG_FORMAT = '%H' + US + '%an' + US + '%s' + US + '%B' + RS

// Commits from `git log --format=LOG_FORMAT`, oldest first as git was asked.
export function parseLog(out) {
  return String(out || '')
    .split(RS)
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, author, subject, body] = r.split(US)
      return { hash: (hash || '').trim(), author: author || '', subject: subject || '', body: body || '' }
    })
    .filter((c) => /^[0-9a-f]{7,40}$/.test(c.hash))
}

// A commit counts as this agent's own when its message carries the trusted marker (case-insensitive).
export function isOwn(commit, trusted) {
  const marks = String(trusted || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (marks.length === 0) return false
  const text = (commit.subject + '\n' + commit.body).toLowerCase()
  return marks.some((m) => text.includes(m))
}

// New commits that need a second look: not seen yet, not already pending, not this agent's own.
export function foreignCommits(commits, trusted, pending) {
  const have = new Set((pending || []).map((p) => p.hash))
  return commits
    .filter((c) => !isOwn(c, trusted) && !have.has(c.hash))
    .map((c) => ({ hash: c.hash, author: c.author, subject: c.subject }))
}

// Whether an automatic review may start now: an hour apart, and neither usage window at or above the ceiling.
export function mayAutoReview(nowMs, lastAutoMs, rateLimits, ceilingPercent) {
  if (lastAutoMs && nowMs - lastAutoMs < 60 * 60 * 1000) return { ok: false, why: 'reviewed less than an hour ago' }
  const high = (rateLimits || []).find((r) => (r.kind === 'five_hour' || r.kind === 'seven_day') && r.percentUsed >= ceilingPercent)
  if (high) return { ok: false, why: 'usage ' + high.kind + ' at ' + high.percentUsed + '%' }
  return { ok: true, why: '' }
}

// Known secret formats in the added lines of a diff.
export function secretPatternHits(diffText) {
  const pats = {
    'Stripe live key': /sk_live_[A-Za-z0-9]{8,}/g,
    'Stripe test key': /sk_test_[A-Za-z0-9]{8,}/g,
    'JWT': /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
    'GitHub token': /gh[pousr]_[A-Za-z0-9]{20,}/g,
    'OpenAI / Anthropic key': /sk-(ant-)?[A-Za-z0-9_-]{20,}/g,
    'Google API key': /AIza[0-9A-Za-z_-]{30,}/g,
    'AWS access key': /AKIA[0-9A-Z]{16}/g,
    'Private key block': /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  }
  const added = String(diffText || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')
  const out = []
  for (const [name, re] of Object.entries(pats)) {
    const n = (added.match(re) || []).length
    if (n > 0) out.push(name + ' x' + n)
  }
  return out
}

export function shortstatLines(s) {
  const ins = Number((String(s).match(/(\d+) insertion/) || [])[1] || 0)
  const del = Number((String(s).match(/(\d+) deletion/) || [])[1] || 0)
  return ins + del
}

export function lineEndingChurn(plain, ignoringCr) {
  const a = shortstatLines(plain)
  const b = shortstatLines(ignoringCr)
  return a !== b ? { shown: a, real: b } : null
}

// One line per commit for the summary.
export function describe(c, facts) {
  const bits = [c.hash.slice(0, 7) + ' ' + c.subject + ' (' + c.author + ')']
  bits.push('  ' + (facts.files || 0) + ' file(s), ' + (facts.lines || 0) + ' line(s) changed')
  if (facts.churn) bits.push('  LINE ENDINGS CHANGED: diff shows ' + facts.churn.shown + ' lines, real content ' + facts.churn.real)
  if (facts.secrets && facts.secrets.length) bits.push('  SECRET-LOOKING STRINGS: ' + facts.secrets.join(', '))
  if (facts.envFiles && facts.envFiles.length) bits.push('  .env FILES COMMITTED: ' + facts.envFiles.join(', '))
  if (facts.missing && facts.missing.length) bits.push('  FILES THE REPORT NAMES BUT THAT DO NOT EXIST: ' + facts.missing.join(', '))
  if (facts.silentVideos && facts.silentVideos.length) bits.push('  VIDEOS WITH NO AUDIO TRACK: ' + facts.silentVideos.join(', '))
  if (facts.claims && facts.claims.length) bits.push('  CLAIMS IN THE REPORT TO CONFIRM:', ...facts.claims.map((c) => '    - ' + c))
  return bits.join('\n')
}

// The prompt that asks Claude to review the other agent's commits.
export function reviewPrompt(commits, summary) {
  const list = commits.map((c) => c.hash.slice(0, 7)).join(' ')
  return [
    'Another agent (or a person) committed to this repository and nobody has reviewed it yet: ' + list + '.',
    'Review these commits as an auditor. Check them against the diffs and by running the relevant tests. Do not rely on their commit messages or any report they wrote.',
    'For each commit, report what actually changed, what is broken or risky, and what you could not verify.',
    'Do not change, revert or rewrite these commits. Only report.',
    'Where the checks below list claims, missing files or videos without sound, confirm each against the real thing.',
    'When the review is finished, call the tool mcp__agent-cross-check__mark_reviewed with the hashes you reviewed. Until then, git push waits.',
    '',
    'Mechanical checks already run:',
    summary,
  ].join('\n')
}

// ---- 0.2.0: compare the other agent's report with what is really there ----

// Words in a report that claim something was done or measured. English and Japanese.
export const CLAIM_RE = /(all (tests )?pass(ed)?|100%|verified|tested on real|works perfectly|fully (working|tested)|zero (errors|bugs|issues)|完全|ゼロ|検証済み|動作確認済み|実機.{0,6}(成功|確認)|ALL PASS|実レシート|本物の|予約済み|試作した)/gi

// Whether a changed file is a report or handoff, the text whose claims are checked.
export function isReportFile(path, pattern) {
  try {
    return new RegExp(pattern || '(report|handoff|summary|報告|引き継ぎ|一覧)[^/]*\\.md$', 'i').test(String(path || ''))
  } catch {
    return false
  }
}

// Added lines of a plain `git show` diff, per file.
export function addedByFile(diffText) {
  const map = new Map()
  let cur = ''
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      cur = line.replace(/^\+\+\+ (b\/)?/, '').replace(/^"|"$/g, '').trim()
      if (!map.has(cur)) map.set(cur, [])
    } else if (line.startsWith('+') && cur) {
      map.get(cur).push(line.slice(1))
    }
  }
  return map
}

// Report lines that claim something, each shortened (at most 10).
export function claimLines(lines) {
  const out = []
  for (const line of lines) {
    const m = String(line).match(CLAIM_RE)
    if (m) out.push([...new Set(m.map((x) => x.toLowerCase()))].join(', ') + ': ' + String(line).trim().slice(0, 100))
    if (out.length >= 10) break
  }
  return out
}

const EXT = '(?:py|ts|tsx|js|mjs|gs|md|json|mp4|mov|png|jpg|zip|html|xlsx|pdf|csv)'

// File paths a report names: in backticks, or absolute. Bare names, URLs and <placeholders> are left out,
// since nobody can say where they should be.
export function namedPaths(lines) {
  const set = new Set()
  for (const line of lines) {
    for (const m of String(line).matchAll(new RegExp('`([^`\\s]+\\.' + EXT + ')`', 'g'))) set.add(m[1])
    // An absolute path starts a token: not the "/name.ts" tail of "src/name.ts"
    for (const m of String(line).matchAll(new RegExp('(?<![\\w./\\\\-])((?:[A-Za-z]:\\\\|/)[^\\s`\'"]+\\.' + EXT + ')', 'g'))) set.add(m[1])
  }
  return [...set].filter((p) => /[\\/]/.test(p) && !/[<>]/.test(p) && !/^[a-z0-9-]+\.[a-z]{2,}\//i.test(p))
}

// Whether a shell command really runs `git push`. Text inside a heredoc or quotes does not count:
// a file being written that mentions "git push" is not a push.
export function isGitPush(command) {
  const code = String(command || '')
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, '\n')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
  return /(^|[;&|(]\s*|\n\s*)git(\s+-[Cc]\s+\S+)*\s+push\b/.test(code)
}

// The folder a push command runs in, when the command names one (`git -C <dir> push`, `cd <dir> && ...`,
// `Set-Location <dir>; ...`); undefined when it runs where the session is.
export function pushTargetDir(command) {
  const code = String(command || '')
  const unquote = (s) => s.replace(/^["']|["']$/g, '')
  const c = code.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(?:-c\s+\S+\s+)*push\b/)
  if (c) return unquote(c[1])
  const cd = code.match(/(?:^|[;&\n]\s*)(?:cd|Set-Location|sl|pushd)\s+(?:-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/)
  if (cd) return unquote(cd[1])
  return undefined
}

// The message a stopped push carries.
export function pushDenial(blockers) {
  return [
    'agent-cross-check: ' + blockers.length + ' commit(s) from another agent have not been reviewed, so this push waits:',
    ...blockers.map((c) => '  - ' + c.hash.slice(0, 7) + ' ' + c.subject),
    'Review them by diff and tests (/cross-check), then mark them with the tool mcp__agent-cross-check__mark_reviewed or /cross-check done.',
  ].join('\n')
}
