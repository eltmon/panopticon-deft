# Pipeline State — 2026-06-13 (handoff for fresh session)

Snapshot of the stabilization effort so a new session can continue. Written ~05:40 UTC.

## ⟶ Session progress (orchestrating conversation, ~06:40 UTC — read this first)
**Worktree cleanup from old "Suggested next steps" #1 is DONE — do not repeat it.**
- **Primary `main` reset to origin and verified clean:** `main == origin/main`, now at `91a96e80f`. Ahead/behind 0/0.
- **The old contaminated commit `a7b65cdd3` was a PURE REGRESSION** (not 16 re-added files): it reverted the merged **PAN-1798** tmux-server-kill safety fix (re-introduced dangerous `pkill -f`) and the **PAN-1812** governor guards. Dropping it was corrective. It is preserved at tag **`salvage/main-stale-a7b65cdd3`** + full backup **`~/pan-reset-backup-20260613/`** (recovery/, whole `.pan/`, screenshots, tracked-continues.patch) if ever needed.
- **`recovery/` committed + pushed** (`91a96e80f`): `pan-1762/` salvage AND `design-artifacts/` (16 files incl. the irreplaceable `pan-1737-merge-queue` + `automerge-toggle` mockups that lived only in gitignored `.tmp/`). Now durable in origin.
- **System rebooted; dashboard brought up with `pan up --no-resume`** (deliberate — [#1665](https://github.com/eltmon/panopticon-cli/issues/1665) thundering-herd resume is still OPEN). Bring agents back **selectively/one-at-a-time**, not via mass auto-resume. Pre-reboot live state: deacon was running (not frozen), 11 stuck + 5 warning agents (cleared by reboot), flywheel no active run.

**Corrections to the old next-steps below:**
- **PRs [#1829](https://github.com/eltmon/panopticon-cli/pull/1829) (PAN-1797) and [#1836](https://github.com/eltmon/panopticon-cli/pull/1836) (PAN-1826) are NOT simply "redundant, close."** Both branches carry the harness-resolution fix *with substantial new tests* (#1829 ≈ +119/+97 test lines; #1836 = start/strike/conversations + tests). Do a real file-level diff vs what `5414805e2`/PAN-1842 already merged BEFORE closing — closing blind would drop test coverage.
- Merged-but-open strikes **PAN-1798/1801/1807/1812 ARE closeable** (commits on origin: `d8e5d0484`/`f9fbb0053`/`1447d2b2d`/`61d078b6e`); close + reap their `strike-pan-*` sessions.
- Config nit: line 13 below is wrong — `plan` routes to `workhorse:expensive` (Opus), not mid.

## Top-line context
- **Fable 5 (claude-fable-5) is suspended by Anthropic.** Do not spawn anything on Fable. Planning role was `workhorse:expensive` → Fable; operator remapped `workhorses.expensive: claude-opus-4-8`.
- **Work/review/strike now route to Kimi.** `workhorses.mid: kimi-k2.7-code` (newly registered, PAN-1831). gpt-5.5 was rate-limit-throttling reviewers (modal stalls); the fleet was migrated off it.
- **Flywheel is intentionally DOWN** (operator hold). `roles.flywheel: { model: claude-opus-4-8, harness: claude-code, maxAgents: 20 }` staged for when it's turned back on.
- This session = orchestrating conversation on `main` (operator-directed pipeline-bypass mode): reviewed merges to main allowed.

## Config state (`~/.panopticon/config.yaml`)
- workhorses: expensive=`claude-opus-4-8`, mid=`kimi-k2.7-code`, cheap=`claude-haiku-4-5`
- roles: plan/review/strike/ship → `workhorse:mid` (=kimi-k2.7-code); work → `workhorse:mid`; flywheel → opus/claude-code (paused)
- New model strings registered on main: `kimi-k2.7-code` (PAN-1831), `grok-build-0.1` (PAN-1838)

## Live agents (as of snapshot)
- **Work:** PAN-1696 (kimi-k2.7-code/pi, in review), PAN-1775 (kimi-k2.6/pi, in review), PAN-1501 (kimi-k2.6/pi), PAN-1803 (gpt-5.5/codex — the one gpt-5.5 holdout; in review)
- **Review convoys (kimi-k2.7-code/pi — NOT stalling on rate-limit modals, the payoff of the switch):** PAN-1696, PAN-1775
- **Strikes running:** PAN-1798, PAN-1801, PAN-1807, PAN-1812 (kimi/pi), PAN-1838 (sonnet/claude-code — Grok research, work merged), PAN-1842 (kimi-k2.7-code/pi, work merged)
- PAN-1797 work agent is PAUSED (its fix was implemented+merged directly; see below).

## Merged to main tonight (~12 fixes)
- PAN-1797 fix (`5414805e2`) — resume re-defaults stale harness for origin-less agents (implemented directly this session; **its PR #1829 is now redundant — close it**)
- PAN-1842 (`bd72a3902`) — route all spawn paths through resolveHarness (specialists + conversations were bypassing it; root of the reviewer-on-gpt-5.5/CLIProxy saga)
- PAN-1838 (`b1bfab4d3`) — register Grok Build 0.1 model
- PAN-1835 (`2e5f3a921`) — strike session node in Command Deck (clickable, mirrors Work)
- PAN-1642 (`#1648`) — merged
- Earlier in session: PAN-1806 (reviewer idle-retry), PAN-1808 (test PANOPTICON_HOME isolation), PAN-1819 (sync-main force-add pollution), PAN-1831 (kimi-k2.7-code model), PAN-1800 (resource-strip spec), PAN-1805 (codex conversation view via PR #1810)
- PAN-1798 / PAN-1812 / PAN-1801 / PAN-1807 work landed on main (commits d8e5d0484, f9fbb0053, 1447d2b2d, 61d078b6e) — **issues still OPEN; verify + close**

## Open PRs (verify readiness — many predate tonight's main movement, likely need rebase)
- #1843 PAN-1501, #1836 PAN-1826, #1822 PAN-1696, #1804 PAN-1803, #1786 PAN-1775, #1811 PAN-1498, #1784 PAN-1765, #1715 PAN-1629, #1679 PAN-1641
- #1829 PAN-1797 — **redundant, close** (fix already merged via 5414805e2)
- Note: `main` had a CI test-hang earlier; resolved (PAN-1824 fake-timer conversion reverted; real cause was the PAN-1798 tmux-founding hang, fixed by `fd7b0cbe1`).

## Systemic issues filed tonight (the backlog that came out of the incidents)
Still OPEN / candidates for strikes:
- **#1845 — CRITICAL: remote Fly work agents lose all work on crash.** Definitive plan agreed (continuous push + persistent volume required; restart-policy/supervisor; user-configurable resiliency tiers + spend cap). See the issue's "Definitive plan" comment.
- #1817 Linear quota exhaustion (IssueDataService polling) — *assigned to another AI*
- #1818 reviewer 400-context overflow on gpt-5.5/claude-code; #1830 reviewer stalls on rate-limit modal; #1834 needs-input modal invisible (no triangle/notification)
- #1820 deacon orphan-recovery ignores strike agents; #1825 pi resume churn (idle-exit loop); #1833 pi-extension path resolved from cwd
- #1821 Linear rate-limit backoff missing; #1807 handoff completion contract; #1832 weighted multi-model roles; #1837 Kimi Code harness; #1839 provider default-harness visible without expand; #1840 `pan switch` command; #1841 sync-main conflicts on tracked .pan/.beads state; #1844 deep-linkable Command Deck + notification targets

## Key incidents / decisions this session
- **gpt-5.5 → kimi migration:** running agents needed kill+`--fresh` restart (plain `pan start --fresh` refuses on a running agent). 1696/1797 switched; 1803 left on gpt-5.5.
- **PAN-1762 (Swarm v2) remote Fly work — GAVE UP on recovery.** Ran on Fly machine 7812076c571018 on Fable; machine crashed 06-12 (Fly host event), ephemeral rootfs + no volume + never pushed = code lost (proven via clone test + config inspection). PRD + 49KB vBRIEF spec survive on main. Recovery artifacts saved in `recovery/pan-1762/` (config, fly logs, partial remote-output.log, PRD, spec). **All 3 Fly machines destroyed.** Do NOT respawn PAN-1762 yet (lower priority); re-implement locally later from the surviving plan. Lessons → #1845.
- **Primary worktree (`main`) is messy:** a contaminated local commit `a7b65cdd3` (swept 16 already-merged strike files) sits unpushed on local main, which is ~60+ behind origin; `.pan/continues/*` churn uncommitted; `recovery/pan-1762/` staged-but-uncommitted. **Recommended: `git reset --hard origin/main` then re-add `recovery/pan-1762/` and commit** — verified the contaminated content is all already on origin (nothing unique lost). Do this early in the fresh session to clean the worktree.

## Suggested next steps (fresh session)
1. Clean the primary worktree: `git fetch && git reset --hard origin/main` (untracked `recovery/` survives the reset), then `git add recovery/ Jun13Pipeline.md && commit`. `recovery/` holds two rescued sets: `pan-1762/` (lost-VM artifacts) and `design-artifacts/` (16 UI mockups + design docs salvaged from the gitignored `.tmp/` — incl. `pan-1737-merge-queue-mockup.html` and `automerge-toggle-mockup.html`, which exist nowhere else in the repo).
2. Close #1829 (redundant PAN-1797 PR). Verify+close the merged-but-open strike issues: PAN-1798, PAN-1801, PAN-1807, PAN-1812.
3. Triage the open PRs (#1843/#1836/#1822/#1804/#1786/#1811/#1784/#1715/#1679): each likely needs sync-main; drive to green + merge. PAN-1696 (MYN-UAT decoupler) and PAN-1803 (codex keystone) are highest value.
4. Strikes for the remaining systemic backlog (esp. #1825 pi churn, #1830/#1834 reviewer-modal, #1820 deacon-strike-blindness, #1841 sync-main conflicts).
5. When ready to resume autonomy: land #1665 (resume throttle) + verify pan-start-hang before turning the flywheel back on; flywheel config already staged (opus/claude-code, maxAgents 20).
6. Do NOT run remote Fly work agents until #1845 (#1+#2) lands.
