# agent-cross-check

<a href="https://fazier.com" target="_blank" rel="noopener noreferrer"><img src="https://fazier.com/api/v1//public/badges/launch_badges.svg?badge_type=launched&theme=light" width="200" height="40" alt="Launched on Fazier"></a>
<a href="https://launchnest.io/p/agent-cross-check" target="_blank">
    <img src="https://launchnest.io/badge/agent-cross-check.svg?variant=featured" alt="agent-cross-check on LaunchNest" width="220" height="56" />
      </a>

**A Claude Code mod: when another coding agent commits to your repo, Claude notices and audits it by diff and tests instead of trusting its report.**

I build with two agents. One writes code, and Claude reviews it. The second agent commits under the same git name and writes confident reports. In one week, three of its reports did not match the code:

- A report said all 46 tests passed. Running them gave 45 passed and 1 failed.
- A report said 83 mods were "validated and tested". 64 of them only returned a fixed sentence, and 6 printed "done" without doing anything.
- A command output pasted into a report did not match the files it claimed to read.

Reviews only happen if someone notices the commits. This mod does the noticing.

**New in 0.2.0.** A later week brought a different kind of mismatch: the report described things that were not there. A report said a prototype was built, and no file for it existed. A report said a video's audio no longer drifted, and the video had no audio track. A report said tests ran on real receipts, and they ran on synthetic samples. And once, the reviewer (Claude) pushed the other agent's commits before reviewing them. 0.2.0 checks the report against the files, and holds the push until the review is marked done.

## What it does

- **Notices.** It checks for new commits when the session starts, after every turn, and every 10 minutes. A commit whose message lacks your marker (by default `Co-Authored-By: Claude`, which Claude Code adds to its own commits) counts as another agent's. A yellow line above the prompt shows how many are waiting, and a toast appears when new ones arrive.
- **Checks mechanically.** For each waiting commit it shows:
  - how many files and lines changed
  - line-ending churn (a diff far bigger than its real content)
  - secret-looking strings in added lines (Stripe, OpenAI/Anthropic, GitHub, Google, AWS, private keys, JWTs)
  - `.env` files that were committed
  - **the report against the real files** (new in 0.2.0): in changed files that look like a report (names with report, handoff, summary, or the Japanese 報告, 引き継ぎ, 一覧), it lists file paths the report names that do not exist, videos it names that have no audio track (when `ffprobe` is installed), and lines that claim success ("all tests passed", "verified", "zero errors") for Claude to confirm
- **Asks Claude to audit.** `/cross-check` hands Claude the list with one instruction: check against the diffs and by running the relevant tests, and do not trust the commit messages or reports. Claude is told to report only, never to revert or rewrite.
- **Holds the push until reviewed** (new in 0.2.0). While another agent's commits are waiting or under review, a push is stopped with the list. Only a real push command counts: text that merely mentions a push, inside a heredoc or quotes, passes. When Claude finishes the audit it marks the commits with the tool `mark_reviewed`; you can also run `/cross-check done`.
- **Optional automatic review.** With "Review automatically" on, the audit starts by itself. It runs at most once an hour, and waits while your 5-hour or weekly usage is at or above the ceiling you set (90% by default).

`/cross-check done [hash ...]` marks commits reviewed (all, when no hash is given). `/cross-check skip` dismisses the waiting commits without a review.

On the first run it only records the current commit, so old history is never flagged. If history is rewritten (rebase, reset), it starts watching again from the current commit.

## Install

```
/plugin marketplace add naoanao/agent-cross-check
/plugin install agent-cross-check@agent-cross-check
```

| Setting | Default | What it means |
|---|---|---|
| Marker of your own commits | `Co-Authored-By: Claude` | Commits containing this text are yours. Use commas to list several markers. |
| Review automatically | off | Start the audit as soon as commits appear. |
| Usage ceiling (%) | 90 | Automatic review waits at or above this usage. |
| Check every (minutes) | 10 | How often to look while the session is open. |
| Hold git push until reviewed | on | Stop a push while another agent's commits are not marked reviewed. (0.2.0) |
| Report files (regular expression) | names with report, handoff, summary, 報告, 引き継ぎ or 一覧, ending in `.md` | Which changed files count as the agent's report. (0.2.0) |

