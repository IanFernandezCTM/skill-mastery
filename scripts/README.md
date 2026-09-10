# scripts/ — dev machines, local runs, and shipping this one repo

Setup + daily-preflight scripts for a Windows dev machine, launchers for running the app
against local models, and this repo's own push/ship pair (the single-repo alternative to the
workspace-wide `/go`). All PowerShell 5.1 — no `&&`, no ternary, no `?.`/`??`.

Operating rules + repo-wide gotchas: [../AGENTS.md](../AGENTS.md). Workspace-wide shipping
(`start-day` / `park` / `push` / `ship` / `go`): [../../agora-devtools/README.md](../../agora-devtools/README.md).

## File map — one line per script

| Script | What it does |
|---|---|
| [setup.ps1](setup.ps1) | One-time fresh-Windows setup: winget-installs Node/Ollama/gcloud, logs into Google Cloud, pulls a starter model, `npm install`. |
| [start_day.ps1](start_day.ps1) / [start_day.cmd](start_day.cmd) | Per-session preflight: verifies gcloud CLI creds **and** ADC (Firestore + Vertex), syncs the repo. Run after `setup.ps1`, once per work session. |
| [start-ollama.ps1](start-ollama.ps1) | Run the app locally against a local **Ollama** model (`127.0.0.1:11434`); sets `APP_PASSWORD`, a generated `SESSION_SECRET`, `GOOGLE_CLOUD_PROJECT`, `OLLAMA_*`. `-Model` picks the model. |
| [start-lmstudio.ps1](start-lmstudio.ps1) | Same, against **LM Studio** (`127.0.0.1:1234`); sets `LMSTUDIO_*`. `-Model` JIT-loads (needs the `lms` CLI). |
| [push-branch.ps1](push-branch.ps1) | Commit ALL local work and push it to THIS machine's own dev branch, for later integration by `merge-branches.ps1`. |
| [merge-branches.ps1](merge-branches.ps1) | Integrate the per-developer branches, land them on `main`, and **DEPLOY** the Mastery Engine to Cloud Run — this repo's "ship ONE repo" command. Skips `wip/*` (parked) branches. |
| [kimi-bypass-mode.ps1](kimi-bypass-mode.ps1) / [.cmd](kimi-bypass-mode.cmd) | Launch Claude Code on Moonshot Kimi (shared org key). **Mirrored from `agora-devtools` — never edit here.** |
| [glm-bypass-mode.ps1](glm-bypass-mode.ps1) / [.cmd](glm-bypass-mode.cmd) | Launch Claude Code on Z.ai GLM (shared org key). **Mirrored from `agora-devtools` — never edit here.** |
| [reshape-growth-books.mjs](reshape-growth-books.mjs) | One-off repair giving BOTH reading programs one shape: **course = theme, lesson = the book (or a named part of it), sub-lesson = a claim**. Fixes the corpus planner's inverted shape (course = the book) that made a book deck impossible for *The Charisma Myth* and *Do Hard Things*. Dry run by default; `--apply` writes (Firestore ADC). Names in [growth-books.json](growth-books.json). Uses `renameScope` so each lesson's SOURCE TRANSCRIPT travels with it — see AGENTS.md §3. Idempotent. |
| [build-book-decks.mjs](build-book-decks.mjs) | Builds the title→points **book deck** for every reading-program lesson that has none. Runs against the DEPLOYED service (the deck is an AI call) over SSE, one lesson per request; needs `$env:SSO_SECRET` from `platform-sso-key`. Dry run by default. Skips any lesson that already has a title card, so it is the safe way to retry. |
| [rename-philosophy-points.mjs](rename-philosophy-points.mjs) | One-off repair: rewrites the **Philosophy** program's 28 sub-lessons from bare labels into the CLAIM each key point makes, then rebuilds every book deck's title card from the new names. Dry run by default; `--apply` writes (Firestore ADC). The names live beside it in [philosophy-points.json](philosophy-points.json). Goes through `renameTopics`, so questions, cards and guides follow the rename — see AGENTS.md §3. Idempotent. |
| [seed-agora-dev-onboarding.mjs](seed-agora-dev-onboarding.mjs) | Seeds/refreshes the **Agora Developer Onboarding** program (`agora_dev`): 5 courses / 15 lessons / 45 topics, one plain-language source transcript per lesson (written for non-technical vibe coders), Kimi question genjobs, and the 5-stage roadmap. `--wipe` deletes all existing agora_dev questions/transcripts/topics first (Firestore ADC). The inline transcripts are the questions' SOURCE OF TRUTH — see cookbook 6. |

