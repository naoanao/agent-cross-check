# agent-cross-check

**A Claude Code mod: when another coding agent commits to your repo, Claude notices and audits it by diff and tests instead of trusting its report.**

I build with two agents. One writes code, and Claude reviews it. The second agent commits under the same git name and writes confident reports. In one week, three of its reports did not match the code:

- A report said all 46 tests passed. Running them gave 45 passed and 1 failed.
- A report said 83 mods were "validated and tested". 64 of them only returned a fixed sentence, and 6 printed "done" without doing anything.
- A command output pasted into a report did not match the files it claimed to read.

Reviews only happen if someone notices the commits. This mod does the noticing.

## What it does

- **Notices.** It checks for new commits when the session starts, after every turn, and every 10 minutes. A commit whose message lacks your marker (by default `Co-Authored-By: Claude`, which Claude Code adds to its own commits) counts as another agent's. A yellow line above the prompt shows how many are waiting, and a toast appears when new ones arrive.
- **Checks mechanically.** For each waiting commit it shows:
  - how many files and lines changed
  - line-ending churn (a diff far bigger than its real content)
  - secret-looking strings in added lines (Stripe, OpenAI/Anthropic, GitHub, Google, AWS, private keys, JWTs)
  - `.env` files that were committed
- **Asks Claude to audit.** `/cross-check` hands Claude the list with one instruction: check against the diffs and by running the relevant tests, and do not trust the commit messages or reports. Claude is told to report only, never to revert or rewrite.
- **Optional automatic review.** With "Review automatically" on, the audit starts by itself. It runs at most once an hour, and waits while your 5-hour or weekly usage is at or above the ceiling you set (90% by default).

`/cross-check skip` dismisses the waiting commits without a review.

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

## What it reads, runs, and sends

- **Sends nothing over the network.** It does not upload, log, or collect anything.
- **Runs:** only `git`, read-only.
  - `rev-parse HEAD` to find the current commit
  - `merge-base --is-ancestor` to detect rewritten history
  - `log` with a fixed format, for new commits since the last check
  - `diff-tree --name-only`, plus `show` with `--shortstat`, `--ignore-cr-at-eol --shortstat` and the plain diff, for the mechanical checks
- **Keeps:**
  - In Claude Code's plugin store: the last commit it saw, the list of waiting commits, and the time of the last automatic review.
- **Submits a prompt to Claude**, but only when you run `/cross-check` or turn on automatic review. The prompt is the review request described above. You can read it in full in `hooks/logic.js` (`reviewPrompt`).
- **Hooks:**
  - `session.start` and `turn.complete`, to check for commits
  - `command.run`, for `/cross-check`
  - `ui.render`, for the line above the prompt

## Limits

- It watches the current branch only.
- It does not decide what is right. It makes sure the review happens, and Claude does the review.
- The marker is a convention. A commit that copies your marker counts as yours.

## Tests

```
claude plugin test .
```

There are 10 tests: the rules on their own, plus the whole mod running in Claude Code's test engine with a fake git history, store and usage. Each of three guards was broken once on purpose to confirm its test fails for the right reason:

- the marker check
- the usage ceiling
- the first-run behaviour

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

外には何も送りません。動かすのは読むだけの `git` です。