## What it reads, runs, and sends

- **Sends nothing over the network.** It does not upload, log, or collect anything.
- **Runs:** only `git`, read-only.
  - `rev-parse HEAD` to find the current commit
  - `merge-base --is-ancestor` to detect rewritten history
  - `log` with a fixed format, for new commits since the last check
  - `diff-tree --name-only`, plus `show` with `--shortstat`, `--ignore-cr-at-eol --shortstat` and the plain diff, for the mechanical checks
  - `rev-parse --show-toplevel`, to find files the report names
- **Runs `ffprobe`** (0.2.0), only when a report names a video that exists, to count its audio tracks. If `ffprobe` is not installed, the video check is skipped.
- **Reads:** whether each file a report names exists (a file-status check, not its content).
- **Keeps:**
  - In Claude Code's plugin store: the last commit it saw, the list of waiting commits and of commits under review, and the time of the last automatic review.
- **Submits a prompt to Claude**, but only when you run `/cross-check` or turn on automatic review. The prompt is the review request described above. You can read it in full in `hooks/logic.js` (`reviewPrompt`).
- **Hooks:**
  - `session.start` and `turn.complete`, to check for commits
  - `command.run`, for `/cross-check`
  - `tool.call` on `Bash` and `PowerShell`, to hold a push (0.2.0)
  - `tool.call` on its own tool `mark_reviewed`, which Claude calls after the audit (0.2.0)
  - `ui.render`, for the line above the prompt

## Limits

- It watches the current branch only.
- It does not decide what is right. It makes sure the review happens, and Claude does the review.
- The marker is a convention. A commit that copies your marker counts as yours.
- The report check reads paths and words. It finds a missing file or a silent video; it cannot tell whether a number in the report is true. Claude does that part.
- The push hold looks at shell commands Claude runs, in Bash and PowerShell. A push you type in your own terminal is not held. A push into another repository (`git -C <dir> push`, `cd <dir> && git push`) is not held by this one's waiting commits.

## Tests

```
claude plugin test .
```

There are 13 tests: the rules on their own, plus the whole mod running in Claude Code's test engine with a fake git history, store and usage. Each of eight guards was broken once on purpose to confirm its test fails for the right reason:

- the marker check
- the usage ceiling
- the first-run behaviour
- the push hold (0.2.0)
- ignoring a push mentioned inside a heredoc (0.2.0)
- checking only report files for claims (0.2.0)
- letting a push into another repository through (0.2.0)
- holding a push run from PowerShell (0.2.0)

## About

Made by nao, an AI consultant who builds. I design and run AI automation for small businesses, from first conversation to production. Portfolio: https://growl-ai.com/portfolio/en

Also by me: [shared-repo-guard](https://github.com/naoanao/shared-repo-guard). It stops secret values from leaving your `.env`, blocks pushes to public remotes, and blocks git commands that would wipe another agent's uncommitted work.

MIT License.

---

## 日本語

**別の AI が保存（commit）したら、Claude が気づいて、報告ではなく差分とテストで確かめる部品です。**

- **気づく**：会話の始め・毎回のやりとりの後・10分ごとに新しい保存を見ます。印（`Co-Authored-By: Claude`）が無い保存は、別の AI の物として数えます。入力欄の上に件数が出ます。
- **機械で点検する**：変わった量、改行の変化、鍵らしい文字、`.env` の混入を出します。
- **Claude に監査を頼む**：`/cross-check` で頼みます。差分とテストで確かめさせ、元に戻したり書き換えたりはさせません。
- **自動にもできる**：1時間に1回まで。使用量が上限に近いときは待ちます。
- **報告と実物を照らす**（0.2.0）：報告に書かれたファイルが無い、書かれた動画に音が無い、「全部通った」「検証済み」などの言い切り、を出します。
- **確かめる前の送信を止める**（0.2.0）：別の AI の保存が確かめ済みになるまで、送信（push）を止めます。文の中に「push」と書いてあるだけなら止めません。

外には何も送りません。動かすのは読むだけの `git` です。
