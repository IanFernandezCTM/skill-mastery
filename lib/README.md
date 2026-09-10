# lib/ — the server's library layer

Every Firestore read/write, every AI prompt and provider call, auth resolution, and the pure
mastery/scoping logic live here — **one file per concern**. `server.js` routes are thin: they
guard, call into `lib/`, and format. Nothing in `lib/` touches Express.

Operating rules + repo-wide gotchas: [../AGENTS.md](../AGENTS.md). Deep API reference:
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## File map

| File | What it is | Greppable anchors |
|---|---|---|
| [firestore.js](firestore.js) | **All database IO** (1.9k lines). Every read/write goes through here. | `COL` `:34` · `LEGACY_OWNER` `:50` · `statsCol()`/`logCol()` `:58`/`:67` · `slug()` `:74` · `moveTopics()` `:279` · `renameTopics()` `:329` · `renameScope()` `:488` · `flashcardScopeId()` `:1743` · `studyGuideId()` `:1866` · `tupleKey()` `:2511` (**NUL lines 2510+2512**) · `buildTopicIdIndex()` `:2536` · `logResults()` `:2560` |
| [gemini.js](gemini.js) | **All AI prompts + provider dispatch** (3.3k lines). Misleading name — fronts every provider. | HOW-IT-WORKS injection `:29` · `META_QUESTION_RE` `:35` · `clampToPolicy()` `:119` (the HARD per-user AI-allowlist gate) · `complete()` `:132` · `completeStream()` `:148` · `parseLooseJson()` `:242` · `restoreLatexEscapes()` `:314` |
| [auth.js](auth.js) | 4 sign-in paths, identity resolvers, guards. | `verifyAgSso()` `:139` · `currentEmail()` `:182` · `effectiveUser()` `:260` · `conversationUser()` `:280` · `requireAuth` `:302` · `requireAdmin` `:309` |
| [priority.js](priority.js) | The **two** scoring formulas. Pure, IO-free. | `computePriority()` (what to study next) · `computeMastery()` (depth: evidence + freshness — three load-bearing properties, see AGENTS.md §3) · `retentionFactor()` · `deriveStats()` |
| [programs.js](programs.js) | Program/course scoping rules. Pure, IO-free. | `DEFAULT_PROGRAM`, `programOf`, `normalizeEnrollment` |
| [graph.js](graph.js) | Knowledge-map prereq edges + warm-up/readiness logic. | `buildPrereqEdges` · `prereqClosure` · `topoSortScope` |
| [deepseek.js](deepseek.js) | DeepSeek adapter. | default `deepseek-v4-flash` `:17`; `thinkingField()` sends `{type:'disabled'}` only on explicit `thinking === false` — server default is thinking ON |
| [kimi.js](kimi.js) | Kimi adapter — Kimi *Code* subscription key. | `api.kimi.com/coding/v1` ONLY; models `k3` (default) / `kimi-for-coding` / `-highspeed` (`listKimiModels()` `:29`) |
| [lmstudio.js](lmstudio.js) | LM Studio adapter (local). | `json_object` → 400 (use `json_schema`/`text`); qwen3 `<think>` suppression — both workarounds load-bearing |
| [anthropic.js](anthropic.js) / [ollama.js](ollama.js) | Remaining adapters, same shape: `callX()` + `streamX()` (+ `listXModels()`). | — |
| [genjobs.js](genjobs.js) | Background question-gen job runner — stepped, resumable, **browser-driven** (a dead tab = "queued forever"). | — |
| [usage.js](usage.js) | Text-token + TTS usage/cost tally per user; its ALS store also carries `req.aiPolicy`. | `recordUsage` |
| [tts.js](tts.js) | Google Cloud Text-to-Speech, the **paid** spoken voices. Both engines share one endpoint + response shape; only `voice.model_name` differs. Returns MP3 BYTES (not a URL) so playback stays on our origin and the CSP needs no `media-src`. **Throws on every failure** — the browser falls back to its free voice. | `TTS_ENGINES` · `ttsCatalog()` · `synthesize()` · `MAX_TTS_CHARS` |
| [googleauth.js](googleauth.js) | Google OAuth flow. | — |
| [sentinel.js](sentinel.js) | Sentinel bridge, all HMAC (`SSO_SECRET`, `SENTINEL_URL`), all null-safe. People roster (admin enrollment UI) · `sentinelUserLookup` (the /api gate) · `holisticProfile` + `growthDetail` (development, small-to-big) · `mentorSearch` · **`workDigest` + `workDetail`** (their TASK BOARD, scoped by Sentinel to what the caller may see). | Purposes must match Sentinel's `internal.py` exactly; `workDetail` ids capped by `WORK_MAX_IDS` in server.js |
| [bigquery.js](bigquery.js) [csv.js](csv.js) [migrate.js](migrate.js) | Import/analytics side-paths (BQ sink, CSV parser, one-time importer). | — |
| [watcher.js](watcher.js) | Atrium's Watcher archive, both ways. `listClients`/`listChannels`/`listVideos`/`getVideo` READ the shared bucket; `addSource`/`fetchBodies` ADD a source by calling Atrium's HMAC bridge (`SSO_SECRET`, `ATRIUM_URL`) — never a bucket write. Reads degrade to a message, writes throw. | — |
| `_auth_test.js` `_graph_test.js` `_programs_test.js` `_progress_credit_test.js` `_priority_test.js` `_visual_test.js` `_deep_test.js` `_usage_test.js` `_aidiag_test.js` | The **nine** unit tests — `node lib\_x_test.js`, exit 0 = pass. | — |

