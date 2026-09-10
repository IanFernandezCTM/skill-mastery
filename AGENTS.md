# AGENTS.md — Mastery Engine (cloud)

> **Read this before touching any file.** It is the operating manual for this repo.
> If you follow it, you do not need to explore the codebase to make a correct change.
> Product/feature docs live in [README.md](README.md) and [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).
> Loading an online course as the backbone of a subject and growing it with AI: [docs/COURSE-TO-CURRICULUM-SOP.md](docs/COURSE-TO-CURRICULUM-SOP.md).
> Deep file map: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Unit-level maps + cookbooks:
> [lib/README.md](lib/README.md) · [public/README.md](public/README.md) · [scripts/README.md](scripts/README.md).

---

## 0. What this is, in 30 seconds

A **spaced-repetition mastery-learning quiz app**. Learners pick a scope
(Track → Course → Lesson → Topic), get questions weighted toward what they're weak at and
haven't seen recently, and their per-topic stats drive a 0–100 "priority" score. AI (Gemini
via Vertex, or DeepSeek/Kimi/local) generates questions, flashcards, study guides, and powers
a study assistant.

| | |
|---|---|
| **Stack** | Node 20, Express 4, **vanilla JS frontend** (no framework, no build step), Firestore, Vertex AI |
| **Runs on** | Cloud Run service `mastery-engine`, project `agora-data-driven`, region `us-central1` |
| **Live URL** | `https://mastery-engine-585951669065.us-central1.run.app` |
| **Embedded in** | Sentinel's **Professional** tab + **Philosophical**/**Spiritual** tabs (`?embed=1`) + its global **Coach** FAB (`?embed=assistant`), via `<iframe>`. `?program=<id>` PINS the whole session to one program — URL-derived at boot, threaded onto every API call, never persisted. **"Coach" is a door into this app's own study assistant, not a second assistant — see §7** |
| **Sibling repo** | [`../mastery-engine-local`](../mastery-engine-local) runs this same app offline. **See §7 — it mirrors this repo; never hand-port.** |

**There is no build step and no test runner.** `node server.js` serves `public/` statically.
Editing `public/app.js` and reloading the browser is the whole frontend loop.

---

## 1. Run it / deploy it

```powershell
# Local (needs ADC for Firestore + Vertex)
gcloud auth application-default login     # one time
npm install
npm run dev                                # node --watch server.js → http://localhost:8080

# Deploy to production (from repo root)
gcloud run deploy mastery-engine --source . --region us-central1 --project agora-data-driven
```

**Deploy account matters.** You must be `info@agoradatadriven.com`, not `ian@100.digital`.
This VS Code window is pinned to the `agora` gcloud config — see the root [AGENTS.md](../AGENTS.md).
**Never run `gcloud config set …`** here; it breaks the other window.

```powershell
# Verify the pin before deploying
gcloud config list --format="value(core.account,core.project)"
# → info@agoradatadriven.com   agora-data-driven
```

A deploy takes ~3–5 min (Cloud Build). Deploying does **not** require Node or Docker locally.