## Cookbook

1. **New machine** — `.\scripts\setup.ps1` once; then `.\scripts\start_day.ps1` at the start of
   each session.
2. **Run locally with a local model** — `.\scripts\start-ollama.ps1` or
   `.\scripts\start-lmstudio.ps1` (details + tunables: [../README.md](../README.md)). App on
   `http://localhost:8080`.
3. **Ship just this repo** — pre-flight first (`git status --short`;
   `git log --oneline origin/main..main`), then `.\scripts\merge-branches.ps1`. **Read the
   Summary block** — failures live under "Needs you" / "Held back" / `name(failed)`.
4. **Hold work back from a ship** — don't leave it dirty (a workspace `/go` sweeps dirty
   trees): park it with `agora-devtools`' `/park`, which commits to `wip/<dev>/<desc>` — a
   namespace `merge-branches.ps1` never integrates.
5. **Deploy by hand** (skip integration) — `gcloud run deploy mastery-engine --source .
   --region us-central1 --project agora-data-driven`, after `node --check` on every edited file
   and the four `lib\_*_test.js` tests; then confirm the serving revision changed
   ([../AGENTS.md](../AGENTS.md) §6) and re-port `../../mastery-engine-local`
   (`npm run port` there — never hand-port).
6. **Refresh the Developer Onboarding course** — when the workflow/docs change materially
   (new command, changed gate, renamed repo), update the matching lesson transcript INSIDE
   `seed-agora-dev-onboarding.mjs`, then run it:
   `$env:SSO_SECRET = (gcloud secrets versions access latest --secret platform-sso-key --project agora-data-driven); node scripts\seed-agora-dev-onboarding.mjs`.
   Without flags it is idempotent (program/topics upsert; transcripts skip existing titles —
   delete the outdated transcript in Academy Admin first, or bump its title, so the new text
   lands). For a curriculum RESHAPE (lessons/topics renamed or removed) run with `--wipe`,
   which deletes every existing agora_dev question/transcript/topic via Firestore ADC before
   reseeding — otherwise orphaned topics linger. Question generation runs on **Kimi**
   (flat-rate, $0 marginal). The course's audience is non-technical vibe coders — keep
   transcripts in plain language, and keep the Resources tab presentation (linked from
   `public/video-lessons.json`, program `agora_dev`) in step with any transcript change.
   Keeping this course true to the real workflow is part of "docs are part of done".

## Gotchas + do-not-touch

- 🔴 The two `*-bypass-mode` launchers are **mirrors** owned by `agora-devtools` — the
  workspace `/go` re-mirrors them, so edits made here get clobbered. Edit them in
  `agora-devtools` only.
- Verify the gcloud pin before anything that deploys
  (`gcloud config list --format="value(core.account,core.project)"` →
  `info@agoradatadriven.com  agora-data-driven`); **never** `gcloud config set` — windows are
  env-pinned to named configs (root AGENTS.md).
- `git push` hanging = HTTP/2; the scripts force `git -c http.version=HTTP/1.1` — keep it.
- Deploys are last-deploy-wins; a teammate's stale deploy can silently replace yours — check
  the serving revision, not `git status`.

## Status (volatile)

Ship target: Cloud Run `mastery-engine` · `us-central1` · project `agora-data-driven` ·
serving revision `mastery-engine-00193-scv` · verified 2026-07-29.