## Data contract — Firestore doc → lib accessor → app.js consumer

| Data | Firestore | lib accessor | `public/app.js` consumer |
|---|---|---|---|
| Topics / catalog | `topics/{docId}` — id ≠ `slug(fields)` after any move | `getCatalog()` firestore.js:163 · `getTopicsRows()` :252 | catalog fetch + cache app.js:1753 (`state.catalog`; full bank :1762) |
| Stats / progress | legacy owner: inline on `topics/{id}`; everyone else: `users/{email}/topicStats/{topicId}` (+ `quizLog`) | `statsCol()`/`logCol()` :56/:65 · write path `logResults()` :1838 via `buildTopicIdIndex()` :1814 | results POST `/api/quiz/log` app.js:2769 · dashboard `loadStats()` :1255 |
| Questions | `questions/{auto}` — keyed by topic NAME, so program filtering is essential. **`answer` must equal one `options` entry exactly** (see ../AGENTS.md §3) | `getQuestionsForTopics()` :289 · `getAllQuestions()` :301 · `addQuestion()` :370 · `bulkUpdateQuestions()` (edits) · `deleteQuestionById()` (single delete + `questionCount` fix) | offline bank cache app.js:173 · `startQuiz()` :2210 · admin editors app.js `saveQuestionEdit()` + academy-admin.js `openQuestionEditor()` |
| Question flags | `questionFlags/{auto}` — learner-written reports, the valve on auto-publishing | `flagQuestion()` · `listQuestionFlags()` · `resolveQuestionFlag()` (delete goes through `deleteQuestionById`) | `submitReport()` app.js · Proof station `loadFlags()` academy-admin.js |
| Flashcards | `flashcards/{flashcardScopeId(...)}` — `highway` is a SHARED field (admin-curated), unlike the per-user labels `users/{email}/flashcardStatus/{cardId}` | `flashcardScopeId()` :1232 · `getFlashcards()` :1240 · `saveFlashcards()` :1279 · `bulkUpdateFlashcards()` (concept/intuition/formula/**highway**) | `openFlashcards()` app.js:2813 · `toggleCardHighway()` |
| Programs / enrollment | `programs/{id}` · `users/{email}/meta/enrollment` · `meta/shelf` | `getPrograms()` :92 · `getEnrollment()` :128 · `resolveProgramScope()` :147 · `getShelf()` :1056 | program pin resolve app.js:842 · shelf fetch :1946 |

## Cookbook

1. **Add an AI feature** — prompt lives HERE, in `gemini.js`: export a function that builds the
   prompt and returns `complete(prompt, { json, schema, ...ai })` (or `completeStream` +
   `onToken`). The route passes `aiChoice(req)` through as `...ai`. Never call a provider SDK
   from `server.js`. Verify + deploy: step 8.
1b. **Ground a prompt on what is already written** — before inventing an input, check whether the
   scope already has an authoritative document. `generateLesson`'s `source` comes from
   `getScopeTranscripts()` (lesson grain, equality-only filters, no composite index) via
   `scopeSourceText` in server.js. Both study-guide prompts spent a year re-deriving lessons from
   their own quiz questions while 934k chars of hand-authored `doc.md` sat unread — AGENTS.md §7.
1c. **Parse a model's JSON** — `parseAiJson(label, raw, { meta, route })`, never a bare
   `try { parseLooseJson } catch { throw new Error('… non-JSON content') }`: the bare form drops
   the payload, which is why "it fails sometimes, then works on a re-send" went unexplained for
   months. And **ask for an envelope only when it carries something** — the assistant's spoken
   path returns plain text because a voice reply has no `visual` to wrap, while the typed path
   keeps the envelope and SALVAGES (`salvageJsonString`) rather than failing. AGENTS.md §7.
2. **Build a cached AI ARTIFACT (not prose)** — the visual guide is the pattern:
   `generateVisualGuide()` here emits a fenced index + a self-contained HTML page,
   `parseVisualGuide()` splits them tolerantly, `visualGuideLooksComplete()` refuses to let a
   truncated page reach the cache, and `saveVisualGuide()` (firestore.js) rejects an oversized
   one instead of failing inside a fire-and-forget `.catch`. Record the engine with the `meta`
   out-param (`{ ...ai, meta }`), never `aiChoice(req)` — AGENTS.md §7.
3. **Let the learner repair PART of an artifact** — the panel-edit path, also here:
   `splitVisualPanels()` / `visualPanelIndex()` scan the cached page, `canSwapVisualPanel()`
   decides whether one piece can be replaced at all (it refuses when a shared script reaches
   into it), `generateVisualPanel()` regenerates just that piece with the CURRENT one in the
   prompt, and `parseVisualPanel()` + `replaceVisualPanel()` + `replaceOutlineLine()` splice it
   back. Everything not named stays byte-identical. All pure and covered by
   [`_visual_test.js`](_visual_test.js) — AGENTS.md §7.
4. **Add a provider model** — extend the adapter's `listXModels()`; `/api/models`
   (server.js:794) picks it up; `clampToPolicy()` (gemini.js:119) still gates who may use it.
5. **Add a Firestore accessor** — in `firestore.js`, next to its collection's siblings. Per-user
   data goes through `statsCol()`/`logCol()`; never branch on `LEGACY_OWNER` yourself, never
   key anything by `slug(fields)` (use `buildTopicIdIndex()`).
6. **Change the curriculum** — `runCurriculumEdits()` (server.js:4001) → `moveTopics()`
   (firestore.js:227) to RE-FILE, `renameTopics()` (firestore.js:302) to RENAME a sub-lesson.
   Both preserve doc ids, and therefore learner stats. `renameTopics` additionally re-keys the
   four things keyed by the NAME — banked questions, deck cards, a topic deck's `scopeId`, a
   topic guide's doc id — which `moveTopics` does not: renaming through it empties the
   sub-lesson silently. `renameScope()` (firestore.js:488) is the same job one grain UP — a
   course/lesson name keys its SOURCE TRANSCRIPT, its decks and its guides, so renaming a lesson
   with `moveTopics` strips it of the book it teaches from. Never raw Firestore writes for
   moves/renames. See AGENTS.md §3.
7. **Edit a NUL line** (firestore.js:2510/:2512, `tupleKey`) — Node script only:
   `fs.readFileSync` → `s.replace('… …', '…')` → `fs.writeFileSync`. `Edit` cannot match
   these lines; never open-and-rewrite the file.
8. **Verify → deploy → re-port** — `node --check` every edited file; run the twelve tests
   (`node lib\_auth_test.js` `_graph_test.js` `_programs_test.js` `_progress_credit_test.js`
   `_priority_test.js` `_visual_test.js` `_deep_test.js` `_usage_test.js` `_aidiag_test.js`);
   then `gcloud run deploy mastery-engine --source . --region us-central1 --project
   agora-data-driven`; confirm the serving revision changed
   (`gcloud run services describe mastery-engine --region us-central1
   --format="value(status.latestReadyRevisionName,status.traffic[0].revisionName)"`);
   then re-port `../mastery-engine-local` (`npm run port` there — **never hand-port**).

## Gotchas + do-not-touch

- 🔴 **NUL (0x00) bytes** on firestore.js lines **1788 + 1790** (`tupleKey` joins with NUL;
  the comment above contains one too). `Read` shows them as spaces; `Edit` can't match; grep
  calls the file binary. Node-script edits only.
- 🔴 `clampToPolicy()` is the hard AI-allowlist gate — every AI path must stay funneled through
  `complete()`/`completeStream()`.
- 🔴 [../docs/HOW-IT-WORKS.md](../docs/HOW-IT-WORKS.md) is read from disk and injected into the
  assistant prompt at `gemini.js:29` (meta questions only, per `META_QUESTION_RE` `:35`) —
  editing that doc changes what the assistant says about itself.
- 🔴 Adapter workarounds are load-bearing: DeepSeek thinking-off opt-out, Kimi coding-host-only,
  LM Studio `json_schema` + `<think>` suppression. Don't "simplify" them away.
- `priority.js` / `programs.js` are deliberately pure — keep IO out of them.

## Status (volatile)

Live: `https://mastery-engine-585951669065.us-central1.run.app` · serving revision
`mastery-engine-00193-scv` · verified 2026-07-29.
