import {
  LOG_FORMAT, parseLog, foreignCommits, mayAutoReview, secretPatternHits, lineEndingChurn, shortstatLines, describe, reviewPrompt,
} from './logic.js'

let trusted = 'Co-Authored-By: Claude'
let autoReview = false
let ceiling = 90
let everyMinutes = 10
let pending = []
let timer = null

async function git($, args) {
  try {
    const r = await $.process.run(['git', ...args], { timeoutMs: 30000 })
    return { ok: r.exitCode === 0, out: String(r.stdout || '') }
  } catch {
    return { ok: false, out: '' }
  }
}

async function load($, key, fallback) {
  try {
    const v = await $.store.get(key)
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

async function save($, key, value) {
  try {
    await $.store.set(key, value)
  } catch {
    // nothing to keep it in: the next check starts over
  }
}

async function facts($, hash) {
  const files = (await git($, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash])).out.split('\n').filter(Boolean)
  const stat = (await git($, ['show', '--shortstat', '--format=', hash])).out
  const statCr = (await git($, ['show', '--shortstat', '--ignore-cr-at-eol', '--format=', hash])).out
  const diff = (await git($, ['show', '--format=', hash])).out
  return {
    files: files.length,
    lines: shortstatLines(stat),
    churn: lineEndingChurn(stat, statCr),
    secrets: secretPatternHits(diff),
    envFiles: files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.(example|sample|template)$/.test(f)),
  }
}

// A command hook holds the turn, so a prompt submitted from it would wait on itself: submit from a timer instead.
function submitSoon($, text) {
  try {
    $.clock.after(50, () => { void $.prompt.submit({ text }) })
  } catch {
    void $.prompt.fill({ text }).catch(() => {})
  }
}

async function startReview($, auto) {
  const commits = pending.slice()
  const lines = []
  for (const c of commits) lines.push(describe(c, await facts($, c.hash)))
  const summary = lines.join('\n')
  pending = []
  await save($, 'pending', pending)
  if (auto) await save($, 'lastAuto', await $.clock.now())
  $.ui.invalidate('ui.render')
  submitSoon($, reviewPrompt(commits, summary))
  return summary
}

async function check($) {
  const head = await git($, ['rev-parse', 'HEAD'])
  if (!head.ok) return
  const now = head.out.trim()
  const last = await load($, 'lastSeen', '')
  if (!last) {
    await save($, 'lastSeen', now)
    return
  }
  if (last === now) return
  const ancestor = await git($, ['merge-base', '--is-ancestor', last, now])
  if (!ancestor.ok) {
    await save($, 'lastSeen', now)
    $.ui.toast('agent-cross-check: history was rewritten, watching again from the current commit')
    return
  }
  const log = await git($, ['log', '--reverse', '--format=' + LOG_FORMAT, last + '..' + now])
  const found = foreignCommits(parseLog(log.out), trusted, pending)
  await save($, 'lastSeen', now)
  if (found.length === 0) return
  pending = pending.concat(found)
  await save($, 'pending', pending)
  $.ui.invalidate('ui.render')
  $.ui.toast('agent-cross-check: ' + found.length + ' new commit(s) from another agent')
  if (!autoReview) return
  let rateLimits = []
  try {
    rateLimits = (await $.session.usage()).rateLimits
  } catch {
    rateLimits = []
  }
  const may = mayAutoReview(await $.clock.now(), Number(await load($, 'lastAuto', 0)), rateLimits, ceiling)
  if (may.ok) await startReview($, true)
  else $.ui.toast('agent-cross-check: review waits (' + may.why + '). Run /cross-check when ready.')
}

export function register(on, options) {
  trusted = String(options?.trustedMarker ?? trusted)
  autoReview = options?.autoReview === true
  ceiling = Number(options?.usageCeiling ?? ceiling) || 90
  everyMinutes = Math.max(1, Number(options?.checkEveryMinutes ?? everyMinutes) || 10)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'cross-check', description: 'Review commits another agent made: mechanical checks, then ask Claude to audit them (/cross-check skip to dismiss)' })
    pending = await load($, 'pending', [])
    await check($)
    try {
      timer = $.clock.every(everyMinutes * 60 * 1000, () => { void check($) })
    } catch {
      timer = null
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await check($)
    return next(e)
  })

  on('command.run', { command: 'cross-check' }, async ($, e) => {
    await check($)
    if (pending.length === 0) return { text: 'No unreviewed commits from another agent.' }
    if (String(e.args || '').trim() === 'skip') {
      const n = pending.length
      pending = []
      await save($, 'pending', pending)
      $.ui.invalidate('ui.render')
      return { text: 'Dismissed ' + n + ' commit(s) without review.' }
    }
    const summary = await startReview($, false)
    return { text: summary + '\n\nAsked Claude to review these commits.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || pending.length === 0) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text color="yellow">agent-cross-check: {pending.length} commit(s) from another agent not reviewed yet (/cross-check)</Text>
  })
}
