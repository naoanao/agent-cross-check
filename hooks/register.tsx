import {
  LOG_FORMAT, parseLog, foreignCommits, mayAutoReview, secretPatternHits, lineEndingChurn, shortstatLines, describe, reviewPrompt,
  isReportFile, addedByFile, claimLines, namedPaths, isGitPush, pushDenial, pushTargetDir,
} from './logic.js'

let trusted = 'Co-Authored-By: Claude'
let autoReview = false
let ceiling = 90
let everyMinutes = 10
let blockPush = true
let reportFiles = ''
let pending = []
let reviewing = []
let timer = null

async function git($, args) {
  try {
    // core.quotepath=false keeps non-ASCII file names readable in the diff
    const r = await $.process.run(['git', '-c', 'core.quotepath=false', ...args], { timeoutMs: 30000 })
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

async function exists($, path) {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

// Audio tracks in a video, by ffprobe when it is installed; undefined when it cannot be measured.
async function audioTracks($, path) {
  try {
    const r = await $.process.run(['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path], { timeoutMs: 30000 })
    if (r.exitCode !== 0) return undefined
    return String(r.stdout || '').split('\n').filter((l) => l.trim()).length
  } catch {
    return undefined
  }
}

async function facts($, hash) {
  const files = (await git($, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash])).out.split('\n').filter(Boolean)
  const stat = (await git($, ['show', '--shortstat', '--format=', hash])).out
  const statCr = (await git($, ['show', '--shortstat', '--ignore-cr-at-eol', '--format=', hash])).out
  const diff = (await git($, ['show', '--format=', hash])).out
  const root = (await git($, ['rev-parse', '--show-toplevel'])).out.trim()

  // What the other agent's report says, compared with what is really there
  const reportLines = [...addedByFile(diff)].filter(([f]) => isReportFile(f, reportFiles)).flatMap(([, ls]) => ls)
  const missing = []
  const silentVideos = []
  for (const p of namedPaths(reportLines).slice(0, 40)) {
    const abs = /^([A-Za-z]:\\|\/)/.test(p) ? p : root + '/' + p
    if (!(await exists($, abs))) missing.push(p)
    else if (/\.(mp4|mov)$/i.test(p) && (await audioTracks($, abs)) === 0) silentVideos.push(p)
  }

  return {
    files: files.length,
    lines: shortstatLines(stat),
    churn: lineEndingChurn(stat, statCr),
    secrets: secretPatternHits(diff),
    envFiles: files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.(example|sample|template)$/.test(f)),
    claims: claimLines(reportLines),
    missing,
    silentVideos,
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

// Builds the summary and moves the commits from waiting to under review. They stay there, and a push
// waits, until the review is marked done.
async function startReview($, auto) {
  const commits = pending.slice()
  const lines = []
  for (const c of commits) lines.push(describe(c, await facts($, c.hash)))
  const summary = lines.join('\n')
  reviewing = reviewing.concat(commits)
  pending = []
  await save($, 'pending', pending)
  await save($, 'reviewing', reviewing)
  if (auto) await save($, 'lastAuto', await $.clock.now())
  $.ui.invalidate('ui.render')
  submitSoon($, reviewPrompt(commits, summary))
  return summary
}

// Marks commits reviewed: the given hashes (any unique prefix), or all when none are given.
async function markReviewed($, hashes) {
  const want = (hashes || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean)
  const match = (c) => want.length === 0 || want.some((h) => c.hash.toLowerCase().startsWith(h))
  const before = pending.length + reviewing.length
  pending = pending.filter((c) => !match(c))
  reviewing = reviewing.filter((c) => !match(c))
  await save($, 'pending', pending)
  await save($, 'reviewing', reviewing)
  $.ui.invalidate('ui.render')
  const done = before - pending.length - reviewing.length
  return 'Marked ' + done + ' commit(s) reviewed. ' + (pending.length + reviewing.length) + ' still waiting.'
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
  const found = foreignCommits(parseLog(log.out), trusted, pending.concat(reviewing))
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

// A push waits while another agent's commits are unreviewed. A push in another repository is not this one's business.
async function holdPush($, e, next) {
  if (!blockPush || !isGitPush(e.command)) return next(e)
  const dir = pushTargetDir(e.command)
  if (dir) {
    const here = (await git($, ['rev-parse', '--show-toplevel'])).out.trim()
    const there = (await git($, ['-C', dir, 'rev-parse', '--show-toplevel'])).out.trim()
    if (there && here && there.toLowerCase() !== here.toLowerCase()) return next(e)
  }
  await check($)
  const blockers = pending.concat(reviewing)
  return blockers.length ? { deny: pushDenial(blockers) } : next(e)
}

export function register(on, options) {
  trusted = String(options?.trustedMarker ?? trusted)
  autoReview = options?.autoReview === true
  ceiling = Number(options?.usageCeiling ?? ceiling) || 90
  everyMinutes = Math.max(1, Number(options?.checkEveryMinutes ?? everyMinutes) || 10)
  blockPush = options?.blockPush !== false
  reportFiles = String(options?.reportFiles ?? '')

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'cross-check', description: 'Review commits another agent made: mechanical checks, then ask Claude to audit them (/cross-check done when reviewed, /cross-check skip to dismiss)' })
    await $.tool.register({
      name: 'mark_reviewed',
      description: 'After auditing commits another agent made (by diff, tests and the real files), mark them reviewed so git push may go ahead. Give the hashes you reviewed.',
      inputSchema: { type: 'object', properties: { hashes: { type: 'array', items: { type: 'string' } } }, required: ['hashes'] },
      isDeferred: false,
    })
    pending = await load($, 'pending', [])
    reviewing = await load($, 'reviewing', [])
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
    const args = String(e.args || '').trim().split(/\s+/).filter(Boolean)
    if (args[0] === 'done') return { text: await markReviewed($, args.slice(1)) }
    if (args[0] === 'skip') {
      const n = pending.length
      pending = []
      await save($, 'pending', pending)
      $.ui.invalidate('ui.render')
      return { text: 'Dismissed ' + n + ' commit(s) without review.' }
    }
    if (pending.length === 0) {
      return { text: reviewing.length ? reviewing.length + ' commit(s) under review. When done: /cross-check done' : 'No unreviewed commits from another agent.' }
    }
    const summary = await startReview($, false)
    return { text: summary + '\n\nAsked Claude to review these commits.' }
  })

  // Claude marks the commits it audited. An empty list marks nothing (all-at-once is /cross-check done, for the person).
  on('tool.call', { tool: 'mcp__agent-cross-check__mark_reviewed' }, async ($, e) => {
    const hashes = Array.isArray(e.hashes) ? e.hashes.filter(Boolean) : []
    if (hashes.length === 0) return { result: 'Give the hashes you reviewed.' }
    return { result: await markReviewed($, hashes) }
  })

  // PowerShell is watched as well as Bash, so the hold cannot be stepped around by changing shells.
  on('tool.call', { tool: 'Bash' }, holdPush).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'PowerShell' }, holdPush).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const waiting = pending.length + reviewing.length
    if (e.props.hasSurvey || waiting === 0) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text color="yellow">agent-cross-check: {waiting} commit(s) from another agent not reviewed yet (/cross-check){blockPush ? ', git push waits' : ''}</Text>
  })
}
