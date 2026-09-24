---
name: review-memory
description: Curate agent memory - read the lessons inbox and the curated lessons file, promote what repeats, prune what is stale, open a memory-only PR and merge it. Use weekly, when the inbox has notes, when a lessons section is over its cap, or when asked to review, consolidate or dream over memory.
model: opus
context: fork
---

# Review memory

You are the only writer of `.agents/memory/LESSONS.md`. Input is `.agents/memory/INBOX.md`
and the current lessons. Output is one PR that touches only `.agents/memory/`, which you
merge yourself. Anything that changes behaviour (a skill, a lint rule, a test) is a separate
PR a human merges.

## 1. Read

```bash
git fetch origin && git switch --detach origin/main
cat .agents/memory/INBOX.md .agents/memory/LESSONS.md
git log --oneline --since="3 months ago" -- .agents/memory
gh pr list --state open --search "chore(memory): review in:title"
```

Stop without a branch or PR, and report why, when either holds:

- the inbox has no notes under its header and no section is over its cap;
- an earlier memory review PR is still open. Reviewing again would stack a second PR on
  the same inbox.

Otherwise branch: `git switch -c "memory/$(date +%Y-%m-%d)"`.

## 2. Decide per inbox note

- **Promote to a skill section** when the same rule appears in two or more notes from
  different PRs, or once when the cost was a wrong merge or a security miss. Merge the
  notes into one entry citing all PRs.
- **Promote to General** only when it applies to every skill. Expect this to be rare.
- **Mark for a mechanism** when the rule could be a lint rule or a test. File a
  `type:chore` issue via the `file-issue` skill so a human can schedule it; skip its
  interview, the notes are the spec. Then promote the note to its skill section even on a
  single occurrence, with a third line `Mechanism: #<issue>`, and remove it from the inbox:
  agents never read the inbox, and the entry covers the gap until the mechanism lands. Once
  it lands, the entry is deleted on the next review.
- **Keep** a note that matches nothing yet and has no `Seen:` line. Add
  `Seen: <today>` as its fifth line so the next review can pair it with a later note.
- **Drop** a note that already carries a `Seen:` line and still matches nothing, or whose
  code path no longer exists. A dropped note leaves no trace.

## 3. Prune the curated file

For every existing entry, check:

- the path, command or behaviour it cites still exists on `origin/main`;
- no newer entry or code change contradicts it;
- the skill body does not already say it (promoted by hand since); if so, delete;
- the mechanism it waited for has not landed; if it has, delete.

Merge entries that say the same thing. Enforce the caps: 10 per section, 40 in total; over
the cap, drop the oldest entry with the weakest evidence and say so in the PR.

## 4. Ship

Empty the inbox down to its header plus the notes kept in step 2. Then:

```bash
git add .agents/memory && git commit -m "chore(memory): review $(date +%Y-%m-%d)"
git push -u origin HEAD
gh pr create --title "chore(memory): review $(date +%Y-%m-%d)" --body "<promoted: n, kept: n, dropped: n, pruned: n, mechanisms filed: #...>"
gh pr view --json files -q '.files[].path' | grep -v '^\.agents/memory/' && exit 1   # memory only
gh pr merge --squash --delete-branch "memory/$(date +%Y-%m-%d)"
```

The merge is allowed only because the PR touches nothing outside `.agents/memory/`. If the
file check prints anything, stop and leave the PR for a human.

## Report

```
Memory review: <date>  PR: #N (merged | left open: <why>)
Promoted: n  Kept: n  Dropped: n  Pruned: n  Mechanisms filed: <issues or none>
Sections over cap: <names or none>
```
