/**
 * AGORA Mastery Engine — Cloud Run service.
 * Serves the static frontend + a JSON REST API backed by Firestore + Gemini.
 *
 * Modes:
 *   GUEST   (no auth)  -> pick any topic, random questions, score only (nothing saved)
 *   MASTERY (password) -> priority quiz, unseen-first selection, logging, generation
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  getCatalog,
  readTopicDocs,
  overlayStats,
  getQuestionsForTopics,
  getSeenQuestionTexts,
  getRecentActivity,
  getRecentAttemptStats,
  getQuizActivity,
  getQuizLogRows,
  getTopicsRows,
  getStreak,
  logResults,
  addQuestion,
  resetProgress,
  getAllQuestions,
  getQuestionById,
  bulkUpdateQuestions,
  bulkUpdateFlashcards,
  getFlashcards,
  getFlashcardById,
  programForCard,
  getAllFlashcards,
  getAllFlashcardsWithId,
  saveFlashcards,
  studyGuideId,
  getStudyGuide,
  saveStudyGuide,
  getStudyGuideIds,
  visualGuideId,
  getVisualGuide,
  getVisualGuideById,
  getAllVisualGuides,
  saveVisualGuide,
  getFlashcardStatuses,
  setFlashcardStatus,
  getCardChat,
  saveCardChat,
  resetCardChat,
  getCardOverlays,
  getScopeChat,
  saveScopeChat,
  deleteScopeChat,
  getTopicAttempts,
  listAssistantChats,
  getAssistantChat,
  saveAssistantChat,
  deleteAssistantChat,
  mergeIntoMathematics,
  getGraphLinks,
  saveGraphLinks,
  setTopicOrders,
  ORDER_FIELDS,
  moveTopics,
  renameTopics,
  renameScope,
  addUsage,
  getUsage,
  stampActiveMinutes,
  getActivityDays,
  removeActiveMinutes,
  slug,
  resolveProgramScope,
  backfillPrograms,
  getPrograms,
  getProgram,
  saveProgram,
  getEnrollment,
  setEnrollment,
  upsertTopic,
  upsertTopics,
  deleteTopic,
  addTranscript,
  getTranscripts,
  getScopeTranscripts,
  getTranscriptById,
  deleteTranscript,
  updateTranscript,
  setTranscriptDigest,
  createGenJob,
  getGenJob,
  listGenJobs,
  updateGenJob,
  flagQuestion,
  listQuestionFlags,
  resolveQuestionFlag,
  deleteQuestionById,
  deleteQuestionBatch,
  saveRoadmap,
  getRoadmap,
  listRoadmaps,
  deleteRoadmap,
  collectRoadmapTracks,
  getShelf,
  setShelf,
  listBankTracks,
  getAllStudyGuides,
  getAllTopicDocs,
  getUserTopicStats,
  getAiAccess,
  setAiAccess,
  AI_PROVIDERS,
  countExplainLogs,
} from './lib/firestore.js';
import * as watcher from './lib/watcher.js';
import { stepGenJob, publicJob, dedupeKey, contentWords, isNearDuplicate } from './lib/genjobs.js';
import { computeMastery, computePriority, deriveStats } from './lib/priority.js';
import { DEFAULT_PROGRAM, filterCatalog, programOf } from './lib/programs.js';
import {
  toNode,
  buildFlowEdges,
  buildPrereqEdges,
  addConnectivity,
  computeInsights,
  prereqContext,
  computeReadiness,
  WEAK_ACC,
  COURSE_ORDER,
  LESSON_ORDER,
} from './lib/graph.js';
import { streamAttempts, backfillRows, replaceTopics } from './lib/bigquery.js';
import {
  generateQuestions,
  generateHint,
  generateExplanation,
  generateLesson,
  generateVisualGuide,
  parseVisualGuide,
  visualGuideLooksComplete,
  generateVisualPanel,
  parseVisualPanel,
  splitVisualPanels,
  visualPanelIndex,
  canSwapVisualPanel,
  replaceVisualPanel,
  replaceOutlineLine,
  visualTabLabelFrom,
  generateAnalysis,
  generateConfusions,
  generateDrillQuestion,
  generateSimilarQuestions,
  generateFlashcards,
  generateFlashcardQuestion,
  generateCardChat,
  generateScopeChat,
  generateAssistantChat,
  streamAssistantChat,
  generateFlashcardQuestions,
  generateTopicLinks,
  generateTopicOrder,
  generateCurriculumOrder,
  classifyTranscript,
  digestSource,
  splitSource,
  planFromSources,
  planCurriculum,
  planCurriculumEdit,
  planRoadmap,
  writeLessonBrief,
  latexifyQuestions,
  reformatFlashcards,
  editFlashcard,
  gradeExplanation,
  generateBookPointCards,
  gradeBookRecall,
  reformatQuestions,
  restoreLatexEscapes,
} from './lib/gemini.js';
import { growthDetail, holisticProfile, mentorSearch, sentinelGuide, sentinelUserLookup, workDetail, workDigest } from './lib/sentinel.js';
import { runWithUsage, newUsage } from './lib/usage.js';
import { synthesize, ttsCatalog } from './lib/tts.js';
import { listOllamaModels } from './lib/ollama.js';
import { listLMStudioModels } from './lib/lmstudio.js';
import { deepseekConfigured, listDeepSeekModels } from './lib/deepseek.js';
import { kimiConfigured, listKimiModels } from './lib/kimi.js';
import { runMigration } from './lib/migrate.js';
import {
  checkPassword,
  checkEmailPassword,
  setSessionCookie,
  clearSessionCookie,
  clearUserCookie,
  setUserCookie,
  setActAs,
  clearActAs,
  isAuthed,
  isAdmin,
  isAdminEmail,
  isSuperAdmin,
  isSentinelAdminRole,
  setSentinelRoleResolver,
  currentEmail,
  effectiveUser,
  conversationUser,
  authContext,
  requireAuth,
  requireAdmin,
  DEFAULT_ACCOUNT,
} from './lib/auth.js';
import * as googleauth from './lib/googleauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

/*
 * Who may embed this app in a frame.
 *
 * It ships inside two sibling apps already — the public website's /skill-mastery page and
 * Sentinel's Academy tab — and the shared `ag_sso` cookie only rides along because they all sit
 * under agoradatadriven.com. Until now NO framing header was sent at all, which let ANY site frame
 * the app (clickjacking); this pins it to the Agora family while keeping both real embeds working.
 * Override with FRAME_ANCESTORS (space-separated sources) if a new host ever needs it.
 *
 * `frame-src 'self'` is the other half, added 2026-08-10 with the visual guides. The generated
 * page in that iframe is MODEL-AUTHORED and runs inline script by necessity. Its own CSP stops
 * it reaching the network, but nothing in a document's own policy can stop it NAVIGATING ITSELF
 * — not `default-src 'none'`, not `form-action`, not the sandbox — so a poisoned page could
 * replace itself with an attacker's page and keep rendering inside our chrome with the real
 * address bar. Only the EMBEDDER's frame-src governs a nested context's navigations, and it
 * covers redirects too. Safe to pin at 'self': the viewer is the only <iframe> in the frontend
 * and nothing creates one dynamically (video lessons are plain target=_blank links).
 */
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS
  || "'self' https://*.agoradatadriven.com https://agoradatadriven.com";
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}; frame-src 'self'`);
  next();
});

/* ------------------------------- helpers ---------------------------------- */

const NA = new Set(['', 'Review All', '-- N/A --', undefined, null]);
const isAll = (v) => NA.has(v);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Build a topic-name -> {track,course,lesson} lookup from the catalog. */
function metaIndex(catalog) {
  const idx = new Map();
  for (const t of catalog) if (!idx.has(t.topic)) idx.set(t.topic, t);
  return idx;
}

/**
 * A topic-name -> {track,course,lesson} lookup that PREFERS rows living inside
 * the requested scope container (track/course/lesson).
 *
 * A few topic names are shared by two different lessons/courses — e.g. "Anomaly
 * Detection" exists under BOTH the "Supervised Machine Learning" and
 * "Unsupervised Learning, Recommenders, Reinforcement" lessons. Questions in the
 * bank are keyed by topic NAME only, so the plain metaIndex resolves such a name
 * to whichever catalog row sorts first by doc-id (here: the Supervised one). A
 * quiz launched from the OTHER lesson then gets its results slugged to the wrong
 * topic doc — so a perfect score shows no progress on the section you clicked.
 *
 * When the request names a track/course/lesson, resolve shared names to the row
 * that actually lives in that container. Falls back to the global first-by-name
 * for topics outside the scope (and for unscoped, cross-topic quizzes).
 */
function scopedMetaIndex(catalog, scope = {}) {
  const idx = metaIndex(catalog);
  if ([scope.track, scope.course, scope.lesson].every(isAll)) return idx;
  const overridden = new Set();
  for (const r of catalog) {
    if (!r.topic || overridden.has(r.topic)) continue;
    if (!isAll(scope.track) && r.track !== scope.track) continue;
    if (!isAll(scope.course) && r.course !== scope.course) continue;
    if (!isAll(scope.lesson) && r.lesson !== scope.lesson) continue;
    idx.set(r.topic, r); // an in-scope row wins over the global first-by-name
    overridden.add(r.topic);
  }
  return idx;
}

/** Shape question docs into the payload the frontend expects. */
function packageQuestions(questions, idx, count) {
  return questions.slice(0, count).map((q) => {
    const meta = idx.get(q.topic) || {};
    return {
      id: q.id, // needed by the admin "Fix format" button
      track: meta.track || 'Unknown Track',
      course: meta.course || 'Unknown Course',
      lesson: meta.lesson || 'Unknown Lesson',
      topic: q.topic,
      // restoreLatexEscapes repairs any control-char-mangled LaTeX ("\texttt"
      // arriving as a literal tab) at read time, so even questions banked before
      // the generator fix render correctly.
      question: restoreLatexEscapes(q.question),
      options: Array.isArray(q.options) ? q.options.map(restoreLatexEscapes) : q.options,
      answer: restoreLatexEscapes(q.answer),
    };
  });
}

/**
 * One question doc shaped for the ADMIN tools (Proof station, question browser).
 * Unlike packageQuestions this needs no catalog lookup — an admin is editing the
 * doc itself, so it carries the doc's own provenance instead of a resolved
 * track/course/lesson. Same read-time LaTeX repair, so what the editor shows is
 * what a learner sees (and saving it back persists the repair).
 */
const publicQuestion = (q) => ({
  id: q.id,
  topic: q.topic || '',
  program: q.program || '',
  difficulty: q.difficulty || '',
  source: q.source || '',
  batchTag: q.batchTag || '',
  question: restoreLatexEscapes(q.question || ''),
  options: Array.isArray(q.options) ? q.options.map((o) => restoreLatexEscapes(String(o))) : [],
  answer: restoreLatexEscapes(q.answer || ''),
});

/** Filter the catalog rows down to a Track>Course>Lesson>Topic selection. */
function scopeCatalog(catalog, { track, course, lesson, topic }) {
  if (!isAll(topic)) return catalog.filter((r) => r.topic === topic);
  if (!isAll(lesson)) return catalog.filter((r) => r.lesson === lesson);
  if (!isAll(course)) return catalog.filter((r) => r.course === course);
  if (!isAll(track)) return catalog.filter((r) => r.track === track);
  return catalog;
}

const clampCount = (c) => Math.min(50, Math.max(1, parseInt(c, 10) || 5));

/**
 * The BigQuery mirror stays on the DEFAULT program deliberately. Its tables feed
 * the existing data-science dashboards and aren't program-aware, so a second
 * curriculum's topics must not leak into that snapshot. It's pinned to the
 * constant rather than the owner's enrollment so enrolling him in another program
 * later can't silently change what the dashboards report.
 */
const BQ_SCOPE = { program: DEFAULT_PROGRAM, courses: [] };

/**
 * Clamp a client-picked AI choice to the request's per-user allowlist (resolved
 * by the /api middleware; null = unrestricted admin). This is belt-and-braces —
 * the hard gate lives in lib/gemini.js complete()/completeStream(), which every
 * AI path funnels through — but clamping here too keeps the EFFECTIVE choice
 * honest for anything that logs or echoes it back to the client.
 */
function clampAiToPolicy(req, ai) {
  const pol = req.aiPolicy;
  if (!pol || !Array.isArray(pol.providers) || !pol.providers.length) return ai;
  if (pol.providers.includes(ai.provider)) return ai;
  const fallback = pol.providers.includes('kimi') ? 'kimi' : pol.providers[0];
  return { ...ai, provider: fallback, model: undefined };
}

/** The AI engine the client picked (cookies set by the home-page dropdown). */
function aiChoice(req) {
  const p = req.cookies?.aiProvider;
  const provider = ['deepseek', 'kimi', 'ollama', 'lmstudio'].includes(p) ? p : 'gemini';
  const model = req.cookies?.aiModel ? decodeURIComponent(req.cookies.aiModel) : undefined;
  // Extended thinking (Gemini): ON unless the user explicitly turned it off, so
  // nothing regresses by default; turning it off trades some depth for speed.
  const thinking = req.cookies?.aiThinking !== 'off';
  return clampAiToPolicy(req, { provider, model, thinking });
}

// Only Gemini (Vertex) can READ file attachments (multimodal). If the user is on another engine
// (Kimi/DeepSeek/local), use Gemini just for a turn that has files, so uploads actually work — their
// engine choice resumes on the next, file-less message. Clears the model so Gemini uses its default
// (the stored aiModel would be the other provider's id).
function aiForFiles(ai, attachments) {
  return (Array.isArray(attachments) && attachments.length && ai.provider !== 'gemini')
    ? { ...ai, provider: 'gemini', model: undefined }
    : ai;
}

/** The question difficulty the learner picked (cookie set by the settings panel).
 *  'auto' (default) ramps from their per-topic history; core|balanced|challenge
 *  override it. */
function difficultyChoice(req) {
  const d = req.cookies?.difficulty;
  return ['core', 'balanced', 'challenge'].includes(d) ? d : 'auto';
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * result order. Used to fan out per-topic LLM generation instead of awaiting
 * each topic serially (N round-trips -> ceil(N/limit) waves).
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Stream a text response. `produce(onToken)` should call onToken with chunks.
 * Headers are set lazily on the first chunk so that an error before any output
 * can still be returned as a clean JSON 500.
 */
async function streamText(res, produce) {
  let wrote = false;
  const onToken = (t) => {
    if (!wrote) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no'); // don't buffer the stream
      wrote = true;
    }
    res.write(t);
  };
  try {
    await produce(onToken);
    if (!wrote) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end();
  } catch (e) {
    if (!wrote) res.status(500).json({ error: e.message || 'AI request failed' });
    else { try { res.end(); } catch { /* already closed */ } }
  }
}

/**
 * Server-Sent Events for the admin planners: open the stream, then push typed
 * events — 'thinking'/'content' token deltas while the model works, then one
 * 'result' with the finished plan, then 'done'. The Composing Room renders the
 * thinking live so you can watch the model reason instead of staring at a spinner.
 * Disabling buffering + an opening comment defeats proxy buffering on Cloud Run.
 */
function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': open\n\n');
}
function sseSend(res, event, data) {
  // JSON.stringify keeps the payload to a single line, so the `data:` framing holds.
  res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
}

/** An Error that a route's extracted worker can throw to pick its own HTTP status
 *  (the `if (e.status)` branch in the catch blocks below, and `sseResult`). */
const httpErr = (status, message) => Object.assign(new Error(message), { status });

/** True when the caller said it can read an SSE stream. Routes whose model call may
 *  outlive a silent socket serve JSON by default and only switch shape on this. */
const wantsSSE = (req) => String(req.headers.accept || '').includes('text/event-stream');

/**
 * Run one slow model call as a HEARTBEATED stream instead of a plain POST.
 *
 * A single thinking-model call routinely runs minutes. Held as a plain POST the
 * socket carries NO bytes for that whole time, and a silent connection that long
 * gets dropped in front of us — the custom domain's ghs.googlehosted.com frontend,
 * office proxies, NAT. The work still SUCCEEDS here (200 in the request log,
 * everything banked); only the response is lost, so the browser reports a
 * network-level "Failed to fetch" for a request the server completed.
 *
 * So: open the stream immediately, `: ping` until `work()` settles, then emit the
 * payload as one 'result' event. Once the stream is open a failure can no longer
 * be a 500, which is why errors are reported in-band as an 'error' event.
 */
const SSE_HEARTBEAT_MS = 15000;
async function sseResult(res, work, failMessage = 'Request failed') {
  sseInit(res);
  // A bare comment frame is a no-op to any SSE reader but keeps the socket warm.
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, SSE_HEARTBEAT_MS);
  try {
    sseSend(res, 'result', await work());
  } catch (e) {
    sseSend(res, 'error', { error: e.message || failMessage });
  } finally {
    clearInterval(beat);
    sseSend(res, 'done', {});
    res.end();
  }
}

/** The AI engine an admin composer request picked (provider/model/thinking in the
 *  body, written by the Composing Room's rail control). Thinking defaults ON.
 *  Clamped like aiChoice — every call site is requireAdmin today (policy null),
 *  so this is pure defence-in-depth for the day one of them is relaxed. */
const aiFromBody = (req) => clampAiToPolicy(req, {
  provider: req.body?.provider || 'deepseek',
  ...(req.body?.model ? { model: req.body.model } : {}),
  thinking: req.body?.thinking !== false,
});

/* Lightweight rate limiter for the AI endpoints (cost guard). Keyed on the
 * signed-in email when there is one — the whole office shares one NAT IP, so
 * per-IP would let one chatty user 429 everyone else off the Coach — falling
 * back to IP for the public (guest) endpoints. */
const aiHits = new Map(); // email-or-ip -> { count, resetAt }
const AI_WINDOW_MS = 60 * 1000;
const AI_MAX = 25; // per user (or guest IP) per minute
function rateLimitAI(req, res, next) {
  const ip = currentEmail(req)
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'anon';
  const now = Date.now();
  const rec = aiHits.get(ip);
  if (!rec || now > rec.resetAt) {
    aiHits.set(ip, { count: 1, resetAt: now + AI_WINDOW_MS });
    return next();
  }
  if (rec.count >= AI_MAX) {
    return res.status(429).json({ error: 'Too many AI requests. Give it a minute.' });
  }
  rec.count++;
  next();
}

/* --------------------------------- auth ----------------------------------- */

// The account whose progress a request reads/writes: the effective user when signed in, else null
// (guest). Guests see the catalog with fresh/zero stats.
const optionalUser = (req) => (isAuthed(req) ? effectiveUser(req) : null);

/**
 * The {program, courses} slice of the bank this request may see — pass it to
 * getCatalog/getQuestionsForTopics so a learner only ever gets their own
 * curriculum. Resolved from the user's enrollment; `?program=` (or a `program` in
 * the body) is honoured for admins, guests, and enrolled learners — plus, for
 * ANY learner, a growth-category program (the Philosophical/Spiritual reading
 * curricula are open to the whole staff — see lib/firestore.js
 * resolveProgramScope). A career program a learner isn't enrolled in can never
 * be widened into (lib/programs.js resolveScope).
 *
 * Everyone who existed before programs did resolves to the default program with
 * no course limit, which is exactly the whole catalog they see today.
 */
const requestScope = (req) =>
  resolveProgramScope(optionalUser(req), {
    requested: req.query?.program || req.body?.program || '',
    isAdmin: isAdmin(req),
  });

/**
 * True when this request carries an HONOURED ?program= pin — a Sentinel pinned tab
 * (Philosophical/Spiritual), where the whole session is ONE program. Shelf-based
 * topic pools (priority quiz, mastery deck, learn-next, the map) must then scope to
 * the program instead of intersecting with the cross-program shelf: the shelf may
 * not contain the pinned program at all, and the intersection empties the pool
 * (the "Mastery Quiz found no questions in a pinned tab" bug). `scope` is the
 * already-resolved requestScope; an un-honoured request (learner not enrolled)
 * resolves elsewhere and correctly reads as unpinned here.
 */
const pinnedProgram = (req, scope) => {
  const want = String(req.query?.program || '').trim();
  return !!want && !!scope && scope.program === want;
};

/*
 * Sentinel is the source of truth for who may use this app. Any request carrying
 * a signed-in email must belong to an ACTIVE Sentinel user — adding a person in
 * Sentinel → People enables them here; deactivating them locks them out within
 * the cache TTL. Guests (no email) pass — the public endpoints are deliberate —
 * and the super admin is the break-glass exception so a Sentinel outage can
 * never lock out the operator. A lookup FAILURE (Sentinel unreachable, or no
 * SSO_SECRET in local dev) fails OPEN with a short re-check window: the Academy
 * must degrade, not die, when Sentinel restarts.
 */
const SENTINEL_GATE_MSG = 'This account is not active in Sentinel. Ask an admin to add you under People in Sentinel.';
const sentinelActiveCache = new Map(); // email -> { active, role, at }
const sentinelLookupInflight = new Map(); // email -> Promise — dedupe a page load's burst of parallel /api calls
const SENTINEL_CACHE_MS = 5 * 60 * 1000;

/**
 * Cached { active, role } verdict for an email — one Sentinel lookup per email
 * per TTL, deduped across parallel requests. A lookup FAILURE (Sentinel down,
 * no secret locally) yields active:true with NO role and a short re-check
 * window: an outage can keep people working but can never mint an admin.
 */
async function sentinelInfo(email) {
  const hit = sentinelActiveCache.get(email);
  if (hit && Date.now() - hit.at < SENTINEL_CACHE_MS) return hit;
  let pending = sentinelLookupInflight.get(email);
  if (!pending) {
    pending = (async () => {
      const info = await sentinelUserLookup(email);
      const entry = info
        ? { active: !!(info.found && info.active), role: String(info.role || ''), at: Date.now() }
        : { active: true, role: '', at: Date.now() - (SENTINEL_CACHE_MS - 60 * 1000) };
      sentinelActiveCache.set(email, entry);
      return entry;
    })().finally(() => sentinelLookupInflight.delete(email));
    sentinelLookupInflight.set(email, pending);
  }
  return pending;
}

async function sentinelGate(req) {
  const email = currentEmail(req);
  if (!email) return null; // guest or HMAC service call — nothing to vouch for
  if (isSuperAdmin(req)) return null; // break-glass
  return (await sentinelInfo(email)).active ? null : SENTINEL_GATE_MSG;
}

// Sentinel's role decides who is an ME admin (super_admin/admin there = admin
// here). isAdmin() must stay synchronous, so it reads this gate cache through
// a resolver — warm for every /api request because the middleware below awaits
// sentinelInfo() before any route runs. Expired/unknown => undefined => not
// admin (the env break-glass list in lib/auth.js still applies).
setSentinelRoleResolver((email) => {
  const hit = sentinelActiveCache.get(email);
  return hit && Date.now() - hit.at < SENTINEL_CACHE_MS ? hit.role : undefined;
});

/*
 * Per-user AI allowlist: admins are unrestricted (null); everyone else gets
 * their users/{email}/meta/ai doc, defaulting to Kimi-only when none exists;
 * guests are pinned to Kimi (the public hint/explain endpoints must never burn
 * a paid engine). Cached briefly — the Team tab invalidates on save.
 */
const aiAccessCache = new Map(); // email -> { policy, at }
const AI_ACCESS_CACHE_MS = 60 * 1000;
async function resolveAiPolicy(req) {
  if (isAdmin(req)) return null;
  const email = currentEmail(req);
  if (!email) return { providers: ['kimi'] };
  const hit = aiAccessCache.get(email);
  if (hit && Date.now() - hit.at < AI_ACCESS_CACHE_MS) return hit.policy;
  const acc = await getAiAccess(email);
  const policy = { providers: acc.providers };
  aiAccessCache.set(email, { policy, at: Date.now() });
  return policy;
}

// AI cost accounting: scope every /api request in an AsyncLocalStorage usage
// tally that the provider calls write into (lib/usage.js). When the response
// finishes (works for streaming too) and any tokens were spent, persist the
// delta to the signed-in user's lifetime tally for the on-screen cost widget.
// The same middleware enforces the Sentinel gate and resolves the AI policy —
// one place, every /api request. /api/auth/* is exempt from the gate so the
// login screen, status probe and logout keep working for a turned-away user.
app.use('/api', async (req, res, next) => {
  try {
    // ALWAYS resolve (and cache) the Sentinel verdict — the role resolver
    // behind isAdmin() feeds off this cache, and /api/auth/* (status, act-as)
    // needs it warm too. Only ENFORCE the 403 outside /auth/*, so the login
    // screen, status probe and logout keep working for a turned-away user.
    const denied = await sentinelGate(req);
    if (denied && !req.path.startsWith('/auth/')) return res.status(403).json({ error: denied });
    req.aiPolicy = await resolveAiPolicy(req);
  } catch {
    req.aiPolicy = null; // an internal error here must never take the app down
  }
  const store = newUsage();
  store.aiPolicy = req.aiPolicy; // lib/gemini.js reads it via the ALS store
  res.on('finish', () => {
    if (store.calls > 0) {
      const user = optionalUser(req);
      if (user) addUsage(user, store).catch(() => {});
    }
  });
  runWithUsage(store, () => next());
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = req.body?.password;
  clearActAs(res); // a fresh login must never inherit the previous user's impersonation target
  // Email + password combo: verify the pair and sign in AS that email (its own identity/progress).
  if (email) {
    const verified = checkEmailPassword(email, password);
    if (!verified) return res.status(401).json({ error: 'Incorrect email or password' });
    setUserCookie(res, verified);
    return res.json({ ok: true });
  }
  // Legacy shared password → the default account (backwards compatible).
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  clearUserCookie(res);
  clearActAs(res);
  res.json({ ok: true });
});

// Rich auth context (used by the frontend to show who you are / who you're acting as).
app.get('/api/auth/status', (req, res) => res.json(authContext(req)));
app.get('/api/auth/whoami', (req, res) => res.json(authContext(req)));

// Whether Google sign-in is wired (frontend hides the button when not).
app.get('/api/auth/google/enabled', (_req, res) => res.json({ enabled: googleauth.isConfigured() }));

// Google OAuth: start the flow (stash a CSRF state cookie), then handle the callback.
app.get('/api/auth/google/login', (req, res) => {
  if (!googleauth.isConfigured()) return res.redirect('/');
  const state = googleauth.newState();
  res.cookie('g_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600000, path: '/' });
  res.redirect(googleauth.authUrl(state));
});

app.get('/api/auth/google/callback', async (req, res) => {
  if (!googleauth.isConfigured()) return res.redirect('/');
  if (!req.query.state || req.query.state !== req.cookies?.g_state) {
    return res.redirect('/?login=error');
  }
  res.clearCookie('g_state', { path: '/' });
  const { email } = await googleauth.exchangeCode(req.query.code);
  if (!email) return res.redirect('/?login=error');
  // Sentinel is the source of truth: a Google account it doesn't vouch for gets
  // no cookie at all (the /api gate would turn them away anyway, but refusing at
  // the door gives a clear message instead of a wall of 403s). A lookup FAILURE
  // (no secret locally, Sentinel down) falls through — the gate re-checks.
  const who = await sentinelUserLookup(email);
  if (who && !(who.found && who.active)) return res.redirect('/?login=noaccount');
  clearActAs(res); // never inherit the previous user's impersonation target
  setUserCookie(res, email);
  res.redirect('/?login=ok');
});

// Impersonation (admins): act as a user, or stop. Targets are held to the
// Sentinel directory (the super admin may impersonate anyone — legacy accounts
// like the pre-Sentinel Gmail identities are still debuggable that way), and
// every act-as is logged with the real actor.
app.post('/api/auth/act-as', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 0) return res.status(400).json({ error: 'A valid email is required' });
    if (!isSuperAdmin(req)) {
      const { people, error } = await fetchSentinelPeople();
      // A directory FETCH failure (Sentinel down / no secret locally) is
      // unverifiable, not a refusal — fail open like the Sentinel gate does.
      const ok = !!error || (people || []).some((p) => String(p.email || '').toLowerCase() === email);
      if (!ok) return res.status(400).json({ error: 'Not an active Sentinel user' });
    }
    console.log(`[act-as] ${currentEmail(req)} -> ${email}`);
    setActAs(res, email);
    res.json({ ok: true, actingAs: email });
  } catch (e) { next(e); }
});
app.post('/api/auth/stop-acting', requireAdmin, (req, res) => {
  clearActAs(res);
  res.json({ ok: true });
});

/* -------------------------------- catalog --------------------------------- */
// Public: guests need the topic tree to pick what to practice.
/**
 * The learner's Mastery-Engine shelf as a concrete (program, track) set: their
 * CURATED shelf if they have one, else DERIVED from enrollment (every track in
 * their enrolled programs) so never-curated users are unaffected. null for guests.
 */
async function effectiveShelf(email) {
  if (!email) return null;
  const shelf = await getShelf(email);
  if (shelf && shelf.tracks.length) return shelf.tracks;
  const enr = await getEnrollment(email);
  const set = new Map();
  for (const program of enr.programs) {
    const cat = await getCatalog(email, { program, courses: enr.courses });
    for (const r of cat) if (r.track) set.set(JSON.stringify([program, r.track]), { program, track: r.track });
  }
  return [...set.values()];
}

/**
 * Does a catalog row fall under any of the learner's hidden prefixes? A prefix
 * matches when every level it names (track, and optionally course/lesson/topic)
 * equals the row's — so a {track,course} prefix hides that whole course. Used to
 * subtract removed sections from the personal Mastery Engine (Progress tree + the
 * scoped quiz/analyze/visualize views). Roadmaps ignore this — they resolve
 * against the full bank (see the `?full=1` branch below).
 */
function hiddenMatch(row, hidden) {
  if (!hidden || !hidden.length) return false;
  const rp = row.program || DEFAULT_PROGRAM;
  for (const h of hidden) {
    if (!h.track) continue;
    if ((h.program || DEFAULT_PROGRAM) !== rp) continue;
    if (row.track !== h.track) continue;
    if (h.course && row.course !== h.course) continue;
    if (h.lesson && row.lesson !== h.lesson) continue;
    if (h.topic && row.topic !== h.topic) continue;
    return true;
  }
  return false;
}

/**
 * Deepest prefix in `prefixes` that matches `row`, as a level count
 * (0 = none, 1 = track, 2 = course, 3 = lesson, 4 = sub-lesson/topic). Prefixes
 * name levels contiguously from the track down (a {track} is depth 1, a
 * {track,course} depth 2, …). A whole shelf track is passed here as a bare
 * {program,track} — i.e. a depth-1 inclusion.
 */
function matchDepth(row, prefixes) {
  if (!prefixes || !prefixes.length) return 0;
  const rp = row.program || DEFAULT_PROGRAM;
  let best = 0;
  for (const p of prefixes) {
    if (!p || !p.track) continue;
    if ((p.program || DEFAULT_PROGRAM) !== rp) continue;
    if (row.track !== p.track) continue;
    let d = 1;
    if (p.course) { if (row.course !== p.course) continue; d = 2; }
    if (p.lesson) { if (row.lesson !== p.lesson) continue; d = 3; }
    if (p.topic)  { if (row.topic  !== p.topic)  continue; d = 4; }
    if (d > best) best = d;
  }
  return best;
}

/**
 * Is a catalog row part of the learner's personal Mastery Engine? Membership is
 * decided by SPECIFICITY: keep the row when the deepest matching INCLUSION
 * out-specifies the deepest matching hidden prefix. Inclusions are the effective
 * shelf `tracks` (depth-1) plus any `included` sub-prefixes (a lesson pulled from
 * a roadmap without its whole track). So an added lesson survives under a hidden
 * course, and a removed sub-lesson stays gone under an added lesson. With no
 * curation this reduces to "row's track is on the shelf and not hidden".
 */
function inEngine(row, tracks, included, hidden) {
  const incDepth = Math.max(matchDepth(row, tracks), matchDepth(row, included));
  return incDepth > matchDepth(row, hidden);
}

/**
 * The catalog the learner is actually LOOKING AT: their personal Mastery Engine — shelf tracks
 * plus individually-added sections, minus removed ones — carrying their own stats.
 *
 * 🔴 It SPANS PROGRAMS, deliberately, and that is the whole reason this is a named function
 * rather than four lines inlined in /api/catalog: anything grounding on "the section on screen"
 * must match against THIS, never against a single-program `requestScope` catalog. See
 * deepGroundingFor, where doing the latter made half a real shelf invisible.
 *
 * Full rows (program + stats), so callers can resolve a row's own program. `learnerCatalog`
 * deliberately does NOT use it: it also needs the rows that fell OUT of the engine, to report
 * parked sections.
 */
async function engineCatalog(email, bank = null) {
  if (!email) return [];
  const tracks = (await effectiveShelf(email)) || [];
  const shelf = (await getShelf(email)) || {};
  // `bank` lets a caller that has ALREADY read the whole catalog hand it over
  // rather than pay a second ~540-doc read (see selectionScope).
  const full = bank || (await getCatalog(email, null)); // whole bank + this user's stats
  // Keep rows whose deepest inclusion (a shelf track, or an individually-added
  // course/lesson/sub-lesson) out-specifies any hidden prefix. See inEngine.
  return full.filter((t) => inEngine(t, tracks, shelf.included || [], shelf.hidden || []));
}

/**
 * The scope a Track > Course > Lesson > Topic SELECTION actually lives in.
 *
 * The scope dropdowns are filled from /api/catalog, which for an unpinned learner
 * is their ENGINE SHELF — and a shelf legitimately SPANS PROGRAMS (a RAG track
 * sitting next to a digital_marketing enrollment). Scoping such a request to the
 * enrollment program alone matches nothing, which is how "No topics in scope"
 * came back for a selection the learner had just picked off their own dropdowns
 * (2026-09-08). So: keep the requested scope when it already contains the
 * selection, else adopt the program of the selected rows ON THIS LEARNER'S OWN
 * SHELF — never wider than what they can already see. A pinned tab (?program=)
 * is one program by definition and is left exactly as resolved.
 */
async function selectionScope(req, scope, sel, bank) {
  if (pinnedProgram(req, scope)) return scope;
  if (scopeCatalog(filterCatalog(bank, scope), sel).length) return scope;
  const rows = scopeCatalog(await engineCatalog(optionalUser(req), bank), sel);
  return rows.length ? { program: programOf(rows[0]), courses: [] } : scope;
}

/**
 * Honour a `?program=` this learner's own shelf vouches for. resolveScope refuses
 * a career program they aren't enrolled in — right for a stray pin, wrong for the
 * cross-program shelf, whose off-enrollment tracks are already on their screen.
 */
async function shelfVouchedScope(email, scope, want) {
  const p = String(want || '').trim();
  if (!p || !email || scope.program === p) return scope;
  const shelf = await engineCatalog(email);
  return shelf.some((r) => programOf(r) === p) ? { program: p, courses: [] } : scope;
}

app.get('/api/catalog', async (req, res, next) => {
  try {
    const email = optionalUser(req);
    let catalog;
    // Learner app (no ?program) → the user's Mastery-Engine shelf (curated tracks,
    // may span programs) minus any sections they've hidden. `?full=1` → the whole
    // bank + this user's stats, unfiltered (Roadmaps use this so a section removed
    // from Progress still rolls up). Admin/curation loads pass ?program → the old
    // program scope, unchanged. Guests → their default program scope.
    if (req.query.full) {
      catalog = await getCatalog(email, null); // whole bank + this user's stats (none for guests)
    } else if (email && !req.query.program) {
      catalog = await engineCatalog(email);
    } else {
      catalog = await getCatalog(email, await requestScope(req));
    }
    // One instant for the whole projection, so every row's retention decay is measured
    // against the same clock (and the rollups the client builds are internally consistent).
    const catalogNow = new Date();
    res.json(
      catalog.map((t) => ({
        id: t.id,
        // The topic's program — carried so a track pulled from any program launches
        // its quizzes correctly (the learner shelf can span programs).
        program: t.program || DEFAULT_PROGRAM,
        track: t.track,
        course: t.course,
        lesson: t.lesson,
        topic: t.topic,
        // Curriculum position, one number per grain (see firestore.js setTopicOrders):
        // this topic within its lesson, its lesson within its course, its course within
        // its track. null = not yet sequenced, which sorts to the end / alphabetical.
        order: Number.isFinite(t.order) ? t.order : null,
        lessonOrder: Number.isFinite(t.lessonOrder) ? t.lessonOrder : null,
        courseOrder: Number.isFinite(t.courseOrder) ? t.courseOrder : null,
        accuracy: t.totalAttempts ? Math.round((t.correctCount / t.totalAttempts) * 100) : null,
        priority: t.priority ?? null,
        totalAttempts: t.totalAttempts ?? 0,
        correctCount: t.correctCount ?? 0,
        // Depth-aware mastery (lib/priority.js) — the progress tree's second metric,
        // behind the Coverage/Mastery toggle. Computed HERE, not in the browser, because
        // it needs `lastAttempted` for its retention decay and the client has no reason
        // to carry raw timestamps for every one of ~800 rows. One formula, one file: the
        // client only ever averages this number.
        mastery: computeMastery(
          {
            correctCount: t.correctCount ?? 0,
            totalAttempts: t.totalAttempts ?? 0,
            lastAttempted: toDate(t.lastAttempted),
          },
          catalogNow,
        ),
      }))
    );
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- models --------------------------------- */
// Which AI engines are available TO THIS CALLER. Admins see everything that's
// configured; everyone else sees only their allowlist (default: Kimi), so the
// engine picker never offers a model the server-side clamp would refuse anyway.
app.get('/api/models', async (req, res, next) => {
  try {
    // Enumerated in ONE place (availableProviders, next to the visual-guide
    // routes) so the picker offered here and the "try a different model"
    // rotation behind Regenerate always agree about what this caller may use.
    const providers = await availableProviders(req);
    const has = (id) => providers.some((p) => p.id === id);
    res.json({
      providers,
      deepseekAvailable: has('deepseek'),
      kimiAvailable: has('kimi'),
      ollamaAvailable: has('ollama'),
      lmstudioAvailable: has('lmstudio'),
    });
  } catch (e) {
    next(e);
  }
});

// Public: the whole question bank with hierarchy, for offline caching in the
// browser. Lets the app serve quizzes and render menus without a connection.
app.get('/api/questions/all', async (req, res, next) => {
  try {
    // Guests may name any program here (this cache is public and the content
    // isn't secret); without one they get the default program's bank.
    const scope = await requestScope(req);
    const [catalog, questions] = await Promise.all([getCatalog(null, scope), getAllQuestions(scope)]);
    const idx = metaIndex(catalog);
    res.json(
      questions
        .filter((q) => q.question && Array.isArray(q.options))
        .map((q) => {
          const m = idx.get(q.topic) || {};
          return {
            id: q.id, // needed by the admin "Fix format" button
            track: m.track || '',
            course: m.course || '',
            lesson: m.lesson || '',
            topic: q.topic,
            question: restoreLatexEscapes(q.question),
            options: Array.isArray(q.options) ? q.options.map(restoreLatexEscapes) : q.options,
            answer: restoreLatexEscapes(q.answer),
          };
        })
    );
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- stats ---------------------------------- */
// Auth: progress analytics over the topics catalog + recent quizLog activity.
// All aggregation is in-memory over the (~540-row) catalog — no extra indexes.
function toDate(v) {
  return v?.toDate ? v.toDate() : v || null;
}

function buildStats(catalog, daily, now = new Date()) {
  // Per-topic derived view (accuracy %, daysSince, priority).
  const topics = catalog.map((t) => {
    const stats = {
      correctCount: t.correctCount || 0,
      totalAttempts: t.totalAttempts || 0,
      lastAttempted: toDate(t.lastAttempted),
    };
    const d = deriveStats(stats, now);
    return {
      track: t.track,
      course: t.course,
      lesson: t.lesson,
      topic: t.topic,
      attempts: stats.totalAttempts,
      correct: stats.correctCount,
      accuracy: stats.totalAttempts ? d.accuracy : null,
      daysSince: stats.totalAttempts ? d.daysSince : null,
      priority: d.priority,
    };
  });

  const attempted = topics.filter((t) => t.attempts > 0);
  const totalAttempts = attempted.reduce((s, t) => s + t.attempts, 0);
  const totalCorrect = attempted.reduce((s, t) => s + t.correct, 0);

  const overview = {
    topics: topics.length,
    attempted: attempted.length,
    neverAttempted: topics.length - attempted.length,
    coverage: topics.length ? Math.round((attempted.length / topics.length) * 100) : 0,
    totalAttempts,
    overallAccuracy: totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : null,
  };

  // Weakest *practiced* topics — highest priority first (low accuracy / stale).
  const weakest = [...attempted]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 15);

  // Per-course rollup, weakest course first (lowest accuracy among practiced).
  const byCourseMap = new Map();
  for (const t of topics) {
    const key = `${t.track}||${t.course}`;
    const c = byCourseMap.get(key) || {
      track: t.track, course: t.course,
      topics: 0, attempted: 0, attempts: 0, correct: 0,
    };
    c.topics += 1;
    if (t.attempts > 0) {
      c.attempted += 1;
      c.attempts += t.attempts;
      c.correct += t.correct;
    }
    byCourseMap.set(key, c);
  }
  const byCourse = [...byCourseMap.values()]
    .map((c) => ({
      track: c.track,
      course: c.course,
      topics: c.topics,
      attempted: c.attempted,
      attempts: c.attempts,
      accuracy: c.attempts ? Math.round((c.correct / c.attempts) * 100) : null,
    }))
    .filter((c) => c.attempts > 0)
    .sort((a, b) => a.accuracy - b.accuracy);

  return { overview, weakest, byCourse, daily };
}

app.get('/api/stats', requireAuth, async (req, res, next) => {
  try {
    const [catalog, daily] = await Promise.all([
      getCatalog(req.userEmail, await requestScope(req)),
      getRecentActivity(req.userEmail, 14),
    ]);
    res.json(buildStats(catalog, daily));
  } catch (e) {
    next(e);
  }
});

// Auth: current activity streak (consecutive days with a logged attempt).
app.get('/api/streak', requireAuth, async (req, res, next) => {
  try {
    res.json({ streak: await getStreak(req.userEmail) });
  } catch (e) {
    next(e);
  }
});

// Auth: lifetime AI token/cost tally for the on-screen cost calculator.
app.get('/api/usage', requireAuth, async (req, res, next) => {
  try {
    res.json(await getUsage(req.userEmail));
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- Time spent -------------------------------- */
// Minute-bucket activity tracking. The client (public/app.js `activityTracker`) posts a beat
// about once a minute WHILE it judges the learner active — a visible frame plus a signal (input,
// speaking, the AI speaking or streaming, an action) inside the last few minutes — carrying what
// they were doing. The server stamps every minute the beat covers into that day's doc
// (lib/firestore.js stampActiveMinutes). Minutes are keys, so overlapping beats from several
// frames de-duplicate for free and a reading is a count of keys. Day/minute boundaries are in
// ACTIVITY_TZ, which is Sentinel's today_ph — the two apps must agree where a day starts.
//
// Keyed by the SIGN-IN identity (conversationUser), never effectiveUser: an admin acting as a
// learner is spending THEIR OWN time, and must not put minutes on the learner's clock.
const ACTIVITY_TZ = process.env.ACTIVITY_TZ || 'Asia/Manila';
// A beat may back-fill at most this far: the client ticks every 60 s and reports the seconds since
// its previous beat, so a throttled background timer that wakes late still covers its minutes,
// while a beat can never claim more than the grace window the client itself applies.
const BEAT_MAX_SECS = 180;
const activityFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ACTIVITY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
/** { day: 'YYYY-MM-DD', hm: 'HHMM' } for an instant, in ACTIVITY_TZ. */
function activityKey(date) {
  const parts = {};
  for (const p of activityFmt.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '00' : parts.hour; // some ICU builds print midnight as 24
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hm: `${hour}${parts.minute}` };
}
const clipStr = (v, n = 80) => String(v == null ? '' : v).trim().slice(0, n);

// Body: { program, view, track, course, lesson, topic, secs }. Best-effort by design — the client
// never surfaces a failure here, so this must never be slow or loud either.
app.post('/api/activity/beat', requireAuth, async (req, res, next) => {
  try {
    const who = conversationUser(req);
    if (!who) return res.status(401).json({ error: 'Sign in first' });
    const b = req.body || {};
    const secs = Math.min(BEAT_MAX_SECS, Math.max(0, Number(b.secs) || 0));
    // Every field is ALWAYS written (empty string for absent) because set({merge:true}) deep-merges
    // maps: a later beat for the same minute from another frame (the Coach over a quiz) must
    // REPLACE the minute's context, not inherit the earlier frame's section. Last beat wins.
    const ctx = { p: clipStr(b.program, 60), v: clipStr(b.view, 24) || 'app' };
    for (const [k, f] of [['tr', 'track'], ['co', 'course'], ['le', 'lesson'], ['to', 'topic']]) ctx[k] = clipStr(b[f]);
    // Every minute from (now − secs) through now, grouped by day — a beat can straddle midnight.
    const now = Date.now();
    const byDay = {};
    for (let t = now - secs * 1000; t < now; t += 60000) {
      const { day, hm } = activityKey(new Date(t));
      (byDay[day] ||= {})[hm] = ctx;
    }
    const last = activityKey(new Date(now));
    (byDay[last.day] ||= {})[last.hm] = ctx;
    await Promise.all(Object.entries(byDay).map(([day, m]) => stampActiveMinutes(who, day, m)));
    res.json({ ok: true, minutes: Object.values(byDay).reduce((n, m) => n + Object.keys(m).length, 0) });
  } catch (e) {
    next(e);
  }
});

/**
 * "Progress" summary using the tree metric the dashboard shows:
 * a topic's progress = its accuracy, or 0 if never attempted; a parent's
 * progress = the unweighted average across all its topics. Aggregated to
 * course/track and surfaced as weakest-topic and by-course lists for the AI
 * progress analysis.
 */
function topicProgressPct(t) {
  return t.totalAttempts ? Math.round((t.correctCount / t.totalAttempts) * 100) : 0;
}

function buildProgressSummary(catalog) {
  const topics = catalog.map((t) => ({
    track: t.track,
    course: t.course,
    lesson: t.lesson,
    topic: t.topic,
    attempts: t.totalAttempts || 0,
    progress: topicProgressPct(t),
  }));

  const overallProgress = topics.length
    ? Math.round(topics.reduce((s, t) => s + t.progress, 0) / topics.length)
    : 0;
  const attempted = topics.filter((t) => t.attempts > 0).length;

  const cmap = new Map();
  for (const t of topics) {
    const key = `${t.track}||${t.course}`;
    const c = cmap.get(key) || { track: t.track, course: t.course, sum: 0, n: 0, attempted: 0 };
    c.sum += t.progress;
    c.n += 1;
    if (t.attempts > 0) c.attempted += 1;
    cmap.set(key, c);
  }
  const byCourse = [...cmap.values()]
    .map((c) => ({
      track: c.track,
      course: c.course,
      progress: Math.round(c.sum / c.n),
      topics: c.n,
      attempted: c.attempted,
    }))
    .sort((a, b) => a.progress - b.progress);

  const weakest = [...topics]
    .sort((a, b) => a.progress - b.progress || b.attempts - a.attempts)
    .slice(0, 15);

  return { overall: { topics: topics.length, attempted, overallProgress }, byCourse, weakest };
}

/* ----------------------------- guest quiz --------------------------------- */
// Public: random questions for the chosen scope. No history, no logging.
app.post('/api/quiz/guest', async (req, res, next) => {
  try {
    const count = clampCount(req.body?.count);
    const scope = await requestScope(req);
    const catalog = await getCatalog(optionalUser(req), scope);
    const scoped = scopeCatalog(catalog, req.body || {});
    const topicNames = [...new Set(scoped.map((r) => r.topic))].filter(Boolean);
    if (!topicNames.length) return res.json([]);

    const pool = await getQuestionsForTopics(topicNames, scope);
    res.json(packageQuestions(shuffle(pool), metaIndex(catalog), count));
  } catch (e) {
    next(e);
  }
});

/* ---------------------------- mastery quiz -------------------------------- */
// Auth: ranks scoped topics by priority, serves UNSEEN questions before seen.
app.post('/api/quiz/select', requireAuth, async (req, res, next) => {
  try {
    const count = clampCount(req.body?.count);
    const scope = await requestScope(req);
    const catalog = await getCatalog(req.userEmail, scope);
    const seen = await getSeenQuestionTexts(req.userEmail);

    const scoped = scopeCatalog(catalog, req.body || {});
    const targetTopics = scoped
      .filter((r) => r.topic && r.priority != null)
      .sort((a, b) => (b.priority - a.priority) || (Math.random() - 0.5))
      .slice(0, 15)
      .map((r) => r.topic);

    const valid = await getQuestionsForTopics([...new Set(targetTopics)], scope);
    const unseen = shuffle(valid.filter((q) => !seen.has(q.question.trim())));
    const seenQs = shuffle(valid.filter((q) => seen.has(q.question.trim())));

    // Resolve topic hierarchy within the requested scope so a topic name shared
    // by two lessons is credited to the section the learner actually launched.
    res.json(packageQuestions([...unseen, ...seenQs], scopedMetaIndex(catalog, req.body || {}), count));
  } catch (e) {
    next(e);
  }
});

// Public + mastery: quiz over an EXPLICIT set of topics (the multi-select Live
// Quiz builder). The client resolves its checkbox tree to a union of topic names
// and posts them here. Signed-in users get unseen questions first (like
// /api/quiz/select); guests just get a shuffled sample.
app.post('/api/quiz/multi', async (req, res, next) => {
  try {
    const count = clampCount(req.body?.count);
    const topics = [...new Set((Array.isArray(req.body?.topics) ? req.body.topics : [])
      .map((t) => String(t || '').trim()).filter(Boolean))];
    if (!topics.length) return res.json([]);

    const user = optionalUser(req);
    const scope = await requestScope(req);
    const catalog = await getCatalog(user, scope);
    const pool = await getQuestionsForTopics(topics, scope);
    if (!user) {
      return res.json(packageQuestions(shuffle(pool), metaIndex(catalog), count));
    }
    const seen = await getSeenQuestionTexts(user);
    const unseen = shuffle(pool.filter((q) => !seen.has(q.question.trim())));
    const seenQs = shuffle(pool.filter((q) => seen.has(q.question.trim())));
    res.json(packageQuestions([...unseen, ...seenQs], metaIndex(catalog), count));
  } catch (e) {
    next(e);
  }
});

// Auth: the priority quiz. It ALWAYS mixes across every Track/Path (interleaving)
// so a daily run practises all areas, weakest topics first within each track.
// Selection is in-memory over the (~540-row) catalog, so no composite index.
app.post('/api/quiz/priority', requireAuth, async (req, res, next) => {
  try {
    const count = clampCount(req.body?.count);
    const scope = await requestScope(req);
    const catalog = await getCatalog(req.userEmail, scope);
    const idx = metaIndex(catalog);
    // Drill only what's in the learner's Mastery Engine (shelf tracks + added
    // sections, minus removed ones — same rule as /api/catalog). UNLESS pinned:
    // the catalog is already the pinned program, and intersecting with the
    // cross-program shelf would empty the pool.
    const pin = pinnedProgram(req, scope);
    const engTracks = pin ? [] : (await effectiveShelf(req.userEmail)) || [];
    const engShelf = pin ? {} : (await getShelf(req.userEmail)) || {};

    // Rank each track's topics by priority (weakest/stalest first).
    const byTrack = new Map();
    for (const r of catalog) {
      if (!r.topic || r.priority == null) continue;
      if (!r.totalAttempts) continue; // Mastery Quiz drills what you've studied, never a cold topic.
      if (!pin && !inEngine(r, engTracks, engShelf.included || [], engShelf.hidden || [])) continue;
      if (!byTrack.has(r.track)) byTrack.set(r.track, []);
      byTrack.get(r.track).push(r);
    }
    for (const list of byTrack.values()) {
      list.sort((a, b) => (b.priority - a.priority) || (Math.random() - 0.5));
    }

    // Round-robin across tracks so every track is represented in the topic pool.
    const tracks = shuffle([...byTrack.keys()]);
    const orderedTopics = [];
    for (let i = 0, added = true; added; i++) {
      added = false;
      for (const t of tracks) {
        const list = byTrack.get(t);
        if (i < list.length) { orderedTopics.push(list[i].topic); added = true; }
      }
    }
    const topicNames = [...new Set(orderedTopics)].slice(0, 90);
    const pool = await getQuestionsForTopics(topicNames, scope);

    // Group available questions by track, then interleave round-robin across
    // tracks so consecutive questions come from different paths.
    const qByTrack = new Map();
    for (const q of shuffle(pool)) {
      const tr = (idx.get(q.topic) || {}).track || 'Unknown';
      if (!qByTrack.has(tr)) qByTrack.set(tr, []);
      qByTrack.get(tr).push(q);
    }
    const qTracks = shuffle([...qByTrack.keys()]);
    const interleaved = [];
    for (let more = true; more && interleaved.length < count; ) {
      more = false;
      for (const tr of qTracks) {
        const list = qByTrack.get(tr);
        if (list.length) {
          interleaved.push(list.shift());
          more = true;
          if (interleaved.length >= count) break;
        }
      }
    }

    res.json(packageQuestions(interleaved, idx, count));
  } catch (e) {
    next(e);
  }
});

// Auth: the flashcard analogue of the Mastery quiz. Instead of one deck, build a
// single review deck of cards drawn from the learner's WEAKEST topics, interleaved
// round-robin across tracks (and across topics within a track) — the same "mix it
// up, weakest first" philosophy as /api/quiz/priority, applied to flashcards.
const MASTERY_DECK_SIZE = 24;
app.post('/api/flashcards/mastery', requireAuth, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const catalog = await getCatalog(req.userEmail, scope);
    // Drill only what's in the learner's Mastery Engine (shelf tracks + added
    // sections, minus removed ones — same rule as /api/catalog). UNLESS pinned:
    // same rationale as /api/quiz/priority above.
    const pin = pinnedProgram(req, scope);
    const engTracks = pin ? [] : (await effectiveShelf(req.userEmail)) || [];
    const engShelf = pin ? {} : (await getShelf(req.userEmail)) || {};
    // Priority per topic (weakest/stalest first), carrying its track for interleaving.
    const topicMeta = new Map();
    for (const r of catalog) {
      if (!r.topic || r.priority == null) continue;
      if (!r.totalAttempts) continue; // Mastery Flashcards reviews what you've studied, never a cold topic.
      if (!pin && !inEngine(r, engTracks, engShelf.included || [], engShelf.hidden || [])) continue;
      if (!topicMeta.has(r.topic)) topicMeta.set(r.topic, { track: r.track || 'Unknown', priority: r.priority });
    }

    // All cards, grouped by topic; keep only the MOST-SPECIFIC deck level per topic
    // (topic > lesson > course) so we don't mix near-duplicate cards from wider decks.
    const LEVEL_RANK = { topic: 3, lesson: 2, course: 1 };
    const all = await getAllFlashcardsWithId();
    const byTopic = new Map();
    for (const c of all) {
      const t = c.topic || '';
      if (!t || !topicMeta.has(t)) continue;
      const rank = LEVEL_RANK[c.level] || 0;
      const cur = byTopic.get(t);
      if (!cur || rank > cur.rank) byTopic.set(t, { rank, cards: [c] });
      else if (rank === cur.rank) cur.cards.push(c);
    }
    if (!byTopic.size) {
      return res.json({ cards: [], topics: 0, tracks: 0 });
    }

    // Order each topic's cards, and rank topics that HAVE cards by priority.
    for (const g of byTopic.values()) g.cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const rankedTopics = [...byTopic.keys()]
      .sort((a, b) => (topicMeta.get(b).priority - topicMeta.get(a).priority) || (Math.random() - 0.5));

    // Group weakest-first topics by track so we can round-robin across tracks.
    const byTrack = new Map();
    for (const t of rankedTopics) {
      const tr = topicMeta.get(t).track;
      if (!byTrack.has(tr)) byTrack.set(tr, []);
      byTrack.get(tr).push({ t, cards: byTopic.get(t).cards, i: 0 });
    }

    // Interleave: round-robin across tracks; within a track, advance across its weak
    // topics one card at a time, so consecutive cards mix topics AND tracks.
    const trackState = shuffle([...byTrack.keys()]).map((tr) => ({ topics: byTrack.get(tr), ptr: 0 }));
    const picked = [];
    for (let more = true; more && picked.length < MASTERY_DECK_SIZE; ) {
      more = false;
      for (const st of trackState) {
        if (picked.length >= MASTERY_DECK_SIZE) break;
        const n = st.topics.length;
        for (let step = 0; step < n; step++) {
          const topic = st.topics[st.ptr % n];
          st.ptr = (st.ptr + 1) % n;
          if (topic.i < topic.cards.length) { picked.push(topic.cards[topic.i++]); more = true; break; }
        }
      }
    }

    res.json({
      cards: await packageFlashcards(picked, conversationUser(req)),
      topics: byTopic.size,
      tracks: byTrack.size,
    });
  } catch (e) {
    next(e);
  }
});

// Auth: persist results + update running mastery stats.
app.post('/api/quiz/log', requireAuth, async (req, res, next) => {
  try {
    const results = Array.isArray(req.body?.results) ? req.body.results : [];
    if (!results.length) return res.json({ ok: true, topicsUpdated: 0 });
    const topicsUpdated = await logResults(req.userEmail, results);
    // Mirror into BigQuery for analytics (best-effort). The BQ tables aren't per-user, so we mirror
    // ONLY the default account (the one seeding the dashboards); other users stay in Firestore only.
    if (req.userEmail === DEFAULT_ACCOUNT) {
      streamAttempts(results).catch(() => {});
      getTopicsRows(DEFAULT_ACCOUNT, new Date(), BQ_SCOPE).then(replaceTopics).catch(() => {});
    }
    res.json({ ok: true, topicsUpdated });
  } catch (e) {
    next(e);
  }
});

/* --------------------------- question generation -------------------------- */
// Auth: Gemini generates new mastery-level MCQs into the bank.
app.post('/api/generate', requireAuth, async (req, res, next) => {
  try {
    const count = clampCount(req.body?.count);
    // Bank once, then narrow: prereqContext below reads prerequisite stats from
    // the BANK because prereq links cross programs; everything else stays scoped.
    const bank = await getCatalog(req.userEmail, null);
    // Scope from the SELECTION, not from the enrollment alone — the scope selects
    // span programs (see selectionScope). This also decides which program the new
    // questions are BANKED into below, so they land beside the topic they drill.
    const scope = await selectionScope(req, await requestScope(req), req.body || {}, bank);
    const catalog = filterCatalog(bank, scope);
    const scoped = scopeCatalog(catalog, req.body || {});
    const topics = [...new Set(scoped.map((r) => r.topic))].filter(Boolean);
    if (!topics.length) return res.status(400).json({ error: 'No topics in scope' });

    let created = 0;
    const errors = [];
    const ai = aiChoice(req);
    const difficulty = difficultyChoice(req);
    // Optional learner steer: free-text focus + transcripts to base questions on.
    const instructions = String(req.body?.instructions || '').trim().slice(0, 2000);
    let reference = '';
    const wantIds = new Set((Array.isArray(req.body?.transcriptIds) ? req.body.transcriptIds : [])
      .map((v) => String(v || '').trim()).filter(Boolean).slice(0, 10));
    if (wantIds.size) {
      // Fetch within the learner's program only (no cross-program leakage).
      const docs = (await getTranscripts({ program: scope.program })).filter((t) => wantIds.has(t.id));
      reference = docs
        .map((t) => `# ${t.title || t.lesson || 'Source'}\n${t.text || ''}`)
        .join('\n\n---\n\n')
        .slice(0, 8000);
    }
    // Knowledge-graph links (best-effort): each topic's prompt gets the learner's
    // standing on its prerequisites, steering questions toward weak sub-steps.
    const graphLinks = await getGraphLinks().catch(() => []);
    // The bank for EVERY selected topic, read once. Two reasons this is not the old
    // per-topic read: it is one query instead of N, and the fan-out below runs four
    // topics at a time, each of which used to be blind to the other three. A learner
    // generating over a whole lesson got the same question under several topics.
    const selectionBank = await getQuestionsForTopics(topics.slice(0, 60), scope);
    const bankByTopic = new Map();
    for (const q of selectionBank) {
      if (!bankByTopic.has(q.topic)) bankByTopic.set(q.topic, []);
      bankByTopic.get(q.topic).push(q);
    }
    // Shared across the concurrent calls, so two topics in one request cannot bank
    // the same question. Mutated before the await on addQuestion, never after.
    const bankedKeys = new Set(selectionBank.map((q) => dedupeKey(q.question)));
    const bankedSets = selectionBank.map((q) => contentWords(`${q.question} ${q.answer || ''}`));
    let skipped = 0;
    // Fan out across topics (bounded) instead of one serial round-trip each.
    await mapWithConcurrency(topics, 4, async (topic) => {
      try {
        const existing = bankByTopic.get(topic) || [];
        const attempts = await getTopicAttempts(req.userEmail, topic);
        // A few full Q/A for depth calibration; ALL stems as a de-dup avoid-list.
        const baseline = existing.slice(0, 6).map((q) => ({ q: q.question, a: q.answer }));
        // Own topic's stems FIRST, then the rest of the selection's — repeating
        // yourself is worse than repeating the topic next door, and avoidBlock caps.
        const stems = [
          ...existing.map((q) => q.question),
          ...selectionBank.filter((q) => q.topic !== topic).map((q) => q.question),
        ];
        const siblings = topics.filter((t) => t !== topic);
        // Difficulty ramps from THIS learner's history on the topic when set to
        // "auto" (weak/untouched -> core, mastered -> challenge); a manual pick
        // overrides it. Missed questions bias new ones toward closing gaps.
        const performance = {
          accuracy: attempts.accuracy,
          attempts: attempts.attempts,
          missed: (attempts.questions || []).filter((q) => q.result === 0).map((q) => q.question),
        };
        const prereqs = prereqContext(topic, catalog, graphLinks, { bank });
        const generated = await generateQuestions(topic, baseline, count, ai, { existing: stems, siblings, performance, difficulty, prereqs, instructions, reference });
        for (const g of generated) {
          // This route used to bank whatever came back, so a re-run could re-add a
          // question the learner already had. Same two gates the genjob stepper uses.
          const key = dedupeKey(g.question);
          const blob = `${g.question} ${g.answer || ''}`;
          if (!key || bankedKeys.has(key) || isNearDuplicate(blob, bankedSets)) { skipped += 1; continue; }
          bankedKeys.add(key);
          bankedSets.push(contentWords(blob));
          await addQuestion({ ...g, program: scope.program });
          created++;
        }
      } catch (e) {
        errors.push(`${topic}: ${e.message}`);
      }
    });
    res.json({ ok: true, created, skipped, topics: topics.length, errors });
  } catch (e) {
    next(e);
  }
});

// Auth: a light list of transcripts the learner can base generated questions on,
// scoped to their program (id/title/course/lesson only — never the full text).
// Optional ?course=/?lesson= narrow it to the scope the learner is generating for.
app.get('/api/transcripts', requireAuth, async (req, res, next) => {
  try {
    // The picker asks for the program of the track the learner has selected, which
    // may sit outside their enrollment but inside their shelf — see selectionScope.
    const scope = await shelfVouchedScope(req.userEmail, await requestScope(req), req.query.program);
    const filter = { program: scope.program };
    if (req.query.course && !isAll(req.query.course)) filter.course = String(req.query.course);
    if (req.query.lesson && !isAll(req.query.lesson)) filter.lesson = String(req.query.lesson);
    const list = (await getTranscripts(filter))
      .map((t) => ({ id: t.id, title: t.title || t.lesson || 'Untitled', course: t.course || '', lesson: t.lesson || '' }))
      .sort((a, b) => `${a.course} ${a.lesson} ${a.title}`.localeCompare(`${b.course} ${b.lesson} ${b.title}`, undefined, { numeric: true }));
    res.json({ transcripts: list });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- drill deeper ----------------------------- */
// Auth: "master this question" step 1 — given a question the learner just
// answered (often without really understanding it), propose specific things
// that might be confusing them. The UI adds its own 4th "let me explain"
// free-text option, so this returns only the AI-suggested confusions.
app.post('/api/drill/confusions', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const { question, options, answer, topic, userAnswer, isCorrect } = req.body || {};
    if (!question || !Array.isArray(options)) {
      return res.status(400).json({ error: 'question and options are required' });
    }
    const confusions = await generateConfusions(
      { question, options, answer: answer || '', topic: topic || '', userAnswer, isCorrect: !!isCorrect },
      aiChoice(req)
    );
    res.json({ confusions });
  } catch (e) {
    next(e);
  }
});

// Auth: "master this question" step 2 — generate ONE new question that drills
// into the chosen confusion, SAVE it to the bank under the SAME topic, and
// return it packaged with its full hierarchy so the client can serve it
// immediately. Because it shares the topic, it feeds the exact sub-lesson:
// future quizzes pick it up and answering it updates that topic's mastery.
app.post('/api/drill/question', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const { question, options, answer, topic } = req.body || {};
    // Bound the free-text confusion before it reaches the prompt (injection surface).
    const confusion = String(req.body?.confusion || '').slice(0, 500).trim();
    if (!topic || !confusion) {
      return res.status(400).json({ error: 'topic and confusion are required' });
    }
    const scope = await requestScope(req);
    const catalog = await getCatalog(req.userEmail, scope);
    // Prefer the running question's own hierarchy so a shared topic name drills
    // into (and later logs against) the exact sub-lesson it came from.
    const idx = scopedMetaIndex(catalog, req.body || {});
    if (!idx.has(topic)) {
      return res.status(400).json({ error: 'Unknown topic; cannot drill into it' });
    }
    const meta = idx.get(topic);
    const scopeLabel = [meta.course, meta.lesson, topic].filter(Boolean).join(' › ');

    const drilled = await generateDrillQuestion(
      { topic, scopeLabel, question: question || '', options: options || [], answer: answer || '', confusion },
      aiChoice(req)
    );
    // Persist into the bank so it feeds future quizzes for this exact sub-lesson.
    // Tag it `drill` so these can be audited/pruned separately from seeded ones.
    const id = await addQuestion({ ...drilled, source: 'drill', program: scope.program });

    // Package with the topic's full hierarchy (same shape the quiz endpoints use),
    // carrying the new id so the client can reformat it inline.
    res.json(packageQuestions([{ ...drilled, id }], idx, 1)[0]);
  } catch (e) {
    next(e);
  }
});

// Auth: in-quiz "generate more like this" — write N fresh questions on the SAME
// topic, matching the current question's style/difficulty, bank them under that
// topic (so they feed future quizzes), and return them packaged so the client
// can queue them into the running quiz immediately.
app.post('/api/generate/like', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const { question, options, answer, topic } = req.body || {};
    const count = Math.min(10, Math.max(1, parseInt(req.body?.count, 10) || 3));
    if (!topic) return res.status(400).json({ error: 'topic is required' });

    const scope = await requestScope(req);
    const catalog = await getCatalog(req.userEmail, scope);
    // Prefer the running question's own hierarchy so a shared topic name is
    // resolved to (and logged against) the exact sub-lesson it came from.
    const idx = scopedMetaIndex(catalog, req.body || {});
    if (!idx.has(topic)) return res.status(400).json({ error: 'Unknown topic; cannot generate for it' });
    const meta = idx.get(topic);
    const scopeLabel = [meta.course, meta.lesson, topic].filter(Boolean).join(' › ');

    // Existing stems for this topic become an avoid-list so "more like this"
    // widens coverage instead of re-emitting questions already in the bank.
    const pool = await getQuestionsForTopics([topic], scope);
    const generated = await generateSimilarQuestions(
      { topic, scopeLabel, question: question || '', options: options || [], answer: answer || '', existing: pool.map((q) => q.question) },
      count,
      aiChoice(req)
    );
    // Persist into the bank (tagged so these can be audited/pruned separately),
    // carrying each new id back so the client copies can be reformatted inline.
    const banked = [];
    for (const g of generated) {
      banked.push({ ...g, id: await addQuestion({ ...g, source: 'similar', program: scope.program }) });
    }

    res.json(packageQuestions(banked, idx, count));
  } catch (e) {
    next(e);
  }
});

// Public: every shared flashcard deck, so the local offline app's Sync can pull
// the cloud's (better) cards. Card definitions are user-agnostic, so no auth.
app.get('/api/flashcards/all', async (_req, res, next) => {
  try {
    res.json(await getAllFlashcards());
  } catch (e) {
    next(e);
  }
});

/* ---------------------------- offline mirror ------------------------------ */
/**
 * GET /api/export/local?part=<name> — feeds Sync in the offline Mastery Engine.
 *
 * The offline app runs this same server code against a local JSON database, so rather than inventing
 * a transfer format this hands back the documents themselves and lets it write them straight into
 * its own collections. That is what makes offline a genuine mirror — including the artefacts it
 * could never produce well on a laptop model: the AI-written lesson and review guides, and the
 * flashcard decks.
 *
 * One `part` per request instead of a single fat payload: the question bank and guide library are
 * many megabytes together, and a part-at-a-time pull gives the offline app a progress bar and lets a
 * dropped connection resume at the part that failed rather than restarting the whole sync.
 *
 * Everything is scoped to the caller's own enrollment and identity — this exports YOUR mirror, not
 * the database.
 */
app.get('/api/export/local', requireAuth, async (req, res, next) => {
  try {
    const part = String(req.query.part || 'meta');
    const scope = await resolveProgramScope(req.userEmail, {});
    const send = (payload) => res.json({ part, at: new Date().toISOString(), ...payload });

    switch (part) {
      case 'meta': {
        // What's available and how big, so the client can show real progress before committing.
        const [topics, questions, cards, guides] = await Promise.all([
          getAllTopicDocs(), getAllQuestions(scope), getAllFlashcardsWithId(), getAllStudyGuides(),
        ]);
        return send({
          user: req.userEmail,
          parts: ['topics', 'questions', 'flashcards', 'guides', 'visuals', 'quizlog', 'graph', 'programs', 'roadmaps', 'shelf', 'holistic'],
          counts: {
            topics: topics.length, questions: questions.length,
            flashcards: cards.length, guides: guides.length,
          },
        });
      }
      case 'topics':
        return send({ topics: await getAllTopicDocs(), topicStats: await getUserTopicStats(req.userEmail) });
      case 'questions':
        return send({ questions: await getAllQuestions(scope) });
      case 'flashcards':
        return send({ flashcards: await getAllFlashcardsWithId() });
      case 'guides':
        return send({ guides: await getAllStudyGuides() });
      case 'visuals':
        // The generated visual-guide pages. Same rationale as 'guides': each one
        // is a whole HTML document from one model call, and a laptop LLM would
        // take hours to reproduce them worse. NOT in the 'meta' counts above —
        // that block already pays four full-collection reads.
        return send({ visualGuides: await getAllVisualGuides() });
      case 'quizlog':
        return send({ quizLog: await getQuizLogRows(req.userEmail) });
      case 'graph':
        return send({ graphLinks: await getGraphLinks() });
      case 'programs':
        return send({ programs: await getPrograms(), enrollment: await getEnrollment(req.userEmail) });
      case 'roadmaps':
        return send({ roadmaps: await listRoadmaps({}) });
      case 'shelf':
        return send({ shelf: await getShelf(req.userEmail) });
      case 'holistic':
        // Proxied deliberately: the offline app gets the person's Sentinel digest (gym split and
        // cardio, PRs, career goals, reading and philosophy, growth notes) WITHOUT the shared
        // platform secret ever leaving the server. Null when Sentinel is unreachable/unconfigured.
        return send({ holistic: await holisticProfile(req.userEmail) });
      default:
        return res.status(400).json({ error: `Unknown export part "${part}"` });
    }
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- flashcards ------------------------------ */
// Flashcards are enabled for EVERY course/lesson. Decks are still only created
// on demand (when a user clicks "Generate"), so nothing is pre-built. To scope
// the feature back to specific courses, return a regex test here instead, e.g.
//   const FLASHCARD_COURSE_RE = /\bcalculus\b/i;
//   const flashcardsEnabledFor = (course) => FLASHCARD_COURSE_RE.test(course || '');
const flashcardsEnabledFor = (course) => !!String(course || '').trim();

// Normalise a {track,course,lesson,topic} request into a scope + level.
// Flashcards exist at Course level (highest), Lesson level, and Topic level (the
// smallest grain, i.e. a single sub-lesson) — most-specific field present wins.
function flashcardScope(src = {}) {
  const track = String(src.track || '').trim();
  const course = String(src.course || '').trim();
  const lesson = isAll(src.lesson) ? '' : String(src.lesson || '').trim();
  const topic = isAll(src.topic) ? '' : String(src.topic || '').trim();
  return { track, course, lesson, topic, level: topic ? 'topic' : lesson ? 'lesson' : 'course' };
}
const flashcardScopeLabel = (s) => [s.course, s.lesson, s.topic].filter(Boolean).join(' › ');

/**
 * The program scope for a request that hangs off a CARD, rather than the ambient
 * one `requestScope` derives from the caller.
 *
 * 🔴 The two are NOT interchangeable. A learner's shelf mixes programs and the
 * mastery deck interleaves them, so the deck on screen is routinely not from the
 * program their enrolment resolves to. `/api/flashcards` and `/generate` never hit
 * this because the client sends `program` alongside the scope — the card-scoped
 * endpoints have no scope to send, and silently resolved to the wrong program:
 * "This card is not linked to a known topic" and a permanent "0 questions ·
 * — accuracy" on a topic with a full question bank (fixed 2026-08-07).
 *
 * Enrolment still decides: the card's program goes through `resolveProgramScope`
 * exactly like a requested one, so this widens nothing a learner couldn't reach.
 * An unresolvable card falls back to the ambient scope and the caller's own
 * "unknown topic" branch, which is the honest answer.
 */
async function cardScope(req, card) {
  const program = await programForCard(card);
  if (!program) return requestScope(req);
  return resolveProgramScope(optionalUser(req), { requested: program, isAdmin: isAdmin(req) });
}

// Merge a user's private status labels + personalized "rewrite in place" overlay
// onto shared card definitions. Callers pass conversationUser(req): the overlay
// is written by the card CHAT under that identity, so reads must match — and an
// admin's personal labels must not live in the legacy owner's account.
async function packageFlashcards(cards, userEmail) {
  const ids = cards.map((c) => c.id);
  const [statuses, overlays] = await Promise.all([
    getFlashcardStatuses(userEmail, ids),
    getCardOverlays(userEmail, ids),
  ]);
  return cards.map((c) => {
    const o = overlays[c.id];
    return {
      id: c.id,
      concept: c.concept,
      intuition: o ? o.intuition : c.intuition,
      formula: o && o.formula ? o.formula : c.formula,
      visual: o ? (o.visual || null) : (c.visual || null),
      highway: !!c.highway,
      topic: c.topic || '',
      kind: c.kind || '',
      status: statuses[c.id] || null,
      personalized: !!o,
    };
  });
}

/* ------------------------------- Book decks -------------------------------- */
/**
 * Build the fixed-shape BOOK deck for one lesson (lesson = the book, its topics
 * = the book's key points, exactly what auto-file ingest produces for a pasted
 * book summary). Card 1 front = the book title, back = the ordered point list
 * (deterministic — the recall target); then one card per point, front = the
 * point, back = the AI-written explanation grounded in the lesson's attached
 * transcript(s). Replaces any existing deck for the lesson scope.
 *
 * `points` (plan-order names) is optional — when absent they come from the
 * catalog in study order, so the learner's "Book deck" button and the ingest
 * commit produce the same deck.
 */
/** Book mode is AUTOMATIC for reading programs: a program whose Subject is
 *  "Personal growth / philosophy (Reading)" (category 'growth') treats ingested
 *  material as a book — lesson = the title, topics = its key points — so decks
 *  and ingests take the book shape without anyone ticking a box. An explicit
 *  book:true/false in a request still overrides. */
async function isReadingProgram(program) {
  try { return ((await getProgram(program))?.category || 'career') === 'growth'; }
  catch { return false; }
}

async function buildBookDeck({ program, scope, points = null, instructions = '', ai = {} }) {
  const { track, course, lesson } = scope;
  let names = Array.isArray(points) ? points.map((t) => String(t || '').trim()).filter(Boolean) : [];
  if (!names.length) {
    // scopeCatalog filters only by the most specific field; compound-match here so
    // a lesson name shared across courses can't leak foreign points into the book.
    const rows = (await getCatalog(null, { program }))
      .filter((r) => r.topic && r.track === track && r.course === course && r.lesson === lesson)
      .sort((a, b) => (Number.isFinite(a.order) ? a.order : Infinity) - (Number.isFinite(b.order) ? b.order : Infinity)
        || String(a.topic).localeCompare(String(b.topic)));
    names = rows.map((r) => r.topic);
  }
  if (!names.length) throw Object.assign(new Error('This lesson has no sub-lessons (key points) yet'), { status: 400 });

  // The book source: whatever transcripts ingest attached to this lesson.
  const transcripts = await getTranscripts({ program, course, lesson });
  const source = transcripts.map((t) => t.text || '').filter(Boolean).join('\n\n---\n\n');

  const backs = await generateBookPointCards({ book: lesson, points: names, transcript: source, instructions }, ai);
  const cards = [
    {
      kind: 'title',
      topic: '', // spans every point — recall grading logs per point instead
      concept: lesson,
      intuition: `The ${names.length} key points:\n\n${names.map((p, i) => `${i + 1}. **${p}**`).join('\n')}`,
      formula: `${names.length} points — can you name and explain them all?`,
      highway: true,
    },
    ...names.map((p, i) => ({
      kind: 'point',
      topic: p,
      concept: p,
      intuition: backs[i]?.intuition || '',
      formula: backs[i]?.formula || '',
      highway: true,
    })),
  ];
  await saveFlashcards({ ...scope, level: 'lesson', program }, cards);
  return cards.length;
}

// Auth: fetch the (cached) deck for a Course/Lesson scope, with this user's labels.
// `generated:false` tells the client to offer a "Generate flashcards" action.
app.get('/api/flashcards', requireAuth, async (req, res, next) => {
  try {
    const scope = flashcardScope(req.query);
    if (!scope.course) return res.status(400).json({ error: 'A course is required' });
    const enabled = flashcardsEnabledFor(scope.course);
    if (!enabled) return res.json({ enabled: false, level: scope.level, cards: [], generated: false });

    const cards = await getFlashcards(scope);
    // `book` tells the client this scope takes the book-deck shape — either the
    // deck already is one, or it's an empty lesson in a reading program (so the
    // empty state can say "build the book deck" instead of the generic copy).
    const book = cards.some((c) => c.kind)
      || (!cards.length && scope.level === 'lesson' && await isReadingProgram((await requestScope(req)).program));
    res.json({
      enabled: true,
      level: scope.level,
      generated: cards.length > 0,
      book,
      cards: await packageFlashcards(cards, conversationUser(req)),
    });
  } catch (e) {
    next(e);
  }
});

// (Re)generate the deck for a scope from the questions/topics it contains, bank it,
// and return the same payload GET /api/flashcards would. Extracted from the route
// because BOTH transports below run it — throws `httpErr` rather than writing a
// status, since the SSE path has already sent its headers by the time this runs.
async function buildDeckForRequest(req) {
  const scope = flashcardScope(req.body);
  if (!scope.course) throw httpErr(400, 'A course is required');
  if (!flashcardsEnabledFor(scope.course)) throw httpErr(403, 'Flashcards are not enabled for this course yet');
  const programScope = await requestScope(req);
  const packaged = async () => ({
    enabled: true,
    level: scope.level,
    generated: true,
    cards: await packageFlashcards(await getFlashcards(scope), conversationUser(req)),
  });

  // Book deck: `book:true` asks for the fixed title→points shape; with `book`
  // absent, an existing book deck stays a book on regenerate (kind marks it),
  // and a reading program (category 'growth') books its lessons automatically.
  let book = req.body?.book === true;
  if (req.body?.book === undefined && scope.level === 'lesson') {
    const existing = await getFlashcards(scope);
    book = existing.some((c) => c.kind) || await isReadingProgram(programScope.program);
  }
  if (book) {
    if (scope.level !== 'lesson') throw httpErr(400, 'Book decks are built per lesson (the lesson is the book)');
    await buildBookDeck({
      program: programScope.program,
      scope,
      instructions: req.body?.instructions || '',
      ai: aiChoice(req),
    });
    return packaged();
  }

  const catalog = await getCatalog(req.userEmail, programScope);
  const scoped = scopeCatalog(catalog, scope);
  const topics = [...new Set(scoped.map((r) => r.topic))].filter(Boolean);
  if (!topics.length) throw httpErr(400, 'No topics in this section yet');

  // Sample the section's questions so the deck is comprehensive enough to cover them.
  const pool = await getQuestionsForTopics(topics.slice(0, 60), programScope);
  const questions = shuffle(pool).slice(0, 40)
    .map((q) => ({ topic: q.topic, question: q.question, answer: q.answer }));

  const cards = await generateFlashcards(
    { scopeLabel: flashcardScopeLabel(scope), level: scope.level, topics, questions, instructions: req.body?.instructions || '' },
    aiChoice(req),
  );
  if (!cards.length) throw httpErr(502, 'No flashcards were generated; try again');

  await saveFlashcards({ ...scope, program: programScope.program }, cards);
  return packaged();
}

/* Auth: build the deck. Rate-limited (an AI call). Gated to enabled courses.
 *
 * A course-level deck is 18-30 cards, each with an intuition, a LaTeX formula and
 * a visual spec, from ONE thinking-model call — minutes of a socket carrying no
 * bytes, which is precisely the connection an intermediary drops (see `sseResult`).
 * That is what surfaced as "Could not generate flashcards: Failed to fetch" while
 * the deck was in fact written and banked. So when the browser can read a stream we
 * heartbeat one; JSON stays the default for anything else that calls this. */
app.post('/api/flashcards/generate', requireAuth, rateLimitAI, async (req, res, next) => {
  if (wantsSSE(req)) return sseResult(res, () => buildDeckForRequest(req), 'Flashcard generation failed');
  try {
    res.json(await buildDeckForRequest(req));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Auth: set/clear this user's label on a card (mastered | learning | important).
app.post('/api/flashcards/status', requireAuth, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    const status = req.body?.status ? String(req.body.status).trim() : null;
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    // conversationUser: must match packageFlashcards' read identity, or an
    // admin's labels would write to one account and render from another.
    await setFlashcardStatus(conversationUser(req), cardId, status);
    res.json({ ok: true, status });
  } catch (e) {
    next(e);
  }
});

// Auth: "quiz me on this" — generate `count` MCQs (1–10, chosen by the learner)
// for a card's concept, bank them under the card's real topic (source
// 'flashcard'), and return them packaged so the client runs them as a normal
// quiz (logged, mastery + streak updated).
app.post('/api/flashcards/quiz', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    const count = Math.min(10, Math.max(1, parseInt(req.body?.count, 10) || 1));
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    // cardScope, NOT requestScope: the card's own program, or a learner whose
    // enrolment resolves elsewhere quizzes against an empty catalog (see cardScope).
    const programScope = await cardScope(req, card);
    // Bank once, then narrow — prereqContext below resolves prerequisite stats
    // from the BANK (prereq links cross programs); the card resolves scoped.
    const bank = await getCatalog(req.userEmail, null);
    const catalog = filterCatalog(bank, programScope);
    // Resolve within the card's own deck scope so a topic name shared by two
    // lessons quizzes (and logs) against the section this card belongs to.
    const idx = scopedMetaIndex(catalog, { track: card.track, course: card.course, lesson: card.lesson });
    if (!card.topic || !idx.has(card.topic)) {
      return res.status(400).json({ error: 'This card is not linked to a known topic' });
    }
    const meta = idx.get(card.topic);
    const scopeLabel = [meta.course, meta.lesson, card.topic].filter(Boolean).join(' › ');

    // Feed the planner what already exists for this topic (avoid-list), how
    // this learner has done on it (difficulty target + missed-question focus),
    // and the graph's prerequisite standing (weak prereqs become sub-steps).
    const [pool, attempts, graphLinks] = await Promise.all([
      getQuestionsForTopics([card.topic], programScope),
      getTopicAttempts(req.userEmail, card.topic),
      getGraphLinks().catch(() => []),
    ]);
    const existing = pool.map((q) => q.question);
    const performance = {
      accuracy: attempts.accuracy,
      attempts: attempts.attempts,
      missed: (attempts.questions || []).filter((q) => q.result === 0).map((q) => q.question),
    };
    const prereqs = prereqContext(card.topic, catalog, graphLinks, { bank });

    const qs = await generateFlashcardQuestions(
      { topic: card.topic, scopeLabel, concept: card.concept, intuition: card.intuition, formula: card.formula },
      count,
      aiChoice(req),
      { existing, performance, difficulty: difficultyChoice(req), prereqs },
    );
    // Bank each question and carry its new id back so the client copy can be
    // reformatted inline (the admin "Fix format" button needs the id).
    const banked = [];
    for (const q of qs) {
      banked.push({ ...q, id: await addQuestion({ ...q, source: 'flashcard', program: programScope.program }) });
    }
    res.json(packageQuestions(banked, idx, count));
  } catch (e) {
    next(e);
  }
});

// Auth: per-flashcard quiz stats — how many questions exist for the card's topic,
// and this user's accuracy + attempted-question list for it (task: tie cards to
// quiz performance). Multiple cards can share a topic, so these reflect the topic.
app.get('/api/flashcards/card-stats', requireAuth, async (req, res, next) => {
  try {
    const cardId = String(req.query?.cardId || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    if (!card.topic) return res.json({ topic: '', questionCount: 0, attempts: 0, correct: 0, accuracy: null, questions: [] });

    const [pool, attempts] = await Promise.all([
      // cardScope: the ambient one reported "0 questions" for every card whose
      // program wasn't the learner's enrolled one, however full its bank was.
      getQuestionsForTopics([card.topic], await cardScope(req, card)),
      getTopicAttempts(req.userEmail, card.topic),
    ]);
    res.json({ topic: card.topic, questionCount: pool.length, ...attempts });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ Speaker Mode ------------------------------ */
// Auth: grade a spoken (or typed) explanation of a card's concept out of 3 and
// fold it into the learner's topic mastery. The transcript comes from browser
// speech-to-text; the AI scores UNDERSTANDING (see gradeExplanation) and we log
// it as ONE quiz-equivalent attempt on the card's topic — a "pass" when the
// learner scores 2/3 or better — so a good explanation moves mastery exactly
// like answering a question does. Rate-limited (one AI call per request).
app.post('/api/flashcards/explain', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    // Bound the transcript before it reaches the prompt (cost + injection surface).
    // A book-title recall runs through EVERY point of a book, so it gets a longer
    // leash than a single-concept explanation (which keeps its original 4k bound).
    const transcriptFull = String(req.body?.transcript || '').slice(0, 8000).trim();
    const transcript = transcriptFull.slice(0, 4000);
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    if (!transcript) return res.status(400).json({ error: 'An explanation is required' });

    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    // Book TITLE card: the learner recalls ALL the book's key points from the
    // title alone. Grade per-point COVERAGE (not one blended answer) and log an
    // attempt on EACH point's own topic — covered = pass, missed = fail — so a
    // book's mastery lives on the same per-topic stats as everything else and
    // missed points bubble up through priority for the next session.
    if (card.kind === 'title') {
      const deck = await getFlashcards({ track: card.track, course: card.course, lesson: card.lesson, level: 'lesson' });
      const points = deck.filter((c) => c.kind === 'point' && c.topic)
        .map((c) => ({ point: c.topic, intuition: c.intuition || '' }));
      if (!points.length) return res.status(400).json({ error: 'This book deck has no point cards yet — regenerate the deck' });

      const grade = await gradeBookRecall(
        { book: card.lesson || card.concept, points, transcript: transcriptFull },
        aiChoice(req),
      );
      const covered = grade.coverage.filter((c) => c.covered).length;

      // One attempt per point, keyed to the point's own catalog row (scoped to
      // this lesson so a point name shared with another course can't miscredit).
      const catalog = await getCatalog(req.userEmail, await cardScope(req, card));
      const idx = scopedMetaIndex(catalog, { track: card.track, course: card.course, lesson: card.lesson });
      const rows = grade.coverage
        .filter((c) => idx.has(c.point))
        .map((c) => {
          const meta = idx.get(c.point);
          return {
            track: meta.track || '', course: meta.course || '', lesson: meta.lesson || '',
            topic: c.point,
            question: '📖 Recalled the points of: ' + String(card.concept || '').slice(0, 140),
            isCorrect: c.covered,
            reviewFlag: 0,
          };
        });
      if (rows.length) {
        await logResults(req.userEmail, rows);
        if (req.userEmail === DEFAULT_ACCOUNT) {
          streamAttempts(rows).catch(() => {});
          getTopicsRows(DEFAULT_ACCOUNT).then(replaceTopics).catch(() => {});
        }
      }

      // Same response shape the Speaker panel already renders — covered points as
      // strengths, missed ones as gaps, the ordered list as the model answer —
      // plus the raw per-point coverage for the progress note.
      return res.json({
        score: Math.round(3 * covered / points.length),
        verdict: grade.verdict,
        strengths: grade.coverage.filter((c) => c.covered).map((c) => `**${c.point}**${c.note ? ` — ${c.note}` : ''}`),
        gaps: grade.coverage.filter((c) => !c.covered).map((c) => `**${c.point}**${c.note ? ` — ${c.note}` : ''}`),
        modelAnswer: `The ${points.length} key points:\n\n${points.map((p, i) => `${i + 1}. **${p.point}**`).join('\n')}`,
        encouragement: grade.encouragement,
        pass: covered === points.length,
        pointsMax: 3,
        coverage: grade.coverage,
        progress: { logged: rows.length > 0, topic: '', points: rows.length, covered, total: points.length },
      });
    }

    // Resolve the card's full hierarchy (same lookup the quiz endpoint uses) so
    // the attempt logs against the right Track > Course > Lesson > Topic. Scoped to
    // the CARD's program — under the ambient one `meta` came back null for a
    // cross-program deck and a graded explanation silently logged no progress.
    const catalog = await getCatalog(req.userEmail, await cardScope(req, card));
    const idx = metaIndex(catalog);
    const meta = card.topic && idx.has(card.topic) ? idx.get(card.topic) : null;
    const scopeLabel = meta
      ? [meta.course, meta.lesson, card.topic].filter(Boolean).join(' › ')
      : (card.topic || '');

    const grade = await gradeExplanation(
      { concept: card.concept, intuition: card.intuition, formula: card.formula, scopeLabel, transcript },
      aiChoice(req),
    );

    // Progress (lighter mapping): count the whole explanation as ONE attempt on
    // the topic — correct when they scored 2/3+. Only log when the card is tied
    // to a known topic, so mastery keys correctly; otherwise just return the grade.
    const pass = grade.score >= 2;
    let logged = false;
    if (meta) {
      const row = {
        track: meta.track || '',
        course: meta.course || '',
        lesson: meta.lesson || '',
        topic: card.topic || '',
        question: '🎙️ Explained aloud: ' + String(card.concept || '').slice(0, 140),
        isCorrect: pass,
        reviewFlag: 0,
      };
      await logResults(req.userEmail, [row]);
      logged = true;
      // Mirror into BigQuery for the analytics dashboards, same as /api/quiz/log
      // (best-effort, default account only).
      if (req.userEmail === DEFAULT_ACCOUNT) {
        streamAttempts([row]).catch(() => {});
        getTopicsRows(DEFAULT_ACCOUNT).then(replaceTopics).catch(() => {});
      }
    }

    res.json({ ...grade, pass, pointsMax: 3, progress: { logged, topic: card.topic || '' } });
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- Chat ------------------------------------ */
// Auth: load this user's saved chat thread for one card (empty if none yet).
app.get('/api/flashcards/chat', requireAuth, async (req, res, next) => {
  try {
    const cardId = String(req.query?.cardId || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    // conversationUser, not effectiveUser: chats are private to the signed-in
    // person — an admin must never read (or write into) the legacy owner's threads.
    const chat = await getCardChat(conversationUser(req), cardId);
    res.json({ messages: chat?.messages || [], personalized: !!chat?.intuition });
  } catch (e) {
    next(e);
  }
});

// Auth: send a message about ONE card. Answers it AND rewrites the card's
// explanation in place for this user (stored as a private overlay). Rate-limited.
app.post('/api/flashcards/chat', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    if (!message) return res.status(400).json({ error: 'A message is required' });

    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    // Start from this user's personalized version of the card if they have one.
    // (conversationUser: chat + overlay are private to the signed-in person.)
    const chatUser = conversationUser(req);
    const existing = await getCardChat(chatUser, cardId);
    const history = existing?.messages || [];
    const baseIntuition = existing?.intuition || card.intuition;
    const baseFormula = existing?.formula || card.formula;
    const baseVisual = existing?.intuition ? existing.visual : card.visual;

    // A little context: sample questions from the same topic to gauge depth.
    // cardScope: under the ambient one a cross-program card got neither its
    // hierarchy label nor any sample questions, so the tutor answered blind.
    const programScope = await cardScope(req, card);
    const catalog = await getCatalog(req.userEmail, programScope);
    const idx = metaIndex(catalog);
    const meta = card.topic && idx.has(card.topic) ? idx.get(card.topic) : {};
    const scopeLabel = [meta.course, meta.lesson, card.topic].filter(Boolean).join(' › ') || card.topic || '';
    const pool = card.topic ? await getQuestionsForTopics([card.topic], programScope) : [];
    const questions = shuffle(pool).slice(0, 8).map((q) => ({ question: q.question, answer: q.answer }));

    const out = await generateCardChat(
      {
        topic: card.topic, scopeLabel, concept: card.concept,
        intuition: baseIntuition, formula: baseFormula, visual: baseVisual,
        questions, history, message,
      },
      aiChoice(req),
    );

    const messages = [...history, { role: 'user', text: message }, { role: 'assistant', text: out.reply }];
    await saveCardChat(chatUser, cardId, {
      messages, intuition: out.intuition, formula: out.formula, visual: out.visual,
    });

    res.json({
      reply: out.reply,
      visual: out.visual,
      card: { intuition: out.intuition, formula: out.formula, visual: out.visual, personalized: true },
    });
  } catch (e) {
    next(e);
  }
});

// Auth: revert this user's card to the shared original (drops chat + overlay).
app.post('/api/flashcards/chat/reset', requireAuth, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    await resetCardChat(conversationUser(req), cardId);
    res.json({
      card: { intuition: card.intuition, formula: card.formula, visual: card.visual || null, personalized: false },
    });
  } catch (e) {
    next(e);
  }
});

/* --------------------------- Fix card formatting -------------------------- */
// Candidate detection for the BATCH sweep (the per-card "fixformat" command
// reformats whatever card you point it at, so it does NOT gate on this).
// Deliberately TIGHT to avoid touching valid math: \lambda, \det, \frac etc. are
// KaTeX commands, NOT code, so we strip \texttt{}/\text{}/\<command> BEFORE
// hunting for raw code left inside a $...$ span. A `\implies` on its own is
// legitimate math (derivations), so we only flag the awkward "code chip glued to
// prose by an arrow" pattern (the screenshot case), plus unbalanced $ delimiters.
const CODE_TOK = /\b(def|class|import|return|lambda|print)\b|=>/;
const stripLatex = (s) => String(s)
  .replace(/\\texttt\{[^{}]*\}/g, ' ') // code chips (render fine as <code>)
  .replace(/\\text\{[^{}]*\}/g, ' ')   // \text{...} prose (valid in math)
  .replace(/\\[a-zA-Z]+/g, ' ');       // \lambda, \frac, \det, \implies, ...
function fieldLooksBroken(s) {
  const str = String(s || '');
  if (!str) return false;
  // Unbalanced (odd) count of unescaped $ -> KaTeX delimiter mismatch.
  if (((str.match(/(?<!\\)\$/g) || []).length) % 2 === 1) return true;
  // A \texttt{} code chip immediately glued to prose by an arrow (screenshot style).
  if (/\\texttt\{[^{}]*\}\s*\\(implies|Rightarrow|to)\b/.test(str)) return true;
  // Raw code still sitting inside a math span once real LaTeX is stripped out.
  const spans = stripLatex(str).match(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g) || [];
  return spans.some((sp) => CODE_TOK.test(sp));
}
const flashcardNeedsFormatFix = (c) =>
  fieldLooksBroken(c.formula) || fieldLooksBroken(c.intuition) || fieldLooksBroken(c.concept);

// Keep only cleaned fields that are non-empty AND actually differ, so a bad or
// no-op model response can never blank a card. Returns the accepted patch.
function acceptCardFix(original, out) {
  const patch = {};
  if (!out) return patch;
  for (const f of ['concept', 'intuition', 'formula']) {
    const v = out[f];
    if (typeof v === 'string' && v.trim() && v !== original[f]) patch[f] = v;
  }
  return patch;
}

// Admin: reformat ONE shared flashcard's code/math so it renders correctly, and
// save it for everyone. Meaning is preserved (formatting only); never blanks a
// field. Backs the assistant's "fixformat" quick command. Returns the (possibly
// unchanged) card plus which fields changed.
app.post('/api/flashcards/fix-format', requireAdmin, rateLimitAI, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    const orig = { concept: card.concept || '', intuition: card.intuition || '', formula: card.formula || '' };
    let arr;
    try {
      arr = await reformatFlashcards([{ id: card.id, ...orig }], aiChoice(req));
    } catch {
      return res.status(502).json({ error: 'The reformatter did not return usable output. Try again.' });
    }
    const out = (arr || []).find((o) => o && o.id === card.id) || (arr || [])[0];
    const patch = acceptCardFix(orig, out);
    const changed = Object.keys(patch);
    if (changed.length) await bulkUpdateFlashcards([{ id: card.id, ...patch }]);

    const merged = { ...orig, ...patch };
    res.json({ changed, card: { id: card.id, ...merged } });
  } catch (e) {
    next(e);
  }
});

// Admin: apply a natural-language EDIT to ONE shared flashcard and save it for
// everyone. Unlike fix-format (formatting only) this can change wording/content,
// but only as the instruction asks. Reuses acceptCardFix, so it never blanks a
// field and only persists fields that actually changed. Returns which changed.
app.post('/api/flashcards/edit', requireAdmin, rateLimitAI, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    const instruction = String(req.body?.instruction || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    if (!instruction) return res.status(400).json({ error: 'An edit instruction is required' });
    if (instruction.length > 1000) return res.status(400).json({ error: 'Instruction is too long (max 1000 characters)' });

    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    const orig = { concept: card.concept || '', intuition: card.intuition || '', formula: card.formula || '' };
    let out;
    try {
      out = await editFlashcard({ id: card.id, ...orig }, instruction, aiChoice(req));
    } catch {
      return res.status(502).json({ error: 'The editor did not return usable output. Try again.' });
    }
    const patch = acceptCardFix(orig, out);
    const changed = Object.keys(patch);
    if (changed.length) await bulkUpdateFlashcards([{ id: card.id, ...patch }]);

    const merged = { ...orig, ...patch };
    res.json({ changed, card: { id: card.id, ...merged } });
  } catch (e) {
    next(e);
  }
});

// Admin: manual edit — save the exact text the admin typed for ONE shared card
// (no AI involved). Concept and intuition are required; formula may be blank.
// Persists only the fields that actually changed and returns which those were.
app.post('/api/flashcards/set', requireAdmin, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });

    const concept = String(req.body?.concept ?? '').trim();
    const intuition = String(req.body?.intuition ?? '').trim();
    // Formula is optional: keep the admin's text (only trim trailing space) and
    // allow an empty value to clear it.
    const formula = String(req.body?.formula ?? '').replace(/\s+$/, '');
    if (!concept) return res.status(400).json({ error: 'The concept (front of the card) cannot be empty' });
    if (!intuition) return res.status(400).json({ error: 'The intuition cannot be empty' });
    if (concept.length > 4000 || intuition.length > 8000 || formula.length > 8000) {
      return res.status(400).json({ error: 'One of the fields is too long' });
    }

    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    const orig = { concept: card.concept || '', intuition: card.intuition || '', formula: card.formula || '' };
    const next_ = { concept, intuition, formula };
    const patch = {};
    for (const f of ['concept', 'intuition', 'formula']) {
      if (next_[f] !== orig[f]) patch[f] = next_[f];
    }
    const changed = Object.keys(patch);
    if (changed.length) await bulkUpdateFlashcards([{ id: card.id, ...patch }]);

    const merged = { ...orig, ...patch };
    res.json({ changed, card: { id: card.id, ...merged } });
  } catch (e) {
    next(e);
  }
});

// Admin: put ONE shared card into Highway (rapid review) or take it out. The
// generator tags roughly a third of a deck automatically; this is the manual
// override for the ones it judged wrong, and it is shared like every other card
// edit. Idempotent — pass `highway` explicitly, or omit it to flip the current
// value. Book cards are excluded: a book deck is all-highway by construction, so
// the filter (and its badge) would mean nothing there.
app.post('/api/flashcards/highway', requireAdmin, async (req, res, next) => {
  try {
    const cardId = String(req.body?.cardId || '').trim();
    if (!cardId) return res.status(400).json({ error: 'cardId is required' });
    const card = await getFlashcardById(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    if (card.kind) return res.status(400).json({ error: 'Book cards are all rapid-review already — Highway does not apply' });

    const was = !!card.highway;
    const highway = req.body?.highway === undefined ? !was : req.body.highway === true;
    if (highway !== was) await bulkUpdateFlashcards([{ id: card.id, highway }]);
    res.json({ ok: true, highway, changed: highway !== was });
  } catch (e) {
    next(e);
  }
});

/* ------------------------ Fix quiz-question formatting -------------------- */
// Raw HTML that leaked into a question renders literally (the "<code>def
// demo(a, b, *args):</code>" case), so flag any recognised tag. Combined with
// the flashcard-style checks (code inside $...$, unbalanced $) this decides the
// BATCH sweep's candidates; the per-question button fixes whatever you point it
// at and does NOT gate on this.
const HTML_TAG = /<\/?(code|pre|b|i|strong|em|u|br|span|sub|sup|tt|kbd|samp|mark)\b[^>]*>/i;
// A literal control char glued to lowercase text is a LaTeX command mangled by
// JSON parsing (e.g. "\texttt" -> TAB+"exttt"); flag it so the batch sweep fixes
// these even though they contain no HTML and parse fine. \b here is backspace.
const CTRL_LATEX = /[\t\f\b\r\n][a-z]/;
const questionFieldLooksBroken = (s) =>
  HTML_TAG.test(String(s || '')) || CTRL_LATEX.test(String(s || '')) || fieldLooksBroken(s);
const questionNeedsFormatFix = (q) =>
  questionFieldLooksBroken(q.question) ||
  (Array.isArray(q.options) && q.options.some(questionFieldLooksBroken)) ||
  questionFieldLooksBroken(q.answer);

// Deterministically repair control-char-mangled LaTeX across a question's text
// fields (same transform as gemini's, applied to the {question, options, answer}
// shape the fixer uses). The answer<->option match is preserved because every
// field is cleaned identically.
const cleanQuestionEscapes = (q) => ({
  question: restoreLatexEscapes(q.question || ''),
  options: (q.options || []).map((o) => restoreLatexEscapes(String(o))),
  answer: restoreLatexEscapes(q.answer || ''),
});

// Validate a reformatted question before saving: keep the same option count, and
// require the answer to still equal one option exactly (trimmed). Returns the
// accepted {question, options, answer} — falling back to the original per field —
// or null if the shape is unusable, so a bad model response never corrupts a
// question. Never blanks a field.
function acceptQuestionFix(orig, out) {
  if (!out) return null;
  const question = typeof out.question === 'string' && out.question.trim() ? out.question : orig.question;
  const options = Array.isArray(out.options) && out.options.length === orig.options.length
    ? out.options.map(String)
    : orig.options;
  const answer = typeof out.answer === 'string' && out.answer.trim() ? out.answer : orig.answer;
  const answerMatches = options.map((s) => s.trim()).includes(String(answer).trim());
  if (!answerMatches) return null;
  return { question, options, answer };
}

// List which of question/options/answer actually changed (so the UI can report it
// and we skip a no-op write).
function questionFixChanges(orig, fix) {
  const changed = [];
  if (fix.question !== orig.question) changed.push('question');
  if (JSON.stringify(fix.options) !== JSON.stringify(orig.options)) changed.push('options');
  if (fix.answer !== orig.answer) changed.push('answer');
  return changed;
}

// Admin: reformat ONE shared quiz question's code/math (and strip any raw HTML)
// so it renders correctly, and save it for everyone. Meaning is preserved
// (formatting only); the answer stays matched to an option. Backs the quiz
// view's "Fix format" button. Returns the (possibly unchanged) question plus
// which fields changed.
app.post('/api/questions/fix-format', requireAdmin, rateLimitAI, async (req, res, next) => {
  try {
    const questionId = String(req.body?.questionId || '').trim();
    if (!questionId) return res.status(400).json({ error: 'questionId is required' });
    const q = await getQuestionById(questionId);
    if (!q) return res.status(404).json({ error: 'Question not found' });

    const stored = {
      question: q.question || '',
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      answer: q.answer || '',
    };
    // Deterministically repair control-char-mangled LaTeX first, so the model
    // sees valid LaTeX AND so this class of breakage is fixed even if the model
    // returns the text unchanged. `cleaned` is the AI input and the fallback.
    const cleaned = cleanQuestionEscapes(stored);
    let arr;
    try {
      arr = await reformatQuestions([{ id: q.id, ...cleaned }], aiChoice(req));
    } catch {
      return res.status(502).json({ error: 'The reformatter did not return usable output. Try again.' });
    }
    const out = (arr || []).find((o) => o && o.id === q.id) || (arr || [])[0];
    const fix = acceptQuestionFix(cleaned, out);
    if (!fix) return res.status(502).json({ error: 'The reformatter returned an unusable result. Try again.' });

    // Compare against the TRUE stored value so a control-char-only repair still
    // counts as a change and gets saved.
    const changed = questionFixChanges(stored, fix);
    if (changed.length) await bulkUpdateQuestions([{ id: q.id, ...fix }]);

    res.json({ changed, question: { id: q.id, ...fix } });
  } catch (e) {
    next(e);
  }
});

// Admin: manual edit — save the exact question text/options/answer an admin
// typed, shared for everyone (no AI). The sibling of /api/flashcards/set, and
// the write behind both the quiz view's "Edit this question" panel and the
// Composing Room's question browser.
//
// The answer MUST still equal one of the options, or the question becomes
// unanswerable for everyone: handleAnswer() in the frontend grades by comparing
// the clicked option's text to `answer`, so an answer that matches nothing marks
// every attempt wrong. That check is the whole reason this isn't a raw write.
app.post('/api/questions/set', requireAdmin, async (req, res, next) => {
  try {
    const questionId = String(req.body?.questionId || '').trim();
    if (!questionId) return res.status(400).json({ error: 'questionId is required' });

    const question = String(req.body?.question ?? '').trim();
    const options = (Array.isArray(req.body?.options) ? req.body.options : [])
      .map((o) => String(o ?? '').trim())
      .filter(Boolean);
    const answer = String(req.body?.answer ?? '').trim();
    if (!question) return res.status(400).json({ error: 'The question cannot be empty' });
    if (options.length < 2) return res.status(400).json({ error: 'A question needs at least two options' });
    if (new Set(options).size !== options.length) return res.status(400).json({ error: 'Two options are identical — the learner could not tell them apart' });
    if (!options.includes(answer)) return res.status(400).json({ error: 'The answer must match one of the options exactly' });
    if (question.length > 4000 || options.some((o) => o.length > 2000)) {
      return res.status(400).json({ error: 'One of the fields is too long' });
    }

    const q = await getQuestionById(questionId);
    if (!q) return res.status(404).json({ error: 'Question not found' });

    const orig = {
      question: q.question || '',
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      answer: q.answer || '',
    };
    const fix = { question, options, answer };
    const changed = questionFixChanges(orig, fix);
    if (changed.length) await bulkUpdateQuestions([{ id: q.id, ...fix }]);

    res.json({ changed, question: { id: q.id, ...fix } });
  } catch (e) {
    next(e);
  }
});

// Scope-level chat id: works for any track/course/lesson selection.
const scopeChatId = ({ track, course, lesson }) =>
  slug(track || '', isAll(course) ? '' : course || '', isAll(lesson) ? '' : lesson || '');

// Auth: load this user's saved chat thread for a lesson/course scope.
// (conversationUser throughout the chat endpoints: threads are private to the
// signed-in person and never default to the legacy owner's account.)
app.get('/api/chat', requireAuth, async (req, res, next) => {
  try {
    const id = scopeChatId(req.query || {});
    const messages = await getScopeChat(conversationUser(req), id);
    res.json({ messages });
  } catch (e) {
    next(e);
  }
});

// Auth: send a message about a whole section. Reads the section's flashcards +
// quiz questions to answer big-picture questions. Rate-limited (an AI call).
app.post('/api/chat', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'A message is required' });

    const programScope = await requestScope(req);
    const catalog = await getCatalog(req.userEmail, programScope);
    const scoped = scopeCatalog(catalog, req.body || {});
    const topics = [...new Set(scoped.map((r) => r.topic))].filter(Boolean).slice(0, 60);
    if (!topics.length) return res.status(400).json({ error: 'No topics in this section yet' });

    const { track, course, lesson, topic } = req.body || {};
    const scopeLabel = !isAll(topic) ? topic
      : !isAll(lesson) ? lesson
      : !isAll(course) ? course
      : !isAll(track) ? track
      : 'Your selection';

    const pool = await getQuestionsForTopics(topics, programScope);
    const questions = shuffle(pool).slice(0, 30).map((q) => ({ topic: q.topic, question: q.question, answer: q.answer }));

    // Include the section's flashcards when a deck exists (course/lesson scope).
    let cards = [];
    const fscope = flashcardScope(req.body || {});
    if (fscope.course && flashcardsEnabledFor(fscope.course)) {
      try { cards = await getFlashcards(fscope); } catch { /* no deck; questions are enough */ }
    }

    const id = scopeChatId(req.body || {});
    const chatUser = conversationUser(req);
    const history = await getScopeChat(chatUser, id);

    const out = await generateScopeChat(
      { scopeLabel, topics, cards, questions, history, message },
      aiChoice(req),
    );

    const messages = [...history, { role: 'user', text: message }, { role: 'assistant', text: out.reply }].slice(-40);
    await saveScopeChat(chatUser, id, messages);

    res.json({ reply: out.reply, visual: out.visual });
  } catch (e) {
    next(e);
  }
});

// Auth: delete this user's saved chat thread for a lesson/course scope. Same
// conversationUser scoping as the read/write above — you can only wipe your OWN.
app.delete('/api/chat', requireAuth, async (req, res, next) => {
  try {
    const id = scopeChatId(req.query || {});
    if (!id) return res.status(400).json({ error: 'A track/course/lesson scope is required' });
    await deleteScopeChat(conversationUser(req), id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* --------------------------- Global AI assistant -------------------------- */
// Auth: list this user's saved conversations (metadata for the history dropdown).
app.get('/api/assistant/chats', requireAuth, async (req, res, next) => {
  try {
    res.json({ chats: await listAssistantChats(conversationUser(req)) });
  } catch (e) {
    next(e);
  }
});

// Auth: load one conversation's messages (by ?id=), or the most recent if no id.
app.get('/api/assistant/chat', requireAuth, async (req, res, next) => {
  try {
    const id = req.query?.id ? String(req.query.id) : '';
    const chatUser = conversationUser(req);
    if (id) {
      const chat = await getAssistantChat(chatUser, id);
      return res.json(chat || { id: '', title: '', messages: [] });
    }
    const list = await listAssistantChats(chatUser);
    if (!list.length) return res.json({ id: '', title: '', messages: [] });
    const chat = await getAssistantChat(chatUser, list[0].id);
    return res.json(chat || { id: '', title: '', messages: [] });
  } catch (e) {
    next(e);
  }
});

// Auth: delete one conversation (the history dropdown's trash button).
app.delete('/api/assistant/chat', requireAuth, async (req, res, next) => {
  try {
    const id = req.query?.id ? String(req.query.id) : '';
    if (!id) return res.status(400).json({ error: 'A conversation id is required' });
    await deleteAssistantChat(conversationUser(req), id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// A content-location question ("which card teaches X", "where is Y", "is there a
// lesson on Z") — only then do we spend tokens grounding the assistant in the full
// catalog so it answers from real topics instead of inventing a card name. Also
// matches remove/restore phrasing ("let's skip this for now", "hide that lesson"):
// the Coach's remove_section/restore_section proposals must copy names verbatim
// from this grounding, so those turns need the catalog too.
function looksLikeCatalogLookup(msg) {
  return /\b(card|deck|topic|sub-?lesson|lesson|course|track|section|module|curriculum|syllabus|teach|cover|where|study|learn about|is there|which|list|find|remove|hide|restore|skip)\b/i.test(String(msg || ''));
}

/** Which mentor (if any) THIS message is about, matched against the learner's own roster.
 *  Matches the full name or any distinctive part of it, because people type "what would Nick say",
 *  not "what would Nick Saraev say". Parts shorter than 4 chars are ignored so a mentor called
 *  "Al" can't match every message containing "all". */
function mentorNamedIn(msg, roster) {
  const text = ` ${String(msg || '').toLowerCase()} `;
  let best = '';
  for (const m of roster) {
    const name = String(m.name || '');
    if (!name) continue;
    const parts = name.toLowerCase().split(/\s+/).filter((p) => p.length >= 4);
    const hit = text.includes(` ${name.toLowerCase()} `) || parts.some((p) => text.includes(p));
    // Prefer the longest matching name: "Ben Heath - Google Ads" should beat "Ben Heath"
    // when the learner actually named the more specific one.
    if (hit && name.length > best.length) best = name;
  }
  return best;
}

/** Asking to be coached BY someone, rather than merely about them ("act as Nick", "channel Nick",
 *  "what would Nick say", "mentor me as..."). Only a signal for WHEN to retrieve — the persona
 *  itself is driven by the prompt block in lib/gemini.js. */
function looksLikeMentorAsk(msg) {
  return /\b(act|speak|talk|respond|answer|reply|coach|mentor|advise|channel|roleplay|role-play|pretend|as if you (?:are|were)|in the (?:voice|style)|what would|how would|what does|what do you think .* would)\b/i
    .test(String(msg || ''));
}

/** Grounding for the mentor-library features: the passages from the learner's imported mentor
 *  transcripts that bear on this message. Null when there's nothing to add.
 *
 *  WHEN we search (each Sentinel round trip costs, so this is deliberate):
 *    - they NAMED a mentor they own material for  -> search that mentor (the "what would Nick
 *      say about my plan" / "act as Nick" case),
 *    - or it's a COACH turn that reads like asking for guidance -> search the whole library, so
 *      real mentor material can inform ordinary coaching without being asked for by name.
 *  Otherwise we skip it: a plain "explain gradient descent" needs no mentor lookup.
 *
 *  NEVER throws (mentorSearch degrades to null), so a Sentinel outage just means no mentor block. */
async function mentorGroundingFor(email, message, holistic, coach) {
  const roster = (holistic && Array.isArray(holistic.mentors)) ? holistic.mentors : [];
  if (!roster.length) return null;
  const named = mentorNamedIn(message, roster);
  if (!named && !(coach && looksLikeMentorAsk(message))) return null;
  return mentorSearch(email, { q: message, mentor: named, limit: named ? 10 : 6 });
}

// How much growth-journal BODY text we'll pull into one turn's prompt, in characters (~6k tokens).
// Below this the whole journal ships and there is no retrieval at all; above it we choose. Raising
// it costs tokens on every turn; lowering it makes the coach choose sooner, never wrong.
const GROWTH_HYDRATE_BUDGET_CHARS = 24000;
// Mirrors MAX_GROWTH_DETAIL_IDS in Sentinel's development service. Asking for more than it accepts
// would have it silently drop the tail, and we'd then render those entries as loaded when they
// weren't — the precise lie this whole design exists to prevent. Anything past this is a declared gap.
const GROWTH_MAX_IDS = 50;

const GROWTH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'was', 'are', 'you', 'your', 'about', 'what',
  'how', 'why', 'can', 'have', 'has', 'from', 'into', 'they', 'them', 'his', 'her', 'our',
  'not', 'but', 'all', 'any', 'out', 'get', 'got', 'did', 'does', 'were', 'been', 'more',
  'some', 'than', 'then', 'there', 'when', 'who', 'whom', 'will', 'would', 'should', 'could',
  'much', 'many', 'just', 'like', 'want', 'need', 'know', 'tell', 'show', 'give', 'make',
]);

/** Content words of a string, for the cheap title match below. */
function growthTerms(s) {
  return new Set(
    String(s || '').toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !GROWTH_STOPWORDS.has(w)),
  );
}

/** Grounding for the learner's growth journal — the "big" half of small-to-big retrieval.
 *
 *  Sentinel ships a COMPLETE index (every entry's title, uncapped) on every turn; the bodies are
 *  fetched here, whole, for the entries this turn actually bears on. Three properties matter, and
 *  each of them is load-bearing:
 *
 *   1. WHILE IT FITS, EVERYTHING SHIPS. If the entire journal is under the budget we hydrate all of
 *      it and skip scoring entirely — no retrieval, no misses, nothing to get wrong. Retrieval only
 *      switches on once the corpus genuinely outgrows the prompt, which is the point at which its
 *      risk finally buys something. Small and complete beats large and sampled.
 *   2. BODIES ARE WHOLE OR ABSENT. We budget from the index's `chars` BEFORE fetching, so a body is
 *      never cut to fit. A truncated note is indistinguishable to the model from a complete one and
 *      gets summarised as though it were the whole thing — the original bug, one layer down.
 *   3. GAPS ARE DECLARED. Whatever we chose not to load comes back in `skipped` and is named in the
 *      prompt. That is what keeps a retrieval miss recoverable: the coach can say "you have a note
 *      called X that I haven't opened" instead of "you have no note about X".
 *
 *  NEVER throws (growthDetail degrades to null) — a Sentinel outage just means titles-only, which is
 *  degraded but still honest. */
async function growthGroundingFor(email, message, holistic) {
  const index = (holistic && holistic.growth && Array.isArray(holistic.growth.index))
    ? holistic.growth.index : [];
  const withBody = index.filter((e) => e && Number(e.chars) > 0);
  if (!withBody.length) return null;

  const total = withBody.reduce((n, e) => n + Number(e.chars), 0);
  let chosen;
  if (total <= GROWTH_HYDRATE_BUDGET_CHARS && withBody.length <= GROWTH_MAX_IDS) {
    chosen = withBody;                                   // (1) it all fits — no retrieval needed
  } else {
    // Rank by how many content words the title shares with the message, then by recency (Sentinel
    // orders the index newest-first). Titles are all we have to match on — that IS the "small" half
    // — which is exactly why the gaps below get declared rather than swallowed.
    const terms = growthTerms(message);
    const scored = withBody.map((e, i) => {
      let hits = 0;
      for (const w of growthTerms(e.title)) if (terms.has(w)) hits += 1;
      // Open entries edge out resolved/archived ones at equal relevance: an obstacle they're still
      // living with matters more to this turn than one they closed months ago.
      const live = e.status === 'open' ? 0.5 : 0;
      return { e, rank: hits + live, i };
    }).sort((a, b) => (b.rank - a.rank) || (a.i - b.i));

    chosen = [];
    let spent = 0;
    for (const { e } of scored) {
      // The top-ranked entry is always taken WHOLE even if it alone blows the budget — it's the
      // thing they most likely asked about, and half of it would be worse than none of it.
      if (chosen.length && (spent + Number(e.chars) > GROWTH_HYDRATE_BUDGET_CHARS
        || chosen.length >= GROWTH_MAX_IDS)) continue;
      chosen.push(e);
      spent += Number(e.chars);
    }
  }

  const keep = new Set(chosen.map((e) => e.id));
  const skipped = withBody.filter((e) => !keep.has(e.id))
    .map((e) => ({ id: e.id, title: e.title, kind: e.kind, chars: e.chars }));
  const got = await growthDetail(email, chosen.map((e) => e.id));
  if (!got) {
    // Sentinel unreachable: every hydratable entry is now a gap. Say so — the index is still
    // rendered from the profile, so the coach knows what exists, just not what any of it says.
    return { entries: [], skipped: withBody.map((e) => ({ id: e.id, title: e.title, kind: e.kind, chars: e.chars })), failed: true };
  }
  return { entries: got.entries, skipped, failed: false };
}

// Mirrors MAX_WORK_DETAIL_IDS in Sentinel's work_digest service — ask for more and it drops the tail
// silently, which would render un-loaded cards as loaded (the same lie the growth split avoids).
const WORK_MAX_IDS = 25;
// How many cards we'd ever pull the full body of in one turn. Task bodies carry comment threads, so
// this is far smaller than the id cap: a turn is about one or two cards, not a whole board.
const WORK_HYDRATE_TOP = 6;

/** Grounding for the learner's TASK BOARD — the "big" half of small-to-big retrieval, again.
 *
 *  Sentinel's digest lists every card they may see as ONE COMPACT LINE (title, status, dates, who
 *  holds it) and that index is complete for their own work, so "do I have anything about the TCS
 *  landing page?" is already answerable without this. What the line cannot carry is the inside of a
 *  card: the description, the internal notes, the breakdown's steps and the comment thread. This
 *  fetches those, whole, for the handful of cards the turn is actually about.
 *
 *  Why retrieval here is keyed off the MESSAGE and not a budget (unlike the growth journal): the
 *  digest carries no per-card size, so there is nothing to budget against before fetching. A board
 *  also behaves differently from a journal — most turns ("what should I do today?") are answered
 *  from the lines alone, and hydrating six comment threads to answer them would be pure cost.
 *
 *  So: a card is hydrated when the learner NAMES it — by `#id`, or by words that appear in its title.
 *  A miss is safe and recoverable, because the card's line is in the prompt regardless and the block
 *  tells the coach not to describe a card's contents it wasn't given (it can ask which one they mean,
 *  and the next turn's message will name it).
 *
 *  NEVER throws (workDetail degrades to null) — a Sentinel outage just means lines without bodies. */
async function workGroundingFor(email, message, work) {
  const cards = [
    ...(((work && work.mine && work.mine.open) || [])),
    ...(((work && work.board && work.board.others) || [])),
  ].filter((c) => Number.isInteger(c && c.id));      // Atrium cards have string ids and no bodies here
  if (!cards.length) return null;

  // An explicit "#412" is an unambiguous request for that card — always honour it, whatever the rest
  // of the sentence says.
  const named = new Set(
    [...String(message || '').matchAll(/#(\d{1,9})\b/g)].map((m) => Number(m[1])),
  );
  const terms = growthTerms(message);                // same content-word split; one definition
  const scored = cards.map((c, i) => {
    if (named.has(c.id)) return { c, rank: 99, i };
    let hits = 0;
    for (const w of growthTerms(c.title)) if (terms.has(w)) hits += 1;
    // Their own work edges out a colleague's at equal relevance — most questions are about their plate.
    return { c, rank: hits + (c.mine ? 0.5 : 0), i };
  }).filter((s) => s.rank >= 1)                      // no title/id match at all ⇒ this turn needs no body
    .sort((a, b) => (b.rank - a.rank) || (a.i - b.i));
  if (!scored.length) return null;

  const ids = scored.slice(0, Math.min(WORK_HYDRATE_TOP, WORK_MAX_IDS)).map((s) => s.c.id);
  const got = await workDetail(email, ids);
  return got ? { cards: got.cards } : null;
}

/* ------------------------------ DEEP MODE --------------------------------- */
/*
 * "Look it up" — the opt-in grounding tier, off by default.
 *
 * WHY IT IS A MODE AND NOT ALWAYS ON. Everything below costs a Firestore read set and a large
 * slice of prompt on a path the learner sits watching: the question bank for a section is
 * hundreds of docs, a study guide is tens of thousands of characters. The ordinary turn
 * ("explain this") needs none of it and is fast because it pays for none of it. So the learner
 * arms it deliberately with the Deep chip, exactly like coach mode — and unlike coach mode it is
 * SCOPE-BOUND: it loads the section they are actually looking at, not their whole shelf.
 *
 * The three sources answer three different questions the assistant could not previously answer:
 *   - the QUESTION BANK   -> "am I ready for this quiz?" (it can rehearse the real items)
 *   - PER-TOPIC PROGRESS  -> "how am I doing on this?" (real accuracy/mastery, not a name in a list)
 *   - the STUDY GUIDE     -> "open my notes on X" (the written lesson, verbatim)
 *
 * Same posture as the growth journal and the task board: budget BEFORE fetching, ship a body
 * whole or not at all, and DECLARE every gap — a section with no cached guide must read as
 * "you haven't generated notes for this yet", never as "there is nothing to know here".
 */

// One section's bank, capped. 60 questions is more than any real lesson holds and still ~20k chars
// with options; past that we are pasting a course, not a section, and the model stops rehearsing
// and starts summarising.
const DEEP_MAX_QUESTIONS = 60;
// The written guide ships WHOLE or not at all (a half-guide reads exactly like a complete one).
// Guides run 8-20k chars; anything past this is a course-level guide that would crowd out the bank.
const DEEP_GUIDE_CHARS = 26000;
// How many topics of per-topic progress to print. A lesson is ~5-15 sub-lessons; a course scope can
// be a hundred, and the tail is noise next to the section on screen.
const DEEP_MAX_TOPICS = 40;

/**
 * WHICH SECTION deep mode is about, read off what is on screen — most specific wins.
 *
 * A visual guide or a flashcard pins the section harder than the setup dropdowns do: the learner
 * can have "Review All" selected on the home screen and still be looking at one lesson's visual
 * guide. Returns null when nothing on screen names a section, which the prompt block declares
 * rather than papering over with the whole shelf.
 */
function deepScopeFrom(context = {}) {
  const viz = context.visual && context.visual.scope;
  if (viz && (viz.track || viz.course || viz.lesson || viz.topic)) return viz;
  if (context.card && context.card.topic) return { topic: context.card.topic };
  const s = context.scope || {};
  if (!isAll(s.topic) || !isAll(s.lesson) || !isAll(s.course) || !isAll(s.track)) return s;
  // Nothing selected, but they have been answering questions: the topics they just practised are
  // the truest statement of what they are working through.
  const recent = [...new Set((context.recent || []).map((r) => r && r.topic).filter(Boolean))];
  return recent.length ? { topics: recent } : null;
}

/**
 * The opt-in bundle: the section's real question bank (with answers), the learner's own numbers on
 * those topics, and the cached written guide. Returns `{ scopeLabel, topics, questions, progress,
 * guide, gaps }` — `gaps` names what could not be loaded so the prompt can say so out loud.
 *
 * 🔴 Derived numbers come from lib/priority.js, never re-implemented here. `mastery` is the
 * depth-aware score behind the learner's own Coverage/Mastery toggle; a second implementation
 * would quote them a number their progress tree disagrees with (AGENTS.md §3).
 *
 * NEVER throws: every source degrades to a declared gap, because a deep turn that 500s is strictly
 * worse than a deep turn that says "I couldn't open your notes".
 */
/**
 * What section is on screen, resolved to REAL catalog rows and the program they live in.
 *
 * Extracted so deep mode and source grounding cannot drift apart: the shelf-vs-program
 * rule below is subtle, was already the site of one silent bug, and two copies of it is
 * how that bug comes back on only one of the two paths.
 *
 * @returns {Promise<{scope, rows, program}|null>} null when nothing on screen resolves.
 */
async function onScreenScope(req, context) {
  const scope = deepScopeFrom(context);
  if (!scope) return null;
  const email = req.userEmail;
  const programScope = await requestScope(req);
  const match = (catalog) => (Array.isArray(scope.topics)
    ? catalog.filter((r) => scope.topics.includes(r.topic))
    : scopeCatalog(catalog, scope));

  // The section on screen is matched against their SHELF, which spans programs - never
  // against one program's catalog. This once read `getCatalog(email, requestScope(req))`,
  // a scoping bug of exactly the `cardScope` shape one level up: the assistant's POST
  // carries no `program`, so requestScope falls back to the learner's FIRST enrolled
  // program while the screen behind it is engineCatalog's cross-program shelf. On the live
  // shelf 285 of 808 topics sat in a second program, so every deep turn on that half
  // matched zero rows - with the bank sitting right there.
  //
  // A PINNED session is the exception and wins: Sentinel's Philosophical/Spiritual tabs
  // are one program for the whole session, and that program may not be on the shelf at
  // all. The program scope is also the fallback for anyone with no shelf built yet.
  let rows = [];
  if (!pinnedProgram(req, programScope)) rows = match(await engineCatalog(email));
  if (!rows.length) rows = match(await getCatalog(email, programScope));
  if (!rows.length) return null;

  // The program comes from the rows we MATCHED, never from the request - they are what is
  // on screen. A `topics` scope can straddle two programs, so take the majority.
  const tally = new Map();
  for (const r of rows) tally.set(programOf(r), (tally.get(programOf(r)) || 0) + 1);
  const program = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { scope, rows, program };
}

/**
 * The SOURCE MATERIAL behind the section on screen - the actual transcripts filed in the
 * Library, so an answer can rest on the learner's own course rather than the model's
 * general knowledge, and can name which document it came from.
 *
 * Deliberately separate from deep mode: deep carries the ANSWER KEY and is the wrong thing
 * to leave switched on while studying, but wanting answers grounded in your own material
 * is not. Budgeted and fail-soft, like every other grounding source.
 */
async function sourceGroundingFor(req, context) {
  const NL = String.fromCharCode(10);
  const SEP = NL + NL;
  const hit = await onScreenScope(req, context);
  if (!hit) return null;
  const { scope, program } = hit;
  // Transcripts key off a real course+lesson tuple, so the `topics` fallback (the
  // recently-practised list) has no scope to fetch against.
  if (Array.isArray(scope.topics) || !scope.course || isAll(scope.course)) return null;
  const docs = await getScopeTranscripts({
    program,
    course: scope.course,
    lesson: (scope.lesson && !isAll(scope.lesson)) ? scope.lesson : undefined,
  });
  if (!docs.length) return null;
  const used = [];
  let text = '';
  for (const d of docs) {
    const body = String(d.text || '').trim();
    if (!body || text.length + body.length > GUIDE_SOURCE_BUDGET) continue;
    text += (text ? SEP : '') + '--- ' + (d.title || 'Untitled') + NL + body;
    used.push(d.title || 'Untitled');
  }
  if (!used.length) return null;
  return {
    label: [scope.course, scope.lesson].filter((v) => v && !isAll(v)).join(' > '),
    titles: used,
    text,
  };
}

async function deepGroundingFor(req, context) {
  const scope = deepScopeFrom(context);
  if (!scope) return { gaps: ['nothing on screen names a section'] };

  const gaps = [];
  const email = req.userEmail;
  const programScope = await requestScope(req);
  const match = (catalog) => (Array.isArray(scope.topics)
    ? catalog.filter((r) => scope.topics.includes(r.topic))
    : scopeCatalog(catalog, scope));

  // 🔴 The section on screen is matched against their SHELF, which spans programs — never against
  // one program's catalog. This read `getCatalog(email, requestScope(req))` and that is a scoping
  // bug of exactly the `cardScope` shape (§7), one level up: the assistant's POST carries no
  // `program`, so requestScope falls back to the learner's FIRST enrolled program while the screen
  // behind it is engineCatalog's cross-program shelf. Measured on the live shelf: 285 of 808 topics
  // sat in a second program, so every deep turn on that entire half of their engine matched zero
  // rows and answered "deep mode couldn't load anything" — with the bank sitting right there.
  //
  // A PINNED session is the exception and wins: Sentinel's Philosophical/Spiritual tabs are one
  // program for the whole session, and that program may not be on the shelf at all (see
  // pinnedProgram). The program scope is also the fallback for anyone with no shelf built yet.
  let rows = [];
  if (!pinnedProgram(req, programScope)) rows = match(await engineCatalog(email));
  if (!rows.length) rows = match(await getCatalog(email, programScope));
  if (!rows.length) return { gaps: ['the section on screen matched no topics in their engine'] };

  // The program comes from the rows we MATCHED, never from the request — they are what is on
  // screen. Per topic, because a `topics` scope (the recently-practised fallback) can legitimately
  // straddle two programs; and because a topic NAME is not unique across programs, which is the
  // collision `filterQuestions` exists for. Comparing each question's own program to its row's
  // settles it exactly, where a single scope could only approximate.
  const programByTopic = new Map(rows.map((r) => [r.topic, programOf(r)]));
  const tally = new Map();
  for (const r of rows) tally.set(programOf(r), (tally.get(programOf(r)) || 0) + 1);
  const guideProgram = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const topics = [...new Set(rows.map((r) => r.topic).filter(Boolean))];
  const scopeLabel = Array.isArray(scope.topics)
    ? `the topics they just practised: ${scope.topics.join(', ')}`
    : [scope.track, scope.course, scope.lesson, scope.topic]
      .filter((v) => !isAll(v)).join(' › ') || 'their current selection';

  // The bank and the guide are independent reads; the progress rows are already in `catalog`.
  const [bank, guide] = await Promise.all([
    // Read unscoped, then keep only the questions whose program matches their OWN topic's row.
    getQuestionsForTopics(topics.slice(0, DEEP_MAX_TOPICS), null)
      .then((qs) => qs.filter((q) => programByTopic.get(q.topic) === programOf(q)))
      .catch(() => { gaps.push('their question bank could not be read'); return []; }),
    // A guide is keyed by its exact scope tuple, so a `topics` fallback (no tuple) has none to fetch.
    (Array.isArray(scope.topics) ? Promise.resolve(null) : Promise.all([
      getStudyGuide({ ...scope, program: guideProgram, kind: 'lesson' }),
      getStudyGuide({ ...scope, program: guideProgram, kind: 'review' }),
    ]).then(([lesson, review]) => lesson || review))
      .catch(() => { gaps.push('their study guide could not be read'); return null; }),
  ]);

  // Real accuracy + both scoring formulas, per topic. `lastAttempted` is normalised through
  // `toDate` exactly as /api/catalog does — it arrives as a Firestore timestamp, and retention
  // decay silently reads "never" from an unconverted one.
  const progress = rows.slice(0, DEEP_MAX_TOPICS).map((r) => {
    const stats = {
      correctCount: r.correctCount ?? 0,
      totalAttempts: r.totalAttempts ?? 0,
      lastAttempted: toDate(r.lastAttempted),
    };
    const d = deriveStats(stats);
    return {
      topic: r.topic,
      lesson: r.lesson || '',
      attempts: stats.totalAttempts,
      correct: stats.correctCount,
      accuracy: stats.totalAttempts ? d.accuracy : null,
      mastery: d.mastery,
      priority: d.priority,
      daysSince: stats.totalAttempts ? d.daysSince : null,
      questions: bank.filter((q) => q.topic === r.topic).length,
    };
  });
  if (rows.length > DEEP_MAX_TOPICS) {
    gaps.push(`${rows.length - DEEP_MAX_TOPICS} further topic(s) in this section were not loaded`);
  }

  // Answers ride along on purpose — the learner turned this on to be QUIZZED, and grading an oral
  // answer against the real key is the whole point. The prompt block carries the one rule that
  // survives this: the UNANSWERED question on their screen is still off-limits.
  const questions = shuffle(bank).slice(0, DEEP_MAX_QUESTIONS).map(publicQuestion)
    .map((q) => ({ topic: q.topic, question: q.question, options: q.options, answer: q.answer }));
  if (bank.length > questions.length) {
    gaps.push(`${bank.length - questions.length} of their ${bank.length} questions in this section were not loaded`);
  }

  let guideText = null;
  if (guide && guide.markdown) {
    // Whole or absent — never a slice. A truncated guide reads exactly like a complete one and gets
    // taught as though it were the whole lesson.
    if (String(guide.markdown).length <= DEEP_GUIDE_CHARS) guideText = String(guide.markdown);
    else gaps.push(`their written guide for this section is too long to load (${guide.markdown.length} chars)`);
  } else if (!Array.isArray(scope.topics)) {
    gaps.push('they have not generated a written study guide for this section yet');
  }

  return { scopeLabel, topics, questions, progress, guide: guideText, bankTotal: bank.length, gaps };
}

/** The learner's accessible catalog (their Mastery-Engine shelf), as {track,course,lesson,topic}
 *  rows — the real curriculum the assistant grounds "which card teaches X" answers in.
 *  Sections the learner TEMPORARILY REMOVED ride along marked `removed: true` (a hidden
 *  prefix covers them and no deeper inclusion rescues them), so the assistant knows what
 *  was parked — it can discuss it and propose restore_section by exact name — instead of
 *  being blind to it. Consumers that mean "the active engine" must filter `!removed`
 *  (coachDigest does; the prompt renders removed rows as their own clearly-labelled list). */
async function learnerCatalog(email) {
  if (!email) return [];
  const tracks = (await effectiveShelf(email)) || [];
  const shelf = (await getShelf(email)) || {};
  const included = shelf.included || [], hidden = shelf.hidden || [];
  if (!tracks.length && !included.length) return [];
  const full = await getCatalog(email, null);
  const out = [];
  for (const t of full) {
    // Active = the learner's ACTUAL Mastery Engine — shelf tracks + individually-added
    // sections, minus removed ones (the same specificity rule as /api/catalog).
    const active = inEngine(t, tracks, included, hidden);
    if (!active && !hiddenMatch(t, hidden)) continue; // never on their engine — real blind spot
    // carry mastery stats too, for Coach mode's progress digest (outline ignores them)
    out.push({
      track: t.track, course: t.course, lesson: t.lesson, topic: t.topic,
      totalAttempts: t.totalAttempts || 0, correctCount: t.correctCount || 0,
      ...(active ? {} : { removed: true }),
    });
  }
  return out;
}

/** A compact progress digest for Coach mode: overall accuracy + the topics the
 *  learner has mastered vs is weak on, so the assistant tailors its recommended path.
 *  Parked (removed) rows are excluded — progress speaks to the ACTIVE engine only. */
function coachDigest(allRows) {
  const rows = (allRows || []).filter((r) => !r.removed);
  let attempted = 0; let sumAcc = 0; const mastered = []; const weak = [];
  for (const r of rows || []) {
    if (!r.totalAttempts) continue;
    const acc = Math.round((r.correctCount / r.totalAttempts) * 100);
    attempted += 1; sumAcc += acc;
    if (acc >= 80) mastered.push(r.topic);
    else if (acc < 60) weak.push(r.topic);
  }
  const cap = (a) => [...new Set(a.filter(Boolean))].slice(0, 60);
  const m = cap(mastered); const w = cap(weak);
  const parts = [`Overall: ${attempted ? Math.round(sumAcc / attempted) : 0}% across ${attempted} practised topic${attempted === 1 ? '' : 's'} (of ${(rows || []).length} in their engine; ${(rows || []).length - attempted} not yet started).`];
  if (m.length) parts.push(`Mastered (≥80%): ${m.join(', ')}.`);
  if (w.length) parts.push(`Weak / still learning (<60%): ${w.join(', ')}.`);
  return parts.join('\n');
}

/** Every transcript in the learner's enrolled programs (title + scope) — so the
 *  assistant is aware of the source videos/notes and can point to them by real name. */
async function learnerTranscripts(email) {
  if (!email) return [];
  const enr = await getEnrollment(email);
  const seen = new Set();
  const out = [];
  for (const program of enr.programs) {
    let list = [];
    try { list = await getTranscripts({ program }); } catch { list = []; }
    for (const t of list) {
      if (!t || !t.title) continue;
      const k = t.id || `${t.title}|${t.lesson || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ title: t.title, track: t.track, course: t.course, lesson: t.lesson });
      if (out.length >= 500) return out;
    }
  }
  return out;
}

// Auth: send a message to the always-available assistant. The client passes a
// STRUCTURED snapshot of what's on screen (view, selection, current question or
// flashcard, recent answers) as `context`; the assistant answers grounded in it.
// Appends to `conversationId` when given; otherwise starts a new conversation.
app.post('/api/assistant/chat', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'A message is required' });
    const context = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {};
    const conversationId = req.body?.conversationId ? String(req.body.conversationId) : '';
    // Voice conversation mode: the answer will be read aloud, so ask for spoken-style prose.
    const conversational = !!req.body?.conversational;
    // Web access: Google Search grounding (Gemini only — ignored for other providers downstream).
    const search = !!req.body?.web;

    // Threads + the holistic profile belong to the PERSON typing (conversationUser);
    // curriculum/progress grounding stays on the effective account, whose progress
    // the rest of the app is showing them.
    const chatUser = conversationUser(req);
    const existing = conversationId ? await getAssistantChat(chatUser, conversationId) : null;
    const history = existing ? existing.messages : [];
    const coach = !!req.body?.coach;
    const [catalog, transcripts] = (coach || looksLikeCatalogLookup(message))
      ? await Promise.all([learnerCatalog(req.userEmail), learnerTranscripts(req.userEmail)])
      : [[], []];
    const progress = coach ? coachDigest(catalog) : '';
    // Whole-person context from Sentinel (body-fat/PRs, career goals, reading, obstacles). Null-safe:
    // an unreachable/unconfigured Sentinel just means no holistic block.
    // ...and their TASK BOARD, scoped by Sentinel to what this person may see. Fetched alongside the
    // profile (not after it — neither depends on the other) so knowing their work costs no extra
    // latency on a path the learner is sitting waiting on. Null-safe, exactly like the profile.
    const [holistic, work, sentinelGuideText] = await Promise.all([
      holisticProfile(chatUser),
      workDigest(chatUser),
      // Sentinel's self-knowledge doc (cached 10 min in lib/sentinel.js) - what lets the
      // assistant answer 'how do I use Sentinel for X' from ground truth. Null-safe.
      sentinelGuide(),
    ]);
    // Passages from their imported mentor transcripts, when the turn calls for them — this is what
    // makes "what would Nick say about my plan" / "act as Nick" grounded instead of an impression.
    // Alongside it, the bodies of the growth-journal entries this turn bears on (the digest carries
    // only their titles) and of the task cards it names. All three hang off the payloads above but
    // not off each other, so they go out together: one round trip's latency instead of three.
    const [mentorHits, growthHits, workHits] = await Promise.all([
      mentorGroundingFor(chatUser, message, holistic, coach),
      growthGroundingFor(chatUser, message, holistic),
      workGroundingFor(chatUser, message, work),
    ]);
    // Deep mode: the learner armed the Deep chip, so load the section on screen in full — its real
    // question bank, their own numbers on it, and the written guide. Off by default; see
    // deepGroundingFor. Fail-soft, like every other grounding source.
    const deepHits = req.body?.deep
      ? await deepGroundingFor(req, context).catch(() => ({ gaps: ['deep context could not be loaded'] }))
      : null;
    // Sources chip: ground the answer in the actual filed transcripts for the section on
    // screen, and require a citation. Independent of deep mode, which carries the answer key.
    const sourceHits = req.body?.sources
      ? await sourceGroundingFor(req, context).catch(() => null)
      : null;
    // The host (Sentinel's Coach) can let the assistant PROPOSE profile edits for the user to approve.
    const actions = !!req.body?.actions;
    // True only when this app is embedded in someone else's frame (Sentinel's Coach) — that's
    // the sole context where PROFILE-edit proposals have a host to execute them. Engine ops
    // (park/restore a Mastery Engine section) apply same-origin regardless and don't need this.
    const hostFrame = !!req.body?.hostFrame;
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const out = await generateAssistantChat({ context, history, message, conversational, search, catalog, transcripts, coach, progress, holistic, mentorHits, growthHits, work, workHits, deepHits, sourceHits, actions, hostFrame, sentinelGuide: sentinelGuideText, attachments, admin: isAdmin(req) }, aiForFiles(aiChoice(req), attachments));

    const messages = [...history, { role: 'user', text: message }, { role: 'assistant', text: out.reply }];
    const saved = await saveAssistantChat(chatUser, existing ? conversationId : '', messages);
    // `degraded`/`diag` are present only when the model's JSON envelope was broken and the reply had
    // to be salvaged out of it (generateAssistantChat). The answer is real; the visual was lost. Say
    // so rather than pretending the turn was clean — the 🐞 panel explains what happened.
    res.json({ reply: out.reply, visual: out.visual, conversationId: saved.id, title: saved.title, degraded: out.degraded || undefined, diag: out.diag || undefined });
  } catch (e) {
    next(e);
  }
});

// Auth: STREAMING assistant (SSE) — the text-chat path. Emits the model's
// reasoning ('thinking') and answer ('content') deltas live so the chat shows
// what the AI is doing, and can be paused + steered: the client aborts the
// stream and re-POSTs the SAME message with an accumulated `steer` note (see the
// Atrium assistant — no server-side run state; abort + resend is the mechanism).
// Streams PLAIN MARKDOWN (no visual), unlike the blocking sibling above. The
// turn is persisted on 'done'. Heavy setup runs inside the stream, after the
// heartbeat, so a failure surfaces as an 'error' event, not a dropped connection.
app.post('/api/assistant/chat/stream', requireAuth, rateLimitAI, async (req, res, next) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'A message is required' });
  const context = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {};
  const conversationId = req.body?.conversationId ? String(req.body.conversationId) : '';
  const steer = String(req.body?.steer || '').trim();
  const search = !!req.body?.web; // web access now streams (grounded plain text) so pause still works

  // If the client aborts (a Pause), the socket closes: don't persist the turn the
  // user is about to discard/steer, and stop trying to write to a dead stream.
  let clientGone = false;
  res.on('close', () => { clientGone = true; });

  sseInit(res);
  try {
    // Threads + holistic profile follow the person typing (see the blocking sibling).
    const chatUser = conversationUser(req);
    const existing = conversationId ? await getAssistantChat(chatUser, conversationId) : null;
    const history = existing ? existing.messages : [];

    // A steer restart re-sends the SAME message (with an added steer note) against
    // the same conversation, so the first pass's turn is already saved. Drop that
    // turn here so the model re-answers cleanly (not seeing its own draft in the
    // history), and so we overwrite it rather than duplicating on save.
    const baseHistory = (steer && history.length >= 2
      && history[history.length - 1]?.role === 'assistant')
      ? history.slice(0, -2) : history;

    // Coach mode forces full grounding (progress + catalog + transcripts) so it can
    // recommend a personalised path; otherwise ground only on content-lookup turns.
    const coach = !!req.body?.coach;
    const [catalog, transcripts] = (coach || looksLikeCatalogLookup(message))
      ? await Promise.all([learnerCatalog(req.userEmail), learnerTranscripts(req.userEmail)])
      : [[], []];
    const progress = coach ? coachDigest(catalog) : '';
    // Whole-person context from Sentinel; fetched before streaming starts (null-safe) so a Sentinel
    // outage can never break the SSE stream — it just yields no holistic block.
    // ...and their task board, scoped by Sentinel to what they may see (see the blocking sibling).
    const [holistic, work, sentinelGuideText] = await Promise.all([
      holisticProfile(chatUser),
      workDigest(chatUser),
      // Sentinel's self-knowledge doc (cached 10 min in lib/sentinel.js) - what lets the
      // assistant answer 'how do I use Sentinel for X' from ground truth. Null-safe.
      sentinelGuide(),
    ]);
    // Mentor-library grounding + growth-journal bodies + the bodies of any task cards this turn names
    // (see the blocking sibling for all three). Fetched together before streaming starts, and
    // null-safe, so a Sentinel outage can never break the SSE stream — it just costs the coach some
    // grounding.
    const [mentorHits, growthHits, workHits] = await Promise.all([
      mentorGroundingFor(chatUser, message, holistic, coach),
      growthGroundingFor(chatUser, message, holistic),
      workGroundingFor(chatUser, message, work),
    ]);
    // Deep mode (see the blocking sibling). Inside the stream, after the heartbeat, so its extra
    // reads can never hold the connection open silently before sseInit.
    const deepHits = req.body?.deep
      ? await deepGroundingFor(req, context).catch(() => ({ gaps: ['deep context could not be loaded'] }))
      : null;
    // Sources chip: ground the answer in the actual filed transcripts for the section on
    // screen, and require a citation. Independent of deep mode, which carries the answer key.
    const sourceHits = req.body?.sources
      ? await sourceGroundingFor(req, context).catch(() => null)
      : null;
    const actions = !!req.body?.actions;
    const hostFrame = !!req.body?.hostFrame;
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const out = await streamAssistantChat(
      { context, history: baseHistory, message, steer, catalog, transcripts, search, coach, progress, holistic, mentorHits, growthHits, work, workHits, deepHits, sourceHits, actions, hostFrame, sentinelGuide: sentinelGuideText, attachments, admin: isAdmin(req) }, aiForFiles(aiChoice(req), attachments),
      (t, kind) => { if (!clientGone) sseSend(res, kind === 'thinking' ? 'thinking' : 'content', { text: t }); },
    );

    if (clientGone) return;   // paused/navigated away — leave the prior turn untouched
    const reply = String(out.reply || '').trim();
    const messages = [...baseHistory, { role: 'user', text: message }, { role: 'assistant', text: reply }];
    const saved = await saveAssistantChat(chatUser, existing ? conversationId : '', messages);
    sseSend(res, 'done', { conversationId: saved.id, title: saved.title });
    res.end();
  } catch (e) {
    if (clientGone) return;
    // Headers are already sent (sseInit), so surface the failure as an event — with the diagnosis
    // when there is one, so a streamed failure reaches the 🐞 panel like a blocking one does.
    try { sseSend(res, 'error', { message: e.message || 'AI request failed', diag: e.diag || undefined }); res.end(); } catch { /* closed */ }
  }
});

/* ------------------------------ spoken replies ---------------------------- */
// Which cloud voices the settings picker offers. Server-driven so adding a voice or an
// engine is one edit in lib/tts.js, not two. The free browser voice is NOT listed here —
// it is client-side only and never reaches this server.
app.get('/api/tts/voices', requireAuth, (_req, res) => res.json(ttsCatalog()));

// Auth: speak one utterance with a Google cloud voice and return the MP3 BYTES.
//
// Bytes, not a URL, on purpose: the client plays it from a blob on our own origin, so no
// third-party media host is involved and the app's CSP needs no `media-src` widening.
//
// `rateLimitAI` is deliberate even though this is not a model call in the usual sense — it
// is the per-user cost valve, and it shares its bucket with the chat turn that produced the
// text. A spoken turn is one chat call plus one synthesize call, so a learner gets ~12
// spoken turns a minute, which is well above what talking out loud can actually produce.
//
// This route is the ONLY thing that can spend money on voice, and it only runs when the
// learner has explicitly chosen a paid engine — the default costs nothing. See lib/tts.js.
app.post('/api/tts', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const out = await synthesize({
      text: req.body?.text,
      engine: String(req.body?.engine || ''),
      voice: String(req.body?.voice || ''),
      style: req.body?.style,
    });
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Length', out.audio.length);
    // Speech is per-learner and never worth revalidating: the same text is rarely spoken twice.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(out.audio);
  } catch (e) { next(e); }
});

/* --------------------------- progress AI features ------------------------- */
// Shared by /api/review and /api/lesson: narrow the catalog to a scope and pull
// a question sample + a scope label for the study-guide generators.
async function reviewScopeInputs(req) {
  const programScope = await requestScope(req);
  const catalog = await getCatalog(req.userEmail, programScope);
  return buildReviewInputs(catalog, req.body || {}, programScope);
}

// The catalog-derived inputs for one scope. Factored out of reviewScopeInputs
// so the admin bulk pre-build can reuse it for an ENUMERATED scope (not tied to
// a request body) with the catalog + program slice fetched once up front.
async function buildReviewInputs(catalog, body, programScope) {
  const scoped = scopeCatalog(catalog, body);
  const topics = [...new Set(scoped.map((r) => r.topic))].filter(Boolean).slice(0, 60);
  if (!topics.length) return null;
  const pool = await getQuestionsForTopics(topics, programScope);
  const questions = shuffle(pool).slice(0, 40).map((q) => ({ topic: q.topic, question: q.question, answer: q.answer }));
  const { track, course, lesson, topic } = body;
  const scopeLabel = !isAll(topic) ? topic
    : !isAll(lesson) ? lesson
    : !isAll(course) ? course
    : !isAll(track) ? track
    : 'Your selection';
  return { catalog, scoped, topics, questions, scopeLabel };
}

// A study guide's cache key mirrors the exact scope tuple a learner's progress
// node carries (track/course/lesson/topic in data-*), with "all"/N-A fields
// normalised to empty so both sides slug to the same id.
//
// 🔴 `kind` is pinned to 'lesson' (2026-08-10). It used to separate the Review
// and Lesson guides, which meant two cached guides AND two generated visual
// pages per section — for output that differed only in whether prerequisites
// were named. One generator now serves both routes, so the key must collapse
// too, or the merge would buy nothing. The parameter survives because the id
// shape does; guides cached under the old 'review' key are simply orphaned
// (110 of them at the merge) and cost nothing but storage.
const GUIDE_KIND = 'lesson';

/**
 * 🔴 What a `locked` artifact refuses with.
 *
 * Some guides and visual pages are HAND-WRITTEN (`content-build/`, banked with
 * `locked: true`) rather than generated. Regenerating one replaces hours of
 * authored work with model output and there is no undo inside the app — the
 * authored copy is in the repo, but nothing here can fetch it back. So the
 * routes refuse, the client turns the refusal into a confirm, and only an
 * explicit `force: true` proceeds. A forced rebuild then clears the flag,
 * because what is cached afterwards genuinely IS model output.
 */
const LOCKED_MESSAGE =
  'This one was made by Claude Code, not generated by the quiz app. Regenerating replaces it with a model version and cannot be undone from here.';

const cleanScopeField = (v) => (isAll(v) ? '' : String(v || '').trim());
function guideScope(_kind, program, body = {}) {
  return {
    program: program || '',
    kind: GUIDE_KIND,
    track: cleanScopeField(body.track),
    course: cleanScopeField(body.course),
    lesson: cleanScopeField(body.lesson),
    topic: cleanScopeField(body.topic),
  };
}

/**
 * The authored source document(s) behind a scope, for grounding its guide.
 *
 * Transcripts are stored at LESSON grain, so a sub-lesson scope correctly
 * inherits its lesson's document. A whole-track scope gets nothing: there is no
 * single authoritative text for it, and stitching a dozen together would just
 * be a worse question sample.
 *
 * Whole or absent, never truncated — the same rule the growth journal follows
 * (AGENTS §7). Half a lesson document reads exactly like a complete one and
 * would be taught as though it were the whole thing.
 */
const GUIDE_SOURCE_BUDGET = 24000;
async function scopeSourceText(program, body = {}) {
  const course = cleanScopeField(body.course);
  if (!course) return '';
  const docs = await getScopeTranscripts({ program, course, lesson: cleanScopeField(body.lesson) });
  let out = '';
  let used = 0;
  for (const d of docs) {
    const text = String(d.text || '').trim();
    if (!text || used + text.length > GUIDE_SOURCE_BUDGET) continue;
    out += `${out ? '\n\n---\n\n' : ''}${d.title ? `# ${d.title}\n\n` : ''}${text}`;
    used += text.length;
  }
  return out;
}

/**
 * Everything `generateLesson` needs for one scope, in one place: the catalog
 * slice, the prerequisite graph context, and the authored source document.
 *
 * Shared by both guide routes, the visual guide's cold-cache path and the admin
 * bulk pre-build, so a guide is built from identical inputs however it was
 * triggered — before the merge those four had drifted into three different
 * input shapes. `bank` is the WHOLE catalog (prereq links cross programs); pass
 * it in when the caller already holds it.
 */
async function lessonInputs(email, body, programScope, bank) {
  const rows = bank || await getCatalog(email, null);
  const inp = await buildReviewInputs(filterCatalog(rows, programScope), body, programScope);
  if (!inp) return null;
  let graph = { prereqs: [], dependents: [] };
  try {
    graph = lessonGraphContext(inp.scoped, rows, await getGraphLinks());
  } catch { /* graph unavailable — the guide degrades to foundational, never fails */ }
  // Fail-soft on purpose: a guide grounded on nothing is worse than one grounded
  // on the authored document, and far better than no guide at all.
  const source = await scopeSourceText(programScope.program, body).catch(() => '');
  return { ...inp, ...graph, source };
}

// Send a cached guide as a single-chunk text response (same shape the client
// already streams into renderMarkdown) — instant, and costs zero tokens.
function sendCachedText(res, text) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Study-Guide', 'cache-hit');
  res.end(text);
}

/**
 * The prerequisite context for a Lesson scope, derived from the same stored graph
 * the Knowledge Map uses: which sections OUTSIDE this scope it builds on
 * (`prereqs`, with the graph's "why") and which OUTSIDE sections it unlocks
 * (`dependents`). Each entry is a full {program,track,course,lesson,topic} scope
 * so the client can render a clickable chip that opens that lesson, and the names
 * feed the Lesson generator so it teaches the delta instead of from scratch.
 *
 * `bank` must be the WHOLE catalog, not a program slice: prereq links cross
 * programs, and buildPrereqEdges drops any edge whose endpoint is missing from
 * the rows it is given. The chip carries `program` for the same reason — the
 * referred lesson may live in another program.
 */
function lessonGraphContext(scoped, bank, links) {
  const rows = bank.filter((r) => r.topic && r.id);
  const edges = buildPrereqEdges(links, rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const scopeIds = new Set(scoped.map((r) => r.id).filter(Boolean));
  const toScope = (r, why) => ({
    program: r.program || DEFAULT_PROGRAM,
    track: r.track, course: r.course, lesson: r.lesson, topic: r.topic, ...(why ? { why } : {}),
  });
  const prereqs = new Map();
  const dependents = new Map();
  for (const e of edges) {
    if (scopeIds.has(e.to) && !scopeIds.has(e.from) && byId.has(e.from) && !prereqs.has(e.from)) {
      prereqs.set(e.from, toScope(byId.get(e.from), e.why));
    }
    if (scopeIds.has(e.from) && !scopeIds.has(e.to) && byId.has(e.to) && !dependents.has(e.to)) {
      dependents.set(e.to, toScope(byId.get(e.to)));
    }
  }
  return { prereqs: [...prereqs.values()].slice(0, 12), dependents: [...dependents.values()].slice(0, 12) };
}

/**
 * Auth: THE study guide for a scope — the "Lesson" button.
 *
 * One handler behind two paths since the Review/Lesson merge (2026-08-10).
 * `/api/review` is kept as a deprecated alias, not as a second guide: a browser
 * still holding the pre-merge `app.js` calls it, and it must reach the same
 * generator and the SAME cache key rather than banking a rival document.
 *
 * The guide is derived from shared data, so it is cached once and replayed
 * instantly on later clicks; only a cache miss (or ?refresh=1) spends tokens.
 * "Builds on / Leads to" chips come from /api/lesson/context, which stays live.
 */
async function streamStudyGuide(req, res, next) {
  try {
    const programScope = await requestScope(req);
    const scope = guideScope(GUIDE_KIND, programScope.program, req.body || {});
    const critique = String(req.body?.critique || '').trim().slice(0, 2000);
    const refresh = req.query.refresh === '1' || !!critique;
    const cachedNow = await getStudyGuide(scope).catch(() => null);
    if (!refresh) {
      if (cachedNow && cachedNow.markdown) return sendCachedText(res, cachedNow.markdown);
    } else if (cachedNow && cachedNow.locked && req.body?.force !== true) {
      // 🔴 Hand-written. Replacing it with model output is not recoverable — the
      // authored copy lives in content-build, but nothing here can fetch it back.
      // The client turns this into a confirm and retries with force:true.
      return res.status(409).json({ error: LOCKED_MESSAGE, locked: true });
    }
    const inp = await lessonInputs(req.userEmail, req.body || {}, programScope);
    if (!inp) return res.status(400).json({ error: 'No topics in this section yet' });
    const ai = await regenerateEngine(req, scope, refresh, critique);
    const meta = {};
    let acc = '';
    await streamText(res, (onToken) =>
      generateLesson({
        scopeLabel: inp.scopeLabel, topics: inp.topics, questions: inp.questions,
        prereqs: inp.prereqs, dependents: inp.dependents, source: inp.source, critique,
      }, { ...ai, meta }, (t) => { acc += t; onToken(t); }));
    if (acc.trim()) {
      saveStudyGuide(scope, acc, {
        scopeLabel: inp.scopeLabel, critique, provider: meta.provider, model: meta.model,
        // Whether the authored document was behind this build. A guide written
        // from a source and one inferred from quiz questions are not the same
        // artifact, and only this says which one is cached.
        grounded: !!inp.source,
      }).catch(() => {});
    }
  } catch (e) {
    if (!res.headersSent) next(e);
  }
}
app.post('/api/lesson', requireAuth, streamStudyGuide);
app.post('/api/review', requireAuth, streamStudyGuide);   // deprecated alias — see above

// Auth: the prereq/dependent context for a Lesson scope (non-streaming), so the
// modal can render clickable "Builds on / Leads to" chips while the guide streams.
// Reuses the exact graph computation the streamed Lesson is built on.
app.post('/api/lesson/context', requireAuth, async (req, res, next) => {
  try {
    const programScope = await requestScope(req);
    const bank = await getCatalog(req.userEmail, null);
    const scoped = scopeCatalog(filterCatalog(bank, programScope), req.body || {});
    if (!scoped.length) return res.json({ prereqs: [], dependents: [] });
    try {
      return res.json(lessonGraphContext(scoped, bank, await getGraphLinks()));
    } catch {
      return res.json({ prereqs: [], dependents: [] });
    }
  } catch (e) {
    next(e);
  }
});


/* ------------------------- Visual guides ("Visualize this") ----------------
 * The interactive companion to a Lesson/Review study guide: ONE self-contained
 * HTML page of 3–6 named, numbered, interactive visuals, generated by whichever
 * engine the learner picked, cached per scope, and served into a sandboxed
 * iframe. While it is open the study assistant is grounded in the visuals' own
 * names, so "explain visual 2" works — including out loud in voice mode.
 *
 * 🔴 The page is MODEL-AUTHORED MARKUP. It is never put through innerHTML in
 * app.js and it never runs in this app's origin. It is served from its own route
 * with `CSP: sandbox allow-scripts` (deliberately WITHOUT allow-same-origin),
 * which puts it in an opaque origin: no cookies, no storage, no credentialed
 * calls back to /api. The iframe's own `sandbox=` attribute says the same thing;
 * the header is the backstop for the day someone edits the attribute away, and
 * for a direct navigation to the URL. srcdoc/blob were rejected precisely
 * because both INHERIT this app's CSP — which is frame-ancestors-only, i.e.
 * imposes nothing — leaving the attribute as a single point of failure.
 */

// The artifact's palette, mirroring public/styles.css :root and its dark retune.
// The generated page is told to use ONLY these, so a visual made on the light
// theme is still readable on the dark one without regenerating it.
const VIZ_BASE_CSS = `
:root{color-scheme:light;--viz-bg:#f7f8f5;--viz-surface:#ffffff;--viz-ink:#0e1512;--viz-muted:#6c7671;--viz-line:#e9ece7;--viz-accent:#2fa14a;--viz-green:#2fa14a;--viz-red:#d6453f;--viz-amber:#c98a16;--viz-violet:#7c6ff0}
:root[data-theme="dark"]{color-scheme:dark;--viz-bg:#0b0f0d;--viz-surface:#16211b;--viz-ink:#e7eee9;--viz-muted:#93a09a;--viz-line:rgba(255,255,255,.14);--viz-accent:#4fbf63;--viz-green:#4fbf63;--viz-red:#f0736d;--viz-amber:#e0a84a;--viz-violet:#9c90f7}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--viz-bg);color:var(--viz-ink);font:15px/1.55 'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;padding:12px 12px 28px;-webkit-text-size-adjust:100%}
h1,h2,h3{line-height:1.2;margin:0 0 8px}
svg{max-width:100%;height:auto}
img{max-width:100%;height:auto}
table{width:100%;border-collapse:collapse}
pre,code{font-family:ui-monospace,'SF Mono',Consolas,monospace}
pre{overflow-x:auto}
/* Tab chrome. The generated page supplies the buttons and panels with these
   hooks; the behaviour and this styling are ours, so a page whose own script
   breaks still switches tabs and still reads well on a phone. */
.viz-tabs{display:flex;gap:6px;overflow-x:auto;padding:2px 2px 10px;margin:0 -2px 12px;border-bottom:1px solid var(--viz-line);-webkit-overflow-scrolling:touch;scrollbar-width:none}
.viz-tabs::-webkit-scrollbar{display:none}
.viz-tab{flex:0 0 auto;min-height:44px;padding:10px 14px;border:1px solid var(--viz-line);border-radius:999px;background:var(--viz-surface);color:var(--viz-muted);font:inherit;font-weight:600;font-size:14px;cursor:pointer;white-space:nowrap}
.viz-tab:hover{color:var(--viz-ink)}
.viz-tab.is-active{background:var(--viz-accent);border-color:var(--viz-accent);color:#fff}
.viz-tab:focus-visible{outline:2px solid var(--viz-accent);outline-offset:2px}
.viz-panel{animation:vizIn .18s ease}
.viz-panel[data-viz-hidden]{display:none !important}
.viz-panel[data-viz-force]{display:block !important}
@keyframes vizIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
input[type=range]{width:100%;min-height:44px;accent-color:var(--viz-accent)}
button:not(.viz-tab){min-height:40px;font:inherit;cursor:pointer}
@media (max-width:420px){body{font-size:14px;padding:10px 10px 24px}.viz-tab{padding:10px 12px;font-size:13px}}
`;

// Injected into every artifact, after the page's own script.
//
// It owns tab switching (so the visuals still work when the model's own script
// throws) and it is the ONLY way the app can learn which visual is on screen:
// the artifact is opaque-origin, so the parent cannot read into it. The parent
// must still verify `event.source === iframe.contentWindow` — the payload is
// only tab names, but an unchecked listener is how a message from anywhere gets
// treated as ours.
const VIZ_RUNTIME_JS = `
(function(){
  var tabs = [].slice.call(document.querySelectorAll('[data-viz-tab]'));
  var panels = [].slice.call(document.querySelectorAll('[data-viz-panel]'));
  var names = tabs.map(function(b){ return label(b); });
  function label(b){ return (b.textContent||'').replace(/\\s+/g,' ').trim(); }
  function post(index, name){
    try {
      parent.postMessage({ type:'agora-viz-tab', index:index, name:name, tabs:names }, '*');
    } catch(e){}
  }
  function activate(key, scroll){
    tabs.forEach(function(b){
      var on = b.getAttribute('data-viz-tab') === key;
      b.classList.toggle('is-active', on);
      // aria-current is global and valid on a plain button; aria-selected would
      // not be, now that role="tab" is gone (see the listener below).
      if (on) b.setAttribute('aria-current','true'); else b.removeAttribute('aria-current');
    });
    panels.forEach(function(p){
      var on = p.getAttribute('data-viz-panel') === key;
      // An ATTRIBUTE, never inline display. Generated pages routinely ship their
      // own tab script too, and a common shape is .viz-panel{display:none} in
      // their CSS plus style.display='block' from their JS. Clearing inline
      // display would resolve the ACTIVE panel back to none and blank the page;
      // this leaves their mechanism alone and still wins where it must, because
      // [data-viz-hidden] carries !important.
      if (on) { p.removeAttribute('data-viz-hidden'); p.removeAttribute('hidden'); }
      else { p.removeAttribute('data-viz-force'); p.setAttribute('data-viz-hidden',''); p.setAttribute('hidden',''); }
    });
    var btn = null;
    for (var i=0;i<tabs.length;i++) if (tabs[i].getAttribute('data-viz-tab')===key) btn = tabs[i];
    post(key, btn ? label(btn) : '');
    // Generated pages usually style .viz-panel{display:none} and reveal the
    // active one from their OWN script. If that script threw, nothing is
    // revealed and the learner gets a blank page. So: one tick later, if the
    // panel we just activated still computes to display:none, force it. Only
    // then — forcing it unconditionally would flatten a panel the page
    // deliberately laid out as flex or grid.
    setTimeout(function(){
      for (var j=0;j<panels.length;j++) {
        var p = panels[j];
        if (p.getAttribute('data-viz-panel') !== key) continue;
        try { if (getComputedStyle(p).display === 'none') p.setAttribute('data-viz-force',''); } catch(e){}
      }
    }, 0);
    if (scroll) { try { window.scrollTo(0,0); } catch(e){} }
  }
  tabs.forEach(function(b){
    // Deliberately NOT role="tab": that promises a tablist/tabpanel relationship
    // this runtime cannot build (a generated page may wrap each button in its own
    // element, so there is no reliable common parent to mark as the tablist), and
    // a half-implemented pattern reads worse to a screen reader than a plain
    // button — which is already focusable, operable and announced.
    b.addEventListener('click', function(){ activate(b.getAttribute('data-viz-tab'), true); });
  });
  // The host flips light/dark without reloading the artifact.
  window.addEventListener('message', function(e){
    var d = e && e.data;
    if (!d || d.type !== 'agora-viz-theme') return;
    document.documentElement.setAttribute('data-theme', d.theme === 'dark' ? 'dark' : 'light');
  });
  if (tabs.length) activate(tabs[0].getAttribute('data-viz-tab'), false);
  else post('', '');   // the page built its own tabs — still announce that it loaded
})();
`;

const VIZ_HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const vizEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => VIZ_HTML_ESCAPE[c]);

/**
 * Re-house the model's document inside a shell we control.
 *
 * Rebuilt rather than patched: that way OUR stylesheet is always first (so the
 * page's own CSS wins on purpose), OUR runtime is always last, the viewport meta
 * is guaranteed, and `data-theme` is guaranteed to be on <html>. It also drops
 * the external <link>/<script src> tags a model sometimes reaches for out of
 * habit — the CSP would block them anyway, but silently, which reads as "the
 * visual is broken" rather than "that resource was never going to load".
 */
function renderVisualArtifact(html, { theme, title }) {
  const src = String(html || '');
  const headM = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(src);
  const bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(src);
  const strip = (s) => String(s || '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv=["']?content-security-policy[^>]*>/gi, '')
    // A meta refresh is a NAVIGATION request that needs no script at all. The
    // embedder's frame-src blocks it, but leaving the tag in means the only
    // thing standing between us and it is a header somebody could later relax.
    .replace(/<meta\b[^>]*http-equiv=["']?refresh[^>]*>/gi, '')
    .replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi, '');
  const head = strip(headM ? headM[1] : '').replace(/<title[\s\S]*?<\/title>/i, '');
  const body = strip(bodyM ? bodyM[1]
    : src.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/gi, '').replace(/<head[\s\S]*?<\/head>/i, ''));
  const t = theme === 'dark' ? 'dark' : 'light';
  return `<!doctype html>
<html lang="en" data-theme="${t}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${vizEsc(title || 'Visual Guide')}</title>
<style>${VIZ_BASE_CSS}</style>
${head}
</head>
<body>
${body}
<script>${VIZ_RUNTIME_JS}</script>
</body>
</html>`;
}

// A visual guide's cache key. Mirrors guideScope exactly — same normalisation,
// same tuple — so the visuals and the study guide they visualise agree about
// which section they belong to. `kind` is part of the key: a Lesson's visuals
// and a Review's visuals for the same section are two documents.
function visualScope(kind, program, body = {}) {
  return guideScope(kind === 'lesson' ? 'lesson' : 'review', program, body);
}

/** The line the generator puts at the top of its index: "Title: … Visual Guide". */
function visualTitleFrom(outline, fallback) {
  const m = /^\s*title\s*:\s*(.+)$/im.exec(String(outline || ''));
  const t = m ? m[1].trim() : '';
  return t || `${fallback}: Visual Guide`;
}

/** What the client gets back — never the HTML itself (it loads that from its own
 *  route into the iframe), just what it needs to label and ground the viewer. */
function visualPayload(doc, cached) {
  return {
    cached: !!cached,
    id: doc.id,
    url: `/api/visuals/${encodeURIComponent(doc.id)}/html`,
    kind: doc.kind || 'review',
    title: doc.title || '',
    outline: doc.outline || '',
    scopeLabel: doc.scopeLabel || '',
    provider: doc.provider || '',
    model: doc.model || '',
    attempt: doc.attempt || 1,
    critique: doc.critique || '',
    bytes: doc.bytes || 0,
    updatedAt: doc.updatedAt || '',
    // The regenerate picker's checkbox list. Read from the PAGE's own tab strip
    // rather than from `outline`, which a model can leave stale — the learner
    // must be ticking the visuals they can actually see. `editable` is resolved
    // here too, so a panel that cannot be swapped is disabled in the UI instead
    // of failing after the click.
    panels: doc.html
      ? visualPanelIndex(doc.html).map((p) => ({ ...p, editable: canSwapVisualPanel(doc.html, p.key).ok }))
      : [],
    patched: Array.isArray(doc.patched) ? doc.patched : [],
    locked: !!doc.locked,
  };
}

/**
 * The cached visuals for a scope — but only if the study guide they were built
 * from has not been rewritten since.
 *
 * Regenerating the WRITTEN guide silently invalidates its visuals: they teach
 * the old text. Without this the button would still say "Open visuals" and hand
 * back a page that contradicts the guide on screen. ISO-8601 `updatedAt` on both
 * docs compares correctly as a string, so this costs one read that the callers
 * were making anyway.
 */
async function freshVisualGuide(vscope, gscope) {
  const [visual, guide] = await Promise.all([
    getVisualGuide(vscope).catch(() => null),
    getStudyGuide(gscope).catch(() => null),
  ]);
  if (!visual || !visual.html) return null;
  if (guide && guide.updatedAt && visual.updatedAt && guide.updatedAt > visual.updatedAt) return null;
  return visual;
}

/**
 * Every engine THIS caller may actually use, as flat {provider, model} pairs.
 *
 * Extracted from GET /api/models so the picker and the "try a different model"
 * rotation can never drift apart. Note the local probes are live network calls
 * with short timeouts — fine on a user-initiated regenerate, never inside a loop.
 */
async function availableProviders(req) {
  const geminiModels = [...new Set([
    process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
  ])];
  let providers = [{ id: 'gemini', label: 'Cloud', models: geminiModels }];
  if (deepseekConfigured()) providers.push({ id: 'deepseek', label: 'DeepSeek', models: listDeepSeekModels() });
  if (kimiConfigured()) providers.push({ id: 'kimi', label: 'Kimi', models: listKimiModels() });
  const [ollama, lmstudio] = await Promise.all([listOllamaModels(), listLMStudioModels()]);
  if (ollama.length) providers.push({ id: 'ollama', label: 'Local (Ollama)', models: ollama });
  if (lmstudio.length) providers.push({ id: 'lmstudio', label: 'Local (LM Studio)', models: lmstudio });
  const pol = req.aiPolicy;
  if (pol && Array.isArray(pol.providers) && pol.providers.length) {
    providers = providers.filter((p) => pol.providers.includes(p.id));
  }
  return providers;
}

/**
 * The next engine to try after `current`, for a regenerate with NO critique.
 *
 * "It's not good enough but I can't say why" is best answered by a different
 * model rather than by the same one at a different temperature — which we have
 * no lever for anyway. Rotation is over the caller's own permitted pairs, so it
 * can never escape the AI policy, and it wraps around. Returns null when there
 * is only one engine to choose from (then the caller just re-rolls the same one).
 */
async function nextEngine(req, current) {
  const providers = await availableProviders(req).catch(() => []);
  const pairs = [];
  for (const p of providers) for (const m of (p.models || [])) pairs.push({ provider: p.id, model: m });
  if (pairs.length < 2) return null;
  const key = (x) => `${x.provider}|${x.model}`;
  const at = pairs.findIndex((x) => key(x) === key(current || {}));
  return pairs[(at + 1) % pairs.length] || null;
}

/**
 * The engine a Lesson/Review REGENERATE should run on.
 *
 * Same rule as the visual guide: with a critique the learner's own engine keeps
 * the job (their note is the new input); without one, "it's not good enough but
 * I can't say why" is best answered by a different model — so rotate off
 * whichever one wrote the cached guide. A first build, or a cached guide from
 * before provenance was recorded, just uses their choice.
 */
async function regenerateEngine(req, guideCacheScope, refresh, critique) {
  const ai = aiChoice(req);
  if (!refresh || critique) return ai;
  const previous = await getStudyGuide(guideCacheScope).catch(() => null);
  if (!previous || !previous.provider) return ai;
  const next = await nextEngine(req, previous);
  return next ? { ...ai, provider: next.provider, model: next.model } : ai;
}

/**
 * The written guide the visuals must follow, plus the curriculum context.
 *
 * The cached guide markdown is the source of truth: the learner is looking at
 * that text, so the visuals have to teach THAT, not a fresh reading of the
 * question bank. On a cold cache it generates the guide first (and banks it,
 * warming the button the learner would have pressed next) — two model calls,
 * which is exactly why this route runs over a heartbeated stream.
 *
 * It returns the graph context too, because the VISUALS now use it: the prereqs
 * drive the bridge visual, and they must be the same list the written guide was
 * built from or visual 1 would reconcile with nothing on the page.
 */
async function visualSourceInputs(req, kind, body, programScope, ai) {
  const gscope = guideScope(kind, programScope.program, body);
  const cachedGuide = await getStudyGuide(gscope).catch(() => null);
  const inp = await lessonInputs(req.userEmail, body, programScope);
  if (!inp) throw httpErr(400, 'No topics in this section yet');

  let guide = cachedGuide && cachedGuide.markdown ? cachedGuide.markdown : '';
  if (!guide) {
    const meta = {};
    guide = await generateLesson({
      scopeLabel: inp.scopeLabel, topics: inp.topics, questions: inp.questions,
      prereqs: inp.prereqs, dependents: inp.dependents, source: inp.source,
    }, { ...ai, meta });
    if (guide && guide.trim()) {
      saveStudyGuide(gscope, guide, {
        scopeLabel: inp.scopeLabel, provider: meta.provider, model: meta.model, grounded: !!inp.source,
      }).catch((e) => console.error('study-guide save failed:', e.message));
    }
  }
  return { guide, ...inp };
}

/** Generate + cache one visual guide. Throws httpErr so sseResult reports it in-band. */
async function buildVisualGuide(req, { kind, scope, body, programScope, critique, regenerate }) {
  const previous = await getVisualGuide(scope).catch(() => null);
  let ai = aiChoice(req);
  // A blind regenerate ("just make it better") switches engine; a regenerate WITH
  // feedback keeps the learner's chosen one, because the note is the new input.
  if (regenerate && !critique) {
    // Anchor on the cached page's engine when there is one. When there is NOT,
    // the last attempt failed before it could be banked (a truncated page is
    // never cached), so the engine to rotate OFF is the one the learner is on —
    // the one that just failed. Without this the 502's "try Regenerate, it will
    // use a different engine" is a promise the code does not keep.
    const next = await nextEngine(req, (previous && previous.provider) ? previous : ai);
    if (next) ai = { ...ai, provider: next.provider, model: next.model };
  }

  const inp = await visualSourceInputs(req, kind, body, programScope, ai);
  const meta = {};
  const raw = await generateVisualGuide({
    scopeLabel: inp.scopeLabel,
    kind,
    topics: inp.topics,
    guide: inp.guide,
    questions: inp.questions,
    // The same prereq/dependent lists the written guide was built from — visual 1
    // is the bridge from these to this section, so they have to agree with the
    // text behind them and with the "Builds on" chips above it.
    prereqs: inp.prereqs,
    dependents: inp.dependents,
    critique,
  }, { ...ai, meta });

  const { outline, html } = parseVisualGuide(raw);
  // A page that stopped mid-document looks like a working one until you reach the
  // tab that isn't there — and complete() has no maxOutputTokens lever to raise.
  // Refusing to cache it is what keeps that failure from becoming permanent.
  if (!visualGuideLooksComplete(html)) {
    throw httpErr(502, 'The model returned an incomplete page. Try Regenerate — it will use a different engine.');
  }

  const title = visualTitleFrom(outline, inp.scopeLabel);
  const attempt = (Number(previous?.attempt) || 0) + 1;
  await saveVisualGuide(scope, html, {
    scopeLabel: inp.scopeLabel, title, outline, critique, attempt,
    provider: meta.provider, model: meta.model,
  });
  const saved = await getVisualGuide(scope);
  return visualPayload(saved || { id: visualGuideId(scope), kind, title, outline, scopeLabel: inp.scopeLabel, attempt, ...meta }, false);
}

/**
 * How many visuals ONE targeted edit may rewrite. Past this a whole-page rebuild
 * is both cheaper and more coherent: panels are rewritten independently and
 * nothing reconciles them with each other, so rewriting most of a page this way
 * buys a set of visuals that no longer reads as one lesson.
 */
const MAX_PATCH_PANELS = 3;

/**
 * Rewrite SOME visuals in the cached page, leaving every other byte identical.
 *
 * This is the cheap half of Regenerate. `buildVisualGuide` re-authors a whole
 * ~90 KB document and never sees the page it is replacing, so fixing visual 3
 * also re-rolls the three that were fine. Here the model is shown the panel it
 * is fixing and returns just that panel, which `replaceVisualPanel` splices back
 * in — one small call instead of one large one, and the visuals the learner
 * liked are not merely "probably preserved", they are untouched.
 *
 * 🔴 It deliberately does NOT generate a missing study guide the way
 * `visualSourceInputs` does. Writing one here would stamp `studyGuides.updatedAt`
 * NEWER than the page being patched, and `freshVisualGuide` reads exactly that
 * as "these visuals teach superseded text" — so the page would be discarded on
 * the very next open, and the edit the learner just paid for with it. No cached
 * guide means no patch; the answer is a rebuild, and it says so.
 */
async function patchVisualGuide(req, { kind, scope, body, programScope, critique, panels }) {
  const previous = await getVisualGuide(scope).catch(() => null);
  if (!previous || !previous.html) throw httpErr(409, 'There are no visuals to edit yet — build the page first.');

  const guideDoc = await getStudyGuide(guideScope(kind, programScope.program, body)).catch(() => null);
  if (!guideDoc || !guideDoc.markdown) {
    throw httpErr(409, 'The written guide behind these visuals is no longer cached, so a single visual cannot be rewritten from it. Rebuild the whole page.');
  }
  if (guideDoc.updatedAt && previous.updatedAt && guideDoc.updatedAt > previous.updatedAt) {
    throw httpErr(409, 'The written guide has been rewritten since these visuals were made. Rebuild the whole page so they teach the same text.');
  }

  const wanted = [...new Set((panels || []).map((p) => String(p).trim()).filter(Boolean))];
  if (!wanted.length) throw httpErr(400, 'Pick at least one visual to rewrite');
  // Rejected, never trimmed: silently rewriting 3 of the 4 they ticked reads as
  // "it ignored one", and they would have no way to tell which.
  if (wanted.length > MAX_PATCH_PANELS) {
    throw httpErr(400, `One edit can rewrite at most ${MAX_PATCH_PANELS} visuals. Beyond that, rebuild the whole page — it is cheaper and keeps them reading as one lesson.`);
  }

  // Refuse BEFORE spending a token. A page that drives this panel's controls from
  // a script shared with the others would keep that script and lose the elements
  // it wires — it throws on the first missing one and the visuals after it die
  // with it, so the "fix" would break more than it repaired.
  for (const key of wanted) {
    const v = canSwapVisualPanel(previous.html, key);
    if (!v.ok) {
      throw httpErr(409, `Visual ${key} can't be edited on its own — ${v.reason}. Rebuild the whole page once; pages built after that can be edited one visual at a time.`);
    }
  }

  // Same rule as the whole-page regenerate: a note is the new input, so the
  // learner's own engine keeps the job; "not good enough, can't say why" is best
  // answered by a different model. Anchored on whoever wrote the cached page.
  let ai = aiChoice(req);
  if (!critique) {
    const next = await nextEngine(req, previous.provider ? previous : ai);
    if (next) ai = { ...ai, provider: next.provider, model: next.model };
  }

  const index = visualPanelIndex(previous.html);
  const current = new Map(splitVisualPanels(previous.html).map((p) => [p.key, p.html]));
  const edits = await mapWithConcurrency(wanted, 2, async (key) => {
    const meta = {};
    const raw = await generateVisualPanel({
      scopeLabel: previous.scopeLabel || '',
      kind,
      number: key,
      name: (index.find((i) => i.key === key) || {}).name || '',
      current: current.get(key) || '',
      outline: previous.outline || '',
      guide: guideDoc.markdown,
      critique,
    }, { ...ai, meta });
    const parsed = parseVisualPanel(raw, key);
    // Same posture as the truncation guard on a whole page: an unbalanced
    // fragment is what running out of tokens looks like, and splicing it in
    // would corrupt a page that is currently fine.
    if (!parsed) throw httpErr(502, `The replacement for visual ${key} came back incomplete. Try again — a blank note switches model.`);
    return { key, ...parsed, meta };
  });

  let html = previous.html;
  let outline = previous.outline || '';
  for (const e of edits) {
    const next = replaceVisualPanel(html, e.key, e.html, visualTabLabelFrom(e.line, e.key));
    if (!next) throw httpErr(500, `Could not splice visual ${e.key} back into the page`);
    html = next;
    outline = replaceOutlineLine(outline, e.key, e.line);
  }
  if (!visualGuideLooksComplete(html)) {
    throw httpErr(502, 'The edited page no longer reads as a complete document, so nothing was saved. Rebuild the whole page.');
  }

  await saveVisualGuide(scope, html, {
    scopeLabel: previous.scopeLabel || '',
    title: previous.title || '',
    outline,
    critique,
    attempt: (Number(previous.attempt) || 0) + 1,
    patched: wanted,
    // The engine that made the EDIT — the untouched panels are still whoever
    // wrote them, which is why the tag names the visuals that changed.
    provider: edits[0]?.meta?.provider || previous.provider || '',
    model: edits[0]?.meta?.model || previous.model || '',
    source: 'visualize-patch',
    // A patched authored page STAYS locked. Most of it is still hand-written, and
    // dropping the flag here would leave the panels the learner did NOT touch
    // unprotected against the next regenerate. The tag names both authors.
    locked: !!previous.locked,
  });
  const saved = await getVisualGuide(scope);
  return visualPayload(saved || { ...previous, html, outline, patched: wanted }, false);
}

// Auth: get-or-build the interactive visual guide for a scope. A cache hit costs
// nothing and returns instantly; a miss (or `regenerate`) generates. Answers SSE
// when the caller asks for it — generation is one or two full model calls and a
// plain POST that quiet for that long gets dropped in front of us (§7).
app.post('/api/visualize', requireAuth, rateLimitAI, async (req, res, next) => {
  try {
    const body = req.body || {};
    const kind = body.kind === 'lesson' ? 'lesson' : 'review';
    const regenerate = body.regenerate === true;
    const critique = String(body.critique || '').trim().slice(0, 2000);
    // Which visuals to rewrite. Empty = the whole page, which is the original
    // behaviour and stays the default — naming panels is the learner opting into
    // the cheap path, never something inferred for them.
    const panels = Array.isArray(body.panels) ? body.panels.slice(0, 16) : [];
    const programScope = await requestScope(req);
    const scope = visualScope(kind, programScope.program, body);

    if (!regenerate) {
      const cached = await freshVisualGuide(scope, guideScope(kind, programScope.program, body));
      if (cached && cached.html) {
        const hit = visualPayload(cached, true);
        if (wantsSSE(req)) return sseResult(res, async () => hit);
        return res.json(hit);
      }
    }
    // A hand-written page is refused BEFORE either rebuild path — including a
    // single-panel edit, which would splice model output into an authored page
    // and leave it looking hand-made.
    if (regenerate && body.force !== true) {
      const held = await getVisualGuide(scope).catch(() => null);
      if (held && held.locked) {
        if (wantsSSE(req)) return sseResult(res, async () => { throw httpErr(409, LOCKED_MESSAGE); });
        return res.status(409).json({ error: LOCKED_MESSAGE, locked: true });
      }
    }
    if (regenerate && panels.length) {
      const edit = () => patchVisualGuide(req, { kind, scope, body, programScope, critique, panels });
      if (wantsSSE(req)) return sseResult(res, edit, 'Could not rewrite those visuals');
      return res.json(await edit());
    }
    const work = () => buildVisualGuide(req, { kind, scope, body, programScope, critique, regenerate });
    if (wantsSSE(req)) return sseResult(res, work, 'Could not build the visual guide');
    return res.json(await work());
  } catch (e) {
    // The JSON fallback only: over SSE the stream is already open and sseResult
    // has reported the failure in-band as an 'error' event.
    if (e.status && !res.headersSent) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Auth: what is CACHED for a scope — which engine wrote the study guide, and
// whether a visual guide already exists. Lets the modal label its buttons
// honestly ("Open visuals" vs "Visualize this") without generating anything.
app.post('/api/guide/info', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const kind = body.kind === 'lesson' ? 'lesson' : 'review';
    const programScope = await requestScope(req);
    const [guide, visual] = await Promise.all([
      getStudyGuide(guideScope(kind, programScope.program, body)).catch(() => null),
      getVisualGuide(visualScope(kind, programScope.program, body)).catch(() => null),
    ]);
    // Same staleness rule as /api/visualize, or the button would promise
    // "Open visuals" for a page the click is about to regenerate anyway.
    const stale = !!(visual && guide && guide.updatedAt && visual.updatedAt && guide.updatedAt > visual.updatedAt);
    res.json({
      kind,
      guide: guide
        ? {
          provider: guide.provider || '', model: guide.model || '', updatedAt: guide.updatedAt || '',
          critique: guide.critique || '', locked: !!guide.locked, grounded: !!guide.grounded,
        }
        : null,
      visual: visual && visual.html && !stale ? visualPayload(visual, true) : null,
    });
  } catch (e) {
    next(e);
  }
});

// Auth: serve one generated page into the viewer's iframe.
//
// 🔴 This is the ONLY place model-authored markup is served, and every header
// below is load-bearing — see the block comment at the top of this section.
// `frame-ancestors` reuses FRAME_ANCESTORS on purpose: the production chain is
// Sentinel -> this app -> this artifact, and 'self' alone would block the whole
// feature everywhere the engine is embedded.
app.get('/api/visuals/:id/html', requireAuth, async (req, res, next) => {
  try {
    const doc = await getVisualGuideById(req.params.id);
    if (!doc || !doc.html) return res.status(404).type('text/plain').send('No visual guide with that id');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', [
      'sandbox allow-scripts',        // opaque origin: no cookies, no storage, no credentialed /api calls
      "default-src 'none'",
      "script-src 'unsafe-inline'",   // safe ONLY because of the sandbox above
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${FRAME_ANCESTORS}`,
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(renderVisualArtifact(doc.html, { theme: req.query.theme, title: doc.title }));
  } catch (e) {
    next(e);
  }
});

// Admin: PRE-BUILD (cache) Lesson/Review study guides for a whole scope in
// parallel, so a learner's buttons open instantly and cost zero tokens. It
// enumerates the selected scope into per-sub-lesson and/or per-lesson targets
// (matching exactly where the buttons live), builds each requested kind with
// several generations in flight at once (never one-after-the-other), skips what
// is already cached unless `force`, and returns counts. The engine is whatever
// was picked at the top of the Composing Room (aiChoice — the aiProvider/aiModel
// cookies). Synchronous: the admin leaves the page open until it reports done.
const STUDY_GUIDE_CONCURRENCY = Math.max(
  1, Math.min(12, parseInt(process.env.STUDY_GUIDE_CONCURRENCY, 10) || 5),
);
app.post('/api/admin/study-guides/build', requireAdmin, async (req, res, next) => {
  try {
    const programScope = await requestScope(req);
    const program = programScope.program;
    // Bank once, then narrow — the Lesson builds' graph context needs the whole
    // bank (prereq links cross programs); targets stay scoped to the program.
    const bank = await getCatalog(req.userEmail, null);
    const catalog = filterCatalog(bank, programScope);
    const scoped = scopeCatalog(catalog, req.body || {});
    if (!scoped.length) return res.status(400).json({ error: 'No topics in that scope' });

    const kinds = [];
    if (req.body?.doLesson) kinds.push('lesson');
    if (req.body?.doReview) kinds.push('review');
    if (!kinds.length) return res.status(400).json({ error: 'Pick Lessons and/or Reviews to build' });

    // Grain: which button locations to pre-warm. Default = both (sub-lessons and
    // lessons), matching where the learner can click.
    const grains = req.body?.grains || {};
    const doTopicGrain = grains.topic !== false;
    const doLessonGrain = grains.lesson !== false;
    const force = req.body?.force === true;

    // Enumerate the (deduped) target scopes at the requested grains. Each target
    // tuple mirrors the data-* a progress node carries so the key matches.
    const targets = new Map(); // dedupe-key -> scope
    const add = (s) => {
      const k = JSON.stringify([s.track || '', s.course || '', s.lesson || '', s.topic || '']);
      if (!targets.has(k)) targets.set(k, s);
    };
    if (doTopicGrain) {
      for (const r of scoped) if (r.topic) add({ track: r.track, course: r.course, lesson: r.lesson, topic: r.topic });
    }
    if (doLessonGrain) {
      const seen = new Set();
      for (const r of scoped) {
        if (!r.lesson) continue;
        const k = JSON.stringify([r.track || '', r.course || '', r.lesson || '']);
        if (!seen.has(k)) { seen.add(k); add({ track: r.track, course: r.course, lesson: r.lesson }); }
      }
    }
    if (!targets.size) return res.status(400).json({ error: 'Nothing to build for that grain' });

    const ai = aiChoice(req);
    const cachedIds = force ? new Set() : await getStudyGuideIds(program).catch(() => new Set());

    // Flatten to a work list of {scope, gscope}, dropping already-cached. There
    // is ONE guide per scope since the merge, so `kinds` no longer multiplies the
    // work list — asking for Lessons and Reviews builds the same single guide.
    const jobs = [];
    let skipped = 0;
    for (const scope of targets.values()) {
      const gscope = guideScope(GUIDE_KIND, program, scope);
      if (!force && cachedIds.has(studyGuideId(gscope))) { skipped++; continue; }
      jobs.push({ scope, gscope });
    }

    let built = 0, failed = 0, grounded = 0;
    await mapWithConcurrency(jobs, STUDY_GUIDE_CONCURRENCY, async ({ scope, gscope }) => {
      try {
        // The whole bank is already in hand — passing it in keeps this to the
        // per-scope reads (graph links, the scope's transcript) instead of
        // re-fetching ~1,200 topic rows for every target.
        const inp = await lessonInputs(req.userEmail, scope, programScope, bank);
        if (!inp) return;
        // Per JOB, never hoisted: `ai` is shared by every concurrent job here, so
        // one meta object would be cross-written by whichever finished last.
        const meta = {};
        let acc = '';
        await generateLesson({
          scopeLabel: inp.scopeLabel, topics: inp.topics, questions: inp.questions,
          prereqs: inp.prereqs, dependents: inp.dependents, source: inp.source,
        }, { ...ai, meta }, (t) => { acc += t; });
        if (acc.trim()) {
          // Pre-warmed guides are most of the library, so without provenance here
          // the learner's engine tag is blank and Regenerate has nothing to
          // rotate off for the majority of sections.
          await saveStudyGuide(gscope, acc, {
            scopeLabel: inp.scopeLabel, provider: meta.provider, model: meta.model, grounded: !!inp.source,
          });
          built += 1;
          if (inp.source) grounded += 1;
        }
        else failed += 1;
      } catch (e) {
        failed += 1;
        console.error('study-guide build failed:', scope.topic || scope.lesson, e.message);
      }
    });

    res.json({
      ok: true, program, kinds,
      targets: targets.size, attempted: jobs.length,
      // `grounded` is how many were built FROM the authored lesson document
      // rather than inferred from the question bank — the quality split that
      // matters most, and invisible without it.
      built, grounded, failed, skipped,
      concurrency: STUDY_GUIDE_CONCURRENCY,
    });
  } catch (e) {
    next(e);
  }
});

// Auth: AI analysis of the learner's overall progress dashboard (streamed).
// The knowledge graph's frontier/keystone signals ride along (best-effort) so
// the coach can say WHAT to study next, not just where accuracy is low.
app.post('/api/analyze', requireAuth, async (req, res, next) => {
  try {
    const bank = await getCatalog(req.userEmail, null);
    const catalog = filterCatalog(bank, await requestScope(req));
    const summary = buildProgressSummary(catalog);
    try {
      const links = await getGraphLinks();
      // Insights over the WHOLE bank so cross-program prereq edges count (a weak
      // math topic can block DE topics), then filtered back to the program this
      // dashboard is showing so the coach never recommends an off-view topic.
      const rows = bank.filter((r) => r.topic);
      const now = new Date();
      const g = computeInsights(rows.map((r) => toNode(r, now)), buildPrereqEdges(links, rows), { limit: 32 });
      const inProgram = new Set(catalog.filter((r) => r.topic).map((r) => r.id));
      summary.graph = {
        frontier: g.frontier.filter((f) => inProgram.has(f.id)).slice(0, 8),
        keystones: g.keystones.filter((k) => inProgram.has(k.id)).slice(0, 8),
      };
    } catch { /* graph unavailable — the analysis still works without it */ }
    await streamText(res, (onToken) => generateAnalysis(summary, aiChoice(req), onToken));
  } catch (e) {
    if (!res.headersSent) next(e);
  }
});

/* ------------------------------ knowledge graph ---------------------------- */
// Nodes are topics (the stable unit every quiz attempt and priority score keys
// on); each node carries its flashcards + this user's labels. Edges are the
// computed curriculum "flow" spine plus stored AI "prereq" links (lib/graph.js).

/** Link a batch of topics (LLM -> graphLinks), chunked so each call stays
 *  careful. Shared by the admin sweep and the background top-up. */
async function linkTopics(rows, targets, ai) {
  const candidates = rows.map((r) => ({ id: r.id, topic: r.topic, course: r.course || '', track: r.track || '' }));
  const chunks = [];
  for (let i = 0; i < targets.length; i += 20) chunks.push(targets.slice(i, i + 20));
  let linked = 0;
  await mapWithConcurrency(chunks, 2, async (chunk) => {
    try {
      const results = await generateTopicLinks({ targets: chunk, candidates }, ai);
      linked += await saveGraphLinks(results);
    } catch (e) {
      console.error('graph: link batch failed:', e.message);
    }
  });
  return linked;
}

// Self-healing map: whenever the graph is opened and topics without stored
// links exist (a fresh install, or newly added topics), link a capped batch in
// the background. Repeat opens finish the job; no admin action required.
let graphLinkingInFlight = false;
function kickBackgroundLinking(rows, unlinked, ai) {
  if (graphLinkingInFlight || !unlinked.length) return;
  graphLinkingInFlight = true;
  linkTopics(rows, unlinked.slice(0, 30), ai)
    .catch(() => {})
    .finally(() => { graphLinkingInFlight = false; });
}

// Auth: the full graph for the "Visualize my progress" map — nodes with THIS
// user's mastery state, flow + prereq edges, coverage, and the deterministic
// insights (frontier = ready to start; keystones = weak links blocking the most).
app.get('/api/graph', requireAuth, async (req, res, next) => {
  try {
    // Whole bank, NOT requestScope: the shelf can span programs (a data-science
    // learner with AI-engineering tracks), and scoping the catalog to one
    // program here silently dropped those tracks from the map. inEngine below
    // is program-aware, so the bank narrows to exactly the learner's engine —
    // the same pattern as /api/catalog's learner branch.
    const [catalog, links, allCards, engTracks, engShelf] = await Promise.all([
      getCatalog(req.userEmail, null),
      getGraphLinks(),
      getAllFlashcardsWithId(),
      effectiveShelf(req.userEmail),
      getShelf(req.userEmail),
    ]);
    // Visualize only what's actually in the learner's Mastery Engine (shelf tracks
    // + individually-added sections, minus removed ones — the same rule as
    // /api/catalog and the quiz/drill views), not the whole curriculum bank.
    // EXCEPT under a program PIN (?program=, Sentinel's Philosophical/Spiritual tabs):
    // there the whole session is one program and the tree is program-scoped, so the map
    // must mirror THAT — the shelf would leak every other program's tracks into the tab.
    const scope = await requestScope(req);
    let rows;
    if (pinnedProgram(req, scope)) {
      rows = filterCatalog(catalog, scope).filter((r) => r.topic);
    } else {
      const shelf = engShelf || {};
      rows = catalog.filter(
        (r) => r.topic && inEngine(r, engTracks || [], shelf.included || [], shelf.hidden || []),
      );
    }
    const now = new Date();
    const nodes = rows.map((r) => toNode(r, now));

    // Hang each topic's flashcards off its node (compact), with this user's
    // private labels, so clicking a node shows its cards and their state.
    // (conversationUser — the identity the labels are written under.)
    const statuses = await getFlashcardStatuses(conversationUser(req), allCards.map((c) => c.id));
    const cardsByTopic = new Map();
    for (const c of allCards) {
      if (!c.topic) continue;
      if (!cardsByTopic.has(c.topic)) cardsByTopic.set(c.topic, []);
      cardsByTopic.get(c.topic).push({
        id: c.id,
        concept: c.concept || '',
        level: c.level || 'course',
        status: statuses[c.id] || null,
      });
    }
    const LEVEL_RANK = { topic: 0, lesson: 1, course: 2 }; // most-specific first
    for (const n of nodes) {
      n.cards = (cardsByTopic.get(n.topic) || [])
        .sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3));
    }

    const prereqEdges = buildPrereqEdges(links, rows);
    addConnectivity(nodes, prereqEdges);
    const edges = [...buildFlowEdges(rows), ...prereqEdges];
    const insights = computeInsights(nodes, prereqEdges);

    const linkedIds = new Set(links.map((l) => l.id));
    const unlinked = rows.filter((r) => !linkedIds.has(r.id));
    // Candidates = the WHOLE bank, not the shelf and not one program: prereqs
    // deliberately cross programs (a DE topic really does rest on data_science
    // probability), so the linker must see the full menu or those edges can
    // never exist. Repeat map opens work through the backlog 30 at a time.
    if (unlinked.length) {
      kickBackgroundLinking(catalog.filter((r) => r.topic), unlinked, aiChoice(req));
    }

    res.json({
      nodes,
      edges,
      insights,
      coverage: {
        linked: rows.length - unlinked.length,
        total: rows.length,
        building: unlinked.length > 0,
      },
    });
  } catch (e) {
    next(e);
  }
});

// Admin: bulk-build the prereq links (resumable sweep, like the format fixers).
// Processes up to `max` unlinked topics per call; `?refresh=1` re-links
// EVERYTHING (e.g. after a big catalog change). Safe to re-run.
app.post('/api/admin/build-graph', requireAdmin, async (req, res, next) => {
  try {
    const max = Math.min(parseInt(req.query.max, 10) || 120, 600);
    // TARGETS are scoped (?program=…) so a sweep pages through one program at a
    // time, but CANDIDATES are always the whole bank: prerequisites deliberately
    // cross programs (an ai_engineering topic can rest on a data_science math
    // topic), so the linker must see the full menu.
    const [bank, scope, links] = await Promise.all([
      getCatalog(req.userEmail, null),
      requestScope(req),
      getGraphLinks(),
    ]);
    const rows = bank.filter((r) => r.topic);
    const targets = filterCatalog(rows, scope);
    const linkedIds = new Set(links.map((l) => l.id));
    // refresh=1 relinks everything EXCEPT hand-authored docs — the curated edges
    // (ai_engineering track, July 2026) are deliberately better than the LLM's and
    // must survive an admin refresh sweep. force=1 overrides even that.
    const curated = new Set(links.filter((l) => l.source === 'hand-authored').map((l) => l.id));
    const force = req.query.force === '1';
    const pending = req.query.refresh === '1'
      ? targets.filter((r) => force || !curated.has(r.id))
      : targets.filter((r) => !linkedIds.has(r.id));
    // `refresh=1` re-links ALL rows in a stable order — page it with `offset` so a
    // program with >max topics can be swept fully (max caps at 600/call).
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const todo = pending.slice(offset, offset + max);
    const linked = await linkTopics(rows, todo, aiChoice(req));
    const nextOffset = offset + todo.length;
    res.json({ ok: true, linked, nextOffset, remaining: Math.max(0, pending.length - nextOffset) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------- Warm-up / readiness ---------------------------- */
// The Learn flow: before starting a NEW topic, diagnose how ready the learner is
// from their prerequisite mastery, and (optionally) warm up on the weak prereqs.
// Runtime is pure logic over the cached prereq graph + this user's stats (no LLM).
//
// Prerequisites deliberately cross courses/tracks — and PROGRAMS (the linker
// picks from the whole bank) — so readiness is computed over the WHOLE bank:
// buildPrereqEdges keeps only edges with both ends in the catalog slice, so any
// narrower slice would drop edges and mis-read prereqs as never-attempted.
async function readinessForTarget(userEmail, scope, body) {
  const fullScope = null; // whole bank; doubles as the warm-up question-pool scope
  const [catalog, links] = await Promise.all([getCatalog(userEmail, fullScope), getGraphLinks()]);
  const rows = catalog.filter((r) => r.topic);
  const now = new Date();
  const nodes = rows.map((r) => toNode(r, now));
  const prereqEdges = buildPrereqEdges(links, rows);
  // Target(s) = an explicit topic-name list (Live Quiz's ticked topics) OR the rows
  // inside the narrow launched scope. Either way resolved to real doc ids, WITHIN
  // the launched program — topic names are only unique per program; the prereq
  // closure over the edges above can still reach any program.
  const inProgram = filterCatalog(rows, { program: scope.program, courses: [] });
  let targetRows;
  if (Array.isArray(body?.topics) && body.topics.length) {
    const wanted = new Set(body.topics.map((t) => String(t || '').trim()).filter(Boolean));
    targetRows = inProgram.filter((r) => wanted.has(r.topic));
  } else {
    targetRows = scopeCatalog(inProgram, body || {});
  }
  const targetIds = targetRows.map((r) => r.id);
  const readiness = computeReadiness(targetIds, nodes, prereqEdges);
  const linkedIds = new Set(links.map((l) => l.id));
  const linked = targetIds.filter((id) => linkedIds.has(id)).length;
  // No linked target => the graph hasn't been built for this topic yet; say so
  // rather than reporting a false "ready" off an empty prereq set.
  const coverage = { targets: targetIds.length, linked, building: targetIds.length > 0 && linked === 0 };
  return { readiness, targetIds, coverage, fullScope };
}

// Auth: readiness diagnosis for the topic(s) about to be learned.
app.post('/api/readiness', requireAuth, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const { readiness, coverage } = await readinessForTarget(req.userEmail, scope, req.body || {});
    res.json({ ...readiness, coverage });
  } catch (e) {
    next(e);
  }
});

// Auth: a short warm-up quiz drawn from the target's PREREQUISITES (all of them,
// weak-first — so a learner can warm up EVEN when already solid on the prereqs;
// warm-up is never gated on readiness). Empty only when the topic has no known
// prerequisites at all. Each question is credited to its OWN prerequisite's
// container (not the launched target), so warm-up attempts log to the right doc id.
app.post('/api/quiz/warmup', requireAuth, async (req, res, next) => {
  try {
    const count = clampCount(req.body?.count);
    const scope = await requestScope(req);
    const { readiness, coverage, fullScope } = await readinessForTarget(req.userEmail, scope, req.body || {});
    const prereqs = readiness.prereqs;
    if (!prereqs.length) return res.json({ ready: readiness.ready, questions: [], readiness, coverage });

    const prereqNames = [...new Set(prereqs.map((w) => w.topic))];
    const pool = await getQuestionsForTopics(prereqNames, fullScope);
    const seen = await getSeenQuestionTexts(req.userEmail);
    const rank = new Map(prereqs.map((w, i) => [w.topic, i])); // weak-first / prerequisite-first
    const byRank = (a, b) => (rank.get(a.topic) ?? 99) - (rank.get(b.topic) ?? 99);
    const unseen = pool.filter((q) => !seen.has(q.question.trim())).sort(byRank);
    const seenQs = pool.filter((q) => seen.has(q.question.trim())).sort(byRank);
    // Credit each question to ITS prerequisite's row, NOT the launched target —
    // the doc-id-not-slug rule on the warm path.
    const metaByName = new Map(prereqs.map((w) => [w.topic, w]));
    res.json({
      ready: readiness.ready,
      readiness,
      coverage,
      questions: packageQuestions([...unseen, ...seenQs], metaByName, count),
    });
  } catch (e) {
    next(e);
  }
});

// Auth: a warm-up flashcard deck from the target's PREREQUISITES (all of them,
// weak-first — warm-up is never gated on readiness). Mirrors the mastery-deck
// composer (most-specific level per topic), ordered prerequisite-first. Empty only
// when the topic has no prerequisites or none of them have decks.
app.post('/api/flashcards/warmup', requireAuth, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const { readiness, coverage } = await readinessForTarget(req.userEmail, scope, req.body || {});
    const prereqs = readiness.prereqs;
    if (!prereqs.length) return res.json({ ready: readiness.ready, cards: [], readiness, coverage });

    const prereqTopics = new Set(prereqs.map((w) => w.topic));
    const LEVEL_RANK = { topic: 3, lesson: 2, course: 1 };
    const all = await getAllFlashcardsWithId();
    const byTopic = new Map();
    for (const c of all) {
      const t = c.topic || '';
      if (!t || !prereqTopics.has(t)) continue;
      const r = LEVEL_RANK[c.level] || 0;
      const cur = byTopic.get(t);
      if (!cur || r > cur.rank) byTopic.set(t, { rank: r, cards: [c] });
      else if (r === cur.rank) cur.cards.push(c);
    }
    for (const g of byTopic.values()) g.cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const picked = [];
    for (const w of prereqs) { const g = byTopic.get(w.topic); if (g) picked.push(...g.cards); }
    res.json({
      ready: readiness.ready,
      readiness,
      coverage,
      coveredPrereqs: byTopic.size,
      cards: await packageFlashcards(picked, conversationUser(req)),
    });
  } catch (e) {
    next(e);
  }
});

// Auth: the "Learn next" shortlist. Ranks the NEW topics in the learner's engine
// (never attempted OR still weak <60%) by how ready they are to learn now —
// prerequisites-mastered first — so the Learn tab can suggest what to study next
// without making the learner drill through selects. Pure logic (no LLM).
app.get('/api/learn/next', requireAuth, async (req, res, next) => {
  try {
    // Whole bank, same reason as /api/graph: the shelf spans programs and the
    // prereq graph crosses them — a program-scoped catalog would hide both
    // other-program candidates and their cross-program prerequisite edges.
    const [catalog, links, engTracks, engShelf] = await Promise.all([
      getCatalog(req.userEmail, null),
      getGraphLinks(),
      effectiveShelf(req.userEmail),
      getShelf(req.userEmail),
    ]);
    const rows = catalog.filter((r) => r.topic);
    const now = new Date();
    const nodes = rows.map((r) => toNode(r, now));
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const prereqEdges = buildPrereqEdges(links, rows);
    const linkedIds = new Set(links.map((l) => l.id));
    const shelf = engShelf || {};
    const tracks = engTracks || [];

    // Candidate NEW topics, limited to the learner's Mastery Engine (same inEngine
    // rule as the quiz/drill views): never attempted, or attempted but still weak.
    // Under a program PIN the candidates come from the pinned program instead —
    // the whole-bank nodes/edges above still power readiness, so cross-program
    // prerequisites keep counting; only the SUGGESTIONS narrow to the tab.
    const scope = await requestScope(req);
    const pin = pinnedProgram(req, scope);
    const inTab = (r) => (pin
      ? filterCatalog([r], scope).length > 0
      : inEngine(r, tracks, shelf.included || [], shelf.hidden || []));
    const candidates = nodes.filter((n) => {
      if (!inTab(rowById.get(n.id))) return false;
      return n.attempts === 0 || (n.accuracy != null && n.accuracy < WEAK_ACC);
    });
    const scored = candidates.map((n) => {
      const r = computeReadiness([n.id], nodes, prereqEdges);
      const linked = linkedIds.has(n.id);
      // Foundational (linked, no prereqs) is ready to learn now; "unknown because
      // unlinked" ranks last since we can't vouch for its prerequisites yet.
      let score, tier, sortScore;
      if (r.tier === 'unknown') { score = null; tier = linked ? 'ready' : 'unknown'; sortScore = linked ? 90 : -1; }
      else { score = r.score; tier = r.tier; sortScore = r.score; }
      return {
        id: n.id, topic: n.topic, track: n.track, course: n.course, lesson: n.lesson,
        program: rowById.get(n.id)?.program,
        attempts: n.attempts, accuracy: n.accuracy, readiness: { score, tier }, _s: sortScore,
      };
    });
    // Most-ready first; among equals, never-attempted before weak, weakest first.
    scored.sort((a, b) =>
      (b._s - a._s)
      || (a.attempts - b.attempts)
      || ((a.accuracy ?? 999) - (b.accuracy ?? 999))
      || String(a.topic).localeCompare(String(b.topic)));
    res.json({ suggestions: scored.slice(0, 8).map(({ _s, ...s }) => s) });
  } catch (e) {
    next(e);
  }
});

// Admin: AI-sequence each lesson's topics into study order and persist an
// `order` field per topic doc (resumable sweep, like the format fixers). Every
// view then sorts topics by that order instead of alphabetically.
//
// Processes up to `max` LESSONS per call; a lesson is "pending" until every one
// of its topics has a stored order. `?refresh=1` re-sequences every lesson (e.g.
// after adding topics). `?track=`/`?course=` narrow the sweep to one curriculum
// slice — the ML button passes ?track=Machine Learning. Safe to re-run.
app.post('/api/admin/sequence-topics', requireAdmin, async (req, res, next) => {
  try {
    const maxLessons = Math.min(parseInt(req.query.max, 10) || 40, 200);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const catalog = await getCatalog(req.userEmail, await requestScope(req));
    const track = (req.query.track || '').trim();
    const course = (req.query.course || '').trim();
    const rows = catalog.filter((r) =>
      r.topic && (!track || r.track === track) && (!course || r.course === course));

    // Group rows into lessons (track+course+lesson is the unit we sequence).
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.track} ${r.course} ${r.lesson}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const refresh = req.query.refresh === '1';
    // Only 2+-topic lessons can be ordered; a lesson is pending if it has an
    // unordered topic, or unconditionally on a full refresh.
    const pending = [...groups.values()].filter(
      (g) => g.length >= 2 && (refresh || g.some((r) => !Number.isFinite(r.order))));
    // Incremental mode shrinks `pending` as lessons gain orders (always take from the
    // front); refresh keeps a stable set, so page through it with `offset`.
    const start = refresh ? offset : 0;
    const todo = pending.slice(start, start + maxLessons);
    const ai = aiChoice(req);

    let sequenced = 0;
    await mapWithConcurrency(todo, 2, async (g) => {
      try { await sequenceLessonGroup(g, ai); sequenced += 1; }
      catch (e) { console.error('sequence-topics: lesson failed:', e.message); }
    });
    const nextOffset = start + todo.length;
    res.json({
      ok: true,
      sequenced,
      total: pending.length,
      nextOffset,
      remaining: refresh ? Math.max(0, pending.length - nextOffset) : Math.max(0, pending.length - todo.length),
    });
  } catch (e) {
    next(e);
  }
});

// Admin: AI-sequence the two grains ABOVE the topic — the COURSES within a track
// and the LESSONS within each course — and persist `courseOrder`/`lessonOrder` per
// topic doc. The sibling of /sequence-topics; together the two cover the whole tree,
// so no level has to fall back to alphabetical.
//
// Every creation path now persists its own designed order, so this is the REPAIR
// tool: run it on a track that landed alphabetically (anything built before the
// order was stored), or after a reshape. `?track=` narrows it to one track,
// `?refresh=1` re-sequences even tracks whose units already carry a rank —
// WITHOUT it only tracks holding an unranked course or lesson are touched, so a
// curriculum someone curated by hand is never quietly reshuffled. Safe to re-run.
app.post('/api/admin/sequence-curriculum', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const catalog = (await getCatalog(null, { program })).filter((r) => r.topic && r.id);
    const only = String(req.query.track || '').trim();
    const refresh = req.query.refresh === '1';

    let tracks = [...new Set(catalog.map((r) => r.track))].filter(Boolean).sort(cmpNatural);
    if (only) tracks = tracks.filter((t) => t === only);
    if (!refresh) {
      const want = new Set(tracks);
      tracks = tracksNeedingOrder(catalog.filter((r) => want.has(r.track)));
    }

    const ai = aiChoice(req);
    const done = [];
    const failed = [];
    for (const track of tracks) {
      try {
        const n = await sequenceCurriculumTrack(program, track, ai);
        if (n) done.push(track);
      } catch (e) {
        console.error('sequence-curriculum: track failed:', track, e.message);
        failed.push({ track, error: e.message });
      }
    }
    res.json({ ok: true, sequenced: done.length, tracks: done, failed });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- AI tutor --------------------------------- */
// Public (rate-limited): a hint that does NOT reveal the answer (streamed).
app.post('/api/hint', rateLimitAI, async (req, res) => {
  const { question, options, answer } = req.body || {};
  if (!question || !Array.isArray(options)) {
    return res.status(400).json({ error: 'question and options are required' });
  }
  await streamText(res, (onToken) =>
    generateHint({ question, options, answer: answer || '' }, aiChoice(req), onToken));
});

// Public (rate-limited): a from-scratch explanation, shown after answering (streamed).
app.post('/api/explain', rateLimitAI, async (req, res) => {
  const { question, options, answer, userAnswer, isCorrect } = req.body || {};
  if (!question || !Array.isArray(options) || !answer) {
    return res.status(400).json({ error: 'question, options and answer are required' });
  }
  await streamText(res, (onToken) =>
    generateExplanation({ question, options, answer, userAnswer, isCorrect: !!isCorrect }, aiChoice(req), onToken));
});

/* -------------------------------- admin ----------------------------------- */
// Auth: wipe all progress (reset topic stats + delete quiz history). Keeps the
// catalog and the question bank. Start-from-scratch.
app.post('/api/admin/reset', requireAuth, async (req, res, next) => {
  try {
    const report = await resetProgress(req.userEmail);
    // Best-effort: refresh the BQ topics snapshot to mirror the wipe (default account only).
    if (req.userEmail === DEFAULT_ACCOUNT) getTopicsRows(DEFAULT_ACCOUNT).then(replaceTopics).catch(() => {});
    res.json({ ok: true, ...report });
  } catch (e) {
    next(e);
  }
});

// Auth: one-time migration that converts the existing question bank's informal
// math notation (x^2, cos^-1, x->3, ...) into KaTeX LaTeX so it renders. Safe
// and resumable: processes up to `max` un-converted questions per call, skips
// any whose converted answer no longer matches an option (keeps the original),
// and reports how many remain. Call repeatedly until remaining = 0.
const MATH_HINT = /[\^_√→×÷≤≥≠∞∑∫π]|\\[a-zA-Z]/;
const hasDollar = (q) =>
  String(q.question || '').includes('$') || (q.options || []).some((o) => String(o).includes('$'));
const needsLatex = (q) =>
  !hasDollar(q) && (MATH_HINT.test(q.question || '') || (q.options || []).some((o) => MATH_HINT.test(String(o))));

app.post('/api/admin/latexify', requireAdmin, async (req, res, next) => {
  try {
    const max = Math.min(parseInt(req.query.max, 10) || 200, 800);
    // Scoped: this is a MATH formatter, so it must not reach a non-maths
    // program's bank. Defaults to the admin's program (data science today, which
    // is the whole bank); pass ?program= to sweep another one.
    const all = await getAllQuestions(await requestScope(req));
    const pending = all.filter(needsLatex);
    const todo = pending.slice(0, max);

    let converted = 0;
    let skipped = 0;
    const BATCH = 12;
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH).map((q) => ({
        id: q.id, question: q.question, options: q.options, answer: q.answer,
      }));
      let out;
      try {
        out = await latexifyQuestions(chunk, aiChoice(req));
      } catch {
        skipped += chunk.length;
        continue;
      }
      const byId = new Map((out || []).map((o) => [o.id, o]));
      const updates = [];
      for (const q of chunk) {
        const o = byId.get(q.id);
        const okShape =
          o && typeof o.question === 'string' && Array.isArray(o.options) &&
          o.options.length === q.options.length && typeof o.answer === 'string';
        const answerMatches =
          okShape && o.options.map((s) => String(s).trim()).includes(String(o.answer).trim());
        if (okShape && answerMatches) {
          updates.push({
            id: q.id,
            question: o.question,
            options: o.options.map(String),
            answer: String(o.answer),
          });
          converted += 1;
        } else {
          skipped += 1;
        }
      }
      // Commit each batch immediately so progress persists and is resumable
      // even if the request later times out.
      await bulkUpdateQuestions(updates);
    }
    res.json({ ok: true, converted, skipped, remaining: Math.max(0, pending.length - converted) });
  } catch (e) {
    next(e);
  }
});

// Admin: sweep every shared flashcard and fix the code/math formatting of the
// broken ones (same reformatter as the per-card "fixformat" command). Processes
// up to `max` candidates per call, commits each batch (resumable), and reports
// how many were fixed. Meaning is preserved; a field is only rewritten when it
// actually changes to non-empty content.
app.post('/api/admin/fix-flashcard-formats', requireAdmin, async (req, res, next) => {
  try {
    const max = Math.min(parseInt(req.query.max, 10) || 120, 600);
    const all = await getAllFlashcardsWithId();
    const pending = all.filter(flashcardNeedsFormatFix);
    const todo = pending.slice(0, max);

    let fixed = 0;
    let skipped = 0;
    const BATCH = 10;
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH).map((c) => ({
        id: c.id, concept: c.concept || '', intuition: c.intuition || '', formula: c.formula || '',
      }));
      let out;
      try {
        out = await reformatFlashcards(chunk, aiChoice(req));
      } catch {
        skipped += chunk.length;
        continue;
      }
      const byId = new Map((out || []).map((o) => [o.id, o]));
      const updates = [];
      for (const c of chunk) {
        const patch = acceptCardFix(c, byId.get(c.id));
        if (Object.keys(patch).length) { updates.push({ id: c.id, ...patch }); fixed += 1; }
        else skipped += 1;
      }
      // Commit each batch immediately so progress persists / is resumable.
      await bulkUpdateFlashcards(updates);
    }
    res.json({ ok: true, fixed, skipped, candidates: pending.length, remaining: Math.max(0, pending.length - fixed) });
  } catch (e) {
    next(e);
  }
});

// Admin: sweep every shared quiz question and fix the code/math formatting (and
// strip raw HTML) of the broken ones (same reformatter as the per-question "Fix
// format" button). Processes up to `max` candidates per call, commits each batch
// (resumable), and reports how many were fixed. Meaning is preserved; the answer
// always stays matched to an option, and a field is only rewritten when it
// actually changes.
app.post('/api/admin/fix-question-formats', requireAdmin, async (req, res, next) => {
  try {
    const max = Math.min(parseInt(req.query.max, 10) || 120, 600);
    // Scoped like /api/admin/latexify — the reformatter's rules are maths-shaped.
    const all = await getAllQuestions(await requestScope(req));
    const pending = all.filter(questionNeedsFormatFix);
    const todo = pending.slice(0, max);

    let fixed = 0;
    let skipped = 0;
    const BATCH = 10;
    for (let i = 0; i < todo.length; i += BATCH) {
      // `stored` keeps the true values for change detection; `cleaned` (control
      // chars repaired) is what the model sees and the fallback baseline.
      const stored = todo.slice(i, i + BATCH).map((q) => ({
        id: q.id,
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options.map(String) : [],
        answer: q.answer || '',
      }));
      const cleanedById = new Map(stored.map((q) => [q.id, cleanQuestionEscapes(q)]));
      let out;
      try {
        out = await reformatQuestions(stored.map((q) => ({ id: q.id, ...cleanedById.get(q.id) })), aiChoice(req));
      } catch {
        skipped += stored.length;
        continue;
      }
      const byId = new Map((out || []).map((o) => [o.id, o]));
      const updates = [];
      for (const orig of stored) {
        const fix = acceptQuestionFix(cleanedById.get(orig.id), byId.get(orig.id));
        if (fix && questionFixChanges(orig, fix).length) {
          updates.push({ id: orig.id, ...fix });
          fixed += 1;
        } else {
          skipped += 1;
        }
      }
      // Commit each batch immediately so progress persists / is resumable.
      await bulkUpdateQuestions(updates);
    }
    res.json({ ok: true, fixed, skipped, candidates: pending.length, remaining: Math.max(0, pending.length - fixed) });
  } catch (e) {
    next(e);
  }
});

// Admin: one-time, idempotent merge of the math tracks into a single
// "Mathematics" track (renames Math Foundations, folds in Mathematics for ML),
// re-keying mastery stats + flashcard decks. Safe to re-run (reports 0 moved).
app.post('/api/admin/merge-math', requireAdmin, async (_req, res, next) => {
  try {
    const report = await mergeIntoMathematics();
    // Refresh the BigQuery topics snapshot to mirror the rename (default account only).
    getTopicsRows(DEFAULT_ACCOUNT, new Date(), BQ_SCOPE).then(replaceTopics).catch(() => {});
    res.json({ ok: true, ...report });
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- programs -------------------------------- */

// Auth: the programs this user may study + which one this request resolves to.
// The frontend uses it to know whether to offer a program switcher at all.
app.get('/api/programs', requireAuth, async (req, res, next) => {
  try {
    const [all, enrollment, scope] = await Promise.all([
      getPrograms(),
      getEnrollment(req.userEmail),
      requestScope(req),
    ]);
    // Admins may study/inspect anything; a learner sees only what they're enrolled in.
    const mine = req.isAdmin ? all : all.filter((p) => enrollment.programs.includes(p.id));
    res.json({ programs: mine, current: scope.program, courses: scope.courses, admin: req.isAdmin });
  } catch (e) {
    next(e);
  }
});

// The curated video baseline (public/video-lessons.json), read once and cached.
let _videoSeed = null;
function videoSeed() {
  if (_videoSeed) return _videoSeed;
  try { _videoSeed = JSON.parse(readFileSync(path.join(__dirname, 'public', 'video-lessons.json'), 'utf8')); }
  catch { _videoSeed = {}; }
  return _videoSeed;
}

// Auth: the Video Lessons watch-list for the user's program — the curated baseline
// PLUS any transcript attached in Academy Admin that carries a video URL (Watcher
// imports, or a paste with a URL). Admins may pass ?program= to preview another.
app.get('/api/video-lessons', requireAuth, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = scope.program;
    // Start from the curated, curriculum-ordered baseline for this program.
    const base = (videoSeed()[program] && JSON.parse(JSON.stringify(videoSeed()[program]))) || { intro: '', tracks: [] };
    const tracks = base.tracks || (base.tracks = []);
    const seenUrls = new Set();
    for (const t of tracks) for (const c of (t.courses || [])) for (const v of (c.videos || [])) if (v.url) seenUrls.add(v.url);

    const findGroup = (track, course) => {
      let tg = tracks.find((x) => x.track === track);
      if (!tg) { tg = { track, courses: [] }; tracks.push(tg); }
      let cg = tg.courses.find((x) => x.course === course);
      if (!cg) { cg = { course, videos: [], note: null }; tg.courses.push(cg); }
      return cg;
    };

    // Merge in attached transcripts that reference a video URL (deduped).
    const transcripts = await getTranscripts({ program });
    for (const tr of transcripts) {
      const url = tr.watcherRef && tr.watcherRef.url;
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const cg = findGroup(tr.track || 'Other', tr.course || 'Attached videos');
      cg.videos.push({ title: tr.title || 'Video', url, lessons: tr.lesson ? [tr.lesson] : [] });
    }
    res.json({ program, ...base });
  } catch (e) {
    next(e);
  }
});

// Verify an internal service-to-service HMAC (shared platform-sso-key both apps mount
// as SSO_SECRET). Signature is over `${purpose}:${ts}` with a 5-min replay window.
// Returns true/false; used for sister-app calls that carry no user session.
function verifyInternalSig(req, purpose) {
  const secret = process.env.SSO_SECRET || '';
  if (!secret) return false;
  const ts = req.get('x-academy-ts');
  const sig = req.get('x-academy-sig');
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${purpose}:${ts}`).digest('hex');
  return expected === sig;
}

// Internal (HMAC-gated): a user's enrolled programs with progress, for Sentinel's
// Growth hub (the Overview rings) and Professional tab. No user session — Sentinel calls
// this server-to-server with the logged-in worker's email.
//
// The numbers MIRROR what that person's own engine session shows, or the Overview ring and
// the in-app "Overall mastery" disagree (they did: 16% vs 50%). Two rules make the mirror:
//  1. ACCOUNT — a break-glass-listed admin's session maps to DEFAULT_ACCOUNT (effectiveUser's
//     listed-admin rule), so their stats live THERE, not under their sign-in email. Apply the
//     same mapping here. (Sentinel-role admins keep their own account in both places.)
//  2. SCOPE — the engine's rollup runs over the personal SHELF (curated tracks minus hidden
//     sections), not whole programs. When a curated shelf exists, aggregate the same rows,
//     grouped by program; an uncurated shelf falls back to whole-program scope, which is what
//     the engine derives anyway. `progressSum` is included raw so Sentinel can combine career
//     programs topic-weighted — exactly the engine's overview formula.
/**
 * One person's per-program rollup — the shape BOTH internal progress endpoints report.
 *
 * Extracted (2026-08-03) so the single-person path (/enrollment-progress, behind Sentinel's
 * Overview rings) and the batch path (/team-progress, behind its admin team table) cannot drift.
 * The same person has to read the same number in both places, or one of the two is lying.
 *
 * One card per ASSIGNED PROGRAM, aggregated over the same rows ITS TAB shows.
 * Career programs mirror the personal engine (the Professional tab is the unpinned,
 * SHELF-scoped app — including programs the shelf omits reporting 0 topics; whole-program
 * fallback there was the 50%-vs-39% drift). Growth programs mirror their PINNED tab
 * (Philosophical/Spiritual), which is WHOLE-PROGRAM scoped — shelf-filtering those
 * zeroed the ring while the tab itself showed real progress.
 *
 * Pass `deltas` (a getRecentAttemptStats map) to also get `progressSumThen`: the identical sum
 * computed against each topic's stats AS THEY STOOD when the window opened. now − then over the
 * window is a real rate of progress; without it a caller can only report a running total.
 */
function rollupPrograms({ enrollment, allPrograms, shelf, bank, deltas = null }) {
  const nameOf = (id) => (allPrograms.find((p) => p.id === id) || {}).name || id;
  const catOf = (id) => (allPrograms.find((p) => p.id === id) || {}).category || 'career';
  const tracks = shelf && shelf.tracks && shelf.tracks.length ? shelf.tracks : null;
  const programs = [];
  for (const pid of enrollment.programs) {
    let rows = filterCatalog(bank, { program: pid, courses: enrollment.courses });
    if (tracks && catOf(pid) !== 'growth') rows = rows.filter((r) => inEngine(r, tracks, shelf.included, shelf.hidden));
    let total = 0, practiced = 0, progSum = 0, progSumThen = 0;
    const courses = new Set();
    for (const r of rows) {
      total += 1;
      courses.add(r.course);
      const attempts = r.totalAttempts || 0;
      const correct = r.correctCount || 0;
      if (attempts > 0) { practiced += 1; progSum += Math.round(correct / attempts * 100); }
      if (!deltas) continue;
      // Where this topic stood when the window opened. CLAMPED because quizLog and topicStats can
      // legitimately disagree — a reset account, an import, a row logged under a since-re-filed
      // tuple — and a negative attempt count is not a number. Clamping makes the worst case
      // "this person's velocity reads low", never a nonsense percentage.
      const d = deltas.get(r.id);
      const wasAttempts = Math.max(0, attempts - (d ? d.attempts : 0));
      const wasCorrect = Math.min(wasAttempts, Math.max(0, correct - (d ? d.correct : 0)));
      if (wasAttempts > 0) progSumThen += Math.round(wasCorrect / wasAttempts * 100);
    }
    programs.push({
      id: pid, name: nameOf(pid), category: catOf(pid),
      courseCount: courses.size,
      topicsTotal: total, topicsPracticed: practiced,
      progressSum: progSum,
      ...(deltas ? { progressSumThen: progSumThen } : {}),
      pct: total ? Math.round(progSum / total) : 0,
    });
  }
  return programs;
}

app.get('/api/internal/enrollment-progress', async (req, res, next) => {
  try {
    if (!verifyInternalSig(req, 'enrollment-progress')) return res.status(401).json({ error: 'bad signature' });
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const acct = isAdminEmail(email) ? DEFAULT_ACCOUNT : email;
    const [enrollment, allPrograms, shelf, bank] = await Promise.all([
      getEnrollment(acct), getPrograms(), getShelf(acct), getCatalog(acct, null),
    ]);
    const programs = rollupPrograms({ enrollment, allPrograms, shelf, bank });
    // `admin` lets the Sentinel Academy tab default admins straight to the admin view. The
    // academy-admin page re-gates at the SERVER with full cookie context (non-admins are
    // 302'd to the homepage — see the /academy-admin.html gate), so this is only a UI default.
    // Role-aware: Sentinel super_admin/admin count, alongside the env break-glass list.
    res.json({ programs, admin: isAdminEmail(email) || isSentinelAdminRole((await sentinelInfo(email)).role) });
  } catch (e) {
    next(e);
  }
});

// At most this many people per team-progress call. Not a performance ceiling (the shared catalog
// is read once either way) — a guard so a malformed caller can't turn one request into an
// unbounded fan-out of per-user Firestore reads. Sentinel pages its roster against it.
const MAX_TEAM_EMAILS = 60;

// Internal (HMAC-gated): the SAME rollup as /enrollment-progress for MANY people at once, plus
// each person's recent attempt window — what Sentinel's admin "Team progress" panel ranks on.
//
// BATCHED for one reason: the shared `topics` catalog (~540 docs) is read ONCE here and overlaid
// with each person's own stats, rather than re-read per person. Twelve staff cost ~540 topic reads
// plus twelve small per-user reads, instead of ~6,500. That is the whole justification for a second
// endpoint rather than Sentinel looping the first one.
//
// FAIL-SOFT PER PERSON, not per request: one unreadable account answers { found:false, error } in
// its own slot and everybody else still reports. Failing the whole call would blank a panel that is
// mostly fine, and (worse) an all-zeroes table reads as "nobody is doing anything" — a wrong
// answer, where a named gap is an honest one.
app.get('/api/internal/team-progress', async (req, res, next) => {
  try {
    if (!verifyInternalSig(req, 'team-progress')) return res.status(401).json({ error: 'bad signature' });
    const emails = [...new Set(
      String(req.query?.emails || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    )];
    if (!emails.length) return res.status(400).json({ error: 'emails required' });
    if (emails.length > MAX_TEAM_EMAILS) {
      return res.status(400).json({ error: `at most ${MAX_TEAM_EMAILS} emails per call` });
    }
    const days = Math.min(180, Math.max(1, Number(req.query?.days) || 30));
    const [allPrograms, topicRows] = await Promise.all([getPrograms(), readTopicDocs()]);
    const people = await Promise.all(emails.map(async (email) => {
      try {
        // Same account mapping as /enrollment-progress: a break-glass-listed admin's stats live
        // under DEFAULT_ACCOUNT, so ranking them by their sign-in email would show an empty row.
        const acct = isAdminEmail(email) ? DEFAULT_ACCOUNT : email;
        const [enrollment, shelf, bank] = await Promise.all([
          getEnrollment(acct), getShelf(acct), overlayStats(acct, topicRows, null),
        ]);
        const window = await getRecentAttemptStats(acct, days, topicRows);
        return {
          email,
          found: true,
          programs: rollupPrograms({ enrollment, allPrograms, shelf, bank, deltas: window.deltas }),
          activity: {
            days,
            attempts: window.attempts,
            correct: window.correct,
            activeDays: window.activeDays,
            streak: window.streak,
            lastActive: window.lastActive,
            unmatched: window.unmatched,
          },
        };
      } catch (e) {
        return {
          email, found: false, programs: [], activity: null,
          error: String((e && e.message) || e).slice(0, 160),
        };
      }
    }));
    res.json({ days, people });
  } catch (e) {
    next(e);
  }
});

/* --------------------------- Time spent (internal) -------------------------- */
// The reading side of /api/activity/beat, for Sentinel. Both endpoints answer over an inclusive
// day range [from, to] in ACTIVITY_TZ — Sentinel picks Today / This week / 30 days and sends the
// DATES, so the two apps can never disagree about where a window starts. `days` is the fallback
// when no `from` is given (counted back from `to`, default today).
//
// Unlike the progress rollups, a person with no minutes is a real ZERO, not an unknown: the
// absence of activity docs means nothing was recorded, which is the answer. `found:false` is
// reserved for a read that actually failed.
const MAX_ACTIVITY_DAYS = 62;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const shiftDay = (d, n) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
function activityRange(q) {
  const today = activityKey(new Date()).day;
  let to = DAY_RE.test(String(q?.to || '')) ? String(q.to) : today;
  let from = DAY_RE.test(String(q?.from || '')) ? String(q.from) : '';
  if (!from) {
    const days = Math.min(MAX_ACTIVITY_DAYS, Math.max(1, Number(q?.days) || 1));
    from = shiftDay(to, -(days - 1));
  }
  if (from > to) [from, to] = [to, from];
  if (dayDiff(from, to) + 1 > MAX_ACTIVITY_DAYS) from = shiftDay(to, -(MAX_ACTIVITY_DAYS - 1));
  const days = [];
  for (let i = 0; i <= dayDiff(from, to); i++) days.push(shiftDay(from, i));
  return { from, to, days };
}

// Which accounts hold one person's minutes. Beats are keyed by the sign-in email, but a
// break-glass-listed admin who signs in with the shared password lands under DEFAULT_ACCOUNT
// (currentEmail's password arm) — read both and union by minute. Minute keys de-duplicate, so
// the union can't double count one person; it CAN attribute the shared account's minutes to
// every listed admin, which is the same convenience mapping the progress endpoints make.
function activityAccounts(email) {
  return isAdminEmail(email) && email !== DEFAULT_ACCOUNT ? [email, DEFAULT_ACCOUNT] : [email];
}
async function readActivity(email, days) {
  const merged = {};
  for (const acct of activityAccounts(email)) {
    const got = await getActivityDays(acct, days);
    for (const [day, m] of Object.entries(got)) Object.assign(merged[day] ||= {}, m);
  }
  return merged; // { day: { HHMM: ctx } }
}
/** Totals over a { day: { HHMM: ctx } } map: minutes, byProgram ('' = no programme, i.e. the
 *  Coach frame or an unscoped screen), byView, byDay, and the first/last active minute. */
function summarizeActivity(byDay) {
  const out = { minutes: 0, byProgram: {}, byView: {}, byDay: {}, firstAt: null, lastAt: null };
  for (const day of Object.keys(byDay).sort()) {
    const m = byDay[day];
    const keys = Object.keys(m).sort();
    out.byDay[day] = keys.length;
    out.minutes += keys.length;
    for (const hm of keys) {
      const c = m[hm] || {};
      const p = c.p || '', v = c.v || 'app';
      out.byProgram[p] = (out.byProgram[p] || 0) + 1;
      out.byView[v] = (out.byView[v] || 0) + 1;
    }
    if (keys.length) {
      const first = `${day} ${keys[0].slice(0, 2)}:${keys[0].slice(2)}`;
      const lastK = keys[keys.length - 1];
      const last = `${day} ${lastK.slice(0, 2)}:${lastK.slice(2)}`;
      if (!out.firstAt || first < out.firstAt) out.firstAt = first;
      if (!out.lastAt || last > out.lastAt) out.lastAt = last;
    }
  }
  return out;
}
// Consecutive minutes with the same programme / view / section fold into one SESSION row — the
// detail Sentinel shows on click ("09:32–09:51 · Linear Algebra › Eigenvalues · quiz · 19 min").
// A one-minute hole is bridged (a beat that landed a second late), anything wider is a real break.
const SESSION_GAP = 2;
const MAX_SESSION_TOPICS = 12;
function activitySessions(byDay) {
  const sessions = [];
  const hhmm = (idx) => `${String(Math.floor(idx / 60)).padStart(2, '0')}:${String(idx % 60).padStart(2, '0')}`;
  const finish = (s) => ({
    day: s.day, start: hhmm(s.startIdx), end: hhmm(Math.min(s.endIdx + 1, 24 * 60 - 1)), minutes: s.minutes,
    program: s.p, view: s.v, track: s.track, course: s.course, lesson: s.lesson, topics: s.topics,
  });
  for (const day of Object.keys(byDay).sort()) {
    const m = byDay[day];
    let cur = null;
    for (const hm of Object.keys(m).sort()) {
      const c = m[hm] || {};
      const idx = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2));
      const same = cur && idx - cur.endIdx <= SESSION_GAP && cur.p === (c.p || '') && cur.v === (c.v || 'app')
        && cur.track === (c.tr || '') && cur.course === (c.co || '') && cur.lesson === (c.le || '');
      if (same) {
        cur.endIdx = idx;
        cur.minutes += 1;
        if (c.to && !cur.topics.includes(c.to) && cur.topics.length < MAX_SESSION_TOPICS) cur.topics.push(c.to);
      } else {
        if (cur) sessions.push(finish(cur));
        cur = {
          day, startIdx: idx, endIdx: idx, minutes: 1, p: c.p || '', v: c.v || 'app',
          track: c.tr || '', course: c.co || '', lesson: c.le || '', topics: c.to ? [c.to] : [],
        };
      }
    }
    if (cur) sessions.push(finish(cur));
  }
  return sessions;
}
const programCards = async () => (await getPrograms()).map((p) => ({
  id: p.id, name: p.name || p.id, category: p.category || 'career',
}));

// Internal (HMAC-gated): many people's minutes in the engine over a day range, split by
// programme and by view. Sentinel maps programmes onto its dimensions (career → Professional,
// its pinned growth programmes → Philosophical / Spiritual, no programme → Coach).
app.get('/api/internal/time-spent', async (req, res, next) => {
  try {
    if (!verifyInternalSig(req, 'time-spent')) return res.status(401).json({ error: 'bad signature' });
    const emails = [...new Set(
      String(req.query?.emails || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    )];
    if (!emails.length) return res.status(400).json({ error: 'emails required' });
    if (emails.length > MAX_TEAM_EMAILS) {
      return res.status(400).json({ error: `at most ${MAX_TEAM_EMAILS} emails per call` });
    }
    const range = activityRange(req.query);
    const programs = await programCards();
    const people = await Promise.all(emails.map(async (email) => {
      try {
        return { email, found: true, ...summarizeActivity(await readActivity(email, range.days)) };
      } catch (e) {
        return { email, found: false, minutes: null, error: String((e && e.message) || e).slice(0, 160) };
      }
    }));
    res.json({ from: range.from, to: range.to, tz: ACTIVITY_TZ, programs, people });
  } catch (e) {
    next(e);
  }
});

// Internal (HMAC-gated): REMOVE recorded minutes — the learner's own honesty edit, made in Sentinel
// ("delete this session" / "I only really worked until 10:20"). Body:
//   { email, day: 'YYYY-MM-DD', remove: [{ start: 'HH:MM', end: 'HH:MM' }, …] }   end is EXCLUSIVE
// Every listed range is cleared from every account that can hold this person's minutes
// (activityAccounts), so a break-glass admin's edit reaches the shared account too. Removal is the
// ONLY edit: minutes can't be added here (a learner adds time as a Sentinel manual entry, which never
// pretends to be engine activity) and can't be moved (trim = remove the ends). Nothing is tombstoned:
// a minute deleted inside the live grace window can be re-stamped by the next beat, which is why
// Sentinel refuses to edit today's still-running session.
const MAX_REMOVE_RANGES = 50;
app.post('/api/internal/time-edit', async (req, res, next) => {
  try {
    if (!verifyInternalSig(req, 'time-edit')) return res.status(401).json({ error: 'bad signature' });
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const day = String(b.day || '');
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!DAY_RE.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    const ranges = Array.isArray(b.remove) ? b.remove.slice(0, MAX_REMOVE_RANGES) : [];
    const toIdx = (hm) => {
      const m = /^(\d{2}):(\d{2})$/.exec(String(hm || ''));
      if (!m) return null;
      const v = Number(m[1]) * 60 + Number(m[2]);
      return v >= 0 && v <= 24 * 60 ? v : null;
    };
    const keys = new Set();
    for (const r of ranges) {
      const a = toIdx(r && r.start), z = toIdx(r && r.end);
      if (a == null || z == null || z <= a) return res.status(400).json({ error: 'each range needs start < end as HH:MM' });
      for (let i = a; i < z; i++) keys.add(`${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}`);
    }
    if (!keys.size) return res.status(400).json({ error: 'nothing to remove' });
    // Count what actually goes, so Sentinel can say "removed 19 minutes" rather than guess.
    const before = await readActivity(email, [day]);
    const had = Object.keys(before[day] || {}).filter((k) => keys.has(k)).length;
    await Promise.all(activityAccounts(email).map((acct) => removeActiveMinutes(acct, day, [...keys])));
    res.json({ ok: true, day, removed: had });
  } catch (e) {
    next(e);
  }
});

// Internal (HMAC-gated): ONE person's minutes as session rows — the on-click detail.
app.get('/api/internal/time-detail', async (req, res, next) => {
  try {
    if (!verifyInternalSig(req, 'time-detail')) return res.status(401).json({ error: 'bad signature' });
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const range = activityRange(req.query);
    const [programs, byDay] = await Promise.all([programCards(), readActivity(email, range.days)]);
    res.json({
      email, from: range.from, to: range.to, tz: ACTIVITY_TZ, programs,
      ...summarizeActivity(byDay),
      sessions: activitySessions(byDay),
    });
  } catch (e) {
    next(e);
  }
});

// How many attempt rows one quiz-activity call may return. A ceiling on the RESPONSE, not on the
// window: the aggregates always cover every attempt in `days`, and `truncated` declares any drop.
const MAX_ACTIVITY_ROWS = 1000;

// Internal (HMAC-gated): ONE person's attempt-by-attempt history — the per-question detail that
// /team-progress aggregates away. Sentinel's daily personal report reads this to say which
// questions were missed, where /team-progress can only say how many.
//
// 🔴 A quizLog row carries the question text and a right/wrong bit — NOT the option that was
// chosen, and not the correct one (see logResults in lib/firestore.js). Anything rendering this
// payload may say "you missed this" and must never state what was answered.
//
// Defaults to `wrongOnly`, because that is the whole point of asking at a per-question grain: a
// day's correct answers are adequately described by the counts, and the misses are not.
app.get('/api/internal/quiz-activity', async (req, res, next) => {
  try {
    if (!verifyInternalSig(req, 'quiz-activity')) return res.status(401).json({ error: 'bad signature' });
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const days = Math.min(180, Math.max(1, Number(req.query?.days) || 1));
    const limit = Math.min(MAX_ACTIVITY_ROWS, Math.max(1, Number(req.query?.limit) || 400));
    // `wrongOnly=0` is the only way to ask for every row; anything else (including absent) keeps
    // the default, so a caller has to opt IN to the heavy shape rather than out of it by accident.
    const wrongOnly = String(req.query?.wrongOnly ?? '1') !== '0';
    // Same account mapping as its two sibling endpoints: a break-glass-listed admin's stats live
    // under DEFAULT_ACCOUNT, so reading their sign-in email would return an empty history.
    const acct = isAdminEmail(email) ? DEFAULT_ACCOUNT : email;
    const topicRows = await readTopicDocs();
    const activity = await getQuizActivity(acct, days, topicRows, { wrongOnly, limit });
    res.json({ email, ...activity });
  } catch (e) {
    next(e);
  }
});

// Ceiling on the per-topic payload. A real shelf is ~850 rows, so this is headroom rather than a
// limit anyone meets; `truncated` declares it if they ever do.
const MAX_DETAIL_TOPICS = 2500;

// Internal (HMAC-gated): the learner's WHOLE curriculum with their own stats on every topic.
//
// /enrollment-progress and /team-progress both answer "how far along are they" at PROGRAM grain.
// That is the right size for a dashboard ring and far too coarse for anything that has to reason
// about the learner — which topic is weak, what has never been started, what is about to be
// forgotten. The in-app assistant never needed this endpoint because it runs INSIDE the engine and
// reads the catalog directly; an outside reader (Sentinel's daily report, and through it whatever
// assistant that document is handed to) has no such access, and without this it can only ever talk
// in programme-level averages.
//
// Every derived number comes from lib/priority.js — `computeMastery` and `computePriority`, the
// same two functions the learner's own progress tree renders. 🔴 Do NOT recompute either here:
// mastery in particular is depth-aware and deliberately unlike the coverage figure the rollups
// report, and a second implementation would quietly disagree with the app's own screens.
app.get('/api/internal/learner-detail', async (req, res, next) => {
  try {
    if (!verifyInternalSig(req, 'learner-detail')) return res.status(401).json({ error: 'bad signature' });
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const acct = isAdminEmail(email) ? DEFAULT_ACCOUNT : email;

    const [allPrograms, enrollment, shelf, topicRows] = await Promise.all([
      getPrograms(), getEnrollment(acct), getShelf(acct), readTopicDocs(),
    ]);
    const bank = await overlayStats(acct, topicRows, null);
    const now = new Date();
    const rows = bank.slice(0, MAX_DETAIL_TOPICS).map((t) => {
      const stats = {
        correctCount: t.correctCount ?? 0,
        totalAttempts: t.totalAttempts ?? 0,
        lastAttempted: t.lastAttempted?.toDate ? t.lastAttempted.toDate() : (t.lastAttempted || null),
      };
      const attempts = stats.totalAttempts;
      return {
        program: t.program || '',
        track: t.track || '',
        course: t.course || '',
        lesson: t.lesson || '',
        topic: t.topic || '',
        questions: t.questionCount ?? 0,
        attempts,
        correct: stats.correctCount,
        // 🔴 null, never 0, when the topic was never attempted — 0% accuracy is a claim about
        // performance and "never tried" is not one. The report renders the two differently.
        accuracy: attempts ? Math.round((stats.correctCount / attempts) * 100) : null,
        mastery: computeMastery(stats, now),
        priority: computePriority(stats, now),
        lastAttempted: stats.lastAttempted ? new Date(stats.lastAttempted).toISOString() : null,
      };
    });

    res.json({
      email,
      programs: rollupPrograms({ enrollment, allPrograms, shelf, bank }),
      enrolled: enrollment?.programs || [],
      topics: rows,
      topicsTotal: bank.length,
      truncated: bank.length > rows.length,
    });
  } catch (e) {
    next(e);
  }
});

// Admin: create/rename a program (merge — a rename keeps its defaultCourses).
app.post('/api/admin/programs', requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    await saveProgram({ id, name: req.body?.name, defaultCourses: req.body?.defaultCourses, category: req.body?.category });
    res.json({ ok: true, id });
  } catch (e) {
    next(e);
  }
});

// Admin: read/set any user's enrollment ({programs, courses}); empty courses = all.
app.get('/api/admin/enrollment', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    res.json({ email, ...(await getEnrollment(email)) });
  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/enrollment', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    const saved = await setEnrollment(email, {
      programs: req.body?.programs,
      courses: req.body?.courses,
    });
    res.json({ ok: true, email, ...saved });
  } catch (e) {
    next(e);
  }
});

// Admin: unenroll a student from ONE program. Drops that program from their list
// and clears course filters (courses aren't program-keyed, so we don't want a
// removed program's course filter to leak onto what remains). Removing their last
// program reverts them to the platform default (normalizeEnrollment never leaves
// programs empty) — an explicit "remove this program" action, not "block access".
app.post('/api/admin/enrollment/remove', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const program = String(req.body?.program || '').trim();
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!program) return res.status(400).json({ error: 'program is required' });
    const current = await getEnrollment(email);
    const programs = (current.programs || []).filter((p) => p !== program);
    const saved = await setEnrollment(email, { programs, courses: [] });
    res.json({ ok: true, email, ...saved });
  } catch (e) {
    next(e);
  }
});

// Admin: the Sentinel people directory, for the enrolment person-picker. Fetched
// server-side from Sentinel's HMAC-gated internal endpoint using the shared
// platform-sso-key both apps mount (no CORS, no browser credentials). Degrades
// gracefully to an empty list (UI falls back to typing an email) if Sentinel is
// unreachable or the secret/URL isn't configured.
// Fetch the Sentinel people directory over the shared HMAC. Returns { people, error }
// and never throws — a missing secret / unreachable Sentinel degrades to an empty list.
// Shared by /api/admin/people (enrolment picker) and /api/admin/assignments (the view).
async function fetchSentinelPeople() {
  const secret = process.env.SSO_SECRET || '';
  const base = (process.env.SENTINEL_URL || 'https://sentinel.agoradatadriven.com').replace(/\/+$/, '');
  if (!secret) return { people: [], error: 'SSO_SECRET not configured' };
  try {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', secret).update(`academy-people:${ts}`).digest('hex');
    const r = await fetch(`${base}/api/internal/people`, {
      headers: { 'x-academy-ts': ts, 'x-academy-sig': sig },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { people: [], error: `sentinel ${r.status}` };
    const data = await r.json();
    return { people: Array.isArray(data.people) ? data.people : [] };
  } catch (e) {
    return { people: [], error: String(e.message || e) };
  }
}

app.get('/api/admin/people', requireAdmin, async (_req, res) => {
  res.json(await fetchSentinelPeople());
});

// Admin: everyone in the directory with the program(s) + courses they're assigned.
// Empty courses = the whole program. Enrolment reads run concurrently; a person with
// no explicit enrolment shows their effective default (default program, all courses).
app.get('/api/admin/assignments', requireAdmin, async (_req, res, next) => {
  try {
    const [{ people, error }, programs] = await Promise.all([fetchSentinelPeople(), getPrograms()]);
    const nameOf = (id) => (programs.find((p) => p.id === id) || {}).name || id;
    const assignments = await Promise.all((people || []).map(async (p) => {
      const enr = await getEnrollment(p.email);
      return {
        email: p.email,
        name: p.name || p.email,
        programs: (enr.programs || []).map((id) => ({ id, name: nameOf(id) })),
        courses: enr.courses || [],
      };
    }));
    // Explicit course assignments first, then alphabetical — the interesting rows on top.
    assignments.sort((a, b) => (b.courses.length ? 1 : 0) - (a.courses.length ? 1 : 0)
      || String(a.name).localeCompare(String(b.name)));
    res.json({ assignments, error });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ Team dashboard ----------------------------- */
/**
 * Admin: the Academy home base — one row per Sentinel person with their learning
 * numbers (progress %, accuracy, attempts, Speaker-Mode explains), lifetime AI
 * spend, and the AI-provider allowlist the Team tab edits. Reads the bank ONCE
 * (getCatalog re-scans the topics collection per call otherwise) and fans the
 * per-person doc reads out with a small concurrency cap; the whole load is
 * ~4 small reads + 1 count aggregation per person on top of that single scan.
 * Progress mirrors /api/internal/enrollment-progress: a topic contributes its
 * accuracy (unattempted = 0), scoped to the person's enrolled programs.
 */
app.get('/api/admin/team', requireAdmin, async (_req, res, next) => {
  try {
    const [{ people, error }, programs] = await Promise.all([fetchSentinelPeople(), getPrograms()]);
    const nameOf = (id) => (programs.find((p) => p.id === id) || {}).name || id;
    // Read the bank AS the legacy owner: same rows for everyone, and that
    // account's stats arrive inline (they live on the shared topic docs, not in
    // a subcollection — getUserTopicStats is deliberately empty for it).
    const bank = await getCatalog(DEFAULT_ACCOUNT, null);
    const topicsByProgram = new Map(); // program id -> Set(topic doc ids)
    for (const r of bank) {
      const prog = r.program || DEFAULT_PROGRAM;
      if (!topicsByProgram.has(prog)) topicsByProgram.set(prog, new Set());
      topicsByProgram.get(prog).add(r.id);
    }

    const team = await mapWithConcurrency(people || [], 8, async (p) => {
      const email = String(p.email || '').trim().toLowerCase();
      const [enr, usage, ai, explains, statRows] = await Promise.all([
        getEnrollment(email),
        getUsage(email),
        getAiAccess(email),
        countExplainLogs(email).catch(() => 0),
        getUserTopicStats(email),
      ]);
      // The person's topic universe = every topic in their enrolled programs.
      const inScope = new Set();
      for (const prog of enr.programs || []) {
        for (const id of topicsByProgram.get(prog) || []) inScope.add(id);
      }
      // Their stats rows, scoped to that universe. The legacy owner's live
      // inline on the bank rows; everyone else's come from their subcollection.
      const rows = email === DEFAULT_ACCOUNT
        ? bank.filter((r) => inScope.has(r.id) && r.totalAttempts)
        : statRows.filter((s) => inScope.has(s.id) && s.totalAttempts);
      let attempts = 0, correct = 0, pctSum = 0;
      for (const s of rows) {
        attempts += s.totalAttempts || 0;
        correct += s.correctCount || 0;
        pctSum += (s.totalAttempts ? (s.correctCount || 0) / s.totalAttempts : 0);
      }
      return {
        email,
        name: p.name || email,
        role: p.role || '',
        programs: (enr.programs || []).map((id) => ({ id, name: nameOf(id) })),
        topicsTotal: inScope.size,
        topicsPracticed: rows.length,
        progressPct: inScope.size ? Math.round((pctSum / inScope.size) * 100) : 0,
        accuracy: attempts ? Math.round((correct / attempts) * 100) : null,
        attempts,
        explains,
        usage: {
          costUsd: usage.costUsd || 0,
          calls: usage.calls || 0,
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
        },
        aiProviders: ai.providers,
        aiConfigured: ai.configured,
      };
    });
    team.sort((a, b) => b.attempts - a.attempts || String(a.name).localeCompare(String(b.name)));
    res.json({ team, providers: AI_PROVIDERS, error });
  } catch (e) {
    next(e);
  }
});

// Admin: read one person's AI-provider allowlist (absent doc → the Kimi-only default).
app.get('/api/admin/ai-access', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    res.json({ email, ...(await getAiAccess(email)), providers_all: AI_PROVIDERS });
  } catch (e) {
    next(e);
  }
});

// Admin: replace one person's AI-provider allowlist. Unknown ids are dropped;
// an empty selection falls back to the Kimi-only default. Admins themselves are
// never policed (their policy resolves to null), so this can't lock an admin out.
app.post('/api/admin/ai-access', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 0) return res.status(400).json({ error: 'A valid email is required' });
    const saved = await setAiAccess(email, req.body?.providers);
    aiAccessCache.delete(email); // the 60s policy cache must not outlive an explicit change
    res.json({ email, ...saved });
  } catch (e) {
    next(e);
  }
});

// Admin: one-time, idempotent tagging of pre-program content as the default
// program + creation of the starting program docs. Re-running reports zeros.
app.post('/api/admin/backfill-programs', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await backfillPrograms()) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- curriculum -------------------------------- */
// Admin: author the catalog in place (the Academy's curriculum is hand-written,
// not CSV-imported). Idempotent on slug(track,course,lesson,topic).
app.post('/api/admin/topics', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const id = await upsertTopic({ ...req.body, program });
    await placeNewTopicsInOrder(program).catch(() => { /* ordering is best-effort */ });
    res.json({ ok: true, id });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/admin/topics/:id', requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: await deleteTopic(req.params.id) });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: re-file topics under a new track/course/lesson (drag-and-drop in the
 * curriculum tree). Updates the stored fields in place, KEEPING the doc id — so
 * per-user stats (keyed by id), banked questions (keyed by name) and prereq graph
 * edges (keyed by id) all survive the move. Body: { ids:[...], to:{track?,course?,lesson?} }.
 */
app.post('/api/admin/topics/move', requireAdmin, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    const to = req.body?.to || {};
    if (!ids.length) return res.status(400).json({ error: 'No topics to move' });
    const moved = await moveTopics(ids, to);
    res.json({ ok: true, moved });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: RENAME sub-lessons in place. The doc id is kept (so per-user stats and
 * the prereq graph survive), and `renameTopics` re-keys the collateral that is
 * keyed by NAME instead — banked questions, deck cards, a topic-level deck's
 * scopeId, a topic-level study guide's doc id. Renaming by hand through
 * `topics/move` is NOT equivalent: that writes only track/course/lesson, so the
 * sub-lesson would keep its progress and lose its questions.
 *
 * Body: { items:[{ id, topic, questionIds? }] }. `questionIds` exists for the one
 * case name-matching cannot decide — two sub-lessons of one program that share a
 * name share one question pool; without it those questions are left where they
 * are and reported back in `ambiguous`.
 *
 * Default JSON parser, like its `topics/move` and `topics/reorder` siblings: the body is
 * names and ids, and `bigJson` is not declared until the transcript routes far below.
 */
app.post('/api/admin/topics/rename', requireAdmin, async (req, res, next) => {
  try {
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .map((it) => ({
        id: String(it?.id || '').trim(),
        topic: String(it?.topic || '').trim(),
        ...(Array.isArray(it?.questionIds) ? { questionIds: it.questionIds } : {}),
      }))
      .filter((it) => it.id && it.topic);
    if (!items.length) return res.status(400).json({ error: 'Nothing to rename' });
    res.json({ ok: true, ...(await renameTopics(items)) });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: persist a new curriculum position on a set of topic rows (the drag-and-drop
 * editor). Body: { items:[{id, order?, lessonOrder?, courseOrder?}] } — one grain per
 * field, so reordering lessons writes only `lessonOrder` and leaves every lesson's
 * internal topic order untouched. The client computes the numbers; only the fields it
 * actually sends are written (merge), so a partial patch is safe.
 */
app.post('/api/admin/topics/reorder', requireAdmin, async (req, res, next) => {
  try {
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .map((it) => {
        const out = { id: String(it?.id || '') };
        for (const f of ORDER_FIELDS) if (it?.[f] != null && Number.isFinite(Number(it[f]))) out[f] = Number(it[f]);
        return out;
      })
      .filter((it) => it.id && ORDER_FIELDS.some((f) => Number.isFinite(it[f])));
    if (!items.length) return res.status(400).json({ error: 'Nothing to reorder' });
    const n = await setTopicOrders(items);
    res.json({ ok: true, n });
  } catch (e) {
    next(e);
  }
});

/* ------------------- conversational curriculum editor (AI) ------------------ */
/**
 * Resolve — and optionally execute — a batch of structural curriculum operations
 * proposed by planCurriculumEdit (merge / rename / move / delete / add / reorder).
 *
 * Ops reference nodes by NAME; here we resolve every name against the LIVE catalog
 * and REJECT anything that doesn't exist, so the model proposes but the code
 * decides what's real (the discipline planCurriculum/classifyTranscript use). Each
 * op is translated into the same id-preserving primitives the drag-and-drop editor
 * uses — moveTopics (keeps the doc id, so per-user stats, banked questions AND
 * prereq graph edges all survive a re-file/rename), setTopicOrders, deleteTopic,
 * upsertTopics.
 *
 * A single in-memory working copy of the catalog is mutated as we go, so a later op
 * resolves against the effect of earlier ones in the same batch (e.g. reorder a
 * lesson a merge just filled). `dryRun` resolves + describes WITHOUT writing — that
 * is exactly how the review preview is built, so what the admin approves is what
 * runs. Every op yields a step { op, ok, description, note, error?, warn? }; an
 * unresolved op fails in isolation without aborting the rest.
 *
 * @returns {Promise<{steps:Array<object>, applied:number}>}
 */
async function runCurriculumEdits(program, ops, { dryRun = false } = {}) {
  const clean = (v) => String(v == null ? '' : v).trim();
  const key = (s) => clean(s).toLowerCase();
  const numCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  const cmpTopic = (a, b) => {
    const oa = Number.isFinite(a.order) ? a.order : Infinity;
    const ob = Number.isFinite(b.order) ? b.order : Infinity;
    return oa !== ob ? oa - ob : numCmp(a.topic, b.topic);
  };

  // Working copy: only real topic rows, with the fields we manipulate + the doc id.
  let cat = (await getCatalog(null, { program }))
    .filter((r) => r.topic && r.id)
    .map((r) => ({
      id: r.id,
      track: r.track || '', course: r.course || '', lesson: r.lesson || '', topic: r.topic || '',
      order: Number.isFinite(r.order) ? r.order : null,
      lessonOrder: Number.isFinite(r.lessonOrder) ? r.lessonOrder : null,
      courseOrder: Number.isFinite(r.courseOrder) ? r.courseOrder : null,
    }));

  const rowsIn = (track, course, lesson, topic) => cat.filter((r) =>
    (track == null || key(r.track) === key(track))
    && (course == null || key(r.course) === key(course))
    && (lesson == null || key(r.lesson) === key(lesson))
    && (topic == null || key(r.topic) === key(topic)));

  // A course usually lives in exactly one track. Honour a named track when it holds
  // the course, else infer it when unambiguous — otherwise throw a helpful error.
  const resolveTrack = (track, course) => {
    const co = key(course);
    const tracks = [...new Set(cat.filter((r) => key(r.course) === co).map((r) => r.track))];
    if (track) {
      const hit = tracks.find((t) => key(t) === key(track));
      if (hit) return hit;
      if (!tracks.length) throw new Error(`No course named “${clean(course)}”`);
      throw new Error(`Course “${clean(course)}” isn’t in track “${clean(track)}”`);
    }
    if (tracks.length === 1) return tracks[0];
    if (!tracks.length) throw new Error(`No course named “${clean(course)}”`);
    throw new Error(`Course “${clean(course)}” exists in more than one track — name the track`);
  };

  // A group's rank is the MIN of its field over its rows (see firestore.js
  // setTopicOrders); ties fall through to the legacy min(topic.order), then name -
  // the same ladder app.js's byCourseName/byLessonName climbs, so this reads the tree
  // exactly as the learner sees it.
  const minOf = (rows, field) => rows.reduce((m, r) => (Number.isFinite(r[field]) && r[field] < m ? r[field] : m), Infinity);
  const orderedGroupNames = (rows, pick, field) => {
    const names = [...new Set(rows.map(pick))].filter(Boolean);
    const of = new Map(names.map((nm) => [nm, rows.filter((r) => pick(r) === nm)]));
    return names.sort((a, b) => {
      const oa = minOf(of.get(a), field), ob = minOf(of.get(b), field);
      if (oa !== ob) return oa - ob;
      const ga = minOf(of.get(a), 'order'), gb = minOf(of.get(b), 'order');
      if (ga !== gb) return ga - gb;
      return numCmp(a, b);
    });
  };
  const orderedLessonNames = (rows) => orderedGroupNames(rows, (r) => r.lesson, 'lessonOrder');
  const orderedCourseNames = (track) => orderedGroupNames(rowsIn(track), (r) => r.course, 'courseOrder');

  // Stamp a sibling sequence onto its rows: `lessonOrder` for lessons in a course,
  // `courseOrder` for courses in a track. Returns [{id, <field>}] and updates the
  // working copy. Each grain is independent, so reordering lessons cannot move the
  // course, and reordering courses cannot disturb a lesson or a topic - the whole
  // point of storing the three separately (this used to renumber the entire track's
  // topics, where a single off-by-one silently resequenced everything below it).
  const stampOrder = (rowsFor, names, field) => {
    const items = [];
    names.forEach((name, i) => {
      for (const r of rowsFor(name)) { r[field] = i; items.push({ id: r.id, [field]: i }); }
    });
    return items;
  };

  // DB writes are deferred and run (in order) only after every op resolves cleanly
  // enough to describe; the working copy is mutated immediately regardless.
  const writes = [];
  const doMove = (ids, to) => writes.push(() => moveTopics(ids, to));
  const doRename = (items) => writes.push(() => renameTopics(items));
  // A whole COURSE or LESSON carries its transcript, decks and guides with it —
  // `moveTopics` would write the rows and orphan all three. See renameScope.
  const doScope = (from, to) => writes.push(() => renameScope({ program, ...from }, to));
  const doDelete = (ids) => writes.push(async () => { for (const id of ids) await deleteTopic(id); });
  const doReorder = (items) => { if (items.length) writes.push(() => setTopicOrders(items)); };
  const doAdd = (rows) => writes.push(() => upsertTopics(rows));

  const steps = [];
  let applied = 0;

  for (const raw of (Array.isArray(ops) ? ops : [])) {
    const op = clean(raw && raw.op);
    const note = clean(raw && raw.note);
    try {
      let description;
      switch (op) {
        case 'rename_course': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course);
          if (!rows.length) throw new Error(`No course named “${clean(raw.course)}”`);
          const newName = clean(raw.newName);
          if (!newName) throw new Error('rename_course needs a newName');
          const courseName = rows[0].course; const ids = rows.map((r) => r.id);
          rows.forEach((r) => { r.course = newName; });
          if (!dryRun) doScope({ track, course: courseName }, { course: newName });
          description = `Rename course “${courseName}” → “${newName}” (${ids.length} sub-lesson${ids.length === 1 ? '' : 's'})`;
          break;
        }
        case 'rename_lesson': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course, raw.lesson);
          if (!rows.length) throw new Error(`No lesson “${clean(raw.lesson)}” in “${clean(raw.course)}”`);
          const newName = clean(raw.newName);
          if (!newName) throw new Error('rename_lesson needs a newName');
          const lessonName = rows[0].lesson; const ids = rows.map((r) => r.id);
          rows.forEach((r) => { r.lesson = newName; });
          if (!dryRun) doScope({ track, course: rows[0].course, lesson: lessonName }, { lesson: newName });
          description = `Rename lesson “${lessonName}” → “${newName}” (${ids.length} sub-lesson${ids.length === 1 ? '' : 's'})`;
          break;
        }
        // Renaming a SUB-LESSON is not the same shape as renaming a lesson or a
        // course: those move only the row's fields, while a sub-lesson's NAME is
        // also the key of its banked questions, its deck cards and its guide.
        // `renameTopics` re-keys all of them; `moveTopics` would strand them.
        case 'rename_topic': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course, raw.lesson, raw.topic);
          if (!rows.length) throw new Error(`No sub-lesson “${clean(raw.topic)}” in “${clean(raw.lesson)}”`);
          const newName = clean(raw.newName);
          if (!newName) throw new Error('rename_topic needs a newName');
          const r = rows[0];
          const topicName = r.topic;
          if (key(newName) !== key(topicName) && rowsIn(track, r.course, r.lesson, newName).length) {
            throw new Error(`“${newName}” is already a sub-lesson of “${r.lesson}”`);
          }
          r.topic = newName;
          if (!dryRun) doRename([{ id: r.id, topic: newName }]);
          description = `Rename sub-lesson “${topicName}” → “${newName}”`;
          break;
        }
        case 'move_lesson': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course, raw.lesson);
          if (!rows.length) throw new Error(`No lesson “${clean(raw.lesson)}” in “${clean(raw.course)}”`);
          const toCourse = clean(raw.toCourse);
          if (!toCourse) throw new Error('move_lesson needs a toCourse');
          const toTrack = clean(raw.toTrack) || track;
          const lessonName = rows[0].lesson; const fromCourse = rows[0].course; const ids = rows.map((r) => r.id);
          // Land it at the END of its new course. Its old `lessonOrder` means nothing
          // there and would collide with whatever lesson already holds that rank.
          const tailRank = rowsIn(toTrack, toCourse).reduce(
            (m, r) => (Number.isFinite(r.lessonOrder) && r.lessonOrder > m ? r.lessonOrder : m), -1) + 1;
          rows.forEach((r) => { r.track = toTrack; r.course = toCourse; r.lessonOrder = tailRank; });
          if (!dryRun) {
            doScope({ track, course: fromCourse, lesson: lessonName }, { track: toTrack, course: toCourse });
            doReorder(ids.map((id) => ({ id, lessonOrder: tailRank })));
          }
          description = `Move lesson “${lessonName}” from “${fromCourse}” → “${toCourse}”${key(toTrack) !== key(track) ? ` (track “${toTrack}”)` : ''} (${ids.length} sub-lesson${ids.length === 1 ? '' : 's'})`;
          break;
        }
        case 'move_topic': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course, raw.lesson, raw.topic);
          if (!rows.length) throw new Error(`No sub-lesson “${clean(raw.topic)}” in “${clean(raw.lesson)}”`);
          const toLesson = clean(raw.toLesson);
          if (!toLesson) throw new Error('move_topic needs a toLesson');
          const toCourse = clean(raw.toCourse) || rows[0].course; const r = rows[0];
          const topicName = r.topic; const fromLesson = r.lesson;
          // Same rule as move_lesson one grain down: append, never inherit a rank from
          // the lesson it came from.
          const tailOrder = rowsIn(track, toCourse, toLesson).reduce(
            (m, x) => (Number.isFinite(x.order) && x.order > m ? x.order : m), -1) + 1;
          r.course = toCourse; r.lesson = toLesson; r.order = tailOrder;
          if (!dryRun) { doMove([r.id], { course: toCourse, lesson: toLesson }); doReorder([{ id: r.id, order: tailOrder }]); }
          description = `Move sub-lesson “${topicName}” from “${fromLesson}” → “${toLesson}”${key(toCourse) !== key(raw.course) ? ` (course “${toCourse}”)` : ''}`;
          break;
        }
        case 'merge_lessons': {
          const track = resolveTrack(raw.track, raw.course);
          const into = clean(raw.into);
          if (!into) throw new Error('merge_lessons needs an "into" lesson');
          const fromList = (Array.isArray(raw.from) ? raw.from : []).map(clean).filter(Boolean).filter((l) => key(l) !== key(into));
          if (!fromList.length) throw new Error('merge_lessons needs at least one "from" lesson different from "into"');
          const dropSet = new Set((Array.isArray(raw.drop) ? raw.drop : []).map(key).filter(Boolean));
          const intoRows = rowsIn(track, raw.course, into);
          const intoName = intoRows[0] ? intoRows[0].lesson : into;
          const targetNames = new Set(intoRows.map((r) => key(r.topic)));
          // Resolve EVERY "from" lesson before mutating anything, so a merge that
          // names one bad lesson fails whole instead of half-applying the good ones.
          const fromGroups = fromList.map((fromLesson) => {
            const rows = rowsIn(track, raw.course, fromLesson);
            if (!rows.length) throw new Error(`No lesson “${fromLesson}” in “${clean(raw.course)}” to merge`);
            return rows;
          });
          let moved = 0; const dropped = [];
          for (const rows of fromGroups) {
            for (const r of rows) {
              const nk = key(r.topic);
              if (dropSet.has(nk) || targetNames.has(nk)) {
                dropped.push(r.topic); cat = cat.filter((x) => x.id !== r.id);
                if (!dryRun) doDelete([r.id]);
              } else {
                targetNames.add(nk); r.lesson = intoName; moved += 1;
                if (!dryRun) doMove([r.id], { lesson: intoName });
              }
            }
          }
          const fromLabel = fromList.length === 1 ? `“${fromList[0]}”` : `${fromList.length} lessons`;
          description = `Merge ${fromLabel} into “${intoName}”: moved ${moved} sub-lesson${moved === 1 ? '' : 's'}${dropped.length ? `, dropped ${dropped.length} overlapping (${dropped.join(', ')})` : ''}`;
          break;
        }
        case 'delete_topic': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course, raw.lesson, raw.topic);
          if (!rows.length) throw new Error(`No sub-lesson “${clean(raw.topic)}” in “${clean(raw.lesson)}”`);
          const r = rows[0]; cat = cat.filter((x) => x.id !== r.id);
          if (!dryRun) doDelete([r.id]);
          description = `Delete sub-lesson “${r.topic}” from “${r.lesson}”`;
          break;
        }
        case 'delete_lesson': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course, raw.lesson);
          if (!rows.length) throw new Error(`No lesson “${clean(raw.lesson)}” in “${clean(raw.course)}”`);
          const lessonName = rows[0].lesson; const ids = rows.map((r) => r.id); const idSet = new Set(ids);
          cat = cat.filter((x) => !idSet.has(x.id));
          if (!dryRun) doDelete(ids);
          description = `Delete lesson “${lessonName}” and its ${ids.length} sub-lesson${ids.length === 1 ? '' : 's'}`;
          break;
        }
        case 'add_topic': {
          const course = clean(raw.course); const lesson = clean(raw.lesson); const topic = clean(raw.topic);
          if (!course || !lesson || !topic) throw new Error('add_topic needs course, lesson and topic');
          let track = clean(raw.track);
          if (!track) {
            const tracks = [...new Set(cat.filter((r) => key(r.course) === key(course)).map((r) => r.track))];
            if (tracks.length === 1) [track] = tracks;
            else throw new Error(`add_topic needs a track for new course “${course}”`);
          }
          if (rowsIn(track, course, lesson, topic).length) {
            steps.push({ op, ok: true, description: `Sub-lesson “${topic}” already exists in “${lesson}” — skipped`, note, warn: 'already exists' });
            continue;
          }
          cat.push({ id: slug(track, course, lesson, topic), track, course, lesson, topic, order: null, lessonOrder: null, courseOrder: null });
          if (!dryRun) doAdd([{ program, track, course, lesson, topic }]);
          description = `Add sub-lesson “${topic}” to “${lesson}” (course “${course}”)`;
          break;
        }
        // Course order within a track. The one grain the editor could not touch, so a
        // perfectly reasonable "put RAG Overview before Information Retrieval" had to be
        // refused and done by hand.
        case 'reorder_courses': {
          const track = clean(raw.track) || (rowsIn().length ? rowsIn()[0].track : '');
          const current = orderedCourseNames(track);
          if (!current.length) throw new Error(`No track named “${clean(raw.track)}”`);
          const existing = new Map(current.map((c) => [key(c), c]));
          const want = (Array.isArray(raw.order) ? raw.order : []).map(clean).filter(Boolean);
          const seq = []; const used = new Set();
          for (const w of want) { const a = existing.get(key(w)); if (a && !used.has(key(a))) { seq.push(a); used.add(key(a)); } }
          // Courses the model left out keep their existing relative order, at the end - the
          // same forgiving rule reorder_lessons uses, so a partial list is safe.
          for (const c of current) if (!used.has(key(c))) seq.push(c);
          if (seq.length < 2) throw new Error('Name at least two courses to reorder');
          const items = stampOrder((co) => rowsIn(track, co), seq, 'courseOrder');
          if (!dryRun) doReorder(items);
          description = `Reorder courses in “${track}”: ${seq.join(' → ')}`;
          break;
        }
        case 'reorder_lessons': {
          const track = resolveTrack(raw.track, raw.course);
          const courseRows = rowsIn(track, raw.course);
          if (!courseRows.length) throw new Error(`No course named “${clean(raw.course)}”`);
          const courseName = courseRows[0].course;
          const current = orderedLessonNames(courseRows);
          const existing = new Map(current.map((l) => [key(l), l]));
          const want = (Array.isArray(raw.order) ? raw.order : []).map(clean).filter(Boolean);
          const seq = []; const used = new Set();
          for (const w of want) { const a = existing.get(key(w)); if (a && !used.has(key(a))) { seq.push(a); used.add(key(a)); } }
          for (const l of current) if (!used.has(key(l))) seq.push(l);
          const items = stampOrder((le) => rowsIn(track, raw.course, le), seq, 'lessonOrder');
          if (!dryRun) doReorder(items);
          description = `Reorder lessons in “${courseName}”: ${seq.join(' → ')}`;
          break;
        }
        case 'reorder_topics': {
          const track = resolveTrack(raw.track, raw.course);
          const rows = rowsIn(track, raw.course, raw.lesson);
          if (!rows.length) throw new Error(`No lesson “${clean(raw.lesson)}” in “${clean(raw.course)}”`);
          const lessonName = rows[0].lesson;
          const byName = new Map(rows.map((r) => [key(r.topic), r]));
          const want = (Array.isArray(raw.order) ? raw.order : []).map(clean).filter(Boolean);
          const seq = []; const used = new Set();
          for (const w of want) { const r = byName.get(key(w)); if (r && !used.has(r.id)) { seq.push(r); used.add(r.id); } }
          for (const r of rows.slice().sort(cmpTopic)) if (!used.has(r.id)) seq.push(r);
          // 0-based: a lesson's position in its course is its own `lessonOrder`, so
          // renumbering its topics from 0 can no longer move the lesson itself.
          const items = seq.map((r, i) => { r.order = i; return { id: r.id, order: i }; });
          if (!dryRun) doReorder(items);
          description = `Reorder sub-lessons in “${lessonName}”: ${seq.map((r) => r.topic).join(' → ')}`;
          break;
        }
        default:
          throw new Error(`Unknown operation “${op || '(blank)'}”`);
      }
      steps.push({ op, ok: true, description, note });
      applied += 1;
    } catch (e) {
      steps.push({ op, ok: false, error: e.message, note });
    }
  }

  if (!dryRun) { for (const w of writes) await w(); }
  return { steps, applied };
}

/**
 * Admin: draft structural curriculum edits from a plain-English message (SSE). The
 * model's reasoning streams live, then one 'result' carries the chat reply, a
 * headline summary, the proposed operations AND those ops resolved against the live
 * catalog (dry-run) so the admin sees exactly what each would do before applying.
 */
app.post('/api/admin/curriculum/edit/stream', requireAdmin, async (req, res) => {
  let started = false;
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const message = String(req.body?.message || '').trim();
    if (!message) throw Object.assign(new Error('Tell the editor what to change'), { status: 400 });
    const history = (Array.isArray(req.body?.history) ? req.body.history : [])
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant'))
      .map((t) => ({ role: t.role, content: String(t.content || '').slice(0, 4000) }))
      .slice(-8);
    const catalog = await getCatalog(req.userEmail, scope);
    const programName = (await getPrograms()).find((p) => p.id === program)?.name || program;
    sseInit(res); started = true;
    const plan = await planCurriculumEdit(
      { message, history, catalog, programName, reading: await isReadingProgram(program) },
      aiFromBody(req),
      (t, kind) => sseSend(res, kind === 'thinking' ? 'thinking' : 'content', { text: t }),
    );
    const { steps } = plan.operations.length
      ? await runCurriculumEdits(program, plan.operations, { dryRun: true })
      : { steps: [] };
    sseSend(res, 'result', { reply: plan.reply, summary: plan.summary, operations: plan.operations, steps });
    sseSend(res, 'done', {});
    res.end();
  } catch (e) {
    if (started) { try { sseSend(res, 'error', { error: e.message || 'AI request failed' }); res.end(); } catch { /* closed */ } }
    else res.status(e.status || 500).json({ error: e.message || 'AI request failed' });
  }
});

/**
 * Admin: apply an approved set of structural curriculum edits. Re-resolves against
 * the LIVE catalog (robust to any drift since the preview) and executes the
 * id-preserving primitives, then slots any freshly-created lessons into study order
 * so they don't dump at the bottom of the tree. Returns a per-op report.
 */
app.post('/api/admin/curriculum/apply', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const ops = Array.isArray(req.body?.operations) ? req.body.operations : [];
    if (!ops.length) return res.status(400).json({ error: 'No changes to apply' });
    const { steps, applied } = await runCurriculumEdits(program, ops, { dryRun: false });
    await placeNewTopicsInOrder(program).catch(() => { /* ordering is best-effort */ });
    res.json({ ok: true, applied, steps });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: bulk outline import. Accepts either rows [{track,course,lesson,topic}]
 * or `text` — one "Track > Course > Lesson > Topic" per line, which is what you
 * get from pasting a curriculum outline. `preview: true` parses and reports
 * WITHOUT writing, so a typo in a 200-line paste is caught before it lands.
 */
app.post('/api/admin/topics/bulk', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    let rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const problems = [];

    if (!rows.length && typeof req.body?.text === 'string') {
      req.body.text.split('\n').forEach((line, i) => {
        const raw = line.trim();
        if (!raw || raw.startsWith('#')) return;
        const parts = raw.split('>').map((p) => p.trim());
        if (parts.length !== 4 || parts.some((p) => !p)) {
          problems.push({ line: i + 1, text: raw.slice(0, 80), error: 'Expected "Track > Course > Lesson > Topic"' });
          return;
        }
        rows.push({ track: parts[0], course: parts[1], lesson: parts[2], topic: parts[3] });
      });
    }
    rows = rows.map((r) => ({ ...r, program }));
    if (req.body?.preview) return res.json({ ok: true, preview: true, rows, problems, count: rows.length });
    if (!rows.length) return res.status(400).json({ error: 'Nothing to import', problems });

    const report = await upsertTopics(rows);
    // The PASTE ORDER is the author's intended curriculum order — courses, lessons and
    // topics all land in the sequence they were written, not alphabetically.
    const pasted = [...new Map(rows.map((r) => [
      JSON.stringify([r.track, r.course, r.lesson]),
      { track: r.track, course: r.course, lesson: r.lesson, topics: [] },
    ])).values()];
    const byLesson = new Map(pasted.map((l) => [JSON.stringify([l.track, l.course, l.lesson]), l]));
    for (const r of rows) byLesson.get(JSON.stringify([r.track, r.course, r.lesson]))?.topics.push(r.topic);
    await orderNewCurriculum(program, pasted);
    // Then AI-order each touched lesson's sub-lessons — a paste is ordered at the lesson
    // grain but rarely inside one (mirrors the ingest/commit and goal-plan paths).
    const lessonKeys = pasted.map((l) => ({ track: l.track, course: l.course, lesson: l.lesson }));
    await autoSequenceLessons(program, lessonKeys, aiChoice(req)).catch(() => { /* ordering is best-effort */ });
    res.json({ ok: true, ...report, problems });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- transcripts ------------------------------- */
/* Transcripts run to tens of KB and the global express.json cap is 1mb, so these
 * routes get their own generous limit. */
const bigJson = express.json({ limit: '12mb' });

app.get('/api/admin/transcripts', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const list = await getTranscripts({ program: scope.program, course: req.query.course, lesson: req.query.lesson });
    // Never ship every full transcript to the list view.
    res.json(list.map(({ text, ...rest }) => rest));
  } catch (e) {
    next(e);
  }
});

app.get('/api/admin/transcripts/:id', requireAdmin, async (req, res, next) => {
  try {
    const t = await getTranscriptById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json(t);
  } catch (e) {
    next(e);
  }
});

// Admin: attach source material (paste, uploaded file text, or a Watcher video).
app.post('/api/admin/transcripts', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const id = await addTranscript({ ...req.body, program: req.body?.program || scope.program });
    res.json({ ok: true, id });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/admin/transcripts/:id', requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: await deleteTranscript(req.params.id) });
  } catch (e) {
    next(e);
  }
});

// Admin: edit an attached transcript in place (title, scope, and/or text).
app.put('/api/admin/transcripts/:id', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const existing = await getTranscriptById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await updateTranscript(req.params.id, {
      title: req.body?.title,
      text: req.body?.text,
      track: req.body?.track,
      course: req.body?.course,
      lesson: req.body?.lesson,
      folder: req.body?.folder,
    });
    res.json({ ok: true, id: req.params.id });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: split ONE oversized source into the lessons it is made of.
 *
 * Every reader here is bounded — digest 24k, classify 9k, generation 12k per
 * lesson — so a single file holding a whole module catalogues from its opening
 * third and then grounds every lesson it touches on the same first 12k. The fix
 * is grain, not a bigger window: a source should be about lesson-sized.
 *
 * Children inherit the parent's folder (or get one named after it) and land
 * UNFILED like any other source, so the normal Catalogue → Design flow follows.
 * The parent is KEPT and marked `splitInto`, never deleted — the client offers
 * that separately, because cutting someone's source material on their behalf and
 * then destroying the original is not a decision this route should make alone.
 */
app.post('/api/admin/transcripts/:id/split', requireAdmin, rateLimitAI, async (req, res, next) => {
  try {
    const doc = await getTranscriptById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const sections = await splitSource({ title: doc.title, text: doc.text }, aiFromBody(req));
    if (sections.length < 2) {
      return res.json({ ok: true, split: false, sections: 1, note: 'No lesson boundaries found — left as one source.' });
    }
    // Children go in a folder named after the parent when it had none, so a split
    // never scatters a module's parts across the top level.
    const folder = String(doc.folder || '').trim() || String(doc.title || 'Split').trim().slice(0, 60);
    const ids = [];
    for (const sec of sections) {
      ids.push(await addTranscript({
        program: doc.program, title: sec.title, text: sec.text,
        source: doc.source || 'paste', watcherRef: doc.watcherRef || null, folder,
        splitFrom: doc.id,
      }));
    }
    await updateTranscript(doc.id, { splitInto: ids.length });
    res.json({ ok: true, split: true, sections: ids.length, folder, ids });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: pull a Watcher video's transcript straight INTO the library, unfiled.
 *
 * Watcher is just another way material arrives, so it ends up in the same place as
 * an upload or a paste — one library, one set of actions on it. Before this it was
 * a second entry point wired directly into the filing flow, which is what made the
 * page carry two upload surfaces.
 */
app.post('/api/admin/transcripts/from-watcher', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const { client, channel, video } = req.body || {};
    const v = await watcher.getVideo(client, channel, video);
    if (!v) return res.status(404).json({ error: 'Video not found in the Watcher archive' });
    if (!v.transcript) return res.status(400).json({ error: `That video has no transcript yet${v.error ? ` (${v.error})` : ''}` });
    const id = await addTranscript({
      program, title: req.body?.title || v.title || 'Untitled', text: v.transcript,
      source: 'watcher', watcherRef: { client, channel, video, url: v.url },
      folder: req.body?.folder || '',
    });
    res.json({ ok: true, id, title: v.title || 'Untitled', chars: String(v.transcript).length });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: move sources between library FOLDERS, in bulk.
 *
 * A folder is organisation only — it never affects what a lesson grounds on, which
 * is decided by `course`/`lesson` alone. So this is deliberately a separate verb
 * from filing: moving a source between folders can never change any learner's
 * questions or any lesson's source text. An empty `folder` moves them back to the
 * top level.
 */
app.post('/api/admin/transcripts/folder', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const folder = String(req.body?.folder || '').trim();
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 500);
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one source' });
    let moved = 0;
    for (const id of ids) {
      try { await updateTranscript(id, { folder }); moved += 1; }
      catch (e) { console.error('folder move failed:', id, e.message); }
    }
    res.json({ ok: true, moved, folder });
  } catch (e) {
    next(e);
  }
});

/**
 * Admin: read ONE source and cache what it teaches (abstract + concepts) on its doc.
 *
 * The map half of the corpus flow. Deliberately one source per request — a 40-source
 * corpus digested in a single call would be one long POST that Cloud Run throttles
 * and a closed tab would lose whole; the client loops this the same way it steps a
 * generation job, so a stopped run keeps every source it already catalogued.
 * Idempotent: re-digesting overwrites, so a re-uploaded or edited source is refreshed
 * by calling it again. `force` re-reads a source that already has a digest.
 */
app.post('/api/admin/transcripts/:id/digest', requireAdmin, rateLimitAI, async (req, res, next) => {
  try {
    const t = await getTranscriptById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.digestedAt && req.body?.force !== true) {
      return res.json({ ok: true, cached: true, id: t.id, abstract: t.abstract || '', concepts: t.concepts || [] });
    }
    const digest = await digestSource(
      { title: t.title, text: t.text, reading: await isReadingProgram(t.program) },
      aiFromBody(req),
    );
    await setTranscriptDigest(t.id, digest);
    res.json({ ok: true, cached: false, id: t.id, ...digest });
  } catch (e) {
    next(e);
  }
});

/* --------------------------- Watcher import (Atrium) ------------------------ */
// Admin: browse Atrium's Watcher archive and pull a video's transcript across.
// The three GETs are read-only bucket reads; a missing grant surfaces as a clean
// message, not a crash. The two POSTs at the end of this block are the other
// direction — they ADD a source, and go through Atrium's own bridge (lib/watcher.js).
app.get('/api/admin/watcher/clients', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ clients: await watcher.listClients() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/admin/watcher/channels', requireAdmin, async (req, res, next) => {
  try {
    res.json({ channels: await watcher.listChannels(String(req.query.client || '')) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/admin/watcher/videos', requireAdmin, async (req, res, next) => {
  try {
    const videos = await watcher.listVideos(String(req.query.client || ''), String(req.query.channel || ''));
    res.json({ videos });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Admin: copy one Watcher video's transcript in, attached to a lesson/topic.
app.post('/api/admin/watcher/import', requireAdmin, async (req, res, next) => {
  try {
    const { client, channel, video, track, course, lesson, topic } = req.body || {};
    const v = await watcher.getVideo(client, channel, video);
    if (!v) return res.status(404).json({ error: 'Video not found in the Watcher archive' });
    if (!v.transcript) return res.status(400).json({ error: `That video has no transcript yet${v.error ? ` (${v.error})` : ''}` });
    const scope = await requestScope(req);
    const id = await addTranscript({
      program: req.body?.program || scope.program,
      track, course, lesson, topic,
      title: v.title,
      text: v.transcript,
      source: 'watcher',
      watcherRef: { client, channel, video, url: v.url },
    });
    res.json({ ok: true, id, title: v.title, chars: v.chars });
  } catch (e) {
    next(e);
  }
});

// Admin: add a NEW source to Atrium's Watcher without leaving this page — paste a
// video/article link, a whole YouTube channel, or a whole blog. Atrium does the
// scraping and owns the result; we only ask, and then read it back through the
// GETs above. A refusal (bad link, already watching) is a 400 with Atrium's own
// sentence, so the admin sees why rather than "something went wrong".
app.post('/api/admin/watcher/add', requireAdmin, async (req, res) => {
  try {
    const { client, url, op } = req.body || {};
    const out = await watcher.addSource(String(client || ''), {
      url: String(url || ''), op: String(op || 'add_video'), actor: currentEmail(req),
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Admin: pull the next batch of missing bodies for a channel. ONE batch per call —
// the browser loops it until `remaining` is 0, exactly like Atrium's own tab, so a
// 200-video channel never depends on one long-lived request.
app.post('/api/admin/watcher/fetch', requireAdmin, async (req, res) => {
  try {
    const { client, channel, retry } = req.body || {};
    const out = await watcher.fetchBodies(String(client || ''), String(channel || ''), {
      retry: !!retry, actor: currentEmail(req),
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------- auto-file (AI placement) ------------------------ */
/**
 * Admin: read a piece of source material (pasted text OR a Watcher video) and let
 * the AI decide where it belongs — which existing Track/Course/Lesson it slots
 * into, or what new ones to create, and which topics to build. This is a DRY RUN:
 * it writes nothing. It returns the proposal (with new-vs-existing computed HERE
 * against the live catalog, never trusting the model) plus the resolved transcript
 * text, so /commit acts on exactly what the admin saw and approved.
 */
/**
 * Resolve the source material for an ingest plan: pasted text wins; otherwise pull
 * the chosen Watcher video's transcript. Returns everything the classifier + the
 * response shaper need, or throws an Error tagged with an HTTP `.status`.
 */
async function prepareIngest(req) {
  const scope = await requestScope(req);
  const program = req.body?.program || scope.program;
  let text = String(req.body?.text || '').trim();
  let title = String(req.body?.title || '').trim();
  let watcherRef = null;
  let source = 'paste';
  // A source that is ALREADY in the library is referenced by id, never re-pasted.
  // Committing then FILES that doc in place (see /ingest/commit) instead of writing
  // a second copy of the same material — which is what a paste would do.
  const transcriptId = String(req.body?.transcriptId || '').trim();
  if (!text && transcriptId) {
    const doc = await getTranscriptById(transcriptId);
    if (!doc) throw Object.assign(new Error('That source is no longer in the library'), { status: 404 });
    text = String(doc.text || '').trim();
    if (!text) throw Object.assign(new Error('That source has no text'), { status: 400 });
    source = doc.source || 'paste';
    if (!title) title = doc.title || '';
    watcherRef = doc.watcherRef || null;
  }
  if (!text && req.body?.watcher) {
    const { client, channel, video } = req.body.watcher;
    const v = await watcher.getVideo(client, channel, video);
    if (!v) throw Object.assign(new Error('Video not found in the Watcher archive'), { status: 404 });
    if (!v.transcript) throw Object.assign(new Error(`That video has no transcript yet${v.error ? ` (${v.error})` : ''}`), { status: 400 });
    text = v.transcript;
    source = 'watcher';
    if (!title) title = v.title;
    watcherRef = { client, channel, video, url: v.url };
  }
  if (!text) throw Object.assign(new Error('Pick a source from the library, paste a transcript, or pick a Watcher video first'), { status: 400 });
  const catalog = await getCatalog(req.userEmail, scope);
  const programName = (await getPrograms()).find((p) => p.id === program)?.name || program;
  return { program, programName, reading: await isReadingProgram(program), catalog, text, title, watcherRef, source, transcriptId };
}

// New-vs-existing is decided HERE, from the live catalog — never trusted from the model.
function shapeIngestPlan(p, { program, title, source, watcherRef, text, catalog, transcriptId }) {
  const has = (tr, co, le, to) => catalog.some((r) => r.track === tr && r.course === co && r.lesson === le && (to == null || r.topic === to));
  return {
    program,
    title: title || p.title,
    summary: p.summary,
    source,
    watcherRef,
    // Present when the plan was made from a source already in the library — the
    // commit uses it to file THAT doc rather than write a copy.
    transcriptId: transcriptId || null,
    chars: text.length,
    text,
    placement: {
      track: p.track, course: p.course, lesson: p.lesson,
      trackIsNew: !catalog.some((r) => r.track === p.track),
      courseIsNew: !catalog.some((r) => r.track === p.track && r.course === p.course),
      lessonIsNew: !has(p.track, p.course, p.lesson),
    },
    topics: p.topics.map((t) => ({ topic: t, isNew: !has(p.track, p.course, p.lesson, t) })),
  };
}

app.post('/api/admin/ingest/plan', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const ctx = await prepareIngest(req);
    const p = await classifyTranscript(
      { transcript: ctx.text, catalog: ctx.catalog, programName: ctx.programName, reading: ctx.reading },
      aiFromBody(req),
    );
    res.json(shapeIngestPlan(p, ctx));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Streaming sibling: same plan, but the model's thinking is streamed live (SSE) and
// the finished placement arrives as a single 'result' event. See sseInit/sseSend.
app.post('/api/admin/ingest/plan/stream', requireAdmin, bigJson, async (req, res) => {
  let started = false;
  try {
    const ctx = await prepareIngest(req);
    sseInit(res); started = true;
    const p = await classifyTranscript(
      { transcript: ctx.text, catalog: ctx.catalog, programName: ctx.programName, reading: ctx.reading },
      aiFromBody(req),
      (t, kind) => sseSend(res, kind === 'thinking' ? 'thinking' : 'content', { text: t }),
    );
    sseSend(res, 'result', shapeIngestPlan(p, ctx));
    sseSend(res, 'done', {});
    res.end();
  } catch (e) {
    if (started) { try { sseSend(res, 'error', { error: e.message || 'AI request failed' }); res.end(); } catch { /* closed */ } }
    else res.status(e.status || 500).json({ error: e.message || 'AI request failed' });
  }
});

/* ---------------------- curriculum order (three grains) ---------------------
 * Courses and lessons are not documents — they are fields on topic rows — so
 * their position is denormalised onto every row: `courseOrder` (course within
 * its track), `lessonOrder` (lesson within its course), `order` (topic within
 * its lesson). A group's rank is the MIN over its rows, so a row that missed a
 * write can never drag its group backwards. See firestore.js `setTopicOrders`.
 */
const cmpNatural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
/** Min of `field` over `rows` (Infinity when no row carries it). */
const minRank = (rows, field) => rows.reduce((m, r) => (Number.isFinite(r[field]) && r[field] < m ? r[field] : m), Infinity);
/* The hand-curated sequences (lib/graph.js) as row->rank lookups. They are the ONLY
 * order some units have ever had — Mathematics, Programming Foundations and the three
 * ML courses were sequenced in CODE, never in data — so a backfill must consult them
 * before falling back to the alphabet, or it stamps "College Algebra before
 * Trigonometry" over a list written to say the opposite, permanently (a stored rank
 * now outranks the curated list, which is the point of storing one). */
const CURATED_COURSE_RANK = new Map(COURSE_ORDER.map((name, i) => [name, i]));
const curatedCourseRank = (r) => (CURATED_COURSE_RANK.has(r.course) ? CURATED_COURSE_RANK.get(r.course) : Infinity);
const curatedLessonRank = (r) => {
  const i = (LESSON_ORDER[r.course] || []).indexOf(r.lesson);
  return i === -1 ? Infinity : i;
};
/** Distinct values of `pick` over `rows`, ranked by min `field`, then by name. */
function rankedNames(rows, pick, field) {
  const names = [...new Set(rows.map(pick))].filter(Boolean);
  const rank = new Map(names.map((nm) => [nm, minRank(rows.filter((r) => pick(r) === nm), field)]));
  return names.sort((a, b) => (rank.get(a) !== rank.get(b) ? rank.get(a) - rank.get(b) : cmpNatural(a, b)));
}

/**
 * Give freshly-created rows a position at every grain, so new content lands in
 * place instead of at the bottom of the tree in whatever order Firestore handed
 * the docs over (which is doc-id order — i.e. alphabetical, the bug this fixes).
 *
 * We touch ONLY units that have no rank yet, appending them after the highest
 * rank already used by their siblings: a new sub-lesson trails its lesson, a new
 * lesson trails its course, a new course trails its track. Existing sequences are
 * never disturbed.
 *
 * `hints` is how the DESIGNED order survives the round trip. Every creation path
 * knows the sequence it meant — the planner emits lessons prerequisites-first, a
 * pasted outline is in the author's own order — and that order used to be thrown
 * away, leaving the tree to fall back on names. Pass `curriculumHints(...)` and
 * the unplaced units are appended in THAT order instead of alphabetically. With
 * no hint the fallback is still natural name. Repairing a tree that already
 * landed wrong is `POST /api/admin/sequence-curriculum` (the AI sweep).
 */
async function placeNewTopicsInOrder(program, preread = null, hints = null) {
  const catalog = preread || (await getCatalog(null, { program })).filter((r) => r.topic && r.id);
  // Unambiguous tuple keys (JSON — no separator char can collide with a name).
  const tk = (r) => JSON.stringify([r.track]);
  const ck = (r) => JSON.stringify([r.track, r.course]);
  const lk = (r) => JSON.stringify([r.track, r.course, r.lesson]);

  const updates = new Map(); // id -> patch
  const patch = (id, k, v) => { updates.set(id, { ...(updates.get(id) || { id }), [k]: v }); };

  // Where a hint exists for a group, it decides the order the unplaced groups are
  // appended in; ties (no hint) fall back to natural name, after the hinted ones.
  const hintOf = (key) => (hints && hints.has(key) ? hints.get(key) : Infinity);

  // One grain: group `rows` by `groupKey`, rank the groups that already carry
  // `field`, and append the rest (hint order, then name) after the highest used rank.
  const placeGrain = (rows, parentKey, groupKey, name, field, curated = null) => {
    const curatedOf = (r) => (curated ? curated(r) : Infinity);
    const parents = new Map();
    for (const r of rows) {
      const p = parentKey(r);
      if (!parents.has(p)) parents.set(p, []);
      parents.get(p).push(r);
    }
    for (const kids of parents.values()) {
      const groups = new Map();
      for (const r of kids) {
        const g = groupKey(r);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
      }
      let max = -1;
      const unplaced = [];
      for (const g of groups.values()) {
        const rank = minRank(g, field);
        if (Number.isFinite(rank)) { if (rank > max) max = rank; } else unplaced.push(g);
      }
      // Order the unplaced groups by: the LEGACY global min(topic.order) signal, then
      // the caller's hint, then the name.
      //
      // 🔴 Legacy first is what makes backfilling an OLD program safe. Programs built
      // before course/lesson ranks existed encode their sequence in one running
      // `order` across the track; the first time a topic is added to such a program,
      // this pass ranks every one of its courses and lessons at once, and sorting them
      // by name would silently reorder a curriculum nobody touched. New units carry no
      // legacy order (they were only just upserted), so they tie at Infinity and the
      // hint decides among them — which is the case the hint exists for.
      const legacy = new Map(unplaced.map((g) => [g, minRank(g, 'order')]));
      unplaced.sort((a, b) => {
        const la = legacy.get(a), lb = legacy.get(b);
        if (la !== lb) return la - lb;
        const ha = hintOf(groupKey(a[0])), hb = hintOf(groupKey(b[0]));
        if (ha !== hb) return ha - hb;
        const ca = curatedOf(a[0]), cb = curatedOf(b[0]);
        if (ca !== cb) return ca - cb;
        return cmpNatural(name(a[0]), name(b[0]));
      });
      unplaced.forEach((g, i) => g.forEach((r) => patch(r.id, field, max + 1 + i)));
    }
  };

  placeGrain(catalog, tk, ck, (r) => r.course, 'courseOrder', curatedCourseRank);
  placeGrain(catalog, ck, lk, (r) => r.lesson, 'lessonOrder', curatedLessonRank);
  // Topics are their own grain: each row is its own "group" of one.
  placeGrain(catalog, lk, (r) => JSON.stringify([r.track, r.course, r.lesson, r.topic]), (r) => r.topic, 'order');

  if (updates.size) await setTopicOrders([...updates.values()]);
  return updates.size;
}

/**
 * Turn a creation path's own lesson list — ALREADY in the order it means, which
 * is what every planner and every pasted outline gives us — into the hint map
 * placeNewTopicsInOrder appends unplaced units by. Courses rank by where they
 * first appear, lessons by their position within their course, topics by their
 * position within their lesson. Keys match the grain keys above exactly.
 * `lessons` is [{track, course, lesson, topics:[names]}].
 */
function curriculumHints(lessons) {
  const hints = new Map();
  const next = new Map(); // parent key -> running index
  const take = (parent, key) => {
    if (hints.has(key)) return;
    const i = next.get(parent) || 0;
    next.set(parent, i + 1);
    hints.set(key, i);
  };
  for (const l of (lessons || [])) {
    const track = String(l?.track || '').trim();
    const course = String(l?.course || '').trim();
    const lesson = String(l?.lesson || '').trim();
    if (!track || !course || !lesson) continue;
    const tKey = JSON.stringify([track]);
    const cKey = JSON.stringify([track, course]);
    const lKey = JSON.stringify([track, course, lesson]);
    take(tKey, cKey);
    take(cKey, lKey);
    for (const t of (Array.isArray(l.topics) ? l.topics : [])) {
      const topic = String(t || '').trim();
      if (topic) take(lKey, JSON.stringify([track, course, lesson, topic]));
    }
  }
  return hints;
}

/** Which tracks of `program` still have a course or lesson with no stored rank. */
function tracksNeedingOrder(catalog) {
  const bad = new Set();
  const groups = new Map(); // [track,course(,lesson)] -> rows
  const push = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of catalog) {
    push(groups, JSON.stringify(['c', r.track, r.course]), r);
    push(groups, JSON.stringify(['l', r.track, r.course, r.lesson]), r);
  }
  for (const [k, rows] of groups) {
    const field = JSON.parse(k)[0] === 'c' ? 'courseOrder' : 'lessonOrder';
    if (!Number.isFinite(minRank(rows, field))) bad.add(rows[0].track);
  }
  return [...bad];
}

/** AI-sequence ONE track: its courses, and the lessons inside each, then persist
 *  `courseOrder`/`lessonOrder` on every row. Topic order (`order`) is untouched —
 *  that grain is sequenceLessonGroup's. Returns the number of rows written. */
async function sequenceCurriculumTrack(program, track, ai = {}) {
  const rows = (await getCatalog(null, { program })).filter((r) => r.topic && r.id && r.track === track);
  if (!rows.length) return 0;
  const courses = rankedNames(rows, (r) => r.course, 'courseOrder').map((course) => ({
    course,
    lessons: rankedNames(rows.filter((r) => r.course === course), (r) => r.lesson, 'lessonOrder'),
  }));
  if (courses.length < 2 && (courses[0]?.lessons.length || 0) < 2) return 0; // nothing to sequence
  const ordered = await generateCurriculumOrder({ track, courses }, ai);
  const items = [];
  ordered.forEach((c, ci) => c.lessons.forEach((lesson, li) => {
    for (const r of rows) {
      if (r.course === c.course && r.lesson === lesson) items.push({ id: r.id, courseOrder: ci, lessonOrder: li });
    }
  }));
  if (items.length) await setTopicOrders(items);
  return items.length;
}

/**
 * The one call every content-creation path makes after upserting topic rows:
 * place the new units, in the order the caller designed them. `lessons` is that
 * path's own [{track, course, lesson, topics}] list — pass it and the design is
 * preserved; omit it and new units still land after their siblings by name.
 * Best-effort: an ordering failure never breaks content creation.
 */
async function orderNewCurriculum(program, lessons = null) {
  try {
    await placeNewTopicsInOrder(program, null, lessons ? curriculumHints(lessons) : null);
  } catch (e) {
    console.error('order curriculum failed:', e.message);
  }
}

/** AI-sequence ONE lesson's sub-lessons (topics) into study order and persist it.
 *  Orders are 0-based within the lesson, which is now simply correct: a lesson's own
 *  position is its `lessonOrder`, so renumbering its topics cannot move it. (While
 *  lesson order was min(topic.order), this 0-basing was the bug — it flattened every
 *  lesson in a course to 0 and the tree fell back to alphabetical.) `group` is the
 *  lesson's catalog rows; `ai` picks the model. */
async function sequenceLessonGroup(group, ai = {}) {
  const ordered = await generateTopicOrder(
    { course: group[0].course, lesson: group[0].lesson, topics: group.map((r) => ({ id: r.id, topic: r.topic })) },
    ai,
  );
  await setTopicOrders(ordered.map((t, i) => ({ id: t.id, order: i })));
}

/** Auto-sequence exactly the lessons that just received new topics — so freshly
 *  generated sub-lessons land in pedagogical order instead of the alphabetical
 *  placeholder placeNewTopicsInOrder gives them. Best-effort: a failure here never
 *  breaks content creation. `lessonKeys` = [{track, course, lesson}]. */
async function autoSequenceLessons(program, lessonKeys, ai = {}) {
  try {
    const want = new Set((lessonKeys || []).map((k) => JSON.stringify([k.track, k.course, k.lesson])));
    if (!want.size) return 0;
    const catalog = (await getCatalog(null, { program })).filter((r) => r.topic && r.id);
    const groups = new Map();
    for (const r of catalog) {
      const key = JSON.stringify([r.track, r.course, r.lesson]);
      if (!want.has(key)) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const todo = [...groups.values()].filter((g) => g.length >= 2); // 1-topic lessons need no order
    let n = 0;
    await mapWithConcurrency(todo, 2, async (g) => {
      try { await sequenceLessonGroup(g, ai); n += 1; }
      catch (e) { console.error('auto-sequence: lesson failed:', e.message); }
    });
    return n;
  } catch (e) {
    console.error('auto-sequence failed:', e.message);
    return 0;
  }
}

/**
 * Admin: act on an approved placement. Creates any new topic rows, attaches the
 * transcript at the lesson level (so every chosen topic can use it), and queues a
 * generation job over exactly those topics. Returns the job; the admin page then
 * drives the existing /genjobs/:id/step stepper. Auto-publish, same as a manual
 * run — the flag + delete-batch valves still apply.
 */
app.post('/api/admin/ingest/commit', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const track = String(req.body?.track || '').trim();
    const course = String(req.body?.course || '').trim();
    const lesson = String(req.body?.lesson || '').trim();
    const topics = [...new Set((Array.isArray(req.body?.topics) ? req.body.topics : [])
      .map((t) => String(t || '').trim()).filter(Boolean))];
    // Text comes from the body (a fresh paste) OR from a source already in the
    // library, named by id. The id path is the normal one now: the Library is where
    // material enters, and filing is an ACTION on something already there.
    const existingId = String(req.body?.transcriptId || '').trim();
    const existingDoc = existingId ? await getTranscriptById(existingId) : null;
    const text = String(req.body?.text || '').trim() || String(existingDoc?.text || '').trim();
    if (!track || !course || !lesson) return res.status(400).json({ error: 'Track, course and lesson are all required' });
    if (!text) return res.status(400).json({ error: 'The source material is empty' });
    // Topics are only mandatory when generating: manual placement can just FILE the
    // transcript against a lesson (the old "attach manually" flow), building nothing.
    if (req.body?.generate === true && !topics.length) return res.status(400).json({ error: 'Pick at least one topic to build questions for' });

    // 1. Ensure the topic rows exist (new ones created, existing ones untouched).
    await upsertTopics(topics.map((topic) => ({ program, track, course, lesson, topic })));
    // Slot the new topics/lesson into study order instead of the bottom of the tree.
    await orderNewCurriculum(program, [{ track, course, lesson, topics }]);
    // Then AI-order this lesson's sub-lessons so new topics land pedagogically, not alphabetically.
    await autoSequenceLessons(program, [{ track, course, lesson }], aiChoice(req));

    // 2. Attach the transcript at the lesson level, so every chosen topic can draw on it.
    //    A source already in the library is FILED IN PLACE — it keeps its id, its
    //    folder and its cached digest, and the library shows it move from Unfiled to
    //    the lesson. Writing a fresh doc here would leave the original sitting
    //    unfiled beside a duplicate of itself.
    if (existingDoc) {
      await updateTranscript(existingId, { track, course, lesson });
    } else {
      await addTranscript({
        program, track, course, lesson,
        title: req.body?.title || 'Untitled',
        text,
        source: req.body?.source || 'paste',
        watcherRef: req.body?.watcherRef || null,
        folder: req.body?.folder || '',
      });
    }

    // 2b. Reading programs (Subject = personal growth / philosophy) treat this
    // material as a BOOK — lesson = the title, topics = its key points — and get
    // the fixed-shape flashcard deck built automatically, in the plan's point
    // order (the book's own order, not the AI study-sequence above). An explicit
    // bookDeck:true/false overrides the automatic choice. Best-effort: the filing
    // already succeeded, and the learner can build the deck later from the
    // flashcard view.
    const wantBookDeck = req.body?.bookDeck === undefined
      ? topics.length > 0 && await isReadingProgram(program)
      : req.body.bookDeck === true && topics.length > 0;
    let bookDeck = false;
    if (wantBookDeck) {
      try {
        await buildBookDeck({ program, scope: { track, course, lesson }, points: topics, ai: aiFromBody(req) });
        bookDeck = true;
      } catch (e) {
        console.error('book deck build failed:', e.message);
      }
    }

    // 3. Generation is OPT-IN. By default this just files the transcript + curriculum
    // rows and stops — attaching material and building questions are separate acts.
    if (req.body?.generate !== true) {
      return res.json({ ok: true, generated: false, topics: topics.length, bookDeck });
    }
    const job = await createGenJob({
      program,
      scope: { track, course, lesson },
      targetPerTopic: Math.min(25, Math.max(1, parseInt(req.body?.targetPerTopic, 10) || 6)),
      provider: req.body?.provider || 'deepseek',
      model: req.body?.model || null,
      thinking: req.body?.thinking !== false,
      instructions: req.body?.instructions || '',
      topics: topics.map((topic) => ({ topic, track, course, lesson })),
    });
    res.json({ ok: true, generated: true, job: publicJob(job), bookDeck });
  } catch (e) {
    next(e);
  }
});

/* ------------------ corpus planner (sources -> curriculum) ----------------- */
/*
 * The OTHER direction through this room. The original flow is curriculum-first:
 * build a tree, then attach sources to it (`/ingest/*`). This one is sources-first:
 * upload raw material with no curriculum at all, then select some of it and let the
 * curriculum be DESIGNED from what the sources actually teach.
 *
 * Three steps, mirroring /ingest and /goal: plan (pure, no writes) -> review in the
 * client -> commit (writes). New-vs-existing is decided HERE against the live
 * catalog, never trusted from the model, and the model references sources only by
 * index into the list we hand it, so it cannot attach a lesson to a transcript the
 * admin did not select.
 */

/** Gather the selected sources + baseline for the corpus planner, or throw a
 *  status-tagged Error. Shared by the JSON and streaming plan endpoints. */
async function prepareSourcePlan(req) {
  const scope = await requestScope(req);
  const program = req.body?.program || scope.program;
  const ids = [...new Set((Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : [])
    .map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 60);
  if (!ids.length) throw Object.assign(new Error('Pick at least one source to build from'), { status: 400 });

  const docs = (await Promise.all(ids.map((id) => getTranscriptById(id)))).filter(Boolean);
  if (!docs.length) throw Object.assign(new Error('None of those sources could be read'), { status: 404 });

  // The planner designs from DIGESTS, never full text (lib/gemini.js says why). A
  // source that was never digested still gets included, described by its title
  // alone — degraded but never blocking, and the client offers to digest first.
  const undigested = docs.filter((d) => !d.abstract).length;
  const sources = docs.map((d) => ({ id: d.id, title: d.title, abstract: d.abstract || '', concepts: d.concepts || [] }));
  const catalog = await getCatalog(req.userEmail, scope);
  const programName = (await getPrograms()).find((p) => p.id === program)?.name || program;
  // Gap topics are OPT-IN: they are created empty and never generated over, so a
  // design full of them is mostly a to-do list. Absent flag = no gaps.
  const wantGaps = req.body?.gaps === true;
  return {
    program, programName, reading: await isReadingProgram(program),
    catalog, sources, undigested, wantGaps, guidance: String(req.body?.guidance || '').trim(),
  };
}

/** New-vs-existing decided HERE from the live catalog, never from the model.
 *  Also resolves the model's source INDICES back to real transcript ids. */
function shapeSourcePlan(plan, { program, catalog, sources }) {
  const has = (co, le, to) => catalog.some((r) => r.track === plan.track && r.course === co
    && (le == null || r.lesson === le) && (to == null || r.topic === to));
  const byIndex = (i) => sources[i];
  // Gap topics are keyed by course+lesson so they can be folded into the lesson
  // they belong to — they are part of the design, not a separate list to act on.
  const gapsFor = (co, le) => (plan.gaps || []).filter((g) => g.course === co && g.lesson === le);

  return {
    program,
    track: plan.track,
    summary: plan.summary,
    trackIsNew: !catalog.some((r) => r.track === plan.track),
    sources: sources.map((s) => ({ id: s.id, title: s.title })),
    courses: plan.courses.map((c) => ({
      course: c.course,
      courseIsNew: !has(c.course),
      lessons: c.lessons.map((l) => {
        const gaps = gapsFor(c.course, l.lesson);
        return {
          lesson: l.lesson,
          rationale: l.rationale,
          lessonIsNew: !has(c.course, l.lesson),
          // A source the model pointed at, resolved to a real selected transcript.
          sources: l.sources.map(byIndex).filter(Boolean).map((s) => ({ id: s.id, title: s.title })),
          topics: [
            ...l.topics.map((t) => ({ topic: t, isNew: !has(c.course, l.lesson, t), isGap: false, why: '' })),
            // Gap topics carry no source: they are the subject's missing pieces,
            // created empty so they can be filled later (see the SOP). They are
            // deliberately EXCLUDED from generation at commit — a strict-transcript
            // job over a topic with no transcript just fails.
            ...gaps.filter((g) => !l.topics.includes(g.topic))
              .map((g) => ({ topic: g.topic, isNew: !has(c.course, l.lesson, g.topic), isGap: true, why: g.why })),
          ],
        };
      }),
    })),
  };
}

app.post('/api/admin/sources/plan', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const ctx = await prepareSourcePlan(req);
    const plan = await planFromSources(
      {
        sources: ctx.sources, catalog: ctx.catalog, programName: ctx.programName,
        guidance: ctx.guidance, wantGaps: ctx.wantGaps, reading: ctx.reading,
      },
      aiFromBody(req),
    );
    res.json({ ...shapeSourcePlan(plan, ctx), undigested: ctx.undigested });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Streaming sibling: the design reasoning streams live while it works.
app.post('/api/admin/sources/plan/stream', requireAdmin, bigJson, async (req, res) => {
  let started = false;
  try {
    const ctx = await prepareSourcePlan(req);
    sseInit(res); started = true;
    const plan = await planFromSources(
      {
        sources: ctx.sources, catalog: ctx.catalog, programName: ctx.programName,
        guidance: ctx.guidance, wantGaps: ctx.wantGaps, reading: ctx.reading,
      },
      aiFromBody(req),
      (t, kind) => sseSend(res, kind === 'thinking' ? 'thinking' : 'content', { text: t }),
    );
    sseSend(res, 'result', { ...shapeSourcePlan(plan, ctx), undigested: ctx.undigested });
    sseSend(res, 'done', {});
    res.end();
  } catch (e) {
    if (started) { try { sseSend(res, 'error', { error: e.message || 'AI request failed' }); res.end(); } catch { /* closed */ } }
    else res.status(e.status || 500).json({ error: e.message || 'AI request failed' });
  }
});

/**
 * Admin: materialise an approved corpus plan.
 *
 * Upserts every topic row, FILES each selected source onto the lesson it grounds,
 * and optionally queues ONE generation job across every course in the plan (the
 * queue entries carry their own track/course/lesson, so a single job spans them).
 *
 * 🔴 Filing the source is the step that makes this worth doing. Once a transcript
 * carries a real {course, lesson}, every existing grounding path picks it up for
 * free — study guides (`getScopeTranscripts`), strict-transcript generation, the
 * assistant's source text. An unfiled source is inert by design; a filed one is
 * the lesson's authoritative material.
 *
 * A source that grounds SEVERAL lessons is COPIED to each extra one, because a
 * transcript doc carries exactly one scope and grounding reads by scope. The copy
 * records `copyOf` so the duplicates are traceable. This is rare and deliberate —
 * the alternative (file it once) silently leaves the other lessons ungrounded.
 */
app.post('/api/admin/sources/commit', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const track = String(req.body?.track || '').trim();
    if (!track) return res.status(400).json({ error: 'The plan needs a track' });

    const courses = (Array.isArray(req.body?.courses) ? req.body.courses : [])
      .map((c) => ({
        course: String(c?.course || '').trim(),
        lessons: (Array.isArray(c?.lessons) ? c.lessons : []).map((l) => ({
          lesson: String(l?.lesson || '').trim(),
          sourceIds: [...new Set((Array.isArray(l?.sourceIds) ? l.sourceIds : []).map((s) => String(s || '').trim()).filter(Boolean))],
          // Gap topics arrive flagged so they are created but never generated over.
          topics: (Array.isArray(l?.topics) ? l.topics : [])
            .map((t) => (typeof t === 'string' ? { topic: t, isGap: false } : { topic: String(t?.topic || '').trim(), isGap: t?.isGap === true }))
            .filter((t) => t.topic),
        })).filter((l) => l.lesson && l.topics.length),
      }))
      .filter((c) => c.course && c.lessons.length);
    if (!courses.length) return res.status(400).json({ error: 'Pick at least one lesson with topics' });

    // 1. Every topic row, across every course in the plan.
    const rows = [];
    for (const c of courses) {
      for (const l of c.lessons) {
        for (const t of l.topics) rows.push({ program, track, course: c.course, lesson: l.lesson, topic: t.topic });
      }
    }
    await upsertTopics(rows);
    // The DESIGN's own order is the curriculum order: the planner emits courses and
    // lessons prerequisites-first, so persist that instead of letting the tree fall
    // back to names (which is how the first sources-first tracks landed alphabetical).
    const lessonScopes = courses.flatMap((c) => c.lessons.map((l) => ({
      track, course: c.course, lesson: l.lesson, topics: l.topics.map((t) => t.topic),
    })));
    await orderNewCurriculum(program, lessonScopes);
    await autoSequenceLessons(program, lessonScopes, aiChoice(req));

    // 2. File the sources. First lesson to claim a source MOVES it; any further
    //    lesson gets a copy, so each lesson's grounding reads back its own text.
    const claimed = new Map();   // transcript id -> the scope that already owns it
    let filed = 0; let copied = 0;
    for (const c of courses) {
      for (const l of c.lessons) {
        for (const id of l.sourceIds) {
          const doc = await getTranscriptById(id);
          if (!doc) continue;
          if (!claimed.has(id)) {
            await updateTranscript(id, { track, course: c.course, lesson: l.lesson });
            claimed.set(id, `${c.course} > ${l.lesson}`);
            filed += 1;
          } else {
            await addTranscript({
              program, track, course: c.course, lesson: l.lesson,
              title: doc.title, text: doc.text, source: doc.source || 'paste',
              watcherRef: doc.watcherRef || null, copyOf: id,
            });
            copied += 1;
          }
        }
      }
    }

    // 3. Generation is OPT-IN, and never covers gap topics — they have no source,
    //    so a strict-transcript job over them would only produce errors.
    if (req.body?.generate !== true) {
      return res.json({ ok: true, generated: false, topics: rows.length, filed, copied });
    }
    const queue = [];
    for (const c of courses) {
      for (const l of c.lessons) {
        for (const t of l.topics) {
          if (!t.isGap) queue.push({ topic: t.topic, track, course: c.course, lesson: l.lesson });
        }
      }
    }
    if (!queue.length) {
      return res.json({ ok: true, generated: false, topics: rows.length, filed, copied, note: 'Every topic is a gap — nothing to generate from yet.' });
    }
    const job = await createGenJob({
      program,
      scope: { track },
      targetPerTopic: Math.min(25, Math.max(1, parseInt(req.body?.targetPerTopic, 10) || 6)),
      provider: req.body?.provider || 'deepseek',
      model: req.body?.model || null,
      thinking: req.body?.thinking !== false,
      instructions: req.body?.instructions || '',
      topics: queue,
    });
    res.json({ ok: true, generated: true, topics: rows.length, filed, copied, job: publicJob(job) });
  } catch (e) {
    next(e);
  }
});

/* --------------------- goal-based module planner --------------------------- */
/**
 * Summarise a user's catalog into the baseline the goal planner builds on. We
 * deliberately IGNORE quiz performance: everything already in the curriculum is
 * treated as "known" (content that exists and shouldn't be re-taught), so a new
 * module builds on top of the whole catalog regardless of how the learner has
 * scored. `learning` is kept for the planner's stable signature but is empty —
 * there is no performance-derived "shaky" list any more.
 */
function masteryDigest(catalog) {
  const known = [];
  for (const r of catalog || []) {
    if (r.topic) known.push(r.topic);
  }
  const cap = (a) => [...new Set(a)].slice(0, 120);
  return { known: cap(known), learning: [] };
}

/**
 * Admin: draft a whole MODULE from a stated learning goal, building on what the
 * acting user already knows. Pure planning — new-vs-existing is decided HERE from
 * the live catalog (never trusted from the model); the tree is returned for review
 * and the companion /goal/commit writes it. Mirrors /ingest/plan.
 */
/** Gather the goal + the learner's baseline the planner builds on, or throw a
 *  status-tagged Error. Shared by the JSON and streaming plan endpoints. */
async function prepareGoal(req) {
  const scope = await requestScope(req);
  const program = req.body?.program || scope.program;
  const goal = String(req.body?.goal || '').trim();
  const reference = String(req.body?.reference || '').trim();
  if (!goal) throw Object.assign(new Error('Describe what you want to learn first'), { status: 400 });
  const catalog = await getCatalog(req.userEmail, scope);
  const { known, learning } = masteryDigest(catalog);
  const programName = (await getPrograms()).find((p) => p.id === program)?.name || program;
  return { program, programName, reading: await isReadingProgram(program), catalog, goal, reference, known, learning };
}

// New-vs-existing decided HERE from the live catalog, never from the model.
function shapeGoalPlan(plan, { program, reference, catalog }) {
  const has = (le, to) => catalog.some((r) => r.track === plan.track && r.course === plan.course
    && (le == null || r.lesson === le) && (to == null || r.topic === to));
  return {
    program,
    track: plan.track,
    course: plan.course,
    summary: plan.summary,
    assumedKnowledge: plan.assumedKnowledge,
    reference,
    trackIsNew: !catalog.some((r) => r.track === plan.track),
    courseIsNew: !catalog.some((r) => r.track === plan.track && r.course === plan.course),
    lessons: plan.lessons.map((l) => ({
      lesson: l.lesson,
      rationale: l.rationale,
      lessonIsNew: !has(l.lesson),
      topics: l.topics.map((t) => ({ topic: t, isNew: !has(l.lesson, t) })),
    })),
  };
}

app.post('/api/admin/goal/plan', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const ctx = await prepareGoal(req);
    const plan = await planCurriculum(
      {
        goal: ctx.goal, known: ctx.known, learning: ctx.learning, catalog: ctx.catalog,
        programName: ctx.programName, reference: ctx.reference, reading: ctx.reading,
      },
      aiFromBody(req),
    );
    res.json(shapeGoalPlan(plan, ctx));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Streaming sibling: the model's reasoning streams live (SSE) while it drafts the
// module, then the finished plan arrives as one 'result' event.
app.post('/api/admin/goal/plan/stream', requireAdmin, bigJson, async (req, res) => {
  let started = false;
  try {
    const ctx = await prepareGoal(req);
    sseInit(res); started = true;
    const plan = await planCurriculum(
      {
        goal: ctx.goal, known: ctx.known, learning: ctx.learning, catalog: ctx.catalog,
        programName: ctx.programName, reference: ctx.reference, reading: ctx.reading,
      },
      aiFromBody(req),
      (t, kind) => sseSend(res, kind === 'thinking' ? 'thinking' : 'content', { text: t }),
    );
    sseSend(res, 'result', shapeGoalPlan(plan, ctx));
    sseSend(res, 'done', {});
    res.end();
  } catch (e) {
    if (started) { try { sseSend(res, 'error', { error: e.message || 'AI request failed' }); res.end(); } catch { /* closed */ } }
    else res.status(e.status || 500).json({ error: e.message || 'AI request failed' });
  }
});

/**
 * Admin: materialise an approved goal-plan. Upserts every topic, writes+attaches a
 * short brief per lesson (the stored "lesson" AND the grounding material), and
 * queues ONE topic-anchored generation job over all topics. Flashcards are built
 * client-side per lesson afterwards. Auto-publish + batchTag/flag valves still apply.
 */
app.post('/api/admin/goal/commit', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;
    const track = String(req.body?.track || '').trim();
    const course = String(req.body?.course || '').trim();
    const goal = String(req.body?.goal || '').trim();
    const reference = String(req.body?.reference || '').trim();
    const assumedKnowledge = (Array.isArray(req.body?.assumedKnowledge) ? req.body.assumedKnowledge : [])
      .map((s) => String(s || '').trim()).filter(Boolean);
    // `course` here is only the module-level default; each lesson may carry its own,
    // so a blank module course is fine as long as every lesson resolves one below.
    if (!track) return res.status(400).json({ error: 'Track is required' });

    // The approved lesson tree: {track?, course?, lesson, topics:[...]}, empties dropped.
    // Each lesson may target its own course/lesson (admin re-filed it into an existing
    // unit); missing track/course fall back to the module-level defaults.
    const lessons = (Array.isArray(req.body?.lessons) ? req.body.lessons : [])
      .map((l) => ({
        track: String(l?.track || track).trim() || track,
        course: String(l?.course || course).trim() || course,
        lesson: String(l?.lesson || '').trim(),
        topics: [...new Set((Array.isArray(l?.topics) ? l.topics : []).map((t) => String(t || '').trim()).filter(Boolean))],
      }))
      .filter((l) => l.track && l.course && l.lesson && l.topics.length);
    if (!lessons.length) return res.status(400).json({ error: 'Pick at least one topic to build' });

    // 1. Ensure every topic row exists (new ones created, existing untouched).
    const flat = [];
    for (const l of lessons) for (const topic of l.topics) flat.push({ program, track: l.track, course: l.course, lesson: l.lesson, topic });
    await upsertTopics(flat);
    // The approved plan's own order IS the curriculum order — persist it so the tree
    // reads as designed instead of falling back to alphabetical names.
    await orderNewCurriculum(program, lessons);

    // 2. Write a brief per lesson (parallel) and attach it — the stored lesson + grounding.
    const ai = aiFromBody(req);
    // AI-order each new lesson's sub-lessons so topics land pedagogically, not alphabetically.
    await autoSequenceLessons(program, lessons.map((l) => ({ track: l.track, course: l.course, lesson: l.lesson })), ai);
    await Promise.all(lessons.map(async (l) => {
      const brief = await writeLessonBrief({ course: l.course, lesson: l.lesson, topics: l.topics, assumedKnowledge, goal, reference }, ai);
      if (brief) await addTranscript({ program, track: l.track, course: l.course, lesson: l.lesson, title: l.lesson, text: brief, source: 'goal-plan' });
    }));

    // 3. One topic-anchored generation job over all topics (the briefs are the reference).
    const assumeNote = assumedKnowledge.length
      ? `The learner already knows: ${assumedKnowledge.join(', ')}. Do not test these directly; build on them.` : '';
    // Optional: exact transcripts the admin picked to ground generation on. When
    // present, stepGenJob uses these as the source material (overriding the thin
    // per-lesson briefs) — right when real practitioner transcripts exist for the goal.
    const transcriptIds = Array.isArray(req.body?.transcriptIds)
      ? req.body.transcriptIds.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 20)
      : [];
    const job = await createGenJob({
      program,
      scope: { track, course },
      targetPerTopic: Math.min(25, Math.max(1, parseInt(req.body?.targetPerTopic, 10) || 6)),
      provider: ai.provider,
      model: ai.model || null,
      thinking: ai.thinking,
      grounding: 'topic',
      instructions: [assumeNote, String(req.body?.instructions || '').trim()].filter(Boolean).join(' '),
      transcriptIds,
      topics: flat.map(({ topic, track: tr, course: co, lesson }) => ({ topic, track: tr, course: co, lesson })),
    });

    res.json({
      ok: true,
      job: publicJob(job),
      buildCards: req.body?.buildCards !== false,
      lessons: lessons.map((l) => ({ track: l.track, course: l.course, lesson: l.lesson, topics: l.topics })),
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------- bulk lesson builder ----------------------------- */
/** Clean a structured [{track,course,lesson,topics[]}] list from the client. */
function normalizeBulkLessons(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((l) => ({
      track: String(l?.track || '').trim(),
      course: String(l?.course || '').trim(),
      lesson: String(l?.lesson || '').trim(),
      topics: [...new Set((Array.isArray(l?.topics) ? l.topics : []).map((t) => String(t || '').trim()).filter(Boolean))],
    }))
    .filter((l) => l.track && l.course && l.lesson && l.topics.length);
}

/**
 * Parse a pasted outline into lessons. One "Track > Course > Lesson > Topic" per
 * line (# comments and blanks ignored); lines sharing a Track/Course/Lesson are
 * grouped into a single lesson with several topics. Mirrors the splitter used by
 * /api/admin/topics/bulk, but rolls rows up to the lesson grain.
 */
function lessonsFromOutline(text) {
  const byKey = new Map();
  String(text || '').split('\n').forEach((line) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    const parts = raw.split('>').map((p) => p.trim());
    if (parts.length !== 4 || parts.some((p) => !p)) return;
    const [track, course, lesson, topic] = parts;
    const key = JSON.stringify([track, course, lesson]);
    if (!byKey.has(key)) byKey.set(key, { track, course, lesson, topics: [] });
    byKey.get(key).topics.push(topic);
  });
  return [...byKey.values()]
    .map((l) => ({ ...l, topics: [...new Set(l.topics)] }))
    .filter((l) => l.topics.length);
}

/**
 * Admin: build MANY complete lessons in one run. For every lesson it upserts the
 * topic rows, writes a study brief (the stored lesson + generation grounding),
 * and queues ONE topic-anchored generation job across all topics. Flashcards are
 * built client-side per lesson afterwards. This is the bulk sibling of
 * /goal/commit and /ingest/commit. `preview:true` just parses and echoes back.
 */
app.post('/api/admin/lessons/bulk-commit', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const program = req.body?.program || scope.program;

    let lessons = normalizeBulkLessons(req.body?.lessons);
    if (!lessons.length && typeof req.body?.text === 'string') lessons = lessonsFromOutline(req.body.text);

    if (req.body?.preview) {
      const topicCount = lessons.reduce((n, l) => n + l.topics.length, 0);
      return res.json({ ok: true, preview: true, lessons, count: lessons.length, topicCount });
    }
    if (!lessons.length) return res.status(400).json({ error: 'Add at least one lesson with a track, course, lesson and topics' });

    // 1. Ensure every topic row exists (new ones created, existing untouched).
    const flat = [];
    for (const l of lessons) for (const topic of l.topics) flat.push({ program, track: l.track, course: l.course, lesson: l.lesson, topic });
    await upsertTopics(flat);
    // The approved plan's own order IS the curriculum order — persist it so the tree
    // reads as designed instead of falling back to alphabetical names.
    await orderNewCurriculum(program, lessons);

    // 2. Write a brief per lesson (parallel) and attach it — the stored lesson + grounding.
    const ai = aiFromBody(req);
    // AI-order each new lesson's sub-lessons so topics land pedagogically, not alphabetically.
    await autoSequenceLessons(program, lessons.map((l) => ({ track: l.track, course: l.course, lesson: l.lesson })), ai);
    const instructions = String(req.body?.instructions || '').trim();
    await Promise.all(lessons.map(async (l) => {
      const brief = await writeLessonBrief({ course: l.course, lesson: l.lesson, topics: l.topics, reference: instructions }, ai);
      if (brief) await addTranscript({ program, track: l.track, course: l.course, lesson: l.lesson, title: l.lesson, text: brief, source: 'bulk' });
    }));

    // 3. One topic-anchored generation job over all topics (the briefs are the reference).
    const job = await createGenJob({
      program,
      scope: {},
      targetPerTopic: Math.min(25, Math.max(1, parseInt(req.body?.targetPerTopic, 10) || 6)),
      provider: ai.provider,
      model: ai.model || null,
      thinking: ai.thinking,
      grounding: 'topic',
      instructions,
      topics: flat.map(({ topic, track, course, lesson }) => ({ topic, track, course, lesson })),
    });

    res.json({
      ok: true,
      job: publicJob(job),
      buildCards: req.body?.buildCards !== false,
      lessons: lessons.map((l) => ({ track: l.track, course: l.course, lesson: l.lesson, topics: l.topics })),
    });
  } catch (e) {
    next(e);
  }
});

/* ---------------------------- generation jobs ------------------------------ */
/**
 * Admin: queue a bulk generation over a scope's topics.
 *
 * The runner is a STEPPER (see lib/genjobs.js): this only builds the queue. The
 * caller then POSTs /step repeatedly — which is what survives Cloud Run's
 * between-request CPU throttling without min-instances or new infra.
 */
app.post('/api/admin/genjobs', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const catalog = await getCatalog(req.userEmail, scope);
    const scoped = scopeCatalog(catalog, req.body || {});
    const topics = scoped
      .filter((r) => r.topic)
      .map((r) => ({ topic: r.topic, track: r.track, course: r.course, lesson: r.lesson }));
    if (!topics.length) return res.status(400).json({ error: 'No topics in that scope' });

    const job = await createGenJob({
      program: scope.program,
      scope: { track: req.body?.track, course: req.body?.course, lesson: req.body?.lesson },
      targetPerTopic: Math.min(25, Math.max(1, parseInt(req.body?.targetPerTopic, 10) || 5)),
      provider: req.body?.provider || 'deepseek',
      model: req.body?.model || null,
      thinking: req.body?.thinking !== false,
      instructions: req.body?.instructions || '',
      transcriptIds: Array.isArray(req.body?.transcriptIds) ? req.body.transcriptIds : [],
      topics,
    });
    res.json({ ok: true, job: publicJob(job) });
  } catch (e) {
    next(e);
  }
});

app.get('/api/admin/genjobs', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    res.json({ jobs: await listGenJobs(scope.program) });
  } catch (e) {
    next(e);
  }
});

app.get('/api/admin/genjobs/:id', requireAdmin, async (req, res, next) => {
  try {
    const job = await getGenJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'No such job' });
    res.json({ job: publicJob(job) });
  } catch (e) {
    next(e);
  }
});

/* Advance a job by ONE topic. Deliberately NOT behind rateLimitAI: that limiter
 * is a per-IP cost guard for learner-facing AI, and this is an admin-triggered
 * server-internal batch that would trip it within seconds.
 *
 * A step is ONE model call and with thinking on it routinely runs 1-5 minutes
 * (measured: 78-313s per topic) — the exact socket `sseResult` exists for: held as
 * a plain POST the step SUCCEEDS here (200, questions banked) while the browser
 * sees "Failed to fetch" and the run strands at queued/running. JSON stays the
 * default: scripts/ drives this endpoint too, and it has no such problem over a
 * short-lived CLI socket. */
app.post('/api/admin/genjobs/:id/step', requireAdmin, async (req, res, next) => {
  if (wantsSSE(req)) {
    return sseResult(res, async () => ({ job: await stepGenJob(req.params.id) }), 'Step failed');
  }
  try {
    res.json({ job: await stepGenJob(req.params.id) });
  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/genjobs/:id/cancel', requireAdmin, async (req, res, next) => {
  try {
    await updateGenJob(req.params.id, { status: 'cancelled', queue: [] });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- roadmaps --------------------------------- */
/**
 * A ROADMAP is a curated PATH over existing catalog topics — a second lens on the
 * shared bank (see lib/firestore.js). The admin plans one from a goal (the AI
 * SELECTS existing topics and orders them into stages; it never invents a topic —
 * it only returns indices into the catalog we hand it, resolved to real rows in
 * planRoadmap). Learners see the roadmaps for their program and take them straight
 * from the "Roadmap" tab, their per-topic mastery derived from what they already
 * track. Content generation stays the goal flow's job — a roadmap only re-groups.
 */

/** Shape one stored roadmap for a client, adding progress the caller can compute. */
function publicRoadmap(rm) {
  if (!rm) return null;
  return {
    id: rm.id,
    title: rm.title || 'Roadmap',
    goal: rm.goal || '',
    summary: rm.summary || '',
    program: rm.program || DEFAULT_PROGRAM,
    audience: rm.audience === 'everyone' ? 'everyone' : 'program',
    stages: (Array.isArray(rm.stages) ? rm.stages : []).map((s) => ({
      id: s.id,
      title: s.title || '',
      summary: s.summary || '',
      items: (Array.isArray(s.items) ? s.items : []).map((it) => ({
        level: it.level || 'topic',
        program: it.program || rm.program || DEFAULT_PROGRAM,
        topicId: it.topicId || '',
        track: it.track || '',
        course: it.course || '',
        lesson: it.lesson || '',
        topic: it.topic || '',
        note: it.note || '',
      })),
    })),
    itemCount: (Array.isArray(rm.stages) ? rm.stages : []).reduce((n, s) => n + (s.items?.length || 0), 0),
    // Kept as topicCount for back-compat with existing admin list rendering.
    topicCount: (Array.isArray(rm.stages) ? rm.stages : []).reduce((n, s) => n + (s.items?.length || 0), 0),
    updatedAt: rm.updatedAt?.toMillis?.() || null,
  };
}

// Learner: the roadmaps visible in my program (plus any 'everyone' roadmap), each
// flagged with whether I'm enrolled / it was assigned to me. Access is OPEN — the
// flags are soft labels, not gates. The client joins topics to its own mastery.
app.get('/api/roadmaps', requireAuth, async (req, res, next) => {
  try {
    // Every roadmap is open to everyone — no program filter. A learner sees all
    // roadmaps regardless of program; the `assigned`/`enrolled` flags are soft labels
    // (assigned = "Required"), and topics resolve against the full bank on the client.
    const list = await listRoadmaps();
    const shelf = (await getShelf(req.userEmail)) || { roadmaps: [], assignedRoadmaps: [] };
    const enrolled = new Set(shelf.roadmaps);
    const assigned = new Set(shelf.assignedRoadmaps);
    res.json({
      roadmaps: list.map((rm) => ({
        ...publicRoadmap(rm),
        enrolled: enrolled.has(rm.id),
        assigned: assigned.has(rm.id),
      })),
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/roadmaps/:id', requireAuth, async (req, res, next) => {
  try {
    const rm = await getRoadmap(req.params.id);
    if (!rm) return res.status(404).json({ error: 'No such roadmap' });
    // A learner may only open a roadmap in a program they can see.
    const scope = await requestScope(req);
    if (!isAdmin(req) && rm.audience !== 'everyone' && rm.program !== scope.program) {
      return res.status(403).json({ error: 'Not available in your program' });
    }
    res.json({ roadmap: publicRoadmap(rm) });
  } catch (e) {
    next(e);
  }
});

// Admin: manage roadmaps (list/save/delete) and plan one from a goal.
app.get('/api/admin/roadmaps', requireAdmin, async (req, res, next) => {
  try {
    const program = req.query?.program || undefined;
    res.json({ roadmaps: (await listRoadmaps({ program })).map(publicRoadmap) });
  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/roadmaps', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const saved = await saveRoadmap({
      id: req.body?.id,
      title: req.body?.title,
      goal: req.body?.goal,
      summary: req.body?.summary,
      program: req.body?.program || scope.program,
      audience: req.body?.audience,
      stages: req.body?.stages,
      source: req.body?.source || 'admin',
      createdBy: req.userEmail,
      updatedBy: req.userEmail,
    });
    res.json({ ok: true, roadmap: publicRoadmap(saved) });
  } catch (e) {
    if (String(e.message || '').includes('title')) return res.status(400).json({ error: e.message });
    next(e);
  }
});

app.delete('/api/admin/roadmaps/:id', requireAdmin, async (req, res, next) => {
  try {
    await deleteRoadmap(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Gather the goal + the program's live catalog the roadmap planner selects from. */
async function prepareRoadmap(req) {
  const scope = await requestScope(req);
  const program = req.body?.program || scope.program;
  const goal = String(req.body?.goal || '').trim();
  if (!goal) throw Object.assign(new Error('Describe the goal of the roadmap first'), { status: 400 });
  const catalog = await getCatalog(req.userEmail, { ...scope, program });
  const programName = (await getPrograms()).find((p) => p.id === program)?.name || program;
  return { program, programName, catalog, goal, title: String(req.body?.title || '').trim(), reference: String(req.body?.reference || '').trim() };
}

/** Attach the program to a resolved roadmap plan (planRoadmap already resolved refs to real rows). */
function shapeRoadmapPlan(plan, { program }) {
  return {
    program,
    title: plan.title,
    summary: plan.summary,
    stages: plan.stages,
    gaps: plan.gaps || [],
  };
}

app.post('/api/admin/roadmap/plan', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const ctx = await prepareRoadmap(req);
    const plan = await planRoadmap(
      { goal: ctx.goal, title: ctx.title, catalog: ctx.catalog, programName: ctx.programName, reference: ctx.reference },
      aiFromBody(req),
    );
    res.json(shapeRoadmapPlan(plan, ctx));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Streaming sibling: reasoning streams live (SSE), finished plan arrives as 'result'.
app.post('/api/admin/roadmap/plan/stream', requireAdmin, bigJson, async (req, res) => {
  let started = false;
  try {
    const ctx = await prepareRoadmap(req);
    sseInit(res); started = true;
    const plan = await planRoadmap(
      { goal: ctx.goal, title: ctx.title, catalog: ctx.catalog, programName: ctx.programName, reference: ctx.reference },
      aiFromBody(req),
      (t, kind) => sseSend(res, kind === 'thinking' ? 'thinking' : 'content', { text: t }),
    );
    sseSend(res, 'result', shapeRoadmapPlan(plan, ctx));
    sseSend(res, 'done', {});
    res.end();
  } catch (e) {
    if (started) { try { sseSend(res, 'error', { error: e.message || 'AI request failed' }); res.end(); } catch { /* closed */ } }
    else res.status(e.status || 500).json({ error: e.message || 'AI request failed' });
  }
});

/* ------------------- Mastery Engine shelf (user-curated tracks) ------------- */
/*
 * The learner curates their own Mastery Engine by adding TRACKS from the open
 * bank. Adding a track also ensures its program is in the user's enrollment, so
 * the program-scoped quiz/review endpoints keep working for a track from any
 * program. A roadmap can be added in one click — it drops its referenced tracks
 * onto the shelf.
 */

// The bank browser: every (program, track) with counts. Open — any track addable.
app.get('/api/bank/tracks', requireAuth, async (_req, res, next) => {
  try {
    res.json({ tracks: await listBankTracks() });
  } catch (e) {
    next(e);
  }
});

// My current shelf (resolved tracks, curated-else-enrollment) + the sections I've
// hidden (for the "Customize my engine" restore list).
app.get('/api/me/shelf', requireAuth, async (req, res, next) => {
  try {
    const hidden = (await getShelf(req.userEmail))?.hidden || [];
    res.json({ tracks: (await effectiveShelf(req.userEmail)) || [], hidden });
  } catch (e) {
    next(e);
  }
});

/** Ensure `program` is in the user's enrollment (courses left untouched) so the
 *  program-scoped quiz/review endpoints resolve a section pulled from it. Used when
 *  adding an individual course/lesson/sub-lesson whose track isn't a whole shelf track. */
async function ensureProgramEnrolled(email, program) {
  const enr = await getEnrollment(email);
  if (enr.programs.includes(program)) return;
  await setEnrollment(email, { programs: [...enr.programs, program], courses: enr.courses });
}

/** Materialise the user's shelf (from enrollment if they've never curated), apply
 *  a set of {program, track} mutations, and ensure each added track's program is in
 *  their enrollment so quizzes resolve. `add`/`remove` are arrays of {program, track}. */
async function mutateShelf(email, add = [], remove = []) {
  const base = (await effectiveShelf(email)) || [];
  const map = new Map(base.map((t) => [JSON.stringify([t.program, t.track]), t]));
  for (const t of remove) if (t && t.track) map.delete(JSON.stringify([t.program || DEFAULT_PROGRAM, t.track]));
  const addPrograms = new Set();
  for (const t of add) {
    if (!t || !t.track) continue;
    const rec = { program: t.program || DEFAULT_PROGRAM, track: t.track };
    map.set(JSON.stringify([rec.program, rec.track]), rec);
    addPrograms.add(rec.program);
  }
  const saved = await setShelf(email, { tracks: [...map.values()] });
  // Open bank: adding a track from a program you're not enrolled in enrolls you in
  // it (courses stay "all"), so requestScope honours that program for quizzes.
  if (addPrograms.size) {
    const enr = await getEnrollment(email);
    const programs = new Set(enr.programs);
    let changed = false;
    for (const p of addPrograms) if (!programs.has(p)) { programs.add(p); changed = true; }
    if (changed) await setEnrollment(email, { programs: [...programs], courses: enr.courses });
  }
  return saved;
}

/** Enrol `email` in a roadmap: auto-add its tracks to their Mastery Engine and
 *  record the roadmap id (assigned=true also badges it "Assigned"). */
async function enrollRoadmap(email, roadmap, { assigned = false } = {}) {
  await mutateShelf(email, collectRoadmapTracks(roadmap), []);
  const shelf = (await getShelf(email)) || { roadmaps: [], assignedRoadmaps: [] };
  const roadmaps = new Set(shelf.roadmaps); roadmaps.add(roadmap.id);
  const assignedRoadmaps = new Set(shelf.assignedRoadmaps);
  if (assigned) assignedRoadmaps.add(roadmap.id);
  await setShelf(email, { roadmaps: [...roadmaps], assignedRoadmaps: [...assignedRoadmaps] });
}

/** Un-enrol: drop the roadmap id and (by default) its tracks from the shelf. */
async function unenrollRoadmap(email, roadmap, { removeTracks = true } = {}) {
  const shelf = (await getShelf(email)) || { tracks: [], roadmaps: [], assignedRoadmaps: [] };
  const roadmaps = shelf.roadmaps.filter((x) => x !== roadmap.id);
  const assignedRoadmaps = shelf.assignedRoadmaps.filter((x) => x !== roadmap.id);
  const patch = { roadmaps, assignedRoadmaps };
  if (removeTracks) {
    const drop = new Set(collectRoadmapTracks(roadmap).map((t) => JSON.stringify([t.program, t.track])));
    const base = (await effectiveShelf(email)) || [];
    patch.tracks = base.filter((t) => !drop.has(JSON.stringify([t.program, t.track])));
  }
  await setShelf(email, patch);
}

// Add or remove one track from my Mastery Engine.
app.post('/api/me/tracks', requireAuth, async (req, res, next) => {
  try {
    const program = String(req.body?.program || DEFAULT_PROGRAM);
    const track = String(req.body?.track || '').trim();
    if (!track) return res.status(400).json({ error: 'track is required' });
    const action = req.body?.action === 'remove' ? 'remove' : 'add';
    const saved = await mutateShelf(
      req.userEmail,
      action === 'add' ? [{ program, track }] : [],
      action === 'remove' ? [{ program, track }] : [],
    );
    res.json({ ok: true, ...saved });
  } catch (e) {
    next(e);
  }
});

/** Hide (remove) or show (restore) one section of my Mastery Engine at any grain.
 *  Body: {program, track, course?, lesson?, topic?, action:'hide'|'show'}. Hiding a
 *  coarse level hides everything beneath it; the content stays in the shared bank
 *  (and in any Roadmap that references it). Track-grain removal keeps using
 *  /api/me/tracks; this covers course/lesson/topic (and tolerates a bare track). */
app.post('/api/me/hide', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const track = String(b.track || '').trim();
    if (!track) return res.status(400).json({ error: 'track is required' });
    const entry = { program: String(b.program || DEFAULT_PROGRAM), track };
    for (const k of ['course', 'lesson', 'topic']) {
      const v = String(b[k] || '').trim();
      if (v) entry[k] = v;
    }
    const action = b.action === 'show' ? 'show' : 'hide';
    const shelf = (await getShelf(req.userEmail)) || { hidden: [] };
    const keyOf = (h) =>
      JSON.stringify([h.program || DEFAULT_PROGRAM, h.track, h.course || '', h.lesson || '', h.topic || '']);
    const map = new Map((shelf.hidden || []).map((h) => [keyOf(h), h]));
    if (action === 'show') map.delete(keyOf(entry));
    else map.set(keyOf(entry), entry);
    const saved = await setShelf(req.userEmail, { hidden: [...map.values()] });
    res.json({ ok: true, hidden: saved.hidden });
  } catch (e) {
    next(e);
  }
});

/** Add or remove ONE section of my Mastery Engine at any grain
 *  (path/track, course, lesson or sub-lesson). Body:
 *    {program, track, course?, lesson?, topic?, action:'add'|'remove'}
 *  The grain is the deepest level named. A whole track routes through the tracks
 *  list (like /api/me/tracks); finer grains use the additive `included` /
 *  subtractive `hidden` layers, each clearing the other's exact-key entry so a
 *  toggle is a clean flip (deepest prefix wins — see inEngine). Adding also enrols
 *  the program so its quizzes resolve. This is the single endpoint behind the ＋/✕
 *  toggle on every node in the Roadmap and Mastery Engine trees. */
app.post('/api/me/section', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const track = String(b.track || '').trim();
    if (!track) return res.status(400).json({ error: 'track is required' });
    const program = String(b.program || DEFAULT_PROGRAM);
    const email = req.userEmail;
    const prefix = { program, track };
    for (const k of ['course', 'lesson', 'topic']) {
      const v = String(b[k] || '').trim();
      if (v) prefix[k] = v;
    }
    const grain = prefix.topic ? 'topic' : prefix.lesson ? 'lesson' : prefix.course ? 'course' : 'track';
    const add = b.action !== 'remove';
    const keyOf = (h) =>
      JSON.stringify([h.program || DEFAULT_PROGRAM, h.track, h.course || '', h.lesson || '', h.topic || '']);

    // Opt-in verification (the Coach's AI-proposed edits pass verify:1): the prefix must name a
    // REAL section, matched against the whole bank (so restoring a hidden section still resolves).
    // Matches case-insensitively, then rewrites the prefix to the row's exact casing — hidden[]
    // matching downstream (hiddenMatch/matchDepth) is exact, so a case-drifted entry would
    // otherwise "apply" while hiding nothing. Hand-built UI calls skip this: their names come
    // from rendered catalog nodes and are exact by construction.
    if (b.verify) {
      const eq = (a2, b2) => String(a2 || '').toLowerCase() === String(b2 || '').toLowerCase();
      // The Coach's proposals never carry a program (the shelf can span programs), so
      // only pin the program when the caller sent one explicitly; otherwise adopt the row's.
      const explicitProgram = String(b.program || '').trim();
      const bank = await getCatalog(email, null);
      const row = bank.find((r) =>
        (!explicitProgram || (r.program || DEFAULT_PROGRAM) === explicitProgram) && eq(r.track, prefix.track)
        && (!prefix.course || eq(r.course, prefix.course))
        && (!prefix.lesson || eq(r.lesson, prefix.lesson))
        && (!prefix.topic || eq(r.topic, prefix.topic)));
      if (!row) {
        const path = ['track', 'course', 'lesson', 'topic'].map((k) => prefix[k]).filter(Boolean).join(' > ');
        return res.status(404).json({ error: `No section matches “${path}” — the name must match the curriculum exactly` });
      }
      prefix.program = row.program || DEFAULT_PROGRAM;
      prefix.track = row.track;
      if (prefix.course) prefix.course = row.course;
      if (prefix.lesson) prefix.lesson = row.lesson;
      if (prefix.topic) prefix.topic = row.topic;
    }

    if (grain === 'track') {
      // Whole track goes on/off the tracks list. Either way, clear any finer
      // included/hidden entries under this track so it resolves cleanly (a re-added
      // track comes back whole; a removed track takes its added sub-sections with it).
      // Read names off `prefix`, not the raw body locals — verify may have canonicalized them.
      const shelf = (await getShelf(email)) || {};
      const notUnderTrack = (arr) =>
        (arr || []).filter((h) => !(h.track === prefix.track && (h.program || DEFAULT_PROGRAM) === prefix.program));
      await setShelf(email, { hidden: notUnderTrack(shelf.hidden), included: notUnderTrack(shelf.included) });
      const entry = { program: prefix.program, track: prefix.track };
      await mutateShelf(email, add ? [entry] : [], add ? [] : [entry]);
    } else {
      // Toggling a course/lesson also clears any hidden/included entries STRICTLY BENEATH
      // it (e.g. individually-parked sub-lessons under a lesson being re-added) - otherwise
      // a deeper hidden entry still outranks this shallower inclusion (see inEngine's
      // specificity rule) and the ＋ silently leaves those sub-lessons parked. Mirrors the
      // 'track' branch above; a no-op at topic grain since nothing is deeper than a topic.
      const depthOf = (p) => (p.topic ? 4 : p.lesson ? 3 : p.course ? 2 : p.track ? 1 : 0);
      const prefixDepth = depthOf(prefix);
      const isBeneathPrefix = (h) => {
        if ((h.program || DEFAULT_PROGRAM) !== prefix.program || h.track !== prefix.track) return false;
        if (prefix.course && h.course !== prefix.course) return false;
        if (prefix.lesson && h.lesson !== prefix.lesson) return false;
        if (prefix.topic && h.topic !== prefix.topic) return false;
        return depthOf(h) > prefixDepth;
      };
      const shelf = (await getShelf(email)) || {};
      const included = new Map((shelf.included || []).filter((h) => !isBeneathPrefix(h)).map((h) => [keyOf(h), h]));
      const hidden = new Map((shelf.hidden || []).filter((h) => !isBeneathPrefix(h)).map((h) => [keyOf(h), h]));
      const k = keyOf(prefix);
      if (add) { included.set(k, prefix); hidden.delete(k); }
      else { hidden.set(k, prefix); included.delete(k); }
      await setShelf(email, { included: [...included.values()], hidden: [...hidden.values()] });
      if (add) await ensureProgramEnrolled(email, prefix.program);
    }
    const shelf = await getShelf(email);
    res.json({ ok: true, tracks: shelf.tracks, included: shelf.included, hidden: shelf.hidden });
  } catch (e) {
    next(e);
  }
});

// Enrol in / add a whole roadmap to my Mastery Engine (auto-adds its tracks).
app.post('/api/me/roadmaps/:id/add', requireAuth, async (req, res, next) => {
  try {
    const rm = await getRoadmap(req.params.id);
    if (!rm) return res.status(404).json({ error: 'No such roadmap' });
    const tracks = collectRoadmapTracks(rm);
    if (!tracks.length) return res.status(400).json({ error: 'This roadmap has no tracks to add' });
    await enrollRoadmap(req.userEmail, rm, { assigned: false });
    res.json({ ok: true, added: tracks.length });
  } catch (e) {
    next(e);
  }
});

// Remove a roadmap from my Mastery Engine (drops its tracks too).
app.post('/api/me/roadmaps/:id/remove', requireAuth, async (req, res, next) => {
  try {
    const rm = await getRoadmap(req.params.id);
    if (!rm) return res.status(404).json({ error: 'No such roadmap' });
    await unenrollRoadmap(req.userEmail, rm, { removeTracks: true });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Admin: assign / unassign a roadmap to workers. Assignment is a SOFT label +
// auto-populates their Mastery Engine — it grants no exclusive access (the bank
// is open to everyone regardless).
app.post('/api/admin/roadmaps/:id/assign', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const rm = await getRoadmap(req.params.id);
    if (!rm) return res.status(404).json({ error: 'No such roadmap' });
    const emails = (Array.isArray(req.body?.emails) ? req.body.emails : [])
      .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return res.status(400).json({ error: 'Pick at least one person' });
    const unassign = req.body?.action === 'unassign';
    // Mirror the learner's own add path: refuse to assign a roadmap that would
    // put NOTHING in anyone's engine (its items resolve to zero tracks) — the
    // "Required" badge must never point at an empty roadmap.
    if (!unassign && !collectRoadmapTracks(rm).length) {
      return res.status(400).json({ error: 'This roadmap has no tracks to add — fix its items first' });
    }
    for (const email of emails) {
      if (unassign) await unenrollRoadmap(email, rm, { removeTracks: false });
      else await enrollRoadmap(email, rm, { assigned: true });
    }
    res.json({ ok: true, count: emails.length, action: unassign ? 'unassign' : 'assign' });
  } catch (e) {
    next(e);
  }
});

/* ------------------------- flags (auto-publish valve) ---------------------- */
// Any signed-in learner can flag a bad question — the safety valve that makes
// auto-publishing generated questions survivable.
app.post('/api/questions/:id/flag', requireAuth, async (req, res, next) => {
  try {
    const id = await flagQuestion({
      questionId: req.params.id,
      email: req.userEmail,
      reason: req.body?.reason,
      topic: req.body?.topic,
    });
    res.json({ ok: true, id });
  } catch (e) {
    next(e);
  }
});

// Each flag carries the question it points at, so the Proof station can show
// (and fix) what's actually wrong instead of just a reason string. A question
// already deleted comes back as `question: null` — the flag still needs
// resolving, so it must not vanish from the list.
app.get('/api/admin/flags', requireAdmin, async (req, res, next) => {
  try {
    const flags = await listQuestionFlags(req.query.all === '1');
    const bodies = await mapWithConcurrency(
      flags, 8, (f) => getQuestionById(f.questionId).catch(() => null),
    );
    res.json({
      flags: flags.map((f, i) => ({ ...f, question: bodies[i] ? publicQuestion(bodies[i]) : null })),
    });
  } catch (e) {
    next(e);
  }
});

app.post('/api/admin/flags/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const ok = await resolveQuestionFlag(req.params.id, { deleteQuestion: req.body?.deleteQuestion === true });
    res.json({ ok });
  } catch (e) {
    next(e);
  }
});

// Admin: every question filed under a Course › Lesson › Sub-lesson, for the
// Composing Room's question browser. Scoped through the catalog (not by topic
// name alone) so a name shared by two lessons lists only the section asked for —
// the same reason scopedMetaIndex exists.
app.get('/api/admin/questions', requireAdmin, async (req, res, next) => {
  try {
    const scope = await requestScope(req);
    const sel = {
      track: req.query?.track || '',
      course: req.query?.course || '',
      lesson: req.query?.lesson || '',
      topic: req.query?.topic || '',
    };
    if (isAll(sel.course)) return res.status(400).json({ error: 'Pick a course first' });
    const catalog = await getCatalog(null, scope);
    const rows = scopeCatalog(catalog, sel);
    const topics = [...new Set(rows.map((r) => r.topic))].filter(Boolean);
    if (!topics.length) return res.json({ questions: [], topics: 0 });

    const pool = await getQuestionsForTopics(topics, scope);
    // Group by topic in catalog order so the browser reads like the curriculum,
    // not like Firestore's document order.
    const rank = new Map(topics.map((t, i) => [t, i]));
    const questions = pool
      .map(publicQuestion)
      .sort((a, b) => (rank.get(a.topic) ?? 0) - (rank.get(b.topic) ?? 0)
        || a.question.localeCompare(b.question));
    res.json({ questions, topics: topics.length });
  } catch (e) {
    next(e);
  }
});

// Admin: delete ONE question (the "this one is wrong and not worth fixing"
// button). Corrects the topic's counter — see deleteQuestionById.
app.delete('/api/admin/questions/:id', requireAdmin, async (req, res, next) => {
  try {
    const out = await deleteQuestionById(req.params.id);
    if (!out.deleted) return res.status(404).json({ error: 'Question not found' });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
});

// Admin: pull an entire generation batch (the "that run was bad" button).
app.post('/api/admin/questions/delete-batch', requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await deleteQuestionBatch(String(req.body?.batchTag || ''))) });
  } catch (e) {
    next(e);
  }
});

// Auth: one-time CSV -> Firestore import (idempotent).
app.post('/api/admin/migrate', requireAdmin, async (_req, res, next) => {
  try {
    const report = await runMigration();
    res.json({ ok: true, report });
  } catch (e) {
    next(e);
  }
});

// Auth: one-time backfill of historical quizLog into BigQuery. Idempotent only
// in the sense of "re-runnable" — running twice duplicates rows, so call once.
app.post('/api/admin/bq-backfill', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await getQuizLogRows(DEFAULT_ACCOUNT);
    const inserted = await backfillRows(rows);
    res.json({ ok: true, inserted });
  } catch (e) {
    next(e);
  }
});

// Auth: refresh the BigQuery `topics` mastery snapshot from live Firestore.
// Full replace (WRITE_TRUNCATE) — safe to re-run anytime; also runs
// automatically after every logged quiz.
app.post('/api/admin/bq-sync-topics', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await getTopicsRows(DEFAULT_ACCOUNT, new Date(), BQ_SCOPE);
    const synced = await replaceTopics(rows);
    res.json({ ok: true, synced });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ static + 404 ------------------------------ */

/*
 * The Academy Admin (Composing Room) page is admin-only AT THE SERVER, not just in the
 * browser. express.static below would otherwise hand the full admin shell (and its
 * frontend script) to anyone who asks, leaving only the client-side "Admins only" card
 * between a guest and the admin UI. Every /api/admin route is already requireAdmin-gated,
 * so no data leaks — this closes the UI/recon layer: non-admins never receive the page and
 * are 302'd to the homepage instead (?embed=1 is preserved so the Sentinel iframe lands on
 * the embedded app, not a bare page). isAdmin() reads the Sentinel role through the /api
 * gate cache, which a bare page navigation has NOT warmed, so await sentinelInfo() first —
 * a role-admin opening the page in a fresh browser must not bounce off a cold cache.
 * no-store keeps the admin shell out of shared caches and out of history after sign-out.
 */
app.get(['/academy-admin.html', '/academy-admin.js'], async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const email = currentEmail(req);
  if (email) await sentinelInfo(email).catch(() => {}); // lookup failure ⇒ no role ⇒ not admin
  if (!isAdmin(req)) return res.redirect(302, req.query.embed ? '/?embed=1' : '/');
  const file = req.path.endsWith('.js') ? 'academy-admin.js' : 'academy-admin.html';
  res.sendFile(path.join(__dirname, 'public', file));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JSON error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  const body = { error: err.message || 'Internal error' };
  // A diagnosed AI failure carries the evidence the browser's 🐞 panel renders: what ran, why the
  // payload broke, and the text around the break (lib/gemini.js describeJsonFailure). Only ever a
  // diag object WE built — never a stack trace, never the prompt.
  if (err.diag) body.diag = err.diag;
  res.status(500).json(body);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Mastery Engine listening on :${PORT}`));
