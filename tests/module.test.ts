import { expect, test } from 'claude-code/testing'

const RS = '\x1e'
const US = '\x1f'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const OWN = C + US + 'naoanao' + US + 'docs: notes' + US + 'docs: notes\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>' + RS
const THEIRS = B + US + 'naoanao' + US + 'feat: new pricing page' + US + 'feat: new pricing page' + RS

// A fake engine: git answers from a script, the store is a Map, submitted prompts are recorded.
function fakeEngine(on, opts: { head: string; store?: Record<string, unknown>; usage?: number }) {
  const store = new Map(Object.entries(opts.store || {}))
  const prompts: string[] = []
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false } })
  on('process.run', async ($, e) => {
    const a = e.argv.slice(1).join(' ')
    if (a === 'rev-parse HEAD') return out(opts.head + '\n')
    if (a.startsWith('merge-base --is-ancestor')) return out('', 0)
    if (a.startsWith('log --reverse')) return out(OWN + '\n' + THEIRS)
    if (a.startsWith('diff-tree')) return out('src/pricing.ts\n.env.local\n')
    if (a.includes('--ignore-cr-at-eol')) return out(' 2 files changed, 10 insertions(+), 2 deletions(-)')
    if (a.startsWith('show --shortstat')) return out(' 2 files changed, 400 insertions(+), 392 deletions(-)')
    if (a.startsWith('show --format=')) return out('+const k = "' + 'sk_' + 'live_abcdefgh12345678"\n')
    return out('')
  })
  on('store.get', async ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('clock.now', async () => ({ value: 100 * 60 * 60 * 1000 }))
  on('clock.every', async () => ({ deny: 'no timers in tests' }))
  on('clock.after', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: [{ kind: 'seven_day', percentUsed: opts.usage ?? 10 }] } }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }))
  on('prompt.submit', async ($, e) => { prompts.push(e.text); return { text: e.text } })
  return { store, prompts }
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

async function start($) {
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
}

test('the first run only remembers where it is, so old history is not flagged', async ($, on) => {
  const { store, prompts } = fakeEngine(on, { head: B })
  await start($)
  expect(store.get('lastSeen')).toBe(B)
  expect(store.get('pending')).toBe(undefined)
  expect(prompts).toEqual([])
})

test('a commit without the marker is held for review, and /cross-check asks Claude to audit it', async ($, on) => {
  const { store, prompts } = fakeEngine(on, { head: B, store: { lastSeen: A } })
  await start($)
  expect((store.get('pending') as any[]).map((c) => c.hash)).toEqual([B])
  expect(prompts).toEqual([])
  const r = await $.command.run({ command: 'cross-check', args: '' })
  expect(r.text).toContain('feat: new pricing page')
  expect(r.text).toContain('LINE ENDINGS CHANGED: diff shows 792 lines, real content 12')
  expect(r.text).toContain('Stripe live key x1')
  expect(r.text).toContain('.env FILES COMMITTED: .env.local')
  expect(r.text).not.toContain('docs: notes')
  await flush()
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('bbbbbbb')
  expect(prompts[0]).toContain('Do not change, revert or rewrite')
  expect(store.get('pending')).toEqual([])
})

test('/cross-check skip dismisses without asking Claude', async ($, on) => {
  const { store, prompts } = fakeEngine(on, { head: B, store: { lastSeen: A } })
  await start($)
  const r = await $.command.run({ command: 'cross-check', args: 'skip' })
  expect(r.text).toContain('Dismissed 1')
  expect(prompts).toEqual([])
  expect(store.get('pending')).toEqual([])
})

test('automatic review starts on its own when usage is low', { options: { autoReview: true } }, async ($, on) => {
  const { prompts } = fakeEngine(on, { head: B, store: { lastSeen: A }, usage: 20 })
  await start($)
  await flush()
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('bbbbbbb')
})

test('automatic review waits when weekly usage is at the ceiling', { options: { autoReview: true } }, async ($, on) => {
  const { store, prompts } = fakeEngine(on, { head: B, store: { lastSeen: A }, usage: 95 })
  await start($)
  await flush()
  expect(prompts).toEqual([])
  expect((store.get('pending') as any[]).length).toBe(1)
})
