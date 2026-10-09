import { expect, test } from 'claude-code/testing'
import { LOG_FORMAT, parseLog, isOwn, foreignCommits, mayAutoReview, secretPatternHits, lineEndingChurn, reviewPrompt } from '../hooks/logic.js'

const RS = '\x1e'
const US = '\x1f'
const entry = (hash: string, author: string, subject: string, body: string) => hash + US + author + US + subject + US + body + RS

test('the log format separates fields with control characters', async () => {
  expect(LOG_FORMAT).toBe('%H\x1f%an\x1f%s\x1f%B\x1e')
})

test('git log output is parsed, including bodies with new lines', async () => {
  const out = entry('a'.repeat(40), 'naoanao', 'feat: add', 'feat: add\n\nlong body\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n') + '\n' + entry('b'.repeat(40), 'naoanao', 'fix: x', 'fix: x\n')
  const c = parseLog(out)
  expect(c.length).toBe(2)
  expect(c[0].hash).toBe('a'.repeat(40))
  expect(c[0].body).toContain('long body')
  expect(c[1].subject).toBe('fix: x')
  expect(parseLog('')).toEqual([])
  expect(parseLog('not a log')).toEqual([])
})

test('own commits carry the marker; the rest are another agent\'s', async () => {
  const mine = { hash: 'a'.repeat(40), author: 'naoanao', subject: 's', body: 'x\nco-authored-by: claude opus' }
  const theirs = { hash: 'b'.repeat(40), author: 'naoanao', subject: 'feat: claude support', body: 'feat: claude support' }
  expect(isOwn(mine, 'Co-Authored-By: Claude')).toBe(true)
  expect(isOwn(theirs, 'Co-Authored-By: Claude')).toBe(false)
  expect(isOwn(theirs, '')).toBe(false)
  expect(isOwn(theirs, 'Signed-off-by: me, claude support')).toBe(true)
  expect(foreignCommits([mine, theirs], 'Co-Authored-By: Claude', [])).toEqual([{ hash: 'b'.repeat(40), author: 'naoanao', subject: 'feat: claude support' }])
  expect(foreignCommits([mine, theirs], 'Co-Authored-By: Claude', [{ hash: 'b'.repeat(40) }])).toEqual([])
})

test('automatic review waits an hour between runs and below the usage ceiling', async () => {
  const hour = 60 * 60 * 1000
  expect(mayAutoReview(10 * hour, 0, [], 90).ok).toBe(true)
  expect(mayAutoReview(10 * hour, 9.5 * hour, [], 90).ok).toBe(false)
  expect(mayAutoReview(10 * hour, 8 * hour, [{ kind: 'seven_day', percentUsed: 90 }], 90).ok).toBe(false)
  expect(mayAutoReview(10 * hour, 8 * hour, [{ kind: 'five_hour', percentUsed: 89.9 }], 90).ok).toBe(true)
})

test('secret formats, line-ending churn, and a prompt that forbids rewriting', async () => {
  expect(secretPatternHits('+k="' + 'sk_' + 'live_abcdefgh12345678"\n-k="' + 'sk_' + 'live_abcdefgh12345678"')).toEqual(['Stripe live key x1'])
  expect(lineEndingChurn(' 1 file changed, 2356 insertions(+), 2356 deletions(-)', ' 1 file changed, 29 insertions(+), 3 deletions(-)')).toEqual({ shown: 4712, real: 32 })
  const p = reviewPrompt([{ hash: 'b'.repeat(40), author: 'x', subject: 's' }], 'summary here')
  expect(p).toContain('bbbbbbb')
  expect(p).toContain('Do not change, revert or rewrite')
  expect(p).toContain('summary here')
})