> ⚠️ Deploy is **last-deploy-wins**. If a teammate deploys a stale tree after you, your
> revision is silently replaced. Before blaming browser cache, check what's actually serving:
> ```powershell
> gcloud run services describe mastery-engine --region us-central1 `
>   --format="value(status.traffic[0].revisionName)"
> ```

---

## 2. Map — where everything lives

### Top level

| Path | Lines | What it is |
|---|---:|---|
| [server.js](server.js) | 5.6k | **All ~130 HTTP routes.** Express app, auth wiring, SSE helpers. |
| [lib/firestore.js](lib/firestore.js) | 1.9k | **All database IO.** Every read/write goes through here. |
| [lib/gemini.js](lib/gemini.js) | 3.3k | **All AI prompts + provider dispatch.** Misleading name — it fronts every provider. |
| [lib/auth.js](lib/auth.js) | 314 | Cookies, tokens, SSO, admin checks. |
| [lib/priority.js](lib/priority.js) | 168 | The two scoring formulas (priority + depth mastery). Pure, IO-free, testable. |
| [lib/programs.js](lib/programs.js) | 85 | Program/course scoping rules. Pure, IO-free, testable. |
| [public/app.js](public/app.js) | 6.2k | The entire learner frontend, one IIFE (`const App = (() => {…})()`). |
| [public/academy-admin.js](public/academy-admin.js) | 2.2k | The admin "Composing Room" frontend. |
| [public/index.html](public/index.html) | 835 | Learner shell. All views are `<section>`s toggled by `hidden`. |
| [public/styles.css](public/styles.css) | 2.0k | All styling. **Token-driven**: a `:root` light palette, a `:root[data-theme="dark"]` retune of the same tokens, then a few rules for fills that carry white text (§7). |
| [public/theme.js](public/theme.js) | 100 | Light/dark resolution. Loaded **synchronously in `<head>`** so `data-theme` lands before first paint. |
| [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | — | **Injected into the AI assistant's prompt** at runtime (`lib/gemini.js:29`). Editing it changes assistant behaviour. |

### `lib/` — one file per concern

| File | Purpose |
|---|---|
| `firestore.js` | Data layer. Collections in `COL` at [firestore.js:33](lib/firestore.js#L33). |
| `gemini.js` | Prompt builders + `complete()` / `completeStream()` dispatchers. |
| `auth.js` | 4 sign-in paths (see §4). |
| `anthropic.js` `deepseek.js` `kimi.js` `ollama.js` `lmstudio.js` | One provider adapter each. Same shape: `callX()` + `streamX()`. |
| `genjobs.js` | Background question-generation job runner (stepped, resumable). |
| `graph.js` | Knowledge-map prerequisite edges + warm-up/readiness logic. |
| `programs.js` `priority.js` | Pure logic, IO-free. |
| `usage.js` | Text-token + TTS usage/cost tallying per user. |
| `tts.js` | Google Cloud Text-to-Speech — the **paid** cloud voices for spoken replies (Chirp 3 HD + Gemini Flash TTS). Opt-in; the free browser voice is the default and never reaches the server. See §7. |
| `googleauth.js` | Google OAuth flow. |
| `sentinel.js` | Sentinel bridge: people list, user lookup, the holistic digest, mentor search, `growthDetail` (growth-journal bodies — see §7), `workDigest`/`workDetail` (their TASK BOARD — see §7), and **`sentinelGuide`** (Sentinel's HOW-SENTINEL-WORKS.md, cached 10 min — the assistant's Sentinel self-knowledge, injected by `sentinelGuideBlock` in BOTH chat paths). |
| `bigquery.js` `csv.js` `migrate.js` | Import/analytics side-paths. |
| `watcher.js` | Atrium's Watcher archive. **Asymmetric on purpose** — reads are bucket reads; `addSource`/`fetchBodies` write through Atrium's HMAC bridge (§7). |
| `_*_test.js` | The Node unit tests (auth, graph, programs, progress credit, priority, visual, deep, usage, aidiag, split, gendupe) — see §6. |

### Finding a route fast

Routes are declared in source order in `server.js`. To find one:

```powershell
Select-String -Path server.js -Pattern "app\.(get|post|put|delete)\('/api/quiz" -AllMatches
```

Rough zones in `server.js`:

| Lines | Zone |
|---|---|
| 167–490 | Middleware, CSP (`:198`), helpers (`shuffle` `:211`, `mapWithConcurrency`, `aiChoice` `:333`, `difficultyChoice` `:356`, `streamText` `:384`, `sseInit` `:412`, **`sseResult` `:448`** — the slow-AI transport, §7 — `rateLimitAI` `:480`) |
| 430–577 | `bigJson`, the `/api` gate (`:555` — Sentinel user-lookup + per-user AI policy) |
| 578–660 | Auth routes |
| 660–1010 | Catalog, models, question bank, stats, streak, usage (+ shelf resolver `inEngine` `:739`) |
| 1021–1260 | Quiz guest/select/multi/priority/log (+ mastery flashcard deck `:1168`) |
| 1264–1445 | Question generation, transcripts, drills |
| 1451–2400 | Flashcards (**`cardScope` `:1630`** — §7 — deck build `buildDeckForRequest` `:1758` + its two transports `:1817` (§7), Speaker Mode `explain`, card chat, admin card repair, **Highway toggle**) |
| 2332–2380 | Admin question repair: `fix-format` (AI) and **`/api/questions/set`** (manual, `:2332`) |
| 2381–2725 | Study assistant (scope chat, conversations, blocking + SSE streaming) |
| ~3006–3040 | **Spoken replies**: `GET /api/tts/voices` (picker data) + `POST /api/tts` (text → MP3 bytes). §7 |
| 2730–2970 | The Lesson study guide — `GUIDE_KIND`, `scopeSourceText`, `lessonInputs`, `streamStudyGuide` (serving `/api/lesson` **and** the deprecated `/api/review`), regenerate w/ critique, progress analysis |
| ~3280–3570 | **Visual guides**: the artifact shell (`renderVisualArtifact`), `availableProviders`/`nextEngine`, `/api/visualize`, `/api/guide/info`, `/api/visuals/:id/html` (§7) |
| 2979–3340 | Knowledge graph, readiness, warm-ups, learn-next, topic sequencing |
| 3343–3550 | Hint/explain + admin data repair (latexify, fix-formats, merge-math) |
| 3556–4190 | Programs, enrollment, video lessons, internal SSO endpoints (`verifyInternalSig` `:3724`, `rollupPrograms` `:3767`, `team-progress` `:3842`), team + AI access, topic CRUD |
| 4199–4540 | **Curriculum edit engine** (`runCurriculumEdits` `:4199`) + AI curriculum editing |
| 4349–4800 | Transcripts admin (+ **`/transcripts/:id/digest`** — the corpus MAP step, §5), Watcher import (3 read GETs) + **Watcher add/fetch** (2 POSTs, §7), ingest plan/commit |
| ~4800–4980 | **Corpus planner** — `prepareSourcePlan` / `shapeSourcePlan` / `/api/admin/sources/plan(/stream)` / `/sources/commit`. Sources-FIRST authoring: design a curriculum FROM uploaded material, then FILE it. §5 |
| 4772–5100 | Goal planning, bulk lessons, genjobs |
| 5476–5940 | Roadmaps (`:5476`) + learner shelf (`/api/me/*`, `:5655`) |
| 5941–6073 | **Flags + question CRUD** (`:5941`): learner flag, admin flag list *with the question body*, question browser (`:5989`), single delete (`:6020`), batch delete, migrations, BigQuery sync |
| 6074–6110 | Academy-admin gate (`:6088`), static serving, SPA catch-all, error handler |

---

## 3. Data model (Firestore)

Collections are named in `COL` — [lib/firestore.js:33](lib/firestore.js#L33):

```
topics  questions  quizLog  flashcards  studyGuides  visualGuides
graphLinks  programs  transcripts  genJobs  questionFlags  roadmaps
```

### The content hierarchy

```
program  →  track  →  course  →  lesson  →  topic
(data_science | digital_marketing | …)
```

A `topics` doc is one leaf. It carries
`{ program, track, course, lesson, topic, order, lessonOrder, courseOrder, qCount }`.

### Curriculum order is THREE numbers, one per grain

Courses and lessons are not documents — they are fields on topic rows — so their
position is denormalised onto every row of the group:

| Field | Ranks | Written by |
|---|---|---|
| `courseOrder` | the row's COURSE within its track | `placeNewTopicsInOrder`, `reorder_courses`, the sequence sweep |
| `lessonOrder` | the row's LESSON within its course | the same, plus the tree's drag-and-drop |
| `order` | the row's TOPIC within its lesson | `sequenceLessonGroup` / `/api/admin/sequence-topics` |

A group's rank is the **MIN** over its rows, so a row that missed a write can never
drag its group backwards. Sorting climbs a ladder at each grain: stored rank → the
hand-curated `COURSE_ORDER`/`LESSON_ORDER` (`lib/graph.js`, mirrored in
`public/app.js`) → the legacy `min(topic.order)` signal → natural name.

🔴 **Keep the three separate.** Course and lesson order used to be INFERRED from
`min(topic.order)`, and that is what made every freshly designed track read
alphabetically: each AI sequencing pass numbers a lesson's topics **0-based**, so
after one pass every lesson in a course tied at 0 and the sort fell straight through
to the name. Shipped that way on the RAG track (2026-09-08).
`lib/_graph_test.js` asserts the spine follows the stored ranks and that 0-based
topic order no longer flattens lesson order.

**The designed order is persisted, not re-derived.** Every creation path already
knows the sequence it means — `planFromSources` emits courses and lessons
prerequisites-first, a pasted outline is in the author's own order — and it used to
be thrown away. Each now calls `orderNewCurriculum(program, lessons)`, which turns
that list into `curriculumHints` and appends the new units in that order.
`POST /api/admin/sequence-curriculum` (Academy Admin → Curriculum → **Sequence
order**) is the AI **repair** sweep for a tree that landed wrong; `?refresh=1`
re-sequences every track, without it only tracks holding an unranked unit.

⚠️ **Backfilling an old program must not reshuffle it.** `placeNewTopicsInOrder`
ranks unplaced groups by the legacy `min(topic.order)` FIRST, then the caller's
hint, then the curated lists, then the name — so the first content added to a
program built before these fields existed stamps the order it already displays.

### ⚠️ The single most important rule in this repo

> **A topic's identity is its DOCUMENT ID, never its field values.**

`slug()` ([firestore.js:72](lib/firestore.js#L72)) builds an id from the field values *at
creation time*. But `moveTopics()` ([firestore.js:227](lib/firestore.js#L227)) deliberately
**keeps the doc id** when a topic is renamed or moved to another lesson — that's what
preserves its questions and the learner's stats.

So after any move/rename, `slug(current fields) !== docId`.

**Any code that keys stats/progress by `slug(fields)` is a bug.** It writes to one key and
reads from another; the learner finishes a quiz and sees no progress. This exact bug has been
fixed twice. Use `buildTopicIdIndex()` ([firestore.js:1814](lib/firestore.js#L1814)) to map
rows → real doc ids.

### 🔴 Renaming a SUB-LESSON is not a field write — use `renameTopics`

The doc id is the identity, but the sub-lesson's **name** is still the key of four other
things, and none of them live on the topic doc:

| Keyed by the name | Where |
|---|---|
| the banked questions | `questions.topic` — `getQuestionsForTopics` matches on name |
| a deck's cards | `flashcards.topic` (and `concept`, on a book's point cards) |
| a TOPIC-level deck | `flashcards.scopeId` — `flashcardScopeId` embeds the name |
| a TOPIC-level study guide | the `studyGuides` **doc id** — `studyGuideId` embeds it |

So `moveTopics(ids, { topic })` is **not** a rename: it would keep the learner's progress and
silently empty the sub-lesson — quiz finds no questions, deck disappears, guide regenerates
from nothing. [`renameTopics()`](lib/firestore.js) re-keys all four and keeps the id; the
admin door is `POST /api/admin/topics/rename`, and the AI curriculum editor's op is
`rename_topic`. `graphLinks` and per-user `topicStats` are keyed by id and need nothing.

⚠️ **Questions are the one ambiguous case.** A question doc carries only `{topic, program}`, so
two sub-lessons of one program that share a name share ONE pool and nothing can say which half
belongs where. `renameTopics` refuses to guess: it leaves those questions alone and reports the
name in `ambiguous`, unless the caller passes the exact `questionIds` that follow the row.
(Philosophy hit this — "Attention spotlight and zooming" was a key point of *both* Chatter and
Shift — and the two halves split cleanly by `batchTag`, one generation run per book. See
[scripts/rename-philosophy-points.mjs](scripts/rename-philosophy-points.mjs).)

Historical `quizLog` rows keep the name they were logged under, deliberately — the same
already-documented gap a re-filing opens, so a rename reads velocity slightly LOW for the
current window and heals as the window rolls. Live credit is unaffected: `logResults` resolves
the doc id through `catalogIdIndex()`.

### 🔴 Renaming a COURSE or LESSON is not a field write either — use `renameScope`

Same defect as the sub-lesson one above, one grain up, and it had been shipping since
`rename_lesson` existed. `moveTopics` writes track/course/lesson onto the topic ROWS and
nothing else, but a scope's names are also the key of:

| Keyed by the scope's names | Where |
|---|---|
| the lesson's SOURCE | `transcripts.course` + `.lesson` — `getScopeTranscripts` matches on them |
| the lesson deck / course deck | `flashcards.scopeId` (plus the plain `track/course/lesson` fields) |
| the study guide | the `studyGuides` **doc id** — `studyGuideId` encodes them |

So renaming a lesson through `moveTopics` kept its questions and its learner progress and
silently stripped it of **the book it is grounded on**: the next study guide rebuilds from the
quiz questions instead of the source, and strict-transcript generation has nothing to read.
That is where §7's *"18 transcript scope-keys match no topic scope at all"* came from — every
one of them is an old rename. [`renameScope(from, to)`](lib/firestore.js) re-keys all three and
keeps every doc id; `rename_course`, `rename_lesson` and `move_lesson` all go through it now.

⚠️ **A deck's `scopeId` carries the DECK's topic, not the card's** — `''` for a course- or
lesson-level deck, the topic only for a topic-level one, because `saveFlashcards` hands
`flashcardScopeId` the deck scope. Reconstructing it from `card.topic` matches nothing on a
book deck, so the rename leaves every point card on the old scope and `getFlashcards` — which
queries `scopeId` — stops finding the deck at all while all its cards sit right there. Caught
and fixed 2026-09-09, on the Spiritual reshape.

⚠️ **`Mathematics` holds ~900 cards on a LEGACY scopeId convention** (one id per CARD, with the
topic appended, even at course/lesson level). They are not orphans and must not be "healed" into
deck-shaped ids — that would merge 444 distinct scopes into a handful of decks. Any repair that
recomputes `scopeId` has to match an exact expected value, never just disagree-and-overwrite.

`move_topic` still re-files a single sub-lesson with `moveTopics` and does **not** carry a
topic-level deck or guide with it — a remaining gap, small because a lesson's transcript (the
expensive thing) is unaffected by a single topic moving.

### Per-user data lives in two shapes

There is a **legacy owner** (`LEGACY_OWNER`, [firestore.js:48](lib/firestore.js#L48), default
`ianfernandezctm@gmail.com`) whose stats are embedded directly on the `topics` docs — that's
how the original single-user Google Sheet imported. Everyone else gets subcollections:

| | Legacy owner | Everyone else |
|---|---|---|
| Stats | `topics/{id}` (inline fields) | `users/{email}/topicStats/{topicId}` |
| Quiz log | `quizLog/*` | `users/{email}/quizLog/*` |

`statsCol()` / `logCol()` ([firestore.js:56–69](lib/firestore.js#L56)) hide this. **Always go
through them.** Branching on the legacy owner yourself is how the "no questions found" and
"phantom qCount=0 docs" bugs happened.

Also per-user, under `users/{email}/meta/`: `enrollment` (programs + courses), `shelf`
(which tracks are on their Mastery Engine, plus `hidden[]` / `included[]`), `usage`, and
`ai` (the AI-provider allowlist the Team tab edits — **absent doc = Kimi only** for
non-admins; admins are never policed).

> **Growth-category programs are open to EVERY learner, enrollment or not** (2026-08-05).
> Sentinel's Philosophical/Spiritual tabs pin `?program=` for the whole staff, so
> `resolveProgramScope` honours a growth program's pin for any signed-in user (whole-program
> scope, no course filter), and `/api/internal/enrollment-progress` emits growth cards for
> everyone. Enrollment still gates **career** programs exactly as before.

Chats (`cardChats` / `scopeChats` / `assistantChats` subcollections) are keyed by
**`conversationUser(req)`**, not `effectiveUser(req)`: an admin's threads are their OWN,
never the legacy owner's, and act-as is **not** honoured for chats (changed 2026-07-25) —
threads are private even from admins. Progress/stats stay on `effectiveUser`.

### The two scoring formulas ([lib/priority.js](lib/priority.js))

```
priority = 0.5·(1−accuracy) + 0.3·min(daysSince/30, 1) + 0.2·(1 − min(attempts/10, 1))
```
Returned 0–100. Higher = study this next. Never attempted ⇒ maximally stale ⇒ high priority.

```
mastery = retention · ( 0.7·(correct+1.6)/(attempts+4)  +  0.3·attempts/(attempts+6) )
retention = 1 − 0.35·min(daysUntouched/120, 1)          # floors at 0.65, never 0
```
Returned 0–100; never attempted ⇒ 0. This is the **depth** score behind the learner's
Coverage/Mastery toggle, added 2026-08-08. It exists because the original number (mean
accuracy with untouched topics as 0) is a *breadth* measure that had degenerated into
measuring coverage twice: a real shelf read 66% against 67% coverage, with 509 of 542
practised topics at exactly 100% and 322 of those resting on ≤2 questions. Same shelf,
depth-scored: 32%.

🔴 **Three properties are load-bearing, and all three are properties of the CONSTANTS.**
[`lib/_priority_test.js`](lib/_priority_test.js) asserts each one — retune anything and
re-run it:

1. **Volume beats protecting a perfect score**, anywhere below ~15 attempts on a topic
   (which is the whole range a real shelf occupies). It deliberately crosses over near 20:
   twenty straight correct answers really is stronger evidence than forty at 90%.
2. **More questions always pay in expectation, at any skill** — even 50%. That is why the
   depth term is `a/(a+6)` and not `min(a/T, 1)`: past a hard cap only accuracy moves, so a
   shaky topic becomes better left alone and you have rebuilt the incentive you removed.
3. **It never reaches 100.** Asymptotic on both terms.

A wrong answer still visibly dents the number — that is real evidence, and only the
*expectation* is guaranteed positive. Don't turn it into a best-ever ratchet; a ratchet
stops describing what you currently know.

Computed **server-side**, in the `/api/catalog` projection, because retention needs
`lastAttempted` and the client has no reason to carry ~800 raw timestamps. The browser only
ever averages `row.mastery` — one formula, one file. **Sentinel's rollup is untouched**: the
Overview rings and `rollupPrograms` still report coverage, deliberately, so the host's rings
match the engine's default view.

### ⚠️ A question's `answer` must equal one of its `options`, exactly

The frontend grades by comparing the clicked option's **text** to `answer` (`handleAnswer` in
`public/app.js`). An `answer` that matches no option therefore marks **every attempt wrong**, for
everyone, silently — and mastery drops accordingly. Every write path enforces this:
`acceptQuestionFix` (AI reformat) rejects the model's output rather than saving it, and
`/api/questions/set` (the manual admin editor, `server.js`) 400s. That is the whole reason the
admin editors present the answer as a **radio over the options** rather than a free-text field.
Never add a question write that skips the check.

### `questionFlags` is learner-written — the valve on auto-publishing

Generated questions publish straight into the bank, so the safety valve is the learner: the quiz's
**"Report a problem"** button (distinct from the private review-flag checkbox, which only marks a
row in your own `quizLog`) POSTs `/api/questions/:id/flag`. Admins work the queue in Academy
Admin → **Proof**, which fetches each flag *with the question body attached* so a report can be
judged, fixed, or deleted in place. Resolving with `deleteQuestion:true` goes through
`deleteQuestionById`, which also decrements the topic's `questionCount` — never delete a question
doc directly, or the catalog claims questions that are gone.

### Reporting progress to Sentinel — two endpoints, ONE rollup

Sentinel's Overview rings and its admin **Team progress** table both read this engine's numbers,
and they must agree about the same person on the same day. So both go through `rollupPrograms()`
in `server.js`; only the fan-out differs.

| Endpoint | Purpose (HMAC) | Answers | Used by |
|---|---|---|---|
| `GET /api/internal/enrollment-progress?email=` | `enrollment-progress` | one person's per-program rollup | the four Overview rings, the Professional tab |
| `GET /api/internal/team-progress?emails=&days=` | `team-progress` | many people's rollup **+ each one's attempt window** | Sentinel's admin Team-progress table |
| `GET /api/internal/learner-detail?email=` | `learner-detail` | one person's WHOLE catalogue, per topic: attempts, accuracy, `computeMastery`, `computePriority` | Sentinel's daily personal-context report |
| `GET /api/internal/quiz-activity?email=&days=&wrongOnly=&limit=` | `quiz-activity` | attempt-by-attempt history; defaults to the MISSES only | the same report |
| `GET /api/internal/time-spent?emails=&from=&to=` | `time-spent` | many people's **active minutes** in the engine over a day range, by programme + by view | Sentinel's Overview time strip + admin Team-time table |
| `GET /api/internal/time-detail?email=&from=&to=` | `time-detail` | one person's minutes folded into SESSION rows (start–end · section · view · topics) | the click-through on either |
| `POST /api/internal/time-edit` `{email, day, remove:[{start,end}]}` | `time-edit` | REMOVE recorded minutes (the learner's honesty edit — delete or trim a session; end exclusive). The only write; nothing is added or moved through it | Sentinel's session ✎ / ✕ |

> **Why `learner-detail` exists when two rollups already do (added 2026-08-10).** Both of those
> answer at PROGRAM grain, which is right for a ring and useless for reasoning about a learner:
> "Data Science 96%" supports no advice, "never attempted Bayesian inference" does. The in-app
> assistant never needed an endpoint for this because it runs INSIDE the engine and reads the
> catalogue directly — an outside reader has no such access. Measured on the live shelf: 1,227
> topics, 595 attempted.
>
> 🔴 **Derived numbers come from `lib/priority.js`, never re-implemented.** `mastery` is the
> depth-aware score and is deliberately unlike the coverage figure the rollups report (§3); a second
> implementation would disagree with the learner's own progress tree.
>
> 🔴 **`quiz-activity` cannot say what was ANSWERED.** A quizLog row stores the question text and a
> right/wrong bit — not the chosen option, not the correct one (`logResults`). Anything rendering it
> may say "you missed this" and must not state what was picked.

- **Batched for read cost, not latency.** `team-progress` reads the shared `topics` catalogue ONCE
  (`readTopicDocs`) and overlays each person's own stats onto it (`overlayStats`) — twelve staff
  cost ~540 topic reads plus twelve small ones, not ~6,500. Capped at `MAX_TEAM_EMAILS` (60);
  Sentinel chunks against it. **Never rebuild this by looping `enrollment-progress`.**
- **`progressSumThen` is what makes VELOCITY possible.** `getRecentAttemptStats` replays the last
  `days` of a person's `quizLog` into per-topic deltas (keyed through `buildTopicIdIndex`, never
  `slug(fields)` — see §3), and `rollupPrograms` subtracts them to recompute the identical sum as
  it stood when the window opened. Sentinel's `(now − then) / days × 7` is therefore measured
  points-per-week, not a running total dressed up as a rate.
- **Attribution is honest about its gap.** A quizLog row stores the track/course/lesson/topic as
  they were *when it was logged*, so a topic re-filed inside the window no longer matches the
  catalogue. Those rows land in `activity.unmatched` instead of being guessed at — velocity then
  reads slightly LOW and says so, rather than wrong.
- **Fail-soft PER PERSON.** One unreadable account returns `{found:false, error}` in its own slot;
  everybody else still reports. Sentinel renders that slot as *unknown*, never as zero.

### Time spent — minute buckets, not timers (2026-09-01)

`users/{email}/activity/{YYYY-MM-DD}` holds `m`: a map of `"HHMM" → { p, v, tr, co, le, to }`
(programme id, view, track/course/lesson/topic) for every minute the learner was **active**.
The client (`activityTracker` in [public/app.js](public/app.js)) POSTs `/api/activity/beat`
about once a minute *while* it judges the learner active; the server stamps the covered minutes
(`stampActiveMinutes`, a `set({merge:true})` of nested maps — never a read-modify-write).

- **"Active" is a rule, not a sensor:** the frame is visible (tab in front AND the iframe on
  screen — Sentinel's Coach panel stays mounted while closed) AND a signal happened in the last
  **3 minutes**. Signals: input, any non-GET `api()` call, a stream in flight, spoken audio playing,
  or a speech-recognition result. Mouse *movement* is deliberately not one (a hands-free
  conversation has none); GET polls are not either (an abandoned tab would keep itself alive).
- 🔴 **A minute is a KEY.** Three engine frames (Professional tab + a growth tab + the Coach FAB)
  beating at once count the minute once, and two devices too. Never sum client-reported seconds.
- 🔴 **Keyed by `conversationUser`, not `effectiveUser`.** An admin acting-as a learner is spending
  their OWN time. The internal readers union a break-glass admin's email with `DEFAULT_ACCOUNT`
  (the shared-password arm), same convenience mapping the progress endpoints make.
- **Days and minutes are in `ACTIVITY_TZ` (Asia/Manila)** — Sentinel's `today_ph`. Sentinel sends
  `from`/`to` DATES for Today / This week / 30 days, so the two apps agree where a day starts.
- **Zero is a real answer** (no docs = nothing recorded), unlike the progress rollups where absence
  is *unknown*. `found:false` means the read itself failed.
- Cost: one write per active minute per open frame; reads are one doc per person per day
  (`MAX_ACTIVITY_DAYS` 62, `MAX_TEAM_EMAILS` 60), cached 120 s on Sentinel's side.

---

## 4. Auth — four sign-in paths

Resolved in [lib/auth.js](lib/auth.js). In precedence order:

| # | Path | Mechanism |
|---|---|---|
| 1 | **`ag_sso` cookie** | Portal-wide SSO, HMAC-signed with `SSO_SECRET`. Works only on a `*.agoradatadriven.com` domain. |
| 2 | **Google sign-in** | OAuth. Opt-in — dormant unless `GOOGLE_OAUTH_*` secrets are set. |
| 3 | **Email + password** | `MASTERY_LOGIN_ACCOUNTS="email:pw,email:pw"`. Mints the same cookie a Google login does. Opt-in. |
| 4 | **Shared password** | `APP_PASSWORD`. Legacy. Blank email ⇒ this path. Signs in *as the legacy owner*. |

Guards: `requireAuth` and `requireAdmin` ([auth.js](lib/auth.js)). **Admin = the person's SENTINEL
role** (`super_admin`/`admin` there → admin here; interns/employees are learners) — fed to the sync
`isAdmin()` via `setSentinelRoleResolver` over the /api gate's cached lookup. `MASTERY_SUPER_ADMIN`
(`info@agoradatadriven.com`) + `MASTERY_ADMINS` (default: just the super admin) are the
**break-glass override only** — they keep working when Sentinel is down; a Sentinel outage can
briefly demote role-admins but never mint one. A portal `ag_sso clients:["*"]` grant no longer
confers admin by itself, and only identities backed by a real per-person credential (ag_sso /
Google cookie) can be admin: the shared `APP_PASSWORD` session never is (changed 2026-07-25).
`act-as` lets an admin impersonate a learner for debugging, and its target must be an active
Sentinel person (super admin exempt). Identity resolvers, pick deliberately:

| Resolver | Use for | Admin default |
|---|---|---|
| `effectiveUser(req)` | progress, stats, quiz log | LISTED admins → `DEFAULT_ACCOUNT`; ag_sso `"*"` holders → own email |
| `conversationUser(req)` | chats, card overlays/labels | always the real signer — act-as **not** honoured (private even from admins) |
| `currentEmail(req)` | the real signer (gate, rate limit) | — |

**The Academy Admin page is gated at the server** (added 2026-07-27): `/academy-admin.html` and
`/academy-admin.js` are claimed by an explicit route ahead of `express.static` — non-admins
(and the signed-out) get a 302 to `/` (`?embed=1` preserved) and never receive the admin shell;
the in-page "Admins only" card is just chrome. The route awaits `sentinelInfo()` first because a
bare page navigation hasn't warmed the role cache behind the sync `isAdmin()`.

**Sentinel is the source of truth for accounts** (added 2026-07-25): the `/api` middleware calls
Sentinel's HMAC `user-lookup` (5-min cache) and 403s any signed-in email that isn't an ACTIVE
Sentinel user. `/api/auth/*` is exempt; the super admin is break-glass; a FAILED lookup (Sentinel
down, or no `SSO_SECRET` locally) fails open. The Google callback also refuses non-Sentinel
accounts (`/?login=noaccount`).

**Per-user AI allowlist** (added 2026-07-25): the same middleware resolves `req.aiPolicy`
(admins → `null` = unrestricted; others → `users/{email}/meta/ai`, default `['kimi']`; guests →
Kimi) and stores it on the usage ALS store. The HARD gate is `clampToPolicy()` inside
`complete()`/`completeStream()` in [lib/gemini.js](lib/gemini.js) — every AI path funnels
through it. `/api/models` is filtered per caller; the Team tab (Academy Admin station 06)
edits grants via `GET/POST /api/admin/ai-access`; `GET /api/admin/team` is the per-person
dashboard (progress/accuracy/attempts/explains/spend).

### Calling an admin endpoint with curl

```powershell
# Mint an ag_sso cookie locally. Format (lib/auth.js verifyAgSso): base64url({sub,exp}).base64url(HMAC)
# — NOT the old "email|ts|sig" shape. exp is unix SECONDS. Secret = platform-sso-key.
$env:SSO_SECRET = (gcloud secrets versions access latest --secret platform-sso-key --project agora-data-driven)
$cookie = node -e "const {createHmac}=require('crypto');const p=Buffer.from(JSON.stringify({sub:'info@agoradatadriven.com',exp:Math.floor(Date.now()/1000)+900})).toString('base64url');console.log(p+'.'+createHmac('sha256',process.env.SSO_SECRET).update(p,'ascii').digest('base64url'))"
# POSTs through Google's frontend need a body (411 Length Required otherwise):
curl.exe -s -X POST "$URL/api/admin/sequence-topics" -H "Cookie: ag_sso=$cookie" -H "Content-Type: application/json" -d "{}"
```

---

## 5. Recipes

### Add an API endpoint

1. Put it in `server.js` **next to its siblings** (see the zone table in §2) — not at the bottom.
2. Pick guards: `requireAuth`, `requireAdmin`, `rateLimitAI` (for anything that calls a model),
   `bigJson` (for payloads > 1 MB, e.g. transcripts).
3. Always `next(e)` on error so the handler at [server.js:5632](server.js#L5632) formats it.

```js
app.post('/api/thing', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const email = effectiveUser(req);              // NOT currentEmail
    const scope = await resolveProgramScope(email, { requested: req.body?.program });
    const out = await someLib(req.body, aiChoice(req));
    res.json(out);
  } catch (e) { next(e); }
});
```

> **`app.get('*')` at [server.js:5627](server.js#L5627) is the SPA catch-all.** Any route
> declared after it is unreachable. Never append routes to the end of the file.

### Add an AI feature

All prompts live in `lib/gemini.js`. Never call a provider SDK directly from `server.js`.

```js
export async function generateThing({ topic, context }, ai = {}, onToken) {
  const prompt = `…instructions…\n\nTOPIC: ${topic}\n${context}`;
  return complete(prompt, { json: true, schema: THING_SCHEMA, ...ai });
}
```

- `complete(prompt, opts)` — blocking. `completeStream(prompt, opts, onToken)` — streaming.
- Pass `...ai` through so the user's provider choice is honoured.
- For JSON, prefer a `schema` (Gemini responseSchema) — it guarantees shape at decode time
  and removes a whole class of parse failures.
- `search: true` and `attachments` are **Gemini-only** capabilities; other providers ignore them.

### Stream a response

Two mechanisms, don't mix them:

| Use | Helper | For |
|---|---|---|
| Plain text | `streamText(res, onToken => …)` [server.js:361](server.js#L361) | Learner-facing prose (hints, explanations, guides) |
| Typed events | `sseInit(res)` + `sseSend(res, event, data)` [server.js:389](server.js#L389) | Admin planners — streams `thinking` / `content` / `result` / `done` |

Both set `X-Accel-Buffering: no`. **Without it Cloud Run buffers the whole response** and
streaming silently degrades to one big blob at the end.

> **SSE "network error" in the browser almost always means a 500 *before* the stream opened.**
> Build expensive context *after* `sseInit()`, behind a heartbeat.

### Add a frontend view

`public/index.html` holds every view as a `<section id="xView" class="hidden">` (e.g.
`quizView`, `statsView`, `graphView`). `app.js` toggles them with `show(id)` / `hide(id)`.
There is no router and no build step.

Add the section to the HTML, then wire it in `app.js` near the other view handlers. Reload the
browser — that's the full loop.

### Source material flows BOTH ways — curriculum-first and sources-first

Added 2026-09-07. There are two directions through the Composing Room, and they are
deliberately separate flows over the **same** `transcripts` collection:

| | Curriculum-first (original) | Sources-first (Library) |
|---|---|---|
| Order | Build the tree, then attach material to it | Upload material, then design the tree from it |
| Entry | **Library** → *File a source into the curriculum* | **Library** → *Build a curriculum from these* |
| AI | `classifyTranscript` — places ONE source in an EXISTING tree | `digestSource` (map) → `planFromSources` (reduce) |
| Routes | `/api/admin/ingest/plan` → `/commit` | `/api/admin/transcripts/:id/digest`, `/api/admin/sources/plan` → `/commit` |
| Use it for | The daily loop: watched a video, file it, quiz it | Loading a whole course/book corpus at once |

Three things about the sources-first flow are load-bearing:

1. **An UNFILED transcript is one with no `track`/`course`/`lesson`** — `addTranscript`
   defaults all three to `''`, so the library needed no migration. It is inert by
   construction: `getScopeTranscripts` filters on a real course/lesson, so unfiled material
   can never leak into a lesson's grounding. **Filing it is what activates it** — once a
   transcript carries a real scope, study guides, strict-transcript generation and the
   assistant's source text all pick it up for free.
2. **🔴 The planner reads DIGESTS, never full text.** A 40-source corpus is comfortably 800k
   characters; `CLASSIFY_TRANSCRIPT_CHARS` caps a *single* source at 9k. So each source is
   digested once into `{abstract, concepts[]}` cached on its own doc (`setTranscriptDigest`),
   and the planner designs from those. Feeding raw corpora to `planFromSources` will fail or,
   worse, silently design from introductions. The client steps the digest one source per
   request for the same reason genjobs step: Cloud Run throttles CPU between requests.
3. **Gap topics are OPT-IN and default OFF** (`gaps: true` on the plan call, the "Suggest
   gaps" tick in the UI). When asked for, `planFromSources` also returns what the *subject*
   needs that the corpus does not teach, and `/sources/commit` creates those rows but keeps
   them out of the genjob queue — a strict-transcript job over a topic with no transcript only
   produces errors. When NOT asked for, the prompt tells the model to cover only what the
   sources teach and to cite a source on every lesson, and any `gaps` it emits anyway are
   dropped here, so the caller's choice always holds. Fill gaps later — see
   [docs/COURSE-TO-CURRICULUM-SOP.md](docs/COURSE-TO-CURRICULUM-SOP.md).

**There is ONE way material enters: the Library.** Uploads, pastes and Watcher pulls all
land there unfiled (`/api/admin/transcripts`, `/transcripts/from-watcher`); filing and
designing are then ACTIONS on what is already there. The filing card used to carry its own
paste box, file picker and Watcher fold-out, which made the page hold two upload surfaces and
let a paste create a *second* copy of a source the library already had. So `/ingest/plan` and
`/ingest/commit` now accept a **`transcriptId`**, and when they get one the commit **files
that doc in place** (`updateTranscript`) instead of writing a new one — the source keeps its
id, its folder and its cached digest, and simply stops being unfiled.

**One object per station.** The Library owns the SOURCES (add, folder, split, browse, and file
one into the tree); the Curriculum station owns the TREE (design from sources, build from a
goal or outline, edit with AI). The corpus designer began life in the Library and that was
wrong — it produces a curriculum, so it belongs where the curriculum is. Its selection unit is
a **folder**, not a tick-list: one module per folder, then "design from that folder".

**Reading the sources is phase 1 of designing, not a step.** `digestSource` runs inside the
Design action over anything not yet read, skipping what is cached. It used to be a numbered
button, which turned an implementation detail into something the admin had to understand.

**🔴 A source must be about LESSON-SIZED, and the reason is arithmetic.** Every reader is
bounded: `digestSource` 24k chars, `classifyTranscript` 9k, `sourceFor` 12k **per lesson**
([lib/genjobs.js](lib/genjobs.js)), `scopeSourceText` 24k. So one file holding a whole module
catalogues from its opening third, and because grounding is scope-based, every lesson that
source grounds then draws its questions from the same first 12k. `POST
/api/admin/transcripts/:id/split` exists for exactly this: it finds the lesson boundaries and
cuts the file into parts, each landing unfiled in a folder named after the parent. The parent
is KEPT and marked `splitInto`; deleting it is a separate, explicit click.

The cut itself never round-trips the text through a model — the model returns a title plus a
**verbatim anchor**, and [`cutAtAnchors`](lib/gemini.js) locates each anchor in the original
and slices there. It matches on a whitespace-normalised copy (models silently re-wrap lines),
**drops** an anchor it cannot find rather than approximating, and scans forward so cuts
strictly increase and no text lands in two lessons. [`lib/_split_test.js`](lib/_split_test.js)
asserts all three — every failure mode here is silent, so run it after any change.

**Folders are shelving, not filing.** A source's `folder` is free text on the transcript doc,
derived into a rail from the distinct values in use (no registry, so an empty folder stops
existing on its own). It is orthogonal to `course`/`lesson`: moving a source between folders
can never change what a lesson grounds on, which is why `/api/admin/transcripts/folder` is a
separate verb from filing.

One source may ground several lessons. A transcript doc carries exactly one scope and
grounding reads by scope, so `/sources/commit` **copies** it to each extra lesson, recording
`copyOf`. Filing it once instead would silently leave the other lessons ungrounded.

### Reordering any grain writes ONE field

`reorder_courses` / `reorder_lessons` / `reorder_topics` (and the tree's drag-and-drop)
each stamp a 0-based sequence onto a single field — `courseOrder`, `lessonOrder`, `order`
respectively — via `stampOrder` in `runCurriculumEdits` and
`POST /api/admin/topics/reorder`, which merges only the fields it was sent.

That is the whole benefit of storing the three grains separately (§3). While course
order was `min(topic.order)`, reordering courses meant renumbering **every topic in
the track** in one continuous run (`renumberTrack`), reordering a course's lessons had
to start from that course's current lowest order or it silently dragged the course to
the front of its track, and a single off-by-one resequenced everything below it. All
of that is gone: the grains cannot interfere.

Two rules survive from that design, one grain down:

- **A unit MOVED between parents gets a fresh rank at the end of its new parent.**
  `move_lesson` and `move_topic` recompute one; inheriting the old number collides
  with whatever already holds that rank in the target, and a tie falls back to the
  alphabet. The drag-and-drop editor stamps the whole target parent for the same reason.
- **The curated `COURSE_ORDER`/`LESSON_ORDER` lists are a FALLBACK, not the rule** —
  a stored rank outranks them. That is why the backfill consults them (§3).

### Change the curriculum (move/rename/merge topics)

Use the ops engine, not raw Firestore writes: `runCurriculumEdits()`
([server.js:4001](server.js#L4001)) → `moveTopics()` / `renameTopics()`. It preserves doc ids,
and therefore questions and learner stats.

🔴 **Re-filing and renaming are different writes, at BOTH grains.** `moveTopics` only writes
track/course/lesson onto the topic rows. A SUB-LESSON's name is also the key of its questions,
cards and guide → `renameTopics` (op `rename_topic`, route `POST /api/admin/topics/rename`). A
COURSE or LESSON name is also the key of its SOURCE TRANSCRIPT, its decks and its guides →
`renameScope` (used by `rename_course`, `rename_lesson` and `move_lesson`). Both keep every doc
id. See §3 — getting this wrong strips a lesson of the book it teaches from.

Admin UI: Academy Admin → **Curriculum** → "Edit with AI" (one of that station's three modes,
beside "From my sources" and "Build with AI").

> The in-app AI editor has historically mis-planned large restructures (placeholder junk,
> partial applies). For a big multi-hundred-topic reorganisation, a one-off script doing
> `merge`-update `{course, lesson}` on stable doc ids is more reliable. Preserve the doc id.

---

## 6. Verify your change

There is **no test runner and no linter configured**. `npm test` does not exist. What you have:

```powershell
# 1. Syntax check — catches the majority of breakages, costs a second
node --check server.js
Get-ChildItem lib\*.js | ForEach-Object { node --check $_.FullName }

# 2. The twelve real unit tests (pure logic, no cloud needed — all print "PASS")
node lib\_auth_test.js
node lib\_graph_test.js              # warm-up / readiness graph logic
node lib\_programs_test.js
node lib\_progress_credit_test.js
node lib\_priority_test.js           # priority + the depth-mastery properties (§3)
node lib\_visual_test.js             # visual-guide parsing + the truncation guard (§7)
node lib\_deep_test.js               # deep mode's answer-key / declared-gap invariants (§7)
node lib\_usage_test.js              # AI/TTS usage accounting + cost estimates
node lib\_aidiag_test.js             # AI-failure classifier + the reply salvage (§7)
node lib\_split_test.js              # where an oversized source is CUT into lessons (§5)
node lib\_gendupe_test.js            # question de-duplication + per-program audience (§7)
node lib\_naming_test.js             # the sub-lesson naming rule, concept vs reading (§3)
                                     # _graph_test also covers the curriculum spine's order (§3)

# 3. Boot it and hit a route
npm run dev
curl.exe -s http://localhost:8080/api/auth/status
```

**Always run `node --check` on every file you edited before deploying.** A syntax error is only
discovered at container start otherwise, and Cloud Run will serve the *old* revision while the
new one crash-loops — which looks like "my deploy did nothing".

After deploying, confirm the revision actually changed:

```powershell
gcloud run services describe mastery-engine --region us-central1 `
  --format="value(status.latestReadyRevisionName,status.traffic[0].revisionName)"
```

---

## 7. Gotchas — read before debugging

Each of these cost real hours. Symptom → cause → fix.

### 🔴 `Edit` fails to match a string that's clearly in the file

**Cause:** two files contain **literal NUL (0x00) bytes** used as map-key separators. `Read`
renders them as spaces, so the string you copy back is not the string on disk. Grep reports the
file as binary.

| File | Line | Content |
|---|---|---|
| [server.js](server.js) | 4847 | `` const key = `${r.track}<NUL>${r.course}<NUL>${r.lesson}`; `` |
| [lib/firestore.js](lib/firestore.js) | 2510, 2512 | `tupleKey()` — joins with `<NUL>` (the comment above it contains one too) |

(`public/app.js` no longer holds one — its lesson grouping was rewritten. Re-measure with the
snippet below rather than trusting this table.)

Line numbers here drift with every change — re-measure before trusting them:
```js
require('fs').readFileSync('server.js','utf8').split(/\r?\n/)
  .forEach((l,i)=>{ if (l.includes('\0')) console.log(i+1); });
```

**Fix:** don't edit those lines with `Edit`. Use a Node script with explicit ` `:

```js
const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');
s = s.replace('${r.track} ${r.course}', '…');
fs.writeFileSync('server.js', s);
```

Audit any file before a delicate edit: `` tr -cd '\000' < server.js | wc -c ``

### 🔴 "I finished a quiz and got no progress"

**Cause:** stats keyed by `slug(current fields)` instead of the stable doc id. See §3.
**Fix:** `buildTopicIdIndex()`. Never re-derive an id from field values.

### 🔴 `state.log` is indexed by POSITION in `state.questions`

Added 2026-08-07 with quiz back-navigation. `public/app.js` keeps the learner's results in
`state.log[state.idx]` — a positional parallel array, not a map keyed by question id. Two rules
follow, and both were free before "Previous question" existed:

- **Anything that splices `state.questions` must splice `state.log` with it.** "Drill deeper" and
  "Generate more like this" insert at `idx + 1`; that used to be safe because those actions were
  only reachable at the frontier, where nothing after `idx` was answered. Back-navigation makes
  mid-run insertion possible, and splicing one array alone re-points every later log row at a
  different question — a passed answer filed against someone else's topic. Use
  `queueAfterCurrent()`; don't splice `state.questions` by hand.
- **A revisited question is READ-ONLY.** `renderQuestion` replays the stored row through
  `showAnswered()` instead of re-arming the option buttons. Letting it be answered twice would
  increment `state.score` again and overwrite the log entry, so the results screen and the saved
  attempt would disagree with each other.

### 🔴 Anything hanging off a CARD must scope to the card, not to `requestScope`

Added 2026-08-07. **A learner's shelf mixes programs**, and the Mastery deck interleaves them
card by card — so the deck on screen is routinely NOT from the program the caller's enrolment
resolves to. `requestScope(req)` reads `?program=`/`body.program` and otherwise falls back to
the learner's **first enrolled program**. `/api/flashcards` and `/generate` never noticed,
because the client sends `program` alongside the scope (`fcQuery()`, `fc.scope`). The
card-scoped endpoints have no scope to send, so they silently resolved against the wrong
curriculum and every catalog lookup came back empty:

| Endpoint | How it failed |
|---|---|
| `POST /api/flashcards/quiz` | 400 **"This card is not linked to a known topic"** |
| `GET /api/flashcards/card-stats` | permanent **"0 questions · — accuracy"** on a topic with a full bank |
| `POST /api/flashcards/explain` | graded the explanation, then logged **no progress** (`meta` null) |
| `POST /api/flashcards/chat` | tutor answered with no hierarchy label and no sample questions |

**Use `cardScope(req, card)`** (`server.js`, next to `flashcardScopeLabel`) for every one of
these. It resolves the card's own program via `programForCard()` ([lib/firestore.js](lib/firestore.js))
and runs it through `resolveProgramScope` exactly like a requested one — so **enrolment still
decides** and nothing widens: a learner enrolled elsewhere gets the same 400 as before.

Cards banked from 2026-08-07 store `program` on the doc. Older ones don't, so `programForCard`
falls back to one equality query on the card's topic row — deliberately not `getCatalog`, which
is ~540 docs and this runs per card view. `program` is **not** part of `flashcardScopeId`; adding
it there would orphan every deck already banked.

**2026-09-08 — the same trap caught the GEN scope selects.** The claim above that "`/generate`
never noticed" was only half true: the flashcard path sends `program`, but the **Generate
Questions** cascade (`selection()` in [public/app.js](public/app.js)) sent only
track/course/lesson/topic. Those selects are filled from `GET /api/catalog`, which for an
UNPINNED learner is `engineCatalog()` — **the shelf, which spans programs**. So picking a RAG
track while enrolment resolved to `data_science` scoped the request to the wrong curriculum and
answered **400 "No topics in scope"** for a selection the learner had just picked off their own
dropdown. Two halves to the fix, and both matter:

- `selection()` now carries `selectionProgram()` — the program of the deepest matching catalog
  row. A pinned tab still wins, because `api()` puts `?program=<pin>` on the URL and
  `requestScope` prefers the query over the body.
- `selectionScope(req, scope, sel, bank)` (`server.js`, above `/api/catalog`) is the server-side
  net for old/cached clients: when the resolved scope contains **none** of the selected rows, it
  adopts the program of those rows **as found on this learner's own shelf** (`engineCatalog`) —
  never wider than what is already on their screen, and skipped entirely for a pinned session.
  `/api/generate` runs its scope through it, which also decides the `program` the new questions
  are **banked** under. `engineCatalog(email, bank)` takes the already-read catalog so this
  costs no second ~540-doc read.
- The GEN **"Base on transcripts"** picker had the same split brain — it listed the enrolment
  program's sources next to another program's track. It now passes `?program=` and reloads on a
  track change; `GET /api/transcripts` honours it via `shelfVouchedScope()` (same rule: the
  learner's own shelf must contain that program).

Anything else that reads a scope out of those dropdowns inherits the trap — send the program.

> A client-side fix (send `program` with the card id) is NOT sufficient, and that is the whole
> reason this lives on the server: in the Mastery deck `fc.scope` is `null` by design, because
> consecutive cards belong to different programs.

### 🔴 "No questions found" for a topic that plainly has questions

**Cause:** the legacy owner gets `priority: null` on never-attempted topics, and
`/api/quiz/select` filtered on `priority != null`. Fixed in `getCatalog`'s legacy branch — but
the shape of the bug recurs. Any query filtering on a stat field must tolerate `null`.

### 🔴 LM Studio returns 400, or is unbearably slow

Two separate problems, both fixed in [lib/lmstudio.js](lib/lmstudio.js) — don't reintroduce:
- `response_format: { type: 'json_object' }` → **400**. LM Studio accepts only `json_schema` or `text`.
- qwen3-family models emit `<think>` blocks that destroy latency and corrupt JSON. Thinking must
  be suppressed.

### 🔴 DeepSeek is slow when you asked for the fast path

DeepSeek V4 Flash defaults **thinking ON server-side**. You must explicitly send
`thinking: { type: 'disabled' }` to get the fast path. Passing nothing is not neutral.

### 🔴 A slow AI POST dies with "Failed to fetch" while the server logged 200

**Any route whose model call can run for minutes has this bug until it is given the streamed
transport.** Hit twice now: bulk generation (`/api/admin/genjobs/:id/step`, 2026-08-03) and
whole-course flashcard decks (`/api/flashcards/generate`, 2026-08-07).

**Cause:** the call is a single thinking-model call — `/step` measured at **78–313s per topic**,
a course deck is 18–30 cards each with an intuition, a LaTeX formula and a visual spec. Held as
a plain POST the socket sends **no bytes** for those minutes, and a silent connection that long
gets dropped in front of us — the `ghs.googlehosted.com` domain-mapping frontend, an office
proxy, NAT. The work still **succeeds** (200 in the request log, questions/cards banked); only
the response is lost, so the browser reports a network-level `TypeError: Failed to fetch`.
Observed cleanly on `/step`: every step ≤115s came back, every step ≥148s did not. The service
timeout (3600s) is a red herring, and there is no OOM or 5xx to find.

**Fix — content-negotiate, both sides:**

| Side | Use |
|---|---|
| `server.js` | `wantsSSE(req)` → `sseResult(res, work, failMsg)` ([server.js:447](server.js#L447)). Opens the stream at once, heartbeats `: ping` every 15s, emits one `result`. |
| `public/app.js` | `apiSlow(path, body)` — sends `Accept: text/event-stream`, resolves the `result`. |
| `public/academy-admin.js` | `streamSSE(path, body, handlers)` — same, plus live thinking. |

JSON stays the **default** on both routes: `scripts/` drives `/step` over a short-lived CLI
socket and has no such problem. Two consequences of the streamed shape:

- Once the stream is open a failure can no longer be a 500 — `sseResult` reports it as an
  `error` event, so a worker it runs must **throw `httpErr(status, msg)`**, never write a status.
  That is why `/api/flashcards/generate`'s body lives in `buildDeckForRequest()`.
- `apiStreamSSE` falls back to reading a JSON body as the single `result` frame, so a browser on
  the new client against an older revision still works.

> **Never "retry" a dropped call by re-POSTing.** The first one is almost certainly still
> running. For `/step` that is corrupting — both would `queue.shift()` the same topic, so it
> gets generated twice and the next is skipped; `waitOutStep()` in `public/academy-admin.js`
> polls `GET /api/admin/genjobs/:id` instead. For a deck it is merely wasteful, so
> `generateFlashcards()` re-reads `GET /api/flashcards` after a network error and renders the
> deck the lost response was carrying.

### 🔴 Kimi returns 401

`KIMI_API_KEY` is a **Kimi *Code* subscription key** (`sk-kimi-…`). It authenticates only
against `https://api.kimi.com/coding/v1` — **never** `api.moonshot.ai`. Models: `k3`,
`kimi-for-coding`, `kimi-for-coding-highspeed`.

### 🔴 Gemini: "search + JSON" fails

Vertex forbids Google Search grounding together with a JSON response schema. Web-search answers
must go down the **plain-text** path. This is why the assistant has two branches.

### 🔴 "non-JSON content" from a model — and why the ASSISTANT no longer wraps a spoken reply

Under-escaped LaTeX backslashes. `parseLooseJson` ([gemini.js:242](lib/gemini.js#L242)) /
`restoreLatexEscapes` ([gemini.js:314](lib/gemini.js#L314)) repair it. Also: with thinking OFF,
raw newlines/tabs in strings break parsing.

**Two malformations survive that repair pass, and both are unfixable in principle:** a payload
cut off at the token ceiling (the closing brace never arrived) and an **unescaped `"` inside a
string** (where the string ends is genuinely ambiguous). So any prompt that asks a model to wrap
prose in a JSON envelope is a dice roll on the prose, and it comes up wrong on exactly the long,
quote-heavy, LaTeX-y answers learners ask for ("make me a quiz"). Re-sending the same message
usually works, because the re-roll happens to escape cleanly — which is what made this look like
a flake for months rather than a bug.

🔴 **The rule that follows: only ask for a JSON envelope when the envelope carries something.**
Fixed 2026-08-11 in `generateAssistantChat` — the **conversational (voice) path now returns plain
text**, because a spoken reply cannot carry a `visual` and the wrapper was pure risk there. It was
the ONLY caller of the blocking route (`sendAssistantBlocking` runs only when `convoOn()`), so
this was the whole of the observed failure. The non-conversational branch keeps the envelope,
since that one really does carry the plot spec — but it **salvages** rather than 500s:
`salvageJsonString(text, 'reply')` recovers the answer by hand (it survives both malformations
above) and the turn returns `degraded` + `diag` so the UI can say the visual was lost.

**Every JSON parse a learner is waiting on should go through `parseAiJson(label, raw, {meta})`**,
not a bare `try { parseLooseJson } catch { throw new Error('… returned non-JSON content') }`. It
throws the same sentence *plus* `.diag` — `describeJsonFailure`'s report — which `server.js`
returns on the error body and the 🐞 panel renders. See the next entry.

### 🔴 An AI failure must leave EVIDENCE — the 🐞 panel

Added 2026-08-11, with the fix above. The reason that bug survived so long is that its only trace
was one sentence in the chat: the raw payload was dropped on the floor inside the `catch`, so
every occurrence was unexplainable after the fact and the cause got re-guessed at each time.

| Piece | Where | What it does |
|---|---|---|
| `meta.finishReason` | every `call*` adapter | the provider's own word for why it stopped. **This is the one fact that separates "wrote bad JSON" from "was cut off mid-JSON"** — without it those look identical. Rides the same `meta` out-param as provider/model (§7 "Record the RESOLVED engine") |
| `describeJsonFailure` | [lib/gemini.js](lib/gemini.js) | names the cause (`truncated` / `stray-quote` / `latex-backslash` / `raw-control-char` / `no-json` / `blocked` / `empty`), quotes the break with a `⟪break⟫` marker, samples head + tail |
| `parseAiJson` | [lib/gemini.js](lib/gemini.js) | the diagnosed front door to `parseLooseJson`; throws `.diag`, logs one `[ai-fail]` line |
| `err.diag` → response | [server.js](server.js) error handler + the stream's `error` event | carries the report to the browser |
| the 🐞 panel | [public/app.js](public/app.js) | every rejected `/api` call, in `localStorage` (last 12), rendered by the header button and by "Why did this fail?" on the failed bubble |

Three properties are load-bearing:

1. 🔴 **The PROMPT is never recorded — only its size.** It carries the learner's growth journal,
   their task board and (in deep mode) the answer key. None of that is needed to explain a broken
   reply, and a debug panel is the last place it should surface.
2. **The log lives in the browser, not on the server.** A per-process ring would be split across
   Cloud Run instances (the follow-up read lands on a different one) *and* would mix learners'
   payloads together. `localStorage` is per-person by construction and survives the reload you
   need to make to look at it. The server's half is a `[ai-fail]` line for Cloud Logging.
3. **Recording never breaks the thing it describes.** Every entry point swallows its own errors; a
   full or blocked `localStorage` costs you the history, not the request.

`node lib/_aidiag_test.js` asserts the classifier's ordering (a reported `finishReason` beats any
guess from the text) and that the salvage survives both unfixable malformations.

### 🔴 KaTeX renders broken math

A `<code>` chip inside a `$…$` span splits the TeX. The renderer has `stashTexttNoSplit` to
handle it. Don't "simplify" that.

### 🔴 The assistant's growth-journal index is complete; only the BODIES are lazy

The learner's Sentinel growth journal reaches the assistant as **small-to-big retrieval**: the
holistic digest carries every entry's TITLE (uncapped, every turn), and `growthGroundingFor`
([server.js](server.js)) fetches the full `detail` bodies for the entries this turn bears on via
`growthDetail` → Sentinel's `/api/internal/growth-detail`. `growthNotesBlock`
([lib/gemini.js](lib/gemini.js)) renders both halves.

Three invariants, and each one is load-bearing — breaking any of them makes the assistant deny
things the learner can see on their own screen:

1. **Everything ships while it fits.** Under `GROWTH_HYDRATE_BUDGET_CHARS` the whole journal is
   hydrated and scoring is skipped entirely. Retrieval only switches on once the corpus genuinely
   outgrows the prompt — small and complete beats large and sampled.
2. **A body is whole or absent.** Sizes come from the index's `chars`, so budgeting happens
   *before* fetching and no body is ever cut to fit. A truncated note reads exactly like a complete
   one and gets summarised as though it were the whole thing.
3. **Gaps are declared.** Anything not loaded is named in the prompt, so a retrieval miss becomes
   "you have a note called X I haven't opened" instead of "you have no note about X".

Keep `GROWTH_MAX_IDS` in sync with Sentinel's `MAX_GROWTH_DETAIL_IDS` — ask for more than it accepts
and it drops the tail silently, which renders unloaded entries as loaded. See sentinel's AGENTS.md
for the Sentinel half and the incident that produced all of this.

### 🔴 The learner can withhold their GYM LOG — and a withheld log is not a log of zero

Added 2026-08-10. Sentinel's Physical tab has a toggle (`coach_reads_gym_logs`); when it is off the
holistic profile arrives with **`gym.logs_shared: false`** and `sessions_last_14d` /
`completed_last_14d` as `null`. `holisticBlock` ([lib/gemini.js](lib/gemini.js)) branches on the
flag and prints an explicit *draw no conclusion about training frequency* instruction instead.

**The old line was `Trained ${gym.sessions_last_14d ?? 0} time(s)`** — so a person who trains six
days a week and simply doesn't log it was told by their coach that they had been inconsistent, and
an unshared log would have rendered as a flat "Trained 0 time(s)". `?? 0` on a field that can be
absent is the same mistake as a capped growth index: it converts "I wasn't told" into a fact.

- **`logs_shared !== false`** is the test, not `=== true` — an older Sentinel sends neither, and
  must keep behaving as it always did.
- **Only the log is withheld.** The weekly split and cardio still arrive, so the training-load
  advice about *what to study today* is unaffected. Don't gate them together.
- The gym **action ops** (`set_gym_week` / `set_gym_day` / `clear_gym_day`) are untouched: they
  edit the PLAN, which was never hidden.

### 🔴 The assistant can read the learner's TASK BOARD — and must never present it as the company's

Added 2026-08-05. `workDigest` / `workDetail` ([lib/sentinel.js](lib/sentinel.js)) fetch Sentinel's
`/api/internal/{work-digest,work-detail}`; `workGroundingFor` ([server.js](server.js)) hydrates the
cards a turn names; `workBlock` ([lib/gemini.js](lib/gemini.js)) renders it, injected right after the
holistic block in BOTH assistant paths (blocking + streaming). That adjacency is deliberate: an
overdue card means one thing on a rest day and another before a 10k.

**Sentinel scopes the payload to the caller** (`task_perms.can_view`) — an employee's digest is their
own work plus their team's unclaimed queue; a manager's is the estate; the per-person rollup is
manager-only. So three things in that block are load-bearing, not padding:

1. **It prints `viewer.sees` first.** Without it the model reads a four-card board as "the company has
   four tasks" and says so to an intern — a correct permission boundary turned into a false claim.
2. **Gaps are declared, at two levels.** `board.truncated` covers cards that did not fit; and for any
   card with no `FULL DETAIL` entry the block forbids describing its insides (ask which one they mean
   — the next turn's message names it, and retrieval hits). Same rule as the growth journal.
3. **The rollup's rows DO NOT SUM.** Sentinel counts a card on every plate it is on, so the block says
   so outright, and forbids the word "overloaded" — a task on that board carries no size, and `load`
   is only relative to the team's own median.

Keep `WORK_MAX_IDS` in step with Sentinel's `MAX_WORK_DETAIL_IDS`: ask for more and it drops the tail
silently, which renders un-loaded cards as loaded — the precise lie this design exists to prevent.

🔴 **The assistant is READ-ONLY on the board.** No `agora-action` op touches tasks, and the block says
it cannot move, assign, reschedule or close a card. Adding writes is an action-protocol change (with
the host executor and the Approve card), never a widening of the digest.

### 🔴 DEEP MODE puts the ANSWER KEY in the prompt — and one rule has to survive it

Added 2026-08-10. The 🔍 **Deep** chip is the opt-in grounding tier: armed, `deepGroundingFor`
([server.js](server.js)) loads the section ON SCREEN in full and `deepBlock`
([lib/gemini.js](lib/gemini.js)) renders it — the real question bank **with its answers**, the
learner's per-topic accuracy/mastery/priority, and the cached study guide verbatim. Off by
default, and **that default is the feature**: the ordinary turn is fast because it loads none of
it. `deep:false` produces a byte-identical prompt to before.

🔴 **The unanswered question on screen stays unspoiled, whatever the bank says.** The key is in
the prompt precisely so the assistant can run an oral rehearsal and answer "am I ready?" — but
`assistantContextBlock` may be printing a question from that same bank a few lines below, under
the standing "do NOT reveal the correct option" rule. Those two instructions meet, so `deepBlock`
states the exception explicitly and **is injected last**, after every other grounding block: a
model reading top-to-bottom must meet the override *after* the permission it overrides.
[`lib/_deep_test.js`](lib/_deep_test.js) asserts both the wording and the ordering — moving the
block earlier in the prompt passes `node --check` and silently breaks this.

Four more properties, each the same rule the growth journal and the task board already carry:

0. 🔴 **It matches the section against the SHELF (`engineCatalog`), which SPANS PROGRAMS — never
   against `requestScope`.** Fixed 2026-08-10; it shipped the other way and was the `cardScope` bug
   above, one level up. The assistant's POST carries no `program`, so `requestScope` falls back to
   the learner's **first enrolled program** while the screen behind it is `/api/catalog`'s
   cross-program shelf. On the live shelf that was **285 of 808 topics** (the whole DE/IR
   curriculum, in `ai_engineering`, behind a `data_science` fallback): every deep turn on that half
   matched zero rows and answered *"deep mode couldn't load anything"* with the bank sitting right
   there. All three sources failed together — rows, questions and the guide's cache key.
   Consequences, all load-bearing:
   - **The program is read off the MATCHED ROWS, per topic** (`programByTopic`), not off the
     request. A `topics` scope can straddle programs, and a topic NAME is not unique across them —
     which is the collision `filterQuestions` exists for. So the bank is read unscoped and each
     question is kept only if its own program equals its row's.
   - **A PINNED session wins** (`pinnedProgram`): Sentinel's Philosophical/Spiritual tabs are one
     program for the whole session, and that program may not be on the shelf at all. The program
     scope also remains the fallback for anyone with no shelf built yet.
   - `engineCatalog()` is now the one place that builds "the learner's actual engine" — `/api/catalog`
     calls it too. Anything else grounding on *what is on screen* must call it, not `getCatalog(email,
     requestScope(req))`. (`learnerCatalog` deliberately does not: it also needs the rows that fell
     OUT of the engine, to report parked sections.)
1. **Scope comes from the SCREEN, most specific first** (`deepScopeFrom`): an open visual guide or
   flashcard pins the section harder than the setup dropdowns, which can still read "Review All"
   while a lesson's guide fills the screen. This is why `assistantContext()` now sends `scope` on
   **every** view rather than only `setup` — it was decoration before and is load-bearing now.
2. **A body is whole or absent.** A guide over `DEEP_GUIDE_CHARS` is declared as too long, never
   sliced: a truncated guide reads exactly like a complete one and gets taught as the whole lesson.
3. **Every cap is declared.** Questions past `DEEP_MAX_QUESTIONS` and topics past `DEEP_MAX_TOPICS`
   are counted into `gaps` and printed. A silently trimmed bank reads as "that's all there is",
   which is the one thing that must never happen to a readiness answer.

Deep mode is **fail-soft**: every source degrades to a named gap, and the route catches
`deepGroundingFor` wholesale. A deep turn that says "I couldn't open your notes" beats a 500.

### 🔴 The VOICE path silently dropped coach mode, actions and deep mode

Fixed 2026-08-10, and worth knowing because the shape recurs. There are two send paths in
`public/app.js` — `streamAssistantAnswer` (typed) and `sendAssistantBlocking` (voice, and anything
that needs the whole reply at once). The server's blocking route reads `coach`, `actions`,
`hostFrame` and `deep` exactly like the streaming one, but the **client only ever sent them on the
streaming path**. So every spoken turn ran ungrounded, and it hit Sentinel's Coach hardest, where
`coachOn()` is unconditionally true and the spoken reply was the one ignoring it.

**Adding a flag to the assistant means adding it in THREE places** — the two client send bodies and
the server route pair. Grep for `hostFrame:` in `public/app.js`; both call sites must appear.

### 🔴 "Coach" and "the study assistant" are ONE widget — don't build a second one

Reaffirmed 2026-08-10, after the question "do we need both?" was asked. Three things wear the name
and none of them is a separate assistant:

| Name | What it is |
|---|---|
| **Coach FAB** | Sentinel frames THIS app at `?embed=assistant`; CSS hides every body child except `#assistantPanel` and `openAssistantFull()` fills the frame. The panel, streaming, voice, pause-and-steer and history all come for free — that comment in `public/app.js` is the design |
| **Coach mode** | a toggle on that same panel → `coach:true` → `assistantCoachBlock` (progress digest + "Suggested path to drill this") + forced catalog/transcript grounding + a widened mentor search |
| **Study assistant** | `#assistantPanel` — what the other two are made of |

One route pair, one persona, one `assistantChats` store. **Deleting "the study assistant" would
delete what Coach renders.** (Sentinel calls the whole thing the **AI Assistant** since 2026-09-02 —
its FAB/header and this app's embed-mode header both say so; the widget, wire formats
(`agora-coach-action*`) and store are unchanged. The assistant now also carries SENTINEL ops in
`assistantActionBlock` — `assistantSentinelOps`, host-frame only — which Sentinel's `app.js`
executes in the user's session on Approve, and Sentinel self-knowledge via `sentinelGuideBlock`.) The holistic profile, growth journal, task board and mentor
transcripts ground *every* turn regardless of which door was used.

The two doors are not interchangeable in one direction only, and it is the important one:

- **Only the in-app panel can see the screen.** `assistantContext()` reads live `state` — the
  current question and the learner's answer, the flashcard, the open visual's active tab, the last
  five results. The Coach frame is a *sibling* iframe of the engine, not the engine, so it reports
  a blank `{view:'setup'}`. "Explain this question" / "teach me visual 2" cannot work there, in
  text or in voice.
- **Profile-edit proposals are NOT the difference.** They are gated on `hostFrame` — true in every
  Sentinel embed. (`?actions=1` looked like the gate and never was; removed 2026-08-10.)

So Sentinel suppresses its Coach FAB on pages that already embed the engine (`ENGINE_PAGES` in its
`app.js`) — before that, both buttons rendered in the same corner, `#assistantDock` at `right:20px`
under the Coach pill at `right:24px`. And `coachOn()` returns true unconditionally in the
`?embed=assistant` frame, because a screen-blind door with coach mode off adds nothing at all.

🔴 **The panel is the ONLY assistant outside Sentinel** — a standalone tab, and
`mastery-engine-local`, which has no Sentinel by design. Never gate it on being embedded.

### 🔴 There is ONE study guide per section, and it is called "Lesson"

Merged 2026-08-10. Review and Lesson were the same prompt apart from whether the prerequisite
graph was named — but they cached separately, so every section could hold **two** guides and
**two** generated visual pages, and the learner had to choose between them *before reading
either*. `generateReview` is gone; [`generateLesson`](lib/gemini.js) is the only guide generator.
Four things about the merge are load-bearing:

1. **It teaches the section IN FULL and names what it builds on.** The old Lesson prompt said
   "do NOT re-explain [prerequisites] from scratch", which produced a thin delta — and then thin
   VISUALS, because the guide is the only source the visual generator gets. The merged prompt
   connects to prereqs by name in a clause and then teaches the material anyway. Do not
   "optimise" that back into a delta.
2. **`kind` is pinned to `GUIDE_KIND = 'lesson'`** in `guideScope` ([server.js](server.js)), so
   both routes and the visual scope collapse onto one cache key. Guides banked under the old
   `'review'` key (110 of them, plus 3 visual pages) are orphaned and cost only storage.
   `/api/review` survives as a **deprecated alias to the same handler** — a browser holding the
   pre-merge `app.js` must not bank a rival document.
3. **The guide is GROUNDED on the authored lesson document when one exists.** `scopeSourceText`
   pulls the scope's `transcripts` (lesson grain, so a sub-lesson inherits its lesson's doc) via
   `getScopeTranscripts` — equality-only filters, verified against prod as needing no composite
   index, and fail-soft to `''`. Before this, both prompts re-derived the lesson from its own
   quiz questions while 934k chars of hand-authored `doc.md` sat unread in Firestore. Whole or
   absent, never truncated (same rule as the growth journal). `studyGuides.grounded` records
   which kind of build is cached; the bulk pre-build reports the split.
4. **`lessonInputs()` is the one input builder** — both guide routes, the visual guide's
   cold-cache path and the admin bulk pre-build all go through it, so a guide is identical
   however it was triggered. Those four had drifted into three different input shapes.

Measured on prod at the merge: **1,189 of 1,229 topics carry prereq links** (avg 2.8 each), so
prereq-awareness is the normal case, not the exception. Grounding is patchier — **190 of 342
lesson-grain scopes** have a transcript, 82 of them `claude-authored`, and the split is lopsided:
`ai_engineering` 82/82, `digital_marketing` 70/110, **`data_science` 9/121**. A guide with no
source still builds from topics + questions exactly as before, so this degrades, never fails.
(18 transcript scope-keys match no topic scope at all — course/lesson renamed since the paste;
those are silently unreachable and worth a sweep some day.)

### 🔴 Some guides and visual pages are HAND-WRITTEN — `locked: true` protects them

Added 2026-08-10 with DE 202. `content-build/` already authored the source material (`doc.md` →
transcripts, questions, cards); it now also authors the two learner-facing artifacts —
`guide.md` → `studyGuides` and `visual.html` + `visual.json` → `visualGuides` — published by
[`content-build/assemble-guides.js`](content-build/assemble-guides.js) (dry-run by default,
`--apply` to write). Four things are load-bearing:

1. **`locked: true` is written on both docs, and the routes refuse over it.** `streamStudyGuide`
   409s on a refresh and `/api/visualize` 409s on any regenerate — including a single-panel edit,
   which would otherwise splice model output into an authored page and leave it looking hand-made.
   `LOCKED_MESSAGE` is the sentence; the client turns it into a confirm and retries with
   `force: true`. A forced rebuild clears the flag, because what is cached afterwards genuinely is
   model output. The engine tag reads **✍️ Written by hand** instead of naming a model.
2. **🔴 THE GUIDE IS WRITTEN FIRST, ALWAYS.** `freshVisualGuide()` treats a visual older than its
   study guide as a cache MISS. Write them the other way round and every hand-made page reads as
   stale and is silently replaced by a model on the first click. The assembler enforces the order
   and re-reads both docs afterwards to prove it.
3. **The assembler validates with the server's own parsers**, not with its own: `visualGuideLooksComplete`,
   `splitVisualPanels`, `visualPanelIndex`, `canSwapVisualPanel`. So a hand-made page is held to
   exactly the standard a generated one is — including that **every panel must be individually
   editable**, which is most of the value of making it by hand.
4. **There is no undo inside the app.** The repo copy is the only original. That is the whole
   reason for the confirm, and why `assemble-guides.js` is re-runnable: it republishes from
   `content-build/` at any time.

### 🔴 The Visualize button serves MODEL-AUTHORED HTML — never into this origin

Added 2026-08-10. The Lesson guide becomes ONE self-contained interactive page
(`generateVisualGuide` in [lib/gemini.js](lib/gemini.js)), cached in `visualGuides` and framed by
the learner. **Two doors reach it**: `✨ Visuals` in the progress tree's Learn menu (straight in,
no lesson to read first) and `✨ Visualize this` inside the guide modal. Both call
`showVisualGuide()` and produce the same cached artifact — `/api/visualize` writes the study guide
itself on a cold cache, so the standalone door is never the lesser one.

**The generator is graph-aware**: `prereqs`/`dependents` reach it from the same `lessonInputs()`
the written guide used, and when prereqs exist **visual 1 must be the bridge** — familiar ground
on one side, this section on the other, connection drawn. Conditional on purpose: with no prereqs
on record a "what you already know" panel would be invented. Four things are load-bearing:

1. **It is served from its own route into a sandboxed iframe, never through `innerHTML`.**
   `GET /api/visuals/:id/html` sends `CSP: sandbox allow-scripts; default-src 'none';
   script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:` — the sandbox
   *without* `allow-same-origin` puts the page in an OPAQUE ORIGIN: no cookies, no storage, no
   credentialed `/api` calls, no reach into our DOM. `srcdoc` and `blob:` were both rejected
   because they INHERIT the embedder's CSP, and this app's CSP is `frame-ancestors`-only — i.e.
   it imposes nothing — which would leave the iframe's `sandbox=` attribute as the single point
   of failure. **Never add `allow-same-origin`**, and never narrow that route's
   `frame-ancestors` to `'self'`: the real chain is Sentinel → this app → the artifact, so it
   must reuse `FRAME_ANCESTORS`.
2. **The APP's own CSP now also sends `frame-src 'self'`** ([server.js](server.js), the middleware
   under `FRAME_ANCESTORS`), and that is not decoration. **No policy a document sends can stop that
   document navigating ITSELF** — not `default-src 'none'`, not `form-action`, not the sandbox. So a
   poisoned page could `location.href` (or `<meta http-equiv=refresh>`) out to an attacker's page and
   keep rendering inside our chrome, with the real address bar, still passing the parent's
   `e.source` check. Only the EMBEDDER's `frame-src` governs a nested context's navigations, and it
   covers redirects. Safe at `'self'` because the viewer is the only `<iframe>` in the frontend and
   nothing creates one dynamically — video lessons are plain `target="_blank"` links. **If you ever
   add a legitimate third-party embed, widen `frame-src`; do not delete it.**
3. **The tab state is REPORTED UP, not read.** Being opaque-origin, nothing outside the frame can
   look in. `renderVisualArtifact` injects a runtime that posts
   `{type:'agora-viz-tab', index, name, tabs}` to the parent; `public/app.js` accepts it only when
   `e.source === vizFrame.contentWindow` (origin is `"null"` and useless here). That, plus the
   generator's own plain-text index, is the entire basis for the assistant knowing what is on
   screen — which is what makes "teach me visual 2" work, including in voice mode.
4. **The runtime toggles `[data-viz-hidden]`, never inline `display`.** Generated pages routinely
   ship their own tab script too, and the common shape is `.viz-panel{display:none}` in their CSS
   with `style.display='block'` from their JS. Clearing inline display resolved the ACTIVE panel
   back to `none` and rendered a blank page. Observed on a real generation. A deferred
   `getComputedStyle` check then forces `display:block` **only** if the panel is still hidden, so
   a page whose own script threw is not a blank screen and a page that wanted flex is not flattened.
5. **A truncated page is never cached.** `complete()` has no `maxOutputTokens` lever, so a long
   artifact can stop mid-document — and that looks like a working page until you reach the tab
   that isn't there. `visualGuideLooksComplete` rejects it and the route 502s with "try
   Regenerate"; caching it would make the failure permanent.

**A visual guide older than its source guide is a cache MISS.** Regenerating the WRITTEN guide
silently invalidates its visuals — they teach the superseded text. `freshVisualGuide()` compares the
two `updatedAt` strings on every read, so both `/api/visualize` and the "Open visuals" label in
`/api/guide/info` agree, and the click rebuilds instead of serving a page that contradicts the guide
on screen.

**Regenerate** (on both the guide and the visuals) takes an OPTIONAL critique. With a note, the
learner's own engine keeps the job — the note is the new input. Blank means "better, but I can't say
why", which is best answered by a **different model**: `nextEngine()` rotates over
`availableProviders(req)`, the same enumeration `/api/models` serves, so a rotation can never
escape the per-user AI policy. Every artifact stores the **resolved** `provider`/`model` — see
below — and the UI prints it.

### 🔴 Regenerate has TWO paths, and the cheap one edits the cached page in place

Added 2026-08-10. `POST /api/visualize` with `regenerate:true` and a **`panels:[…]`** list runs
`patchVisualGuide` instead of `buildVisualGuide`: it regenerates only those panels
(`generateVisualPanel`) and splices each one into the stored document (`replaceVisualPanel`), so
every visual the learner did NOT tick is byte-identical afterwards — not "probably preserved",
untouched. Output drops from a ~90 KB document to a few KB, which is the whole point: fixing
visual 3 used to re-roll the three that were fine. No `panels` = the original whole-page rebuild,
and that stays the default. Five things are load-bearing:

1. **A panel is only swappable if nothing outside it reaches in.** `canSwapVisualPanel` refuses
   when a `<script>` outside the panels names an id inside the target, or selects it by number:
   pulling the markup out from under a shared script makes it throw on the first missing element,
   which kills the visuals it wired *after* that too. Checked before any model call, surfaced as
   `editable:false` per row in `visualPayload`, so the UI greys the checkbox instead of failing
   after the click. The whole-page generator now asks for per-panel `<style>`/`<script>` with
   `v<N>-` prefixes, so a rebuild is what makes an old page editable — which is exactly what the
   refusal tells the learner to do.
2. **The patch path NEVER writes a study guide.** `visualSourceInputs` generates a missing one;
   doing that here would stamp `studyGuides.updatedAt` newer than the page being patched, and
   `freshVisualGuide` reads precisely that as stale — discarding the page, and the edit, on the
   next open. No cached guide ⇒ 409 "rebuild the whole page". Same for a guide that moved on.
3. **Balance is the completeness test.** `splitVisualPanels` only ever returns an element whose
   closing tag it actually found (depth-counted — panels nest), and `parseVisualPanel` returns
   null rather than an unbalanced fragment. Same posture as `visualGuideLooksComplete`, which
   still runs on the spliced result: a truncated fragment would corrupt a page that was fine.
4. **The panel number is OURS.** A fragment that comes back renumbered is re-stamped
   (`forcePanelKey`), or the page ends up with two visual 3s and a tab pointing at neither. The
   tab button is re-labelled with it (`setVisualTabLabel`) — the runtime reads button text and
   posts it up, so a renamed visual with a stale tab has the assistant teaching a name that is
   not on screen.
5. **Caps are refused, not trimmed.** `MAX_PATCH_PANELS` (3) 400s rather than silently rewriting
   3 of 4 ticked; past that a rebuild is cheaper and keeps the visuals reading as one lesson.
   `patched` is written on EVERY save (empty on a rebuild) so the viewer's tag can say which
   visuals the named engine actually wrote — after a patch the page has two authors.

All the scanning/splicing is pure and lives in `lib/gemini.js`; `lib/_visual_test.js` covers it.

### 🔴 Record the RESOLVED engine, never `aiChoice(req)`

Added 2026-08-10. `aiChoice(req)` is the REQUEST. `clampToPolicy()` ([lib/gemini.js](lib/gemini.js))
can downgrade a provider the user's allowlist forbids, and when it does it clears `model` — so what
actually ran is the adapter's own `DEFAULT_MODEL`, which the caller never sees. Pass a `meta`
object through the `ai` bag instead:

```js
const meta = {};
await generateVisualGuide(input, { ...aiChoice(req), meta });
// meta.provider / meta.model are now the pair that RAN
```

`complete()` and `completeStream()` fill it synchronously right after the clamp (`fillEngineMeta`),
so concurrent calls under `mapWithConcurrency`/`Promise.all` cannot cross-write — each gets its own
object. Two older provenance writes (`lib/genjobs.js`, the roadmap save) still record the pre-clamp
request and are wrong under a downgrade; use `meta` for anything new.

### 🟡 A new colour looks wrong in dark mode

Added 2026-08-03. There is one palette and it lives in `public/styles.css`: `:root` (light) and
`:root[data-theme="dark"]` retuning **the same token names**. Put a new colour there, not in a
`[data-theme="dark"] .something` rule — the ~180 literals that used to be scattered through the
file are exactly what made a dark theme a day of work instead of an hour.

🔴 **A tint that COMPOUNDS is the worst kind of literal.** `.prog-children` carried
`rgba(238, 241, 236, 0.4)` and nests inside itself, so a level-3 topic row wore three coats: on
the dark card that resolved to `#bfc4bf` — a near-white slab under `--ink` text, **1.5:1**, which
is the "hard to read in dark mode" the tree shipped with. It is `--tint-nested` now (`0.4` of the
sunken tint in light, `0.04` white in dark → 9.85:1 at level 3). Fixed 2026-08-10, along with
dark `--faint`, which carries every row's second line and read at 2.6:1 there.

Three things that are NOT arbitrary:

- **`--x-deep` tokens exist because a fill that carries white text cannot lighten.** `--green-dark`
  and `--violet` are overwhelmingly *text* colours, so in dark mode they have to go light to stay
  readable on the canvas — which would leave `.btn-primary`'s white label on a pale green slab.
  The handful of rules after the token block re-fill those with `--green-deep` / `--violet-deep`.
- **A `<canvas>` cannot resolve CSS custom properties.** The knowledge graph therefore keeps its
  own two-entry `GRAPH_INK` map in `app.js`, read per draw off the live `data-theme` attribute
  (an attribute lookup, not a style recalc) so flipping the theme repaints without a reload.

**Where the theme comes from** ([public/theme.js](public/theme.js), precedence order): `?theme=`
on this document's URL → the learner's own toggle (`localStorage`) → the OS preference. Sentinel
appends `&theme=` to every iframe src it builds and postMessages `{type:'agora-theme'}` when its
own toggle moves, so the embedded engine wears the host's skin and changes with it. Unlike
`?program=` / `?embed=assistant`, the theme IS safe in `sessionStorage`: every frame on a Sentinel
page is handed the same value, so there is no per-frame value to leak across same-origin iframes.

**The Composing Room is deliberately light-only.** `academy-admin.html` carries its own design
system (`--pine`/`--paper`/`--surface`, inline) and does not load `theme.js`; loading it there
would half-darken the page. Theming it is a separate piece of work.

### 🟡 "Add to Watcher" fails locally but reading the archive works

The two halves of [lib/watcher.js](lib/watcher.js) use **different transports, deliberately**.
Reading is a direct GCS read of Atrium's archive objects (needs `storage.objectViewer`). **Adding a
source is never a bucket write** — scraping YouTube/a blog, minting the registry entry, AI-labelling
the industry and the audit trail all belong to Atrium, so `addSource`/`fetchBodies` POST to its
HMAC-gated `POST /api/internal/watcher/add` (purpose `watcher-add`, shared `SSO_SECRET`, `ATRIUM_URL`
defaults to `https://portal.agoradatadriven.com`). So: **no `SSO_SECRET` ⇒ adding fails while
browsing still works**, which is exactly the local-dev picture. Same posture as `lib/sentinel.js`.

Unlike the read helpers, these **throw** — the admin explicitly asked for the action, so a silent
degrade would leave them looking at a source that was never created. Server routes
`POST /api/admin/watcher/{add,fetch}` return Atrium's own sentence as a 400.
`add`/`add_site` register the listing ONLY; the browser then loops `/fetch` until `remaining` is 0
(one batch per call, exactly like Atrium's tab) — `blocked: true` means YouTube rate-limited Atrium
and **nothing was marked failed**, so a later run resumes over the same missing set.

### 🔴 Spoken replies have THREE engines, and only the default is free

Added 2026-08-10. The assistant speaks through one entry point in `public/app.js` —
`ttsSpeak()` / `ttsCancel()` — shared by conversation mode, Speaker Mode's read-aloud and the
settings preview. The learner picks the engine in the assistant settings (⚙ → Voice):

| Engine | Where it runs | Cost |
|---|---|---|
| **Browser voice** (default) | `window.speechSynthesis`, never touches the network | free, works offline |
| **Chirp 3 HD** | `POST /api/tts` → [lib/tts.js](lib/tts.js) | ~$30 / 1M characters |
| **Gemini Flash TTS** | same route, `voice.model_name` carries the model | text input tokens + ~$10 / 1M audio-output tokens @ 25 tok/sec |

Both cloud engines hit the SAME endpoint (`texttospeech.googleapis.com/v1/text:synthesize`,
already enabled on the project), record spend through `lib/usage.js`, and use the same auth and response shape — they differ
only in whether a `model_name` rides along. Keep that symmetry when adding a third.

Four things are load-bearing:

1. **A cloud failure falls back to the BROWSER voice, never to silence.** `cloudSpeak()` catches
   everything — quota, a bad voice name, a blocked autoplay, an offline laptop — speaks the same
   text with `speechSynthesis` instead, and posts the reason into the chat log ONCE per session.
   A voice mode that says nothing reads as broken; a worse voice does not.
2. **`ttsSeq` is what makes barge-in correct.** A cloud reply is *fetched* while the phase is
   still `'thinking'`, so aborting the generation alone would let a barged-over answer start
   talking a second later. Every speak and every cancel bumps the counter; a stale async
   continuation does nothing. This is also why `abortGeneration()` now calls `ttsCancel()`.
2b. **Replies are spoken in CHUNKS, and that is not an optimisation — it is the feature.**
   Synthesis latency is roughly linear in characters. Measured on prod 2026-08-10:

   | Engine | 34 chars | 657 chars |
   |---|---|---|
   | Chirp 3 HD | 854 ms | **8.0 s** |
   | Gemini Flash TTS | 3.6 s | **20.9 s** |

   ≈ Chirp `460ms + 11.5ms/char`, Gemini `2.6s + 28ms/char`. Shipped as one clip, a long answer
   was 8–21 seconds of silence with the full text already on screen — reported as "it's not
   talking back". `speechChunks()` splits at SENTENCE boundaries (~90 chars for the first, ~260
   after) and keeps exactly one chunk synthesizing ahead of the one playing, so only the first
   wait is ever heard. **Never split mid-sentence** — every MP3 join carries encoder padding,
   which reads as a breath at a full stop and a stutter mid-clause.

   🔴 **Gemini Flash TTS has a ~2.6s fixed floor**, so it is the wrong engine for conversation
   mode however cheap it is. Chirp is the conversational one. The picker notes say so.
2c. **Hearing it AGAIN is free — that is the whole design of `ttsCache`** (added 2026-08-11).
   Every synthesized chunk is kept in memory keyed `engine|voice|text`, and `speakChunk()` is the
   cached front door `cloudSpeak` fetches through. Mishearing a word is the ordinary case in voice
   mode and the expensive recovery is the obvious one: asking again regenerates the answer with the
   model *and* re-synthesizes it, to say the same thing. So a spoken reply's bubble carries a
   **↻ Replay** (`addReplayButton` → `replaySpeech`), and Speaker Mode's 🔊 toggle is its own replay.
   - **The key includes the engine and the voice.** The same sentence in Chirp and in Gemini is
     different audio; keying on text alone replays the voice you just switched away from.
   - **Cache the Blob, never an object URL.** `playTtsBlob` revokes its URL after every play, so a
     cached URL replays as an instant error. The Blob outlives the revoke.
   - **Bounded by BYTES** (8 MB), evicted least-recently-*used* — a dozen chunks of one long answer
     is several MB, so an entry-counted cache holds it forever.
   - 🔴 **Replay goes back through `speakAssistantReply` while conversation mode is on**, not
     straight to `ttsSpeak`: the echo guard tests what the recognizer hears against `convo.spoken`,
     so audio played outside that dance is heard by our own mic as the learner talking and fires a
     turn at the assistant. And it is added **only to bubbles this session actually spoke** — on a
     bubble restored from history the audio was never made, so the button would silently be a paid
     first read, which is the exact thing it exists to avoid.
3. **The cost lever is the 1-to-3-sentence rule** in `styleRule` ([lib/gemini.js](lib/gemini.js)).
   A spoken reply is ~250 chars / ~15 seconds ≈ 0.75c (Chirp) or 0.4c (Gemini) per turn. Loosen
   that instruction and this bill scales with it. `MAX_TTS_CHARS` (5,000) is the backstop.
4. **`mastery-engine-local` must keep working.** `GET /api/tts/voices` failing leaves ONLY the
   free browser voice in the picker, which is the correct answer both offline and in the mirror.

🔴 **Local dev cannot call this API without an IAM grant.** A *user* credential (ADC or
`gcloud auth print-access-token`) needs a quota project, and using one needs
`roles/serviceusage.serviceUsageConsumer` on `agora-data-driven`. Without it every synthesize
returns **403 "requires a quota project"** — which is a permissions failure, NOT a bad request,
so it tells you nothing about whether your body was right. Grant once per operator:

```powershell
gcloud projects add-iam-policy-binding agora-data-driven `
  --member="user:info@agoradatadriven.com" --role="roles/serviceusage.serviceUsageConsumer"
gcloud auth application-default set-quota-project agora-data-driven
```

✅ **Production needs no such grant** — verified on revision `mastery-engine-00210-q8w`
(2026-08-10): all 8 voices × both engines returned `200 audio/mpeg`. The Cloud Run runtime SA
(`585951669065-compute@developer.gserviceaccount.com`) resolves its own project for quota, so
the `serviceUsageConsumer` requirement is a **local-user-credential problem only**. Don't go
hunting for a missing role when local dev 403s — the deployed service is fine.

### 🟡 Microphone dead when embedded in Sentinel

The iframe needs `allow="microphone"` **and** Sentinel's own `Permissions-Policy` header must
delegate to this origin. An empty `microphone=()` blocks delegation even with the `allow`
attribute set. Both sides must agree.

### 🟡 Truncated AI output

`maxOutputTokens` too low — thinking tokens count against output. Symptom is a response that
stops mid-sentence or mid-JSON.

---

### 🔴 Generated questions repeat across a lesson's sub-lessons (fixed 2026-09-08)

**Symptom:** a lesson's topics all ask the same thing. Measured on the RAG bank before
the fix: one worked example appeared in **all five topics** of "Keyword Search: TF-IDF";
"The Retriever and Information Retrieval" had 18 questions covering 6 ideas; four
different precision/recall calculations all answered "60%".

**Cause — three things compounding, and the third is the one that matters.** Generation
runs per TOPIC ([lib/genjobs.js](lib/genjobs.js) `stepGenJob`), but a transcript is filed
per LESSON, so `getTranscripts({…, topic})` finds nothing topic-specific and falls back to
the lesson's material: every topic is handed the identical source and told GROUNDING IS
ABSOLUTE. And `existing` was `getQuestionsForTopics([topic])` — **that one topic** — as was
the `dedupeKey` set. Five siblings mining one narrative, each blind to the other four.

**Fix, in four parts. The prompt-side two are what actually prevent it:**

| Part | Where |
|---|---|
| `siblingTopicsBlock` names the sibling sub-lessons as *covered separately, do not test* | [lib/gemini.js](lib/gemini.js) |
| The avoid-list spans the whole LESSON (own topic first), cap 60 → 80 | `avoidBlock` |
| `isNearDuplicate` — content-word Jaccard ≥ **0.6** over question + answer | [lib/genjobs.js](lib/genjobs.js) |
| `getLessonTopicNames` — equality-only, so no composite index and no catalog read | [lib/firestore.js](lib/firestore.js) |

🔴 **The overlap check is a backstop, not the fix.** `dedupeKey` only ever caught a verbatim
re-emission; the collisions were REWORDINGS (same proposition, different company; same
worked example, different numbers), which is why the bank looked deduped and wasn't. 0.6 is
deliberately high — below ~0.5 genuinely different questions on one narrow topic collide,
because they share its vocabulary by necessity. Dropped candidates are counted onto
`progress.duplicatesDropped` so a bad run is visible rather than just short.

**`/api/generate` had the same blindness plus no dedupe at all** — it banked whatever came
back, so a re-run re-added questions the learner already had, and its 4-way `mapWithConcurrency`
fan-out meant four topics generated in one request could not see each other. It now reads the
whole selection's bank once (one query, not N) and shares one key/overlap set across the
concurrent calls, mutated *before* the `await addQuestion`.

### 🔴 A reading program's sub-lessons must be CLAIMS, not labels (fixed 2026-09-08)

**Symptom:** the Philosophy program's book decks taught nothing on the front. The title card
asks the reader to name and explain every key point from memory, and the list it showed was
*"1. Myth of innate talent · 2. Experience versus improvement · 3. Limits of IQ as a
predictor…"* — six labels that only mean something to someone who has already learnt the
book. Same on every point card, where the name IS the whole front.

**Cause:** every planner asked for *"a short noun phrase"*, which is the right ask for a
CONCEPT program and the wrong one for a READING program. "Frequency capping" is the standard
name of a thing that exists and is what a practitioner would search for; turning it into a
sentence would assert one claim about a topic that has many. But a book's sub-lesson is one of
its **key points**, and a key point is an argument: *"Innate talent is a myth: the future stars
showed no early edge"* carries the insight, *"Myth of innate talent"* only points at it.

**Fix:** `topicNameRule(reading)` in [lib/gemini.js](lib/gemini.js) — one constant per kind,
interpolated by every planner that names a sub-lesson (`classifyTranscript`, `digestSource`,
`planFromSources`, `planCurriculum`, `planCurriculumEdit`). `reading` comes from
`isReadingProgram(program)` in [server.js](server.js) — category `'growth'`, the **same switch**
that puts a lesson into book-deck shape, so a program cannot get book cards and concept names.
Every caller that omits the flag keeps the concept rule byte-for-byte, so no career program
moved. [`lib/_naming_test.js`](lib/_naming_test.js) asserts both rules and that no planner
still hardcodes one.

The 28 sub-lessons that shipped before this were rewritten by
[scripts/rename-philosophy-points.mjs](scripts/rename-philosophy-points.mjs) (a dry run by
default; the names it applies are in `scripts/philosophy-points.json`).

🔴 **Do not "improve" this by making every program's names sentences.** The split is the point,
and it is the same category flag the deck shape already uses.

### 🔴 A reading program's SHAPE is a shelf, not a concept map (fixed 2026-09-09)

The naming fix above settled what a sub-lesson is *called*. This is the other half — where the
**book sits** — and it is the one that silently disabled a feature.

**Symptom:** *The Charisma Myth* and *Do Hard Things* had no book deck and could never get one.
All three Spiritual courses were named half-book, half-theme.

**Cause:** Philosophy was running two shapes at once, from its two authoring doors:

| Door | What it produced |
|---|---|
| auto-file ingest (`classifyTranscript`) | course = theme, **lesson = the book** ✅ |
| the corpus planner (`planFromSources`) | **course = the book**, lessons = concept clusters ❌ |

The planner is not misbehaving — its strongest instruction is *"the sources are MATERIAL, not the
STRUCTURE … NEVER name a track, course, lesson or topic after a source"*, which is exactly right
for a career curriculum and exactly backwards for a shelf, where the source **is** the unit of
study. And the second shape is not a style difference: `buildBookDeck` refuses anything but
`scope.level === 'lesson'` (*"the lesson is the book"*), so a book filed as a course cannot
produce the title card the whole reading program exists for.

**The rule, now enforced by `scopeShapeRule(reading)` ([lib/gemini.js](lib/gemini.js)):**

> **COURSE** is always a THEME · **LESSON** is always one BOOK — or one PART of a long book,
> named with the book (`The Charisma Myth — Presence`) · **SUB-LESSON** is one key point, as a
> claim. 4–8 points per lesson, because that is one recall card's worth.

🔴 **It is injected AFTER the rule it overrides**, never before — a model reading top-to-bottom
has to meet the exception after the general case. Same discipline as `deepBlock` (§7), and
[`lib/_naming_test.js`](lib/_naming_test.js) asserts the ordering: moving the interpolation
earlier still passes `node --check` and silently restores the bug. It returns `''` for a career
program, so those prompts are byte-identical.

**Why not just drop the course level and go Track → Book?** Two reasons, both hard.
`upsertTopic` requires all four of track/course/lesson/topic — course and lesson are *fields*,
not documents, so an empty course is not expressible without forking the model away from the six
career programs. And the course is the only place a THEME lives: it is the scope behind "quiz me
across all my Stoicism books", and what keeps a track browsable once it holds thirty books.

The 88 sub-lessons, 14 lessons and 2 courses that shipped the other way were repaired by
[scripts/reshape-growth-books.mjs](scripts/reshape-growth-books.mjs) (dry run by default; names in
`scripts/growth-books.json`), and the decks that had never been buildable by
[scripts/build-book-decks.mjs](scripts/build-book-decks.mjs).

### 🔴 The Academy's question prompts were hardcoded to "a working digital marketer"

Fixed 2026-09-08, same pass. All three Academy generators opened *"building an assessment
for a working digital marketer"* and illustrated their rules with ad campaigns — correct when
the Academy WAS the marketing bank, and quietly wrong from the moment it also hosted
`ai_engineering` (its Data Engineering and Information Retrieval tracks) and the
`retrieval_augmented_generation_rag` program. Every one of those questions was
authored for a marketer, which is why so many open "A digital marketer searches a content
library…".

Audience is a property of the PROGRAM, so it lives in `audienceFor(programId, stored)`
([lib/programs.js](lib/programs.js) — pure, IO-free, tested). A program doc's own `audience`
field wins if set, then a per-program map, then a neutral fallback that names no profession.
`stepGenJob` resolves it from `job.program`, so **no createGenJob call site changed**.

🔴 **Keep the shared rules subject-neutral.** The illustrative examples inside them are
in-context few-shot whether you meant them that way or not: a rule that says *"not 'what does
the source recommend for frequency control?' but 'when running an omnipresent content
campaign…'"* pulls every scenario toward marketing no matter what the audience line says.

### 🔴 Dictation on a phone filled the box with "whatwhat arewhat are my goals…" (2026-09-05)

**Symptom:** the 🎤 in Sentinel's Coach (this app's assistant in a frame) — and any other mic here —
produced stuttering, self-repeating text on Android Chrome / iOS Safari while desktop Chrome was fine.

**Cause:** the `onresult` handlers concatenated every entry of `e.results`. Desktop Chrome hands
back SEGMENTS (each entry is new speech), so that was right there. Mobile browsers hand back
SNAPSHOTS — every entry repeats the whole utterance so far ("what", "what are", "what are my"…) —
and Android re-delivers a final result it already sent. Nothing on the event says which shape it is.

**Fix:** `joinTranscript(results)` in [public/app.js](public/app.js) (next to `dictateInto`) merges by
content — an entry that begins with what is already assembled REPLACES it, an interim that keeps the
first word and is no shorter is a revised snapshot and also replaces, anything else appends, and a
final that only repeats the banked tail is dropped. **Every recognizer in this file goes through it**
(dictation and conversation mode). `dictateInto` also restarts the recognizer on `onend` while the
mic is still toggled on and the last session heard something — "continuous" is a request Android
ignores at the first pause and desktop Chrome after ~a minute — and stops for real on a silent
session, a fatal error (`not-allowed`, `audio-capture`, `network`) or the learner's own tap.

## 8. Never do this

| ❌ | Why |
|---|---|
| `gcloud config set project/account` | Two VS Code windows share one global gcloud config. Breaks the other one. |
| Add a route after `app.get('*')` ([server.js:5627](server.js#L5627)) | Unreachable — the SPA catch-all swallows it. |
| Key stats/progress by `slug(fields)` | Moved topics keep their doc id. Guaranteed silent data bug. |
| Use `requestScope(req)` in a route that starts from a card | The shelf mixes programs. Use `cardScope(req, card)` — see §7. |
| Branch on the legacy owner outside `statsCol`/`logCol` | That's how the phantom-doc bugs happened. |
| Call a provider SDK from `server.js` | All AI goes through `complete()`/`completeStream()` in `lib/gemini.js`. |
| Hand-port a change to `mastery-engine-local` | Run `npm run port` there. See §9. |
| Commit real secrets | Everything comes from Secret Manager via `--set-secrets`. |
| Deploy without `node --check` | A syntax error crash-loops and silently keeps the old revision live. |
| Edit lines with NUL bytes using `Edit` | It cannot match. Use a Node script. |
| Ground a lesson's topics on one transcript with no sibling context | Every topic mines the same passage — `siblingTopicsBlock` + a lesson-wide avoid list — §7. |
| Hardcode WHO a question is for into a prompt | Audience is a property of the program: `audienceFor` — §7. |
| Bank generated questions without a dedupe gate | `dedupeKey` **and** `isNearDuplicate`; the real collisions are rewordings — §7. |
| Concatenate `SpeechRecognition` results yourself | Mobile browsers deliver cumulative snapshots — "whatwhat arewhat are my…". Use `joinTranscript` — §7. |
| Put model-authored HTML through `innerHTML` | Opaque-origin iframe only — see §7. |
| Record `aiChoice(req)` as an artifact's engine | That is the request, not the resolution. Use the `meta` out-param — §7. |
| Swallow the payload in a JSON-parse `catch` | An unexplainable failure gets re-guessed at forever. Use `parseAiJson` — §7. |
| Ask a model to wrap prose in JSON that carries nothing else | The envelope is a dice roll on the prose (a stray `"` kills the turn). Plain text — §7. |
| Put a model's payload through `renderMarkdown`/`innerHTML` in the 🐞 panel | It is untrusted output. `esc()` only. |

---

## 9. Relationship to `mastery-engine-local`

[`../mastery-engine-local`](../mastery-engine-local) runs **this repo's code verbatim** against a
JSON-file shim that stands in for Firestore, so it works offline with local LLMs.

**It is a mirror, not a fork.** Only ~5 files are local-owned (the shim + launcher). Everything
else is copied from here.

> **Never hand-port a change into it.** From that repo run `npm run port`. Hand-porting drifts
> the two apart and silently breaks the mirror.

If you change `server.js`, `lib/*`, or `public/*` here, the local repo needs a re-port to pick it up.

---

## 10. Conventions

- **ES modules** (`"type": "module"`). `import`, not `require`, in app code.
- **2-space indent**, semicolons, single quotes.
- Comments explain **why**, not what. The existing code is unusually well-commented — match that
  density. When you encounter a comment explaining a workaround, do not delete the workaround.
- Frontend is deliberately framework-free. **Do not introduce React/Vue/a bundler.**
- No TypeScript in this repo.
- Firestore writes use `{ merge: true }` unless you specifically intend to replace a document.
- Prefer adding to an existing `lib/` file over creating a new one.
