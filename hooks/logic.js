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
    '',
    'Mechanical checks already run:',
    summary,
  ].join('\n')
}
