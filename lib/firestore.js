/**
 * Firestore data layer.
 *
 * SHARED across all users (unchanged):
 *   Question Bank -> `questions`  (the MCQ pool)
 *   Catalog       -> `topics`     (track/course/lesson/topic + questionCount)
 *
 * PER-USER progress (mastery stats + attempt log), keyed by a normalised email `userKey`:
 *   - The LEGACY OWNER (MASTERY_DEFAULT_ACCOUNT, default ianfernandezctm@gmail.com) maps to the
 *     ORIGINAL top-level collections: stats live embedded on the `topics` docs and attempts in
 *     `quizLog`. So all pre-existing progress is his, with NO migration.
 *   - Every OTHER user gets their own subcollections: `users/{userKey}/topicStats/{topicId}` and
 *     `users/{userKey}/quizLog/{id}`. The catalog is still read from the shared `topics` docs and
 *     each user's stats are overlaid on top (so nobody sees anyone else's numbers).
 * A null `userKey` (guest) reads the catalog with fresh/zero stats.
 */
import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore';
import { computePriority, deriveStats } from './priority.js';
import {
  DEFAULT_PROGRAM,
  programOf,
  defaultEnrollment,
  normalizeEnrollment,
  resolveScope,
  filterCatalog,
  filterQuestions,
} from './programs.js';

// On Cloud Run, project + credentials come from the runtime automatically.
export const db = new Firestore({
  ignoreUndefinedProperties: true,
});

export const COL = {
  topics: 'topics',
  questions: 'questions',
  quizLog: 'quizLog',
  flashcards: 'flashcards',
  studyGuides: 'studyGuides',
  graphLinks: 'graphLinks',
  programs: 'programs',
  transcripts: 'transcripts',
  genJobs: 'genJobs',
  questionFlags: 'questionFlags',
  roadmaps: 'roadmaps',
  visualGuides: 'visualGuides',
};

// The account that owns the pre-existing (global) progress; env-overridable.
export const LEGACY_OWNER = (process.env.MASTERY_DEFAULT_ACCOUNT || 'ianfernandezctm@gmail.com')
  .trim()
  .toLowerCase();

const normKey = (userKey) => (userKey || '').trim().toLowerCase();
const isLegacy = (userKey) => normKey(userKey) === LEGACY_OWNER;

/** The collection holding a user's per-topic stats (embedded on `topics` for the legacy owner). */
function statsCol(userKey) {
  return isLegacy(userKey)
    ? db.collection(COL.topics)
    : db.collection('users').doc(normKey(userKey)).collection('topicStats');
}
function statsDoc(userKey, topicId) {
  return statsCol(userKey).doc(topicId);
}
/** The collection holding a user's attempt log. */
function logCol(userKey) {
  return isLegacy(userKey)
    ? db.collection(COL.quizLog)
    : db.collection('users').doc(normKey(userKey)).collection('quizLog');
}

/** Deterministic doc id so re-running the import is idempotent. */
export function slug(...parts) {
  return (
    parts
      .join('__')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 480) || 'x'
  );
}

/* ------------------------------ Programs ----------------------------------- */
/*
 * A `program` (data_science | digital_marketing | …) sits above the whole
 * hierarchy so several curricula share one engine. See programs.js for the rules;
 * this section is only the IO. Everything here degrades to the original
 * single-curriculum behaviour when no program docs / enrollments exist yet.
 */

/** Every program doc: [{ id, name, defaultCourses[] }]. */
export async function getPrograms() {
  const snap = await db.collection(COL.programs).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** One program doc by id, or null. */
export async function getProgram(id) {
  if (!id) return null;
  const doc = await db.collection(COL.programs).doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/** Upsert a program (merge, so a rename never drops defaultCourses).
 *  `category` ('career' | 'growth') routes it to the right Sentinel tab — career subjects show under
 *  Academy, personal-growth/philosophy subjects under Reading & Philosophy. Missing = career. */
export async function saveProgram({ id, name, defaultCourses, category }) {
  if (!id) throw new Error('program id required');
  await db.collection(COL.programs).doc(id).set(
    {
      name: name || id,
      ...(Array.isArray(defaultCourses) ? { defaultCourses } : {}),
      ...(category ? { category: String(category).trim() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return id;
}

/* A user's enrollment lives beside their usage tally (users/{u}/meta/enrollment)
 * rather than in a top-level collection: it is per-user data, it is read on
 * nearly every request, and this keeps a user's whole footprint under one doc. */
const enrollmentDoc = (userKey) =>
  db.collection('users').doc(normKey(userKey)).collection('meta').doc('enrollment');

/** `userKey`'s enrollment, or the default (all of the default program) when unset. */
export async function getEnrollment(userKey) {
  if (!userKey) return defaultEnrollment();
  const doc = await enrollmentDoc(userKey).get();
  return doc.exists ? normalizeEnrollment(doc.data()) : defaultEnrollment();
}

/** Set `userKey`'s enrollment. Empty `courses` = every course in the program. */
export async function setEnrollment(userKey, { programs, courses }) {
  if (!userKey) return null;
  const enr = normalizeEnrollment({ programs, courses });
  await enrollmentDoc(userKey).set({ ...enr, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return enr;
}

/**
 * The { program, courses } scope a request runs in: the user's enrollment, with
 * `requested` honoured only where allowed (admins anywhere, guests freely, a
 * learner only among their own programs — see resolveScope).
 *
 * EXCEPTION: growth-category programs (the reading curricula behind Sentinel's
 * Philosophical/Spiritual pinned tabs) are open to EVERY learner. Those tabs pin
 * ?program= for the whole staff, and gating them by enrollment made an
 * un-enrolled learner's tab silently fall back to their career program —
 * data-science quizzes inside the Spiritual tab. Whole-program scope on
 * purpose: course filters belong to career enrollments and the pinned tabs
 * mirror the entire program. The extra program read only happens when
 * resolveScope has already refused the request, so enrolled learners, admins
 * and unpinned requests cost nothing new.
 */
export async function resolveProgramScope(userKey, { requested = '', isAdmin = false } = {}) {
  const enrollment = await getEnrollment(userKey);
  const scope = resolveScope(enrollment, { requested, anyProgram: isAdmin || !userKey });
  const want = String(requested || '').trim();
  if (want && scope.program !== want) {
    const category = (await getProgram(want))?.category || 'career';
    if (category === 'growth') return { program: want, courses: [] };
  }
  return scope;
}

/* ----------------------------- Catalog (topics) ---------------------------- */

/**
 * Full topic catalog for `userKey`, each row carrying THAT user's mastery stats (accuracy/priority
 * are derived downstream). Legacy owner: stats are already on the `topics` docs. Others: the shared
 * catalog with their own stats overlaid (zeros where they haven't practised). Guest (null): zeros.
 *
 * `scope` ({program, courses}) narrows the rows to one curriculum. Omit it to read the whole bank
 * (admin tools, migrations). Rows written before programs existed count as DEFAULT_PROGRAM, so a
 * data-science request returns exactly what it always did.
 */
export async function getCatalog(userKey = null, scope = null) {
  return overlayStats(userKey, await readTopicDocs(), scope);
}

/** The shared `topics` collection as raw docs — what `overlayStats` overlays one user's stats onto. */
export async function readTopicDocs() {
  const snap = await db.collection(COL.topics).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * getCatalog's second half, over `topics` docs ALREADY read. Split out so a BATCH caller can read
 * the shared catalog once and overlay many users onto it: `/api/internal/team-progress` costs ~540
 * topic reads for the whole team instead of ~540 per person. getCatalog's behaviour is unchanged.
 */
export async function overlayStats(userKey = null, allRows = [], scope = null) {
  const catalog = scope ? filterCatalog(allRows, scope) : allRows;
  const now = new Date();
  const freshPriority = computePriority({ correctCount: 0, totalAttempts: 0, lastAttempted: null }, now);
  // Legacy owner: stats are embedded on the catalog docs (original behaviour), but a topic doc
  // only carries a `priority` once it's been attempted. Fill the never-attempted ones with the
  // fresh (high) priority so a just-generated topic isn't invisible to quiz/select and the
  // priority quiz, which both drop rows where priority is null.
  if (isLegacy(userKey)) {
    return catalog.map((t) => ({ ...t, priority: t.priority != null ? t.priority : freshPriority }));
  }

  let byId = new Map();
  if (userKey) {
    const sSnap = await statsCol(userKey).get();
    byId = new Map(sSnap.docs.map((d) => [d.id, d.data()]));
  }
  return catalog.map((t) => {
    const s = byId.get(t.id) || {};
    return {
      ...t,
      correctCount: s.correctCount || 0,
      totalAttempts: s.totalAttempts || 0,
      lastAttempted: s.lastAttempted || null,
      priority: s.priority != null ? s.priority : freshPriority,
    };
  });
}

/** The three curriculum-order fields a topic doc can carry, one per grain. */
export const ORDER_FIELDS = ['order', 'lessonOrder', 'courseOrder'];

/**
 * Persist a topic's curriculum position onto its catalog doc. `items` is
 * [{id, order?, lessonOrder?, courseOrder?}] — three INDEPENDENT grains:
 *
 *   `order`       0-based rank of this topic inside its lesson
 *   `lessonOrder` 0-based rank of this topic's LESSON inside its course
 *   `courseOrder` 0-based rank of this topic's COURSE inside its track
 *
 * The lesson/course ranks are denormalised onto every topic row because topics
 * are the only documents that exist — courses and lessons are just fields. Each
 * row of a lesson carries the same `lessonOrder`, so a group's rank is the min
 * over its rows (a row that missed a write can never drag the group backwards).
 *
 * Keeping the grains separate is the whole point: before this, lesson and course
 * position were INFERRED from min(topic.order), so re-sequencing a lesson's
 * topics 0-based (which is what every AI sequencing pass does) collapsed every
 * lesson in the course to min order 0 and the tree silently fell back to
 * alphabetical. See AGENTS.md §7 "Curriculum order".
 *
 * Only finite fields are written, with merge, so a caller can set one grain
 * without disturbing the others. Chunked into batches; returns the docs written.
 */
export async function setTopicOrders(items) {
  let batch = db.batch();
  let ops = 0;
  let n = 0;
  for (const it of items) {
    if (!it?.id) continue;
    const patch = {};
    for (const f of ORDER_FIELDS) if (Number.isFinite(it[f])) patch[f] = it[f];
    if (!Object.keys(patch).length) continue;
    batch.set(db.collection(COL.topics).doc(it.id), patch, { merge: true });
    n += 1;
    if (++ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return n;
}

/**
 * Re-file topics under a new track/course/lesson WITHOUT changing their doc id.
 * The id is slug(track,course,lesson,topic), but everything downstream reads the
 * stored fields, not the slug — so keeping the id preserves per-user stats (keyed
 * by id), banked questions (keyed by name) and prereq graph edges (keyed by id).
 * `fields` is a partial {track?, course?, lesson?}; only provided keys are written.
 * Batched like setTopicOrders. Returns the number of docs moved.
 */
export async function moveTopics(ids, fields = {}) {
  const patch = {};
  for (const k of ['track', 'course', 'lesson']) {
    const v = String(fields[k] ?? '').trim();
    if (v) patch[k] = v;
  }
  if (!Object.keys(patch).length) return 0;
  let batch = db.batch();
  let ops = 0;
  let n = 0;
  for (const id of ids || []) {
    if (!id) continue;
    batch.set(db.collection(COL.topics).doc(id), patch, { merge: true });
    n += 1;
    if (++ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return n;
}

/**
 * RENAME sub-lessons in place, keeping every doc id — and re-key the four things
 * that are keyed by the topic's NAME rather than its id, which is the whole
 * reason a rename cannot simply be a `moveTopics` with a `topic` field:
 *
 *   `topics/{id}.topic`   the row itself (id kept, so per-user stats survive)
 *   `questions.topic`     the shared bank (`getQuestionsForTopics` matches on name)
 *   `flashcards.topic`    a deck's cards, plus a TOPIC-level deck's `scopeId`
 *   `studyGuides/{id}`    a TOPIC-level guide, whose doc id embeds the name
 *
 * Miss any one of them and the rename silently empties the sub-lesson: the quiz
 * finds no questions, the deck disappears, the guide regenerates from nothing.
 * `graphLinks` and per-user `topicStats` are keyed by doc id and need nothing;
 * `quizLog` rows deliberately keep the names they were logged under (see
 * `buildTopicIdIndex`, which maps historical rows back by id).
 *
 * `items` is `[{ id, topic, questionIds? }]`. QUESTIONS ARE THE AMBIGUOUS ONE:
 * a question doc carries only `{topic, program}`, so when two sub-lessons of one
 * program share a name their banks are genuinely ONE pool. Those questions are
 * then LEFT ALONE (reported in `ambiguous`) unless the caller names the exact
 * `questionIds` that follow this row — the only way to split a shared pool
 * without guessing which half belongs where.
 *
 * @returns {Promise<{renamed:number, questions:number, cards:number, guides:number,
 *                    skipped:Array<{id:string,reason:string}>, ambiguous:string[]}>}
 */
export async function renameTopics(items = []) {
  const clean = (v) => String(v == null ? '' : v).trim();
  const out = { renamed: 0, questions: 0, cards: 0, guides: 0, skipped: [], ambiguous: [] };

  // Resolve every row up front, so a bad id fails its own rename and not the batch.
  const jobs = [];
  for (const it of Array.isArray(items) ? items : []) {
    const id = clean(it && it.id);
    const to = clean(it && it.topic);
    if (!id || !to) { out.skipped.push({ id: id || '(blank)', reason: 'needs an id and a new name' }); continue; }
    const doc = await db.collection(COL.topics).doc(id).get();
    if (!doc.exists) { out.skipped.push({ id, reason: 'no such sub-lesson' }); continue; }
    const cur = doc.data();
    const from = clean(cur.topic);
    if (!from) { out.skipped.push({ id, reason: 'row has no name to rename' }); continue; }
    if (from === to) { out.skipped.push({ id, reason: 'already named that' }); continue; }
    jobs.push({
      id,
      from,
      to,
      program: programOf(cur),
      track: clean(cur.track),
      course: clean(cur.course),
      lesson: clean(cur.lesson),
      questionIds: Array.isArray(it.questionIds) ? it.questionIds.map(clean).filter(Boolean) : null,
    });
  }
  if (!jobs.length) return out;

  // A rename must not collide onto a sibling: two rows sharing a name inside one
  // lesson would share a question bank and a deck scope from then on. A sibling
  // that is itself being renamed away in THIS batch is not a collision.
  for (const j of jobs) {
    const sibs = await db.collection(COL.topics)
      .where('course', '==', j.course)
      .where('lesson', '==', j.lesson)
      .get();
    const clash = sibs.docs.find((d) => d.id !== j.id
      && !jobs.some((o) => o.id === d.id)
      && programOf(d.data()) === j.program
      && clean(d.data().track) === j.track
      && clean(d.data().topic).toLowerCase() === j.to.toLowerCase());
    if (clash) j.blocked = `"${j.to}" is already a sub-lesson of "${j.lesson}"`;
  }
  for (const j of jobs) if (j.blocked) out.skipped.push({ id: j.id, reason: j.blocked });
  const live = jobs.filter((j) => !j.blocked);
  if (!live.length) return out;

  // How many rows of this program answer to the old name? More than one means the
  // question bank behind it cannot be split by name alone.
  const claimants = new Map();
  for (const j of live) {
    const k = `${j.program}/${j.from}`;
    if (claimants.has(k)) continue;
    const snap = await db.collection(COL.topics).where('topic', '==', j.from).get();
    claimants.set(k, snap.docs.filter((d) => programOf(d.data()) === j.program).length);
  }

  const commitAll = async (writes) => {
    let batch = db.batch();
    let ops = 0;
    for (const w of writes) {
      w(batch);
      if (++ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops) await batch.commit();
  };

  // 1. The catalog rows themselves. Doc ids are untouched, so every learner's
  //    per-topic stats and the prereq graph's edges survive unchanged.
  await commitAll(live.map((j) => (b) => b.set(db.collection(COL.topics).doc(j.id), { topic: j.to }, { merge: true })));
  out.renamed = live.length;

  // 2. The shared question bank.
  for (const j of live) {
    let refs;
    if (j.questionIds && j.questionIds.length) {
      refs = j.questionIds.map((qid) => db.collection(COL.questions).doc(qid));
    } else if ((claimants.get(`${j.program}/${j.from}`) || 0) > 1) {
      out.ambiguous.push(j.from);
      continue;
    } else {
      const snap = await db.collection(COL.questions).where('topic', '==', j.from).get();
      refs = snap.docs.filter((d) => programOf(d.data()) === j.program).map((d) => d.ref);
    }
    await commitAll(refs.map((ref) => (b) => b.set(ref, { topic: j.to }, { merge: true })));
    out.questions += refs.length;
  }

  // 3. Flashcards. These carry track/course/lesson, so they are never ambiguous.
  //    `concept` is the card FRONT and equals the topic name on a book's point
  //    cards; on an ordinary deck it is its own idea, so it moves only when it
  //    actually matched. A TOPIC-level deck's `scopeId` embeds the name too.
  for (const j of live) {
    const snap = await db.collection(COL.flashcards).where('topic', '==', j.from).get();
    const scope = { level: 'topic', track: j.track, course: j.course, lesson: j.lesson };
    const oldScope = flashcardScopeId({ ...scope, topic: j.from });
    const newScope = flashcardScopeId({ ...scope, topic: j.to });
    const mine = snap.docs.filter((d) => {
      const c = d.data();
      return clean(c.track) === j.track && clean(c.course) === j.course && clean(c.lesson) === j.lesson;
    });
    await commitAll(mine.map((d) => (b) => {
      const c = d.data();
      const patch = { topic: j.to };
      if (clean(c.concept) === j.from) patch.concept = j.to;
      if (clean(c.scopeId) === oldScope) patch.scopeId = newScope;
      b.set(d.ref, patch, { merge: true });
    }));
    out.cards += mine.length;
  }

  // 4. Topic-level study guides. The name is in the DOC ID, so this is a move:
  //    copy to the new id, then drop the old one.
  for (const j of live) {
    for (const kind of ['lesson', 'review']) {
      const base = { program: j.program, kind, track: j.track, course: j.course, lesson: j.lesson };
      const snap = await db.collection(COL.studyGuides).doc(studyGuideId({ ...base, topic: j.from })).get();
      if (!snap.exists) continue;
      await db.collection(COL.studyGuides).doc(studyGuideId({ ...base, topic: j.to }))
        .set({ ...snap.data(), topic: j.to }, { merge: true });
      await snap.ref.delete();
      out.guides += 1;
    }
  }

  return out;
}

/**
 * RE-FILE a whole COURSE or LESSON — rename it, or move it to another
 * track/course — and re-key everything filed against the OLD scope names.
 *
 * `renameTopics` is the same job one grain down; this is the reason both exist.
 * `moveTopics` writes the topic rows and nothing else, which is correct for a
 * drag-and-drop of individual sub-lessons but WRONG for a whole scope, because
 * three other collections are addressed by the scope's NAMES:
 *
 *   `transcripts`         filed at LESSON grain (`getScopeTranscripts` matches
 *                         course + lesson) — the source a lesson is grounded on
 *   `flashcards`          `.track/.course/.lesson` plus `scopeId`, which encodes
 *                         them, on BOTH the lesson deck and every topic deck under it
 *   `studyGuides`         the DOC ID encodes them, again for the lesson guide and
 *                         every topic guide under it
 *
 * Renaming a lesson through `moveTopics` therefore leaves its transcript behind:
 * the lesson keeps its questions and its progress but silently loses its SOURCE,
 * so the next study guide is rebuilt from the quiz questions instead of the book
 * and strict-transcript generation has nothing to ground on. That is where
 * AGENTS.md §7's "18 transcript scope-keys match no topic scope at all" came
 * from — every one of them is an old rename.
 *
 * `from` is `{ program, track, course, lesson? }` — omit `lesson` to re-file a
 * whole course. `to` is a partial `{ track?, course?, lesson? }`; only the keys
 * present are changed. Topic doc ids are never touched, so per-user stats, the
 * question bank and the prereq graph are unaffected.
 *
 * @returns {Promise<{topics:number, transcripts:number, cards:number, guides:number}>}
 */
export async function renameScope(from = {}, to = {}) {
  const clean = (v) => String(v == null ? '' : v).trim();
  const program = clean(from.program);
  const track = clean(from.track);
  const course = clean(from.course);
  const lesson = clean(from.lesson);
  if (!program || !track || !course) throw new Error('renameScope needs program, track and course');

  const next = {
    track: to.track != null && clean(to.track) ? clean(to.track) : track,
    course: to.course != null && clean(to.course) ? clean(to.course) : course,
    lesson: to.lesson != null && clean(to.lesson) ? clean(to.lesson) : lesson,
  };
  if (!lesson && to.lesson != null) throw new Error('renameScope cannot set a lesson on a whole-course re-file');
  if (next.track === track && next.course === course && next.lesson === lesson) {
    return { topics: 0, transcripts: 0, cards: 0, guides: 0 };
  }

  const out = { topics: 0, transcripts: 0, cards: 0, guides: 0 };
  const mine = (d) => clean(d.track) === track && clean(d.course) === course && (!lesson || clean(d.lesson) === lesson);
  const patch = { track: next.track, course: next.course, ...(lesson ? { lesson: next.lesson } : {}) };

  const commitAll = async (docs, make) => {
    let batch = db.batch();
    let ops = 0;
    for (const d of docs) {
      make(batch, d);
      if (++ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops) await batch.commit();
    return docs.length;
  };

  // 1. The catalog rows. Ids are KEPT (see renameTopics) so nothing keyed by id moves.
  {
    let q = db.collection(COL.topics).where('course', '==', course);
    if (lesson) q = q.where('lesson', '==', lesson);
    const rows = (await q.get()).docs.filter((d) => programOf(d.data()) === program && mine(d.data()));
    out.topics = await commitAll(rows, (b, d) => b.set(d.ref, patch, { merge: true }));
  }

  // 2. The SOURCE. Filed at lesson grain, and the thing `moveTopics` was losing.
  {
    let q = db.collection(COL.transcripts).where('course', '==', course);
    if (lesson) q = q.where('lesson', '==', lesson);
    const rows = (await q.get()).docs.filter((d) => programOf(d.data()) === program && mine(d.data()));
    out.transcripts = await commitAll(rows, (b, d) => b.set(d.ref, patch, { merge: true }));
  }

  // 3. Decks — the lesson's own and every topic deck under it. `scopeId` encodes
  //    the names, so it is recomputed per card from that card's own level+topic.
  {
    let q = db.collection(COL.flashcards).where('course', '==', course);
    if (lesson) q = q.where('lesson', '==', lesson);
    const rows = (await q.get()).docs.filter((d) => mine(d.data()));
    out.cards = await commitAll(rows, (b, d) => {
      const c = d.data();
      // 🔴 A deck's scopeId carries the DECK's topic, which is '' for a course- or
      // lesson-level deck and the topic ONLY for a topic-level one (saveFlashcards
      // hands `flashcardScopeId` the deck scope, not the card). Reconstructing it
      // from `c.topic` therefore never matched a book deck's stored id, so the
      // rename left every point card pointing at the old scope and getFlashcards
      // — which queries on scopeId — could no longer find the deck at all.
      const deckTopic = c.level === 'topic' ? (c.topic || '') : '';
      const at = (sc) => flashcardScopeId({
        level: c.level || 'course', track: sc.track, course: sc.course, lesson: sc.lesson, topic: deckTopic,
      });
      const p = { ...patch };
      if (clean(c.scopeId) === at({ track, course, lesson: clean(c.lesson) })) {
        p.scopeId = at({ track: next.track, course: next.course, lesson: lesson ? next.lesson : clean(c.lesson) });
      }
      b.set(d.ref, p, { merge: true });
    });
  }

  // 4. Study guides. The names are in the DOC ID, so each is a copy-then-delete.
  {
    let q = db.collection(COL.studyGuides).where('course', '==', course);
    if (lesson) q = q.where('lesson', '==', lesson);
    const rows = (await q.get()).docs.filter((d) => clean(d.data().program) === program && mine(d.data()));
    for (const d of rows) {
      const g = d.data();
      const to_ = {
        ...g,
        track: next.track,
        course: next.course,
        lesson: lesson ? next.lesson : clean(g.lesson),
      };
      const id = studyGuideId({ program, kind: g.kind || 'lesson', track: to_.track, course: to_.course, lesson: to_.lesson, topic: g.topic || '' });
      if (id === d.id) continue;
      await db.collection(COL.studyGuides).doc(id).set(to_, { merge: true });
      await d.ref.delete();
      out.guides += 1;
    }
  }

  return out;
}

/** The catalog shaped as BigQuery rows (mastery snapshot) for `userKey`. */
export async function getTopicsRows(userKey = null, now = new Date(), scope = null) {
  const cat = await getCatalog(userKey, scope);
  const syncedAt = now.toISOString();
  return cat.map((t) => {
    const correctCount = t.correctCount || 0;
    const totalAttempts = t.totalAttempts || 0;
    const lastAttempted = t.lastAttempted?.toDate ? t.lastAttempted.toDate() : null;
    const d = deriveStats({ correctCount, totalAttempts, lastAttempted }, now);
    return {
      track: t.track || '',
      course: t.course || '',
      lesson: t.lesson || '',
      topic: t.topic || '',
      questionCount: t.questionCount || 0,
      totalAttempts,
      correctCount,
      accuracy: totalAttempts ? d.accuracy : null,
      daysSince: totalAttempts ? d.daysSince : null,
      priority: d.priority,
      lastAttempted: lastAttempted ? lastAttempted.toISOString() : null,
      syncedAt,
    };
  });
}

/* --------------------------------- Questions ------------------------------- */
/* (Shared across all users — the question bank is common.) */

/**
 * All questions for a set of topic names. Firestore `in` caps at 30 values.
 *
 * Pass `scope` to keep one program's bank out of another's: questions are keyed
 * by topic NAME alone, so a name two programs share (e.g. "Attribution") would
 * otherwise mix marketing questions into a data-science quiz. The program filter
 * runs in memory rather than as a second `where`, which keeps this a single-field
 * query and needs no composite index.
 */
export async function getQuestionsForTopics(topicNames, scope = null) {
  const out = [];
  for (let i = 0; i < topicNames.length; i += 30) {
    const chunk = topicNames.slice(i, i + 30);
    if (!chunk.length) continue;
    const snap = await db.collection(COL.questions).where('topic', 'in', chunk).get();
    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  }
  return scope ? filterQuestions(out, scope) : out;
}

/**
 * The topic NAMES of ONE lesson.
 *
 * Question generation runs per topic but grounds on a LESSON's transcript, so a
 * batch has to know its siblings: what they are (to stay out of their territory)
 * and what they already asked (to not ask it again). Equality-only filters, so
 * Firestore serves this from the single-field indexes with no composite index —
 * the same posture as getScopeTranscripts, and the reason this is a targeted
 * query rather than a getCatalog read: it runs once per generation step.
 *
 * `program` is applied in memory via programOf, not as a where clause, so topics
 * written before the program backfill are not silently excluded.
 */
export async function getLessonTopicNames({ program, track, course, lesson } = {}) {
  if (!course || !lesson) return [];
  let q = db.collection(COL.topics).where('course', '==', course).where('lesson', '==', lesson);
  if (track) q = q.where('track', '==', track);
  const snap = await q.get();
  return [...new Set(
    snap.docs
      .map((d) => d.data())
      .filter((t) => !program || programOf(t) === program)
      .map((t) => String(t.topic || '').trim())
      .filter(Boolean),
  )];
}

/** Every question doc (for the one-time LaTeX migration); `scope` narrows to one program. */
export async function getAllQuestions(scope = null) {
  const snap = await db.collection(COL.questions).get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return scope ? filterQuestions(all, scope) : all;
}

/** One question doc by id (for the per-question "fix format" action). */
export async function getQuestionById(id) {
  const doc = await db.collection(COL.questions).doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/** Apply {id, question, options, answer} updates in chunked batches. */
export async function bulkUpdateQuestions(updates) {
  let batch = db.batch();
  let ops = 0;
  let n = 0;
  for (const u of updates) {
    batch.update(db.collection(COL.questions).doc(u.id), {
      question: u.question,
      options: u.options,
      answer: u.answer,
    });
    n += 1;
    if (++ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return n;
}

/** Apply {id, concept?, intuition?, formula?, highway?} updates to shared
 *  flashcards in chunked batches (used by the "fix formatting" reformatter and
 *  the admin Highway toggle). Only the fields present on each update are
 *  written, so a partial patch never blanks the rest.
 *  Returns the number of docs updated. */
export async function bulkUpdateFlashcards(updates) {
  let batch = db.batch();
  let ops = 0;
  let n = 0;
  for (const u of updates) {
    const patch = {};
    if (typeof u.concept === 'string') patch.concept = u.concept;
    if (typeof u.intuition === 'string') patch.intuition = u.intuition;
    if (typeof u.formula === 'string') patch.formula = u.formula;
    if (typeof u.highway === 'boolean') patch.highway = u.highway;
    if (!u.id || !Object.keys(patch).length) continue;
    batch.update(db.collection(COL.flashcards).doc(u.id), patch);
    n += 1;
    if (++ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return n;
}

// Returns the new doc id so callers can hand the banked question back to the
// client already carrying its id (needed by the admin "Fix format" button).
//
// `program` tags which curriculum the question belongs to — callers should pass
// the scope they generated under, since a topic name alone can't say (see
// getQuestionsForTopics). `batchTag` marks a bulk generation run so one bad batch
// can be deleted wholesale, and `difficulty` (core|balanced|challenge) feeds the
// difficulty selector. The last two are dropped when undefined
// (ignoreUndefinedProperties), so existing callers are unaffected.
export async function addQuestion({
  topic, question, options, answer, source, program, batchTag, difficulty,
}) {
  const ref = await db.collection(COL.questions).add({
    topic,
    question,
    options,
    answer,
    program: program || DEFAULT_PROGRAM,
    batchTag,
    difficulty,
    createdAt: FieldValue.serverTimestamp(),
    generated: true,
    source,
  });
  return ref.id;
}

/** Set of question texts THIS user has already answered (mastery mode). */
export async function getSeenQuestionTexts(userKey = null) {
  if (!userKey) return new Set();
  const snap = await logCol(userKey).select('question').get();
  const seen = new Set();
  snap.forEach((d) => {
    const t = d.get('question');
    if (t) seen.add(String(t).trim());
  });
  return seen;
}

/**
 * This user's attempts on ONE topic (for the per-flashcard stats). Dedupes by
 * question text keeping the LATEST result, so "attempted questions" reflects
 * where the learner currently stands. Returns counts + the per-question list.
 */
export async function getTopicAttempts(userKey = null, topic = '') {
  const empty = { attempts: 0, correct: 0, accuracy: null, questions: [] };
  if (!userKey || !topic) return empty;
  const snap = await logCol(userKey).where('topic', '==', topic).get();
  const byQuestion = new Map(); // question -> { question, result, date }
  snap.forEach((d) => {
    const x = d.data();
    const q = String(x.question || '').trim();
    if (!q) return;
    const date = x.date?.toDate ? x.date.toDate() : null;
    const prev = byQuestion.get(q);
    if (!prev || (date && prev.date && date > prev.date) || (date && !prev.date)) {
      byQuestion.set(q, { question: q, result: x.result === 1 ? 1 : 0, date });
    }
  });
  const questions = [...byQuestion.values()].sort((a, b) => (b.date || 0) - (a.date || 0));
  const attempts = questions.length;
  const correct = questions.reduce((s, q) => s + q.result, 0);
  return {
    attempts,
    correct,
    accuracy: attempts ? Math.round((correct / attempts) * 100) : null,
    questions: questions.map((q) => ({ question: q.question, result: q.result, date: q.date ? q.date.toISOString() : null })),
  };
}

/**
 * Recent attempt history bucketed by UTC day for `userKey`, for the progress chart.
 * Reads only the last `days` of the user's quizLog (single-field `date` index is auto-created).
 */
export async function getRecentActivity(userKey = null, days = 14) {
  const out = [];
  const buckets = new Map(); // 'YYYY-MM-DD' -> { total, correct }
  if (userKey) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const snap = await logCol(userKey)
      .where('date', '>=', Timestamp.fromDate(cutoff))
      .select('date', 'result')
      .get();
    snap.forEach((d) => {
      const ts = d.get('date');
      if (!ts?.toDate) return;
      const day = ts.toDate().toISOString().slice(0, 10);
      const b = buckets.get(day) || { total: 0, correct: 0 };
      b.total += 1;
      b.correct += d.get('result') === 1 ? 1 : 0;
      buckets.set(day, b);
    });
  }
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push({ day, ...(buckets.get(day) || { total: 0, correct: 0 }) });
  }
  return out;
}

/**
 * `userKey`'s attempt WINDOW: per-topic deltas over the last `days`, plus a summary of the
 * activity itself. One indexed quizLog read (single-field `date`), same cost as getRecentActivity.
 *
 * The deltas are what make VELOCITY real. Subtract them from the live topicStats and you have that
 * person's mastery as it stood when the window opened, so (now - then) is genuinely
 * points-gained-per-week rather than "how much have they done since the beginning of time".
 * Sentinel's team-progress panel ranks on exactly that.
 *
 * Keyed by each topic's REAL catalog doc id via buildTopicIdIndex, never by slug(fields): a quizLog
 * row stores track/course/lesson/topic AS THEY WERE WHEN IT WAS LOGGED, while a topic keeps its doc
 * id across re-filing and renames (see logResults). A row whose tuple no longer matches the catalog
 * (a topic re-filed inside the window, or since deleted) is counted in `unmatched` instead of being
 * guessed at — that person's velocity then reads slightly LOW and says so, rather than wrong.
 */
export async function getRecentAttemptStats(userKey = null, days = 30, catalogRows = []) {
  const empty = {
    days, deltas: new Map(), attempts: 0, correct: 0,
    activeDays: 0, streak: 0, lastActive: null, unmatched: 0,
  };
  if (!userKey || !(days > 0)) return empty;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const snap = await logCol(userKey)
    .where('date', '>=', Timestamp.fromDate(cutoff))
    .select('date', 'track', 'course', 'lesson', 'topic', 'result')
    .get();
  const index = buildTopicIdIndex(catalogRows);
  const deltas = new Map(); // topicDocId -> { attempts, correct } inside the window
  const dayKeys = new Set();
  let attempts = 0;
  let correct = 0;
  let unmatched = 0;
  let lastActive = null;
  snap.forEach((d) => {
    const ok = d.get('result') === 1 ? 1 : 0;
    attempts += 1;
    correct += ok;
    const ts = d.get('date');
    const when = ts?.toDate ? ts.toDate() : null;
    if (when) {
      dayKeys.add(when.toISOString().slice(0, 10));
      if (!lastActive || when > lastActive) lastActive = when;
    }
    const hit = index.get(tupleKey(d.get('track'), d.get('course'), d.get('lesson'), d.get('topic')));
    if (!hit) {
      unmatched += 1;
      return;
    }
    const cur = deltas.get(hit.id) || { attempts: 0, correct: 0 };
    cur.attempts += 1;
    cur.correct += ok;
    deltas.set(hit.id, cur);
  });
  return {
    days, deltas, attempts, correct,
    activeDays: dayKeys.size,
    streak: streakFromDays(dayKeys),
    lastActive: lastActive ? lastActive.toISOString() : null,
    unmatched,
  };
}

/**
 * `userKey`'s ATTEMPT-BY-ATTEMPT history over the last `days` — the per-question detail that
 * getRecentAttemptStats deliberately aggregates away.
 *
 * That function answers "how far did they move?" (per-topic deltas, which is what velocity needs).
 * This one answers "what did they actually get right and wrong?", which is what a coaching report
 * needs: the missed questions ARE the material, and a count of them is not.
 *
 * Same single indexed quizLog read and the same topic attribution as getRecentAttemptStats —
 * resolved through buildTopicIdIndex, never slug(fields) (see the note on that function), with a
 * row whose tuple no longer matches the catalog counted in `unmatched` rather than guessed at.
 *
 * 🔴 A quizLog row records the question TEXT and WHETHER it was right — never which option was
 * chosen, nor what the correct one was (see logResults). A caller may therefore say "you missed
 * this question" and must NOT claim what you answered; there is nothing on the row to derive it
 * from, and filling the gap would be inventing the learner's own history back at them.
 *
 * `wrongOnly` returns just the misses in `rows` (the aggregates always cover everything) — that is
 * the shape a daily report wants, and it keeps a heavy study day from shipping thousands of rows
 * nobody reads. `limit` caps `rows` newest-first and `truncated` says whether anything was dropped,
 * because a silently short list is indistinguishable from a complete one.
 */
export async function getQuizActivity(userKey = null, days = 1, catalogRows = [], opts = {}) {
  const { wrongOnly = false, limit = 400 } = opts;
  const empty = {
    days, attempts: 0, correct: 0, wrong: 0,
    byDay: [], rows: [], unmatched: 0, truncated: false, wrongOnly: !!wrongOnly,
  };
  if (!userKey || !(days > 0)) return empty;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const snap = await logCol(userKey)
    .where('date', '>=', Timestamp.fromDate(cutoff))
    .select('date', 'track', 'course', 'lesson', 'topic', 'question', 'result', 'reviewFlag')
    .get();
  const index = buildTopicIdIndex(catalogRows);
  const buckets = new Map(); // 'YYYY-MM-DD' -> { total, correct }
  const kept = [];
  let attempts = 0;
  let correct = 0;
  let unmatched = 0;
  snap.forEach((d) => {
    const ok = d.get('result') === 1 ? 1 : 0;
    attempts += 1;
    correct += ok;
    const ts = d.get('date');
    const when = ts?.toDate ? ts.toDate() : null;
    if (when) {
      const day = when.toISOString().slice(0, 10);
      const b = buckets.get(day) || { total: 0, correct: 0 };
      b.total += 1;
      b.correct += ok;
      buckets.set(day, b);
    }
    const track = d.get('track') || '';
    const course = d.get('course') || '';
    const lesson = d.get('lesson') || '';
    const topic = d.get('topic') || '';
    const hit = index.get(tupleKey(track, course, lesson, topic));
    if (!hit) unmatched += 1;
    // The aggregates above counted this attempt either way; only the ROW list is filtered.
    if (wrongOnly && ok) return;
    kept.push({
      topicId: hit ? hit.id : null,
      track,
      course,
      lesson,
      topic,
      question: d.get('question') || '',
      result: ok,
      reviewFlag: d.get('reviewFlag') === 1 ? 1 : 0,
      date: when ? when.toISOString() : null,
    });
  });
  kept.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const rows = limit > 0 ? kept.slice(0, limit) : kept;
  return {
    days,
    attempts,
    correct,
    wrong: attempts - correct,
    byDay: [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, b]) => ({ day, ...b })),
    rows,
    unmatched,
    truncated: rows.length < kept.length,
    wrongOnly: !!wrongOnly,
  };
}

/**
 * Consecutive-day streak ending today (or yesterday) within an ALREADY-collected day set.
 * getStreak() answers the same question by reading the user's whole quizLog — fine for the one
 * signed-in learner, far too expensive once a rollup asks it of every person on the team. This
 * derives it from the window that was read anyway, so it saturates at `days` and never exceeds it.
 */
function streakFromDays(dayKeys) {
  if (!dayKeys.size) return 0;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const keyOf = (dt) => dt.toISOString().slice(0, 10);
  let cursor = new Date();
  if (!dayKeys.has(keyOf(cursor))) {
    cursor = new Date(cursor.getTime() - DAY_MS);
    if (!dayKeys.has(keyOf(cursor))) return 0;
  }
  let streak = 0;
  while (dayKeys.has(keyOf(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/** Full quizLog history for `userKey`, shaped as BigQuery rows (for the one-time backfill). */
export async function getQuizLogRows(userKey = null) {
  if (!userKey) return [];
  const snap = await logCol(userKey).get();
  return snap.docs.map((d) => {
    const x = d.data();
    const date = x.date?.toDate ? x.date.toDate() : null;
    return {
      date: (date || new Date(0)).toISOString(),
      track: x.track || '',
      course: x.course || '',
      lesson: x.lesson || '',
      topic: x.topic || '',
      question: x.question || '',
      result: x.result === 1 ? 1 : 0,
      reviewFlag: x.reviewFlag === 1 ? 1 : 0,
    };
  });
}

/** Current activity streak (consecutive UTC days with a logged attempt) for `userKey`. */
export async function getStreak(userKey = null, now = new Date()) {
  if (!userKey) return 0;
  const snap = await logCol(userKey).select('date').get();
  const days = new Set();
  snap.forEach((d) => {
    const ts = d.get('date');
    if (ts?.toDate) days.add(ts.toDate().toISOString().slice(0, 10));
  });
  if (!days.size) return 0;

  const DAY_MS = 24 * 60 * 60 * 1000;
  let cursor = new Date(now.getTime());
  const keyOf = (dt) => dt.toISOString().slice(0, 10);

  if (!days.has(keyOf(cursor))) {
    cursor = new Date(cursor.getTime() - DAY_MS);
    if (!days.has(keyOf(cursor))) return 0;
  }
  let streak = 0;
  while (days.has(keyOf(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/**
 * Wipe `userKey`'s progress. Legacy owner: zero every `topics` doc's embedded stats + delete
 * `quizLog` (as before). Others: delete their `topicStats` + `quizLog` subcollection docs.
 */
export async function resetProgress(userKey = null, now = new Date()) {
  if (!userKey) return { topicsReset: 0, logDeleted: 0 };

  let topicsReset = 0;
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  if (isLegacy(userKey)) {
    const freshPriority = computePriority(
      { correctCount: 0, totalAttempts: 0, lastAttempted: null },
      now,
    );
    const topicsSnap = await db.collection(COL.topics).get();
    for (const doc of topicsSnap.docs) {
      batch.set(
        doc.ref,
        { correctCount: 0, totalAttempts: 0, lastAttempted: FieldValue.delete(), priority: freshPriority },
        { merge: true },
      );
      topicsReset += 1;
      if (++ops >= 450) await flush();
    }
    await flush();
  } else {
    const statsSnap = await statsCol(userKey).get();
    for (const doc of statsSnap.docs) {
      batch.delete(doc.ref);
      topicsReset += 1;
      if (++ops >= 450) await flush();
    }
    await flush();
  }

  // Delete the user's attempt log.
  const logSnap = await logCol(userKey).get();
  let logDeleted = 0;
  for (const doc of logSnap.docs) {
    batch.delete(doc.ref);
    logDeleted += 1;
    if (++ops >= 450) await flush();
  }
  await flush();

  return { topicsReset, logDeleted };
}

/* --------------------------- Track merge migration ------------------------- */
/*
 * One-time, idempotent merge of the two math tracks into a single "Mathematics"
 * track: rename `Math Foundations` -> `Mathematics` and move every
 * `Mathematics for Machine Learning` course under `Mathematics` (course names
 * unchanged). Questions are keyed only by `topic`, so they need no change — only
 * the docs that embed the track name:
 *   - `topics` (legacy owner's catalog + embedded stats; id = slug(track,course,lesson,topic))
 *   - each user's `users/{u}/topicStats` (lean stats, id = same slug)
 *   - `flashcards` (carry track + a derived scopeId)
 * Historical `quizLog` rows keep their old denormalized track (harmless — charts
 * read the live catalog). Old scope-chat threads are left as harmless orphans.
 */
const MATH_OLD_TRACKS = new Set(['Math Foundations', 'Mathematics for Machine Learning']);
const MATH_NEW_TRACK = 'Mathematics';

/** Merge two docs' stats when a rename collides onto an existing target id. */
function mergeStats(a = {}, b = {}, now = new Date()) {
  const correctCount = (a.correctCount || 0) + (b.correctCount || 0);
  const totalAttempts = (a.totalAttempts || 0) + (b.totalAttempts || 0);
  const la = a.lastAttempted?.toDate ? a.lastAttempted.toDate() : a.lastAttempted || null;
  const lb = b.lastAttempted?.toDate ? b.lastAttempted.toDate() : b.lastAttempted || null;
  const last = la && lb ? (la > lb ? la : lb) : la || lb;
  const stats = { correctCount, totalAttempts, lastAttempted: last };
  return {
    correctCount,
    totalAttempts,
    lastAttempted: last ? Timestamp.fromDate(new Date(last)) : FieldValue.delete(),
    priority: computePriority(stats, now),
  };
}

export async function mergeIntoMathematics(now = new Date()) {
  const report = { topicsMoved: 0, statsMoved: 0, decksMoved: 0, usersScanned: 0 };

  // 1. Read the shared `topics` catalog and build the old-id -> new-id map (also
  //    the vehicle that re-keys the legacy owner's embedded stats).
  const topicsSnap = await db.collection(COL.topics).get();
  const idMap = new Map(); // oldId -> newId (only for docs that actually move)
  const moves = []; // { oldId, newId, data }
  for (const d of topicsSnap.docs) {
    const data = d.data();
    if (!MATH_OLD_TRACKS.has(data.track)) continue;
    const newId = slug(MATH_NEW_TRACK, data.course || '', data.lesson || '', data.topic || '');
    idMap.set(d.id, newId);
    if (newId !== d.id) moves.push({ oldId: d.id, newId, data });
  }

  // 2. Move the `topics` docs (merge stats on collision), then delete the olds.
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  const col = db.collection(COL.topics);
  for (const m of moves) {
    const targetRef = col.doc(m.newId);
    const target = await targetRef.get();
    const base = { ...m.data, track: MATH_NEW_TRACK };
    if (target.exists) {
      batch.set(targetRef, { ...base, ...mergeStats(target.data(), m.data, now) }, { merge: true });
    } else {
      batch.set(targetRef, base, { merge: true });
    }
    batch.delete(col.doc(m.oldId));
    report.topicsMoved += 1;
    if ((ops += 2) >= 440) await flush();
  }
  await flush();

  // 3. Re-key each non-legacy user's topicStats using the same old->new id map.
  const userRefs = await db.collection('users').listDocuments();
  for (const uref of userRefs) {
    report.usersScanned += 1;
    const statsSnap = await uref.collection('topicStats').get();
    for (const s of statsSnap.docs) {
      const newId = idMap.get(s.id);
      if (!newId || newId === s.id) continue;
      const targetRef = uref.collection('topicStats').doc(newId);
      const target = await targetRef.get();
      const data = s.data();
      if (target.exists) {
        batch.set(targetRef, { ...target.data(), ...mergeStats(target.data(), data, now) }, { merge: true });
      } else {
        batch.set(targetRef, { ...data, ...mergeStats({}, data, now) }, { merge: true });
      }
      batch.delete(s.ref);
      report.statsMoved += 1;
      if ((ops += 2) >= 440) await flush();
    }
  }
  await flush();

  // 4. Re-track flashcard decks (update track + recompute scopeId).
  const fcSnap = await db.collection(COL.flashcards).get();
  for (const d of fcSnap.docs) {
    const data = d.data();
    if (!MATH_OLD_TRACKS.has(data.track)) continue;
    const scopeId = flashcardScopeId({
      level: data.level, track: MATH_NEW_TRACK, course: data.course, lesson: data.lesson, topic: data.topic,
    });
    batch.update(d.ref, { track: MATH_NEW_TRACK, scopeId });
    report.decksMoved += 1;
    if (++ops >= 440) await flush();
  }
  await flush();

  return report;
}

/* -------------------------------- Curriculum -------------------------------- */
/*
 * Admin-authored catalog rows. The catalog used to arrive only by CSV import
 * (lib/migrate.js); the Academy needs it editable in place, because Ian writes
 * the digital-marketing curriculum by hand. Same doc shape and the same
 * slug(track,course,lesson,topic) id as the imported rows, so everything
 * downstream (stats, questions, the graph) treats them identically.
 */

/** Upsert one catalog row; returns its id. Idempotent on the slug. */
export async function upsertTopic({ program, track, course, lesson, topic }) {
  const clean = (v) => String(v || '').trim();
  const [tr, co, le, to] = [clean(track), clean(course), clean(lesson), clean(topic)];
  if (!tr || !co || !le || !to) throw new Error('track, course, lesson and topic are all required');
  const id = slug(tr, co, le, to);
  const ref = db.collection(COL.topics).doc(id);
  const existing = await ref.get();
  await ref.set(
    {
      track: tr, course: co, lesson: le, topic: to,
      program: program || DEFAULT_PROGRAM,
      // Never reset a live count/stats on re-run — merge only what identifies the row.
      ...(existing.exists ? {} : { questionCount: 0, createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  return id;
}

/** Delete a catalog row (does NOT touch questions — they're keyed by topic name). */
export async function deleteTopic(id) {
  if (!id) return false;
  await db.collection(COL.topics).doc(id).delete();
  return true;
}

/** Bulk-upsert catalog rows in batches. Returns {created, updated}. */
export async function upsertTopics(rows) {
  const report = { created: 0, updated: 0 };
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const r of rows) {
    const clean = (v) => String(v || '').trim();
    const [tr, co, le, to] = [clean(r.track), clean(r.course), clean(r.lesson), clean(r.topic)];
    if (!tr || !co || !le || !to) continue;
    const ref = db.collection(COL.topics).doc(slug(tr, co, le, to));
    const existing = await ref.get();
    batch.set(
      ref,
      {
        track: tr, course: co, lesson: le, topic: to,
        program: r.program || DEFAULT_PROGRAM,
        ...(existing.exists ? {} : { questionCount: 0, createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
    report[existing.exists ? 'updated' : 'created'] += 1;
    if (++ops >= 450) await flush();
  }
  await flush();
  return report;
}

/** Bump a topic's questionCount by `n` (keeps the catalog's counter honest). */
export async function bumpQuestionCount(topicId, n) {
  if (!topicId || !n) return;
  await db.collection(COL.topics).doc(topicId).set(
    { questionCount: FieldValue.increment(n) }, { merge: true },
  );
}

/* -------------------------------- Transcripts ------------------------------- */
/*
 * Source material for generation: a pasted/uploaded document, or a video
 * transcript imported from Atrium's Watcher. Stored whole (Firestore's 1 MiB doc
 * cap is far above a typical transcript; the caller trims). Attached to a scope
 * — usually a lesson — and read back by the generation job.
 */

export async function addTranscript({ program, track, course, lesson, topic, title, text, source, watcherRef, copyOf, folder, splitFrom }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Transcript text is empty');
  const ref = await db.collection(COL.transcripts).add({
    program: program || DEFAULT_PROGRAM,
    // Scope is OPTIONAL. A transcript with no track/course/lesson is UNFILED —
    // raw material sitting in the library, inert until something files it.
    // `getScopeTranscripts` filters by equality on a real course/lesson, so an
    // unfiled source can never leak into a lesson's grounding by accident.
    track: track || '', course: course || '', lesson: lesson || '', topic: topic || '',
    title: title || 'Untitled', text: body, source: source || 'paste',
    // Library FOLDER — organisation only, and independent of `course`/`lesson`.
    // Filing decides what a lesson GROUNDS on; a folder decides where you find a
    // source in the library. A source keeps its folder after it is filed.
    folder: String(folder || '').trim(),
    watcherRef: watcherRef || null,
    // Set when this doc is a per-lesson copy of another source (one source that
    // grounds several lessons — see /api/admin/sources/commit). Traceable, so the
    // duplicates can be found and swept if the plan is ever revised.
    copyOf: copyOf || null,
    // Set on the parts produced by splitting an oversized source, so a split is
    // traceable back to the file it came from (and undoable by hand).
    splitFrom: splitFrom || null,
    chars: body.length,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Transcripts in a scope. Filtered in memory so no composite index is needed. */
export async function getTranscripts({ program, course, lesson, topic } = {}) {
  const snap = await db.collection(COL.transcripts).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => (!program || (t.program || DEFAULT_PROGRAM) === program)
      && (!course || t.course === course)
      && (!lesson || t.lesson === lesson)
      && (!topic || t.topic === topic));
}

/**
 * The authoritative source text for ONE scope, for grounding its study guide.
 *
 * Separate from `getTranscripts` on purpose: that one reads the WHOLE collection
 * and filters in memory (fine for the admin list), which is ~240 documents each
 * carrying a full lesson — several MB on a path a learner is waiting on, and
 * once per target in the bulk pre-build. This filters server-side.
 *
 * Equality-only filters, so Firestore serves it from the single-field indexes
 * and no composite index is needed. Callers still treat a throw as "no source"
 * — a guide grounded on nothing is worse than one grounded on a document, but
 * it is a great deal better than no guide at all.
 */
export async function getScopeTranscripts({ program, course, lesson } = {}) {
  let q = db.collection(COL.transcripts);
  if (program) q = q.where('program', '==', program);
  if (course) q = q.where('course', '==', course);
  if (lesson) q = q.where('lesson', '==', lesson);
  const snap = await q.get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => String(t.text || '').trim())
    // Hand-authored docs first: they were written to BE the lesson, where a
    // pasted transcript is raw material that happens to mention it.
    .sort((a, b) => (a.source === 'claude-authored' ? -1 : 0) - (b.source === 'claude-authored' ? -1 : 0));
}

/** One transcript with its full text. */
export async function getTranscriptById(id) {
  const doc = await db.collection(COL.transcripts).doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

export async function deleteTranscript(id) {
  if (!id) return false;
  await db.collection(COL.transcripts).doc(id).delete();
  return true;
}

/** Merge-update a transcript's editable fields; recompute chars when the text changes.
 *  Only fields explicitly passed are touched (undefined = leave as-is). */
export async function updateTranscript(id, { title, text, track, course, lesson, folder, splitInto } = {}) {
  if (!id) throw new Error('transcript id required');
  const patch = { updatedAt: FieldValue.serverTimestamp() };
  if (title !== undefined) patch.title = String(title || '').trim() || 'Untitled';
  if (track !== undefined) patch.track = String(track || '').trim();
  if (course !== undefined) patch.course = String(course || '').trim();
  if (lesson !== undefined) patch.lesson = String(lesson || '').trim();
  if (folder !== undefined) patch.folder = String(folder || '').trim();
  if (splitInto !== undefined) patch.splitInto = Number(splitInto) || 0;
  if (text !== undefined) {
    const body = String(text || '').trim();
    if (!body) throw new Error('Transcript text is empty');
    patch.text = body;
    patch.chars = body.length;
  }
  await db.collection(COL.transcripts).doc(id).set(patch, { merge: true });
  return true;
}

/**
 * Cache a source's AI digest (abstract + concepts) on the transcript doc.
 *
 * The corpus planner (`planFromSources`) designs from these, never from full
 * text — a 40-source corpus is far past any prompt. Caching here makes digesting
 * a once-ever cost per source: re-planning is free, and the Library list can show
 * what is in a source without opening it. `digestedAt` is what marks a source as
 * catalogued; a re-digest after an edit simply overwrites.
 */
export async function setTranscriptDigest(id, { abstract, concepts } = {}) {
  if (!id) throw new Error('transcript id required');
  await db.collection(COL.transcripts).doc(id).set({
    abstract: String(abstract || '').trim(),
    concepts: (Array.isArray(concepts) ? concepts : []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 12),
    digestedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return true;
}

/* ----------------------------- Generation jobs ------------------------------ */
/*
 * A long bulk generation (~1000 questions/course) can't run as one request:
 * Cloud Run throttles CPU between requests, so a fire-and-forget loop dies
 * silently. The job doc IS the state, and the admin UI drives it forward one
 * step at a time (see /api/admin/genjobs/:id/step) — which also survives a
 * restart and needs no infra change.
 */

export async function createGenJob({ program, scope, targetPerTopic, provider, model, thinking, topics, batchTag, instructions, transcriptIds, grounding }) {
  const ref = await db.collection(COL.genJobs).doc();
  const job = {
    program: program || DEFAULT_PROGRAM,
    scope: scope || {},
    targetPerTopic: targetPerTopic || 5,
    provider: provider || 'deepseek',
    model: model || null,
    // Extended thinking for this run's generation. Absent (older jobs) => the
    // provider default (on), matching how it behaved before the toggle existed.
    thinking: thinking === false ? false : true,
    // 'topic' = anchor on the topic, material is a supporting reference (goal-planned
    // modules). Anything else / absent = strict transcript grounding (the default).
    grounding: grounding === 'topic' ? 'topic' : null,
    instructions: String(instructions || '').slice(0, 2000),
    // Optional: exact transcripts to ground on (else the lesson's attached ones).
    transcriptIds: Array.isArray(transcriptIds) ? transcriptIds.filter(Boolean).slice(0, 20) : [],
    batchTag: batchTag || `gen-${ref.id}`,
    status: 'queued',
    queue: topics || [],           // topic names still to do
    progress: { topicsDone: 0, topicsTotal: (topics || []).length, questionsWritten: 0, costUsd: 0 },
    errors: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(job);
  return { id: ref.id, ...job };
}

export async function getGenJob(id) {
  const doc = await db.collection(COL.genJobs).doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

export async function listGenJobs(program = null) {
  const snap = await db.collection(COL.genJobs).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((j) => !program || j.program === program)
    // A Firestore Timestamp JSON-serialises to {_seconds,_nanoseconds}, which the
    // admin UI can't render — hand it plain epoch millis alongside.
    .map(({ queue, ...rest }) => ({
      ...rest,
      remaining: (queue || []).length,
      createdAtMs: rest.createdAt?.toMillis?.() || null,
      updatedAtMs: rest.updatedAt?.toMillis?.() || null,
    }))
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

export async function updateGenJob(id, patch) {
  await db.collection(COL.genJobs).doc(id).set(
    { ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true },
  );
}

/* --------------------------------- Roadmaps -------------------------------- */
/*
 * A ROADMAP is a curated learning PATH over EXISTING catalog topics — a second
 * lens on the same shared bank, independent of the Program>Track>Course>Lesson>
 * Topic tree the "My Progress" tab renders. It re-groups topics (the stable unit
 * everything keys on) into ordered STAGES that build on each other toward a goal,
 * so the same content can teach "take over the Agora repos" without disturbing
 * how it's filed. Shared across all users (like `topics`/`flashcards`); a
 * learner's progress on a roadmap is DERIVED at read time from their own
 * per-topic mastery, so a roadmap stores NO per-user state.
 *
 * Doc shape:
 *   { id, title, goal, program, audience: 'program'|'everyone',
 *     stages: [ { id, title, summary,
 *                 items: [ { level, program, track, course, lesson, topic, topicId, note } ] } ],
 *     source, createdBy, createdAt, updatedBy, updatedAt }
 * An item is MIXED-GRAIN: `level` is 'track' | 'course' | 'lesson' | 'topic'. A
 * coarse item (e.g. level:'track') pulls that WHOLE track/course/lesson in as one
 * unit, so "Data Science" is a roadmap of 3 track-level items rather than 553 topic
 * refs. `program` is carried per-item so a roadmap can span programs. A topic-level
 * item also carries the stable topic doc id (topicId). The id defaults to
 * slug(title) so re-planning the same goal UPDATES in place; pass an explicit id
 * to target one.
 */

const RM_LEVELS = ['track', 'course', 'lesson', 'topic'];

/** Coerce one roadmap item into the stored shape (mixed-grain, fields bounded). */
function normRoadmapItem(it, defaultProgram) {
  const level = RM_LEVELS.includes(it?.level) ? it.level : 'topic';
  const track = String(it?.track || '');
  const course = String(it?.course || '');
  const lesson = String(it?.lesson || '');
  const topic = String(it?.topic || '');
  const out = {
    level,
    program: String(it?.program || defaultProgram || DEFAULT_PROGRAM),
    track, course, lesson, topic,
    note: String(it?.note || '').slice(0, 500),
  };
  if (level === 'topic') out.topicId = String(it?.topicId || slug(track, course, lesson, topic));
  return out;
}

/** An item is usable only if it names enough of the hierarchy for its level. */
function roadmapItemValid(it) {
  if (it.level === 'topic') return !!it.topic;
  if (it.level === 'lesson') return !!(it.track && it.course && it.lesson);
  if (it.level === 'course') return !!(it.track && it.course);
  if (it.level === 'track') return !!it.track;
  return false;
}

/** Coerce one stage into the stored shape (ids stable within a roadmap, fields bounded). */
function normRoadmapStage(s, i, defaultProgram) {
  const items = Array.isArray(s?.items) ? s.items : [];
  return {
    id: String(s?.id || `s${i + 1}`),
    title: String(s?.title || `Stage ${i + 1}`).slice(0, 200),
    summary: String(s?.summary || '').slice(0, 1500),
    items: items.map((it) => normRoadmapItem(it, defaultProgram)).filter(roadmapItemValid),
  };
}

/** Upsert a roadmap (merge). Returns the stored doc (with id). */
export async function saveRoadmap(rm) {
  const title = String(rm?.title || '').trim();
  if (!title) throw new Error('roadmap title required');
  const id = String(rm?.id || '').trim() || slug(title);
  const program = String(rm?.program || DEFAULT_PROGRAM);
  const ref = db.collection(COL.roadmaps).doc(id);
  const existing = await ref.get();
  const doc = {
    title,
    goal: String(rm?.goal || '').slice(0, 4000),
    summary: String(rm?.summary || '').slice(0, 2000),
    program,
    audience: rm?.audience === 'everyone' ? 'everyone' : 'program',
    stages: (Array.isArray(rm?.stages) ? rm.stages : []).map((s, i) => normRoadmapStage(s, i, program)),
    source: String(rm?.source || 'manual').slice(0, 40),
    updatedBy: rm?.updatedBy || null,
    updatedAt: FieldValue.serverTimestamp(),
    ...(existing.exists
      ? {}
      : { createdBy: rm?.createdBy || rm?.updatedBy || null, createdAt: FieldValue.serverTimestamp() }),
  };
  await ref.set(doc, { merge: true });
  return { id, ...doc };
}

/** One roadmap by id, or null. */
export async function getRoadmap(id) {
  if (!id) return null;
  const doc = await db.collection(COL.roadmaps).doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * All roadmaps, newest-updated first. `program` narrows to that program (plus any
 * `audience:'everyone'` roadmap, which is visible everywhere); omit for all.
 */
export async function listRoadmaps({ program = null } = {}) {
  const snap = await db.collection(COL.roadmaps).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => !program || r.program === program || r.audience === 'everyone')
    .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
}

export async function deleteRoadmap(id) {
  if (!id) return false;
  await db.collection(COL.roadmaps).doc(id).delete();
  return true;
}

/** Distinct (program, track) a roadmap references — used to drop its tracks onto a shelf. */
export function collectRoadmapTracks(roadmap) {
  const seen = new Set();
  const out = [];
  for (const s of roadmap?.stages || []) {
    for (const it of s.items || []) {
      if (!it.track) continue;
      const program = it.program || roadmap.program || DEFAULT_PROGRAM;
      const k = JSON.stringify([program, it.track]);
      if (!seen.has(k)) { seen.add(k); out.push({ program, track: it.track }); }
    }
  }
  return out;
}

/* ------------------------ Mastery Engine shelf (tracks) --------------------- */
/*
 * A learner's "Mastery Engine" (the tab formerly called My Progress) is a
 * user-CURATED set of tracks chosen from the shared bank — not a whole program
 * they're force-fed. The shelf lives at users/{u}/meta/shelf as
 * { tracks: [{program, track}] }. A user with NO shelf falls back to their
 * enrollment-derived tracks (see effectiveShelf in server.js), so existing users
 * are unaffected until they curate. Adding a track also ensures its program is in
 * the user's enrollment, so the program-scoped quiz/review endpoints keep working
 * for a track pulled from any program (the bank is open to add).
 */
const shelfDoc = (userKey) => db.collection('users').doc(normKey(userKey)).collection('meta').doc('shelf');

function dedupeTracks(tracks) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tracks) ? tracks : []) {
    if (!t || !t.track) continue;
    const rec = { program: String(t.program || DEFAULT_PROGRAM), track: String(t.track) };
    const k = JSON.stringify([rec.program, rec.track]);
    if (!seen.has(k)) { seen.add(k); out.push(rec); }
  }
  return out;
}

/**
 * Hidden subtrees: prefixes the learner has removed from their personal Mastery
 * Engine at ANY grain — {program, track, course?, lesson?, topic?}. A catalog row
 * is hidden when it matches every level the prefix specifies (a course prefix
 * hides all its lessons/topics, etc.). A track at minimum is required (a bare
 * program isn't a hide). Removing a whole track still lives in `tracks`; `hidden`
 * is the finer-grained layer beneath it. Content stays in the shared bank, so a
 * hidden section still rolls up in any Roadmap that references it.
 */
function normalizeHidden(entries) {
  const seen = new Set();
  const out = [];
  for (const h of Array.isArray(entries) ? entries : []) {
    if (!h || !h.track) continue;
    const rec = { program: String(h.program || DEFAULT_PROGRAM), track: String(h.track) };
    if (h.course != null && h.course !== '') rec.course = String(h.course);
    if (h.lesson != null && h.lesson !== '') rec.lesson = String(h.lesson);
    if (h.topic != null && h.topic !== '') rec.topic = String(h.topic);
    const k = JSON.stringify([rec.program, rec.track, rec.course || '', rec.lesson || '', rec.topic || '']);
    if (!seen.has(k)) { seen.add(k); out.push(rec); }
  }
  return out;
}

/**
 * The user's curated shelf, or null if they've never curated one.
 *   { tracks: [{program,track}], roadmaps: [id], assignedRoadmaps: [id],
 *     hidden: [prefix], included: [prefix] }
 * `roadmaps` = roadmaps they're on (self-started + admin-assigned); the enrolled/
 * assigned ones auto-contribute their tracks to `tracks`. `assignedRoadmaps` ⊆
 * roadmaps is the admin-assigned subset (drives the "Assigned" badge). `hidden`
 * subtracts sub-sections from the engine; `included` adds sub-sections that aren't
 * covered by a whole shelf track (see server.js membership rule — deepest prefix wins).
 */
export async function getShelf(userKey) {
  if (!userKey) return null;
  const doc = await shelfDoc(userKey).get();
  if (!doc.exists) return null;
  const d = doc.data() || {};
  return {
    tracks: dedupeTracks(d.tracks),
    roadmaps: [...new Set((Array.isArray(d.roadmaps) ? d.roadmaps : []).map(String))],
    assignedRoadmaps: [...new Set((Array.isArray(d.assignedRoadmaps) ? d.assignedRoadmaps : []).map(String))],
    hidden: normalizeHidden(d.hidden),
    // Additive counterpart of `hidden`: sub-sections (course/lesson/sub-lesson
    // prefixes) explicitly ADDED to the engine without their whole track — so a
    // learner can pull a single lesson from a roadmap. Same prefix shape as hidden.
    included: normalizeHidden(d.included),
  };
}

/** Merge-patch the shelf; pass any of {tracks, roadmaps, assignedRoadmaps, hidden, included}. Returns the full shelf. */
export async function setShelf(userKey, patch = {}) {
  if (!userKey) return null;
  const out = { updatedAt: FieldValue.serverTimestamp() };
  if (Array.isArray(patch.tracks)) out.tracks = dedupeTracks(patch.tracks);
  if (Array.isArray(patch.roadmaps)) out.roadmaps = [...new Set(patch.roadmaps.map(String))];
  if (Array.isArray(patch.assignedRoadmaps)) out.assignedRoadmaps = [...new Set(patch.assignedRoadmaps.map(String))];
  if (Array.isArray(patch.hidden)) out.hidden = normalizeHidden(patch.hidden);
  if (Array.isArray(patch.included)) out.included = normalizeHidden(patch.included);
  await shelfDoc(userKey).set(out, { merge: true });
  return getShelf(userKey);
}

/** Every (program, track) in the bank, with course/topic counts — the "add tracks" browser. */
export async function listBankTracks() {
  const snap = await db.collection(COL.topics).get();
  const agg = new Map();
  for (const d of snap.docs) {
    const r = d.data();
    if (!r.track) continue;
    const program = r.program || DEFAULT_PROGRAM;
    const key = JSON.stringify([program, r.track]);
    let e = agg.get(key);
    if (!e) { e = { program, track: r.track, courses: new Set(), topics: 0 }; agg.set(key, e); }
    if (r.course) e.courses.add(r.course);
    e.topics += 1;
  }
  return [...agg.values()]
    .map((e) => ({ program: e.program, track: e.track, courses: e.courses.size, topics: e.topics }))
    .sort((a, b) => a.program.localeCompare(b.program) || a.track.localeCompare(b.track, undefined, { numeric: true }));
}

/* ------------------------------ Question flags ------------------------------ */
/*
 * The safety valve for auto-published generation: any learner can flag a bad
 * question, and an admin can pull a whole generation batch by its tag.
 */

export async function flagQuestion({ questionId, email, reason, topic }) {
  if (!questionId) throw new Error('questionId is required');
  const ref = await db.collection(COL.questionFlags).add({
    questionId, email: normKey(email), reason: String(reason || '').slice(0, 500),
    topic: topic || '', resolved: false, createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function listQuestionFlags(includeResolved = false) {
  const snap = await db.collection(COL.questionFlags).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((f) => includeResolved || !f.resolved)
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}

export async function resolveQuestionFlag(id, { deleteQuestion = false } = {}) {
  const ref = db.collection(COL.questionFlags).doc(id);
  const doc = await ref.get();
  if (!doc.exists) return false;
  if (deleteQuestion) {
    // Through deleteQuestionById, not a raw delete: the topic's questionCount
    // has to come down with it or the catalog claims questions that are gone.
    const qid = doc.get('questionId');
    if (qid) await deleteQuestionById(qid).catch(() => {});
  }
  await ref.set({ resolved: true, resolvedAt: FieldValue.serverTimestamp() }, { merge: true });
  return true;
}

/**
 * Delete ONE question and correct its topic's counter — the per-question
 * sibling of deleteQuestionBatch, behind the admin "this question is wrong"
 * button. Questions carry a topic NAME (not a topic doc id), so the counter is
 * corrected on every catalog row in the same program carrying that name; a name
 * shared by two lessons decrements both, exactly as the batch delete does.
 * Returns {deleted, topic} — `deleted:false` when the id is already gone.
 */
export async function deleteQuestionById(id) {
  if (!id) return { deleted: false, topic: '' };
  const ref = db.collection(COL.questions).doc(id);
  const doc = await ref.get();
  if (!doc.exists) return { deleted: false, topic: '' };
  const topic = doc.get('topic') || '';
  const program = doc.get('program') || DEFAULT_PROGRAM;
  await ref.delete();
  if (topic) {
    const snap = await db.collection(COL.topics).where('topic', '==', topic).get();
    const batch = db.batch();
    let ops = 0;
    for (const d of snap.docs) {
      if ((d.get('program') || DEFAULT_PROGRAM) !== program) continue;
      batch.set(d.ref, { questionCount: FieldValue.increment(-1) }, { merge: true });
      ops += 1;
    }
    if (ops) await batch.commit();
  }
  return { deleted: true, topic };
}

/**
 * Delete every question from one generation batch and correct the affected
 * topics' counts — the "that batch was bad, pull it" button. Returns how many
 * went. Batched at 450 like the other migrations.
 */
export async function deleteQuestionBatch(batchTag) {
  if (!batchTag) throw new Error('batchTag is required');
  const snap = await db.collection(COL.questions).where('batchTag', '==', batchTag).get();
  const byTopic = new Map(); // topic name -> count removed
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const d of snap.docs) {
    const t = d.get('topic');
    if (t) byTopic.set(t, (byTopic.get(t) || 0) + 1);
    batch.delete(d.ref);
    if (++ops >= 450) await flush();
  }
  await flush();

  // Put the catalog counters back. Topic names alone can't identify a row, so
  // resolve through the program's catalog (see programs.js on name collisions).
  const cat = await db.collection(COL.topics).get();
  for (const d of cat.docs) {
    const n = byTopic.get(d.get('topic'));
    if (!n) continue;
    batch.set(d.ref, { questionCount: FieldValue.increment(-n) }, { merge: true });
    if (++ops >= 450) await flush();
  }
  await flush();
  return { deleted: snap.size, topicsTouched: byTopic.size };
}

/* ------------------------ Program backfill migration ----------------------- */
/*
 * One-time, idempotent tagging of the pre-program world. Every `topics` and
 * `questions` doc written before the program dimension existed belongs to
 * DEFAULT_PROGRAM (data science), and the two starting programs get their
 * registry docs.
 *
 * Idempotent because it only writes docs that are MISSING `program` — a second
 * run tags nothing and reports zeros. Safe to run before the code that reads the
 * field ships, since programOf() already treats an absent field as
 * DEFAULT_PROGRAM: the backfill makes explicit what was already implied, so the
 * catalog a data-science user sees is identical before, during, and after.
 */
const STARTING_PROGRAMS = [
  { id: 'data_science', name: 'Data Science' },
  { id: 'digital_marketing', name: 'Digital Marketing' },
];

export async function backfillPrograms() {
  const report = { programsCreated: 0, topicsTagged: 0, questionsTagged: 0 };

  // 1. Registry docs — create only when absent so a later rename isn't undone.
  for (const p of STARTING_PROGRAMS) {
    const ref = db.collection(COL.programs).doc(p.id);
    if (!(await ref.get()).exists) {
      await ref.set({ name: p.name, defaultCourses: [], createdAt: FieldValue.serverTimestamp() });
      report.programsCreated += 1;
    }
  }

  // 2. Tag every untagged catalog + question doc as the default program.
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const [col, key] of [[COL.topics, 'topicsTagged'], [COL.questions, 'questionsTagged']]) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) {
      if (d.get('program')) continue; // already tagged — the idempotency guard
      batch.update(d.ref, { program: DEFAULT_PROGRAM });
      report[key] += 1;
      if (++ops >= 450) await flush();
    }
    await flush();
  }
  return report;
}

/* -------------------------------- Flashcards ------------------------------- */
/*
 * Flashcards are AI-generated study cards for a Course- or Lesson-level scope
 * (never per sub-lesson). The card DEFINITIONS are shared across users (like the
 * question bank) and live in the `flashcards` collection, tagged with a
 * deterministic `scopeId` so a scope's deck can be fetched (and regenerated)
 * cleanly. Each user's own LABELS (mastered / learning / important) are private
 * and stored under `users/{userKey}/flashcardStatus/{cardId}` for EVERY user
 * (this is all-new data, so there is no legacy-owner special case).
 */

/** Deterministic id for a Course/Lesson/Topic scope so its deck can be looked up + replaced. */
export function flashcardScopeId({ level, track, course, lesson, topic }) {
  return slug(level || 'course', track || '', course || '', lesson || '', topic || '');
}

const flashcardStatusCol = (userKey) =>
  db.collection('users').doc(normKey(userKey)).collection('flashcardStatus');

/** All cards for a scope, ordered by their stored `order` (sorted in-memory: no index needed). */
export async function getFlashcards(scope) {
  const scopeId = flashcardScopeId(scope);
  const snap = await db.collection(COL.flashcards).where('scopeId', '==', scopeId).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** A single card by id (for "quiz me on this"). */
export async function getFlashcardById(id) {
  const doc = await db.collection(COL.flashcards).doc(id).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * The program a CARD belongs to — never the program the request happens to carry.
 * A shelf mixes programs (and the mastery deck interleaves them), so anything
 * hanging off a card must scope to the card, not to the learner's first enrolment.
 *
 * Decks banked from 2026-08-07 store `program`. Older ones don't, so fall back to
 * the card's own topic row: ONE equality query on an auto-indexed field, not the
 * ~540-doc catalog, because this runs on every card view. Topic names repeat across
 * programs, so the track/course/lesson the card was filed under break the tie.
 */
export async function programForCard(card) {
  if (card?.program) return card.program;
  const topic = String(card?.topic || '').trim();
  if (!topic) return '';
  const snap = await db.collection(COL.topics).where('topic', '==', topic).get();
  const rows = snap.docs.map((d) => d.data());
  const match = rows.find((r) => (!card.track || r.track === card.track)
    && (!card.course || r.course === card.course)
    && (!card.lesson || r.lesson === card.lesson));
  return (match || rows[0])?.program || '';
}

/** Every shared flashcard with its doc id + scope fields — for building a
 *  cross-scope deck (e.g. the Mastery deck that mixes many topics' cards). */
export async function getAllFlashcardsWithId() {
  const snap = await db.collection(COL.flashcards).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Every shared flashcard deck (for the local app's Sync to pull good cards). */
export async function getAllFlashcards() {
  const snap = await db.collection(COL.flashcards).get();
  return snap.docs.map((d) => {
    const c = d.data();
    return {
      scopeId: c.scopeId, level: c.level || 'course',
      track: c.track || '', course: c.course || '', lesson: c.lesson || '', topic: c.topic || '',
      concept: c.concept || '', intuition: c.intuition || '', formula: c.formula || '',
      visual: c.visual || null, highway: !!c.highway, kind: c.kind || '', order: c.order ?? 0,
    };
  });
}

/**
 * Replace a scope's deck: delete any existing cards for the scope, then write the
 * freshly-generated ones. Returns the number of cards written.
 */
export async function saveFlashcards(scope, cards) {
  const scopeId = flashcardScopeId(scope);
  const col = db.collection(COL.flashcards);

  // Clear the old deck for this scope.
  const existing = await col.where('scopeId', '==', scopeId).get();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const d of existing.docs) {
    batch.delete(d.ref);
    if (++ops >= 450) await flush();
  }
  // Write the new deck.
  cards.forEach((c, i) => {
    batch.set(col.doc(), {
      scopeId,
      level: scope.level || 'course',
      // The deck's program, so a card-scoped request never has to guess it from
      // the caller's enrolment (see programForCard). NOT part of scopeId — adding
      // it there would orphan every deck banked before this field existed.
      program: scope.program || '',
      track: scope.track || '',
      course: scope.course || '',
      lesson: scope.lesson || '',
      topic: c.topic || '',
      concept: c.concept || '',
      intuition: c.intuition || '',
      formula: c.formula || '',
      visual: c.visual || null,
      highway: !!c.highway,
      // Book decks only: 'title' (the book card) | 'point' (one key point).
      // Absent on ordinary decks; its presence is what marks a deck as a book.
      ...(c.kind ? { kind: c.kind } : {}),
      order: i,
      createdAt: FieldValue.serverTimestamp(),
      source: 'ai',
    });
    ops += 1;
  });
  await flush();
  return cards.length;
}

/* --------------------------- Study guides (Lesson / Review) ---------------
 * The AI "Lesson" and "Review" study guides are derived ENTIRELY from shared
 * data (catalog topics + the shared question bank + the shared prereq graph),
 * so a given scope's guide is identical for every learner and is cached ONCE
 * here. A learner's Lesson/Review button replays the cache instantly (no
 * tokens); a cache miss generates, streams, and saves. Admins pre-warm the
 * cache in bulk from the Composing Room. Keyed by program + kind + the exact
 * scope tuple (track/course/lesson/topic) the learner's node carries, so the
 * key matches wherever they click (course / lesson / sub-lesson).
 */
export function studyGuideId({ program, kind, track, course, lesson, topic } = {}) {
  return slug(program || '', kind || 'review', track || '', course || '', lesson || '', topic || '');
}

/** The cached guide for a scope, or null. */
export async function getStudyGuide(scope) {
  const doc = await db.collection(COL.studyGuides).doc(studyGuideId(scope)).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/** Upsert a scope's guide markdown. Returns the doc id. */
export async function saveStudyGuide(scope, markdown, meta = {}) {
  const id = studyGuideId(scope);
  await db.collection(COL.studyGuides).doc(id).set(
    {
      program: scope.program || '',
      kind: scope.kind || 'lesson',
      track: scope.track || '',
      course: scope.course || '',
      lesson: scope.lesson || '',
      topic: scope.topic || '',
      scopeLabel: meta.scopeLabel || '',
      markdown: markdown || '',
      chars: (markdown || '').length,
      updatedAt: new Date().toISOString(),
      source: meta.source || 'ai',
      // Was the authored lesson document behind this build? A guide written FROM
      // a source and one inferred from the quiz questions are different artifacts
      // at very different quality, and nothing else on the doc distinguishes them.
      // Written unconditionally so a rebuild that lost its source clears the claim.
      grounded: !!meta.grounded,
      // 🔴 Hand-written, not generated. A regenerate would replace it with model
      // output and there is no undo, so the routes refuse unless explicitly
      // forced. Unconditional for the same reason as `grounded`: a forced
      // regenerate genuinely is model output now and must stop claiming otherwise.
      locked: !!meta.locked,
      // Provenance. The pair is the RESOLVED one (lib/gemini.js fillEngineMeta),
      // not what the caller asked for — the per-user policy clamp can downgrade a
      // request, and it clears the model id when it does. `critique` is the
      // learner's note from the regenerate box, '' on a plain build.
      ...(meta.provider ? { provider: meta.provider } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.critique != null ? { critique: String(meta.critique) } : {}),
    },
    { merge: true },
  );
  return id;
}

/** The set of already-cached guide doc ids for a program, so a bulk run can
 *  skip what already exists (unless the admin forces a rebuild). */
export async function getStudyGuideIds(program) {
  const snap = await db.collection(COL.studyGuides).where('program', '==', program || '').get();
  return new Set(snap.docs.map((d) => d.id));
}

/**
 * Every cached study guide — both kinds: `review` guides and `lesson` guides.
 *
 * Written for the offline app's Sync (GET /api/export/local?part=guides). These are the most
 * expensive artefacts the engine produces: each one is a full AI-written lesson or revision guide,
 * and regenerating the whole library on a laptop LLM would take hours and come out worse. Pulling
 * the cloud's copies is what lets someone study a lesson end-to-end with no internet.
 */
export async function getAllStudyGuides() {
  const snap = await db.collection(COL.studyGuides).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* --------------------------- Visual guides (Visualize this) ---------------
 * The interactive HTML companion to a Lesson/Review study guide: one
 * self-contained page of named, numbered, interactive visuals.
 *
 * Cached exactly like a study guide, and for the same reason — the page is
 * derived only from SHARED data (the cached guide + the shared question bank),
 * so it is identical for every learner and worth generating once. It is the most
 * expensive artefact the engine produces (a whole HTML document from one model
 * call), so a cache miss is the only thing that ever spends tokens.
 *
 * Keyed by program + kind + the exact scope tuple, so a Lesson's visuals and a
 * Review's visuals for the SAME section are two separate documents rather than
 * one overwriting the other.
 *
 * 🔴 Never .where()/.orderBy() on `html` or `outline`. Firestore auto-indexes
 * every field and these are blobs; the queries here only ever touch the scope
 * fields. (Same shape as studyGuides.markdown, which has run in production at
 * this size for a year.)
 */
export function visualGuideId({ program, kind, track, course, lesson, topic } = {}) {
  return slug(program || '', kind || 'review', track || '', course || '', lesson || '', topic || '');
}

/** The cached visual guide for a scope, or null. */
export async function getVisualGuide(scope) {
  const doc = await db.collection(COL.visualGuides).doc(visualGuideId(scope)).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * Upsert a scope's visual guide. Returns the doc id.
 *
 * Unlike saveStudyGuide this REJECTS an oversized payload instead of letting
 * Firestore do it: the document cap is 1 MiB and a generated page is normally
 * 30–120 KB, but a runaway generation would otherwise fail inside a fire-and-
 * forget `.catch(() => {})` and look exactly like a cache that never warms.
 * `bytes` is Buffer.byteLength, not .length — .length counts UTF-16 code units
 * and understates anything non-ASCII, which is the number that matters here.
 */
export const VISUAL_GUIDE_MAX_BYTES = 700 * 1024;

export async function saveVisualGuide(scope, html, meta = {}) {
  const id = visualGuideId(scope);
  const bytes = Buffer.byteLength(html || '', 'utf8');
  if (bytes > VISUAL_GUIDE_MAX_BYTES) {
    throw new Error(`Generated page is ${Math.round(bytes / 1024)} KB, over the ${Math.round(VISUAL_GUIDE_MAX_BYTES / 1024)} KB cache limit`);
  }
  await db.collection(COL.visualGuides).doc(id).set(
    {
      program: scope.program || '',
      kind: scope.kind || 'review',
      track: scope.track || '',
      course: scope.course || '',
      lesson: scope.lesson || '',
      topic: scope.topic || '',
      scopeLabel: meta.scopeLabel || '',
      title: meta.title || '',
      html: html || '',
      // The plain-text index the generator emitted alongside the page: one line
      // per visual, "N | name | what it shows | takeaway". This is what the study
      // assistant is grounded on — the page itself is in an opaque-origin sandbox
      // and nothing outside it can read the tabs.
      outline: meta.outline || '',
      bytes,
      provider: meta.provider || '',
      model: meta.model || '',
      critique: meta.critique || '',
      attempt: Number(meta.attempt) || 1,
      // Which visuals the LAST save rewrote, empty on a whole-page build. Written
      // unconditionally (not left to the merge) precisely so a full rebuild
      // clears it — otherwise the viewer keeps claiming "visual 2 rewritten"
      // about a page on which every panel is new.
      patched: Array.isArray(meta.patched) ? meta.patched.map(String) : [],
      // Hand-written page — see the same field on saveStudyGuide.
      locked: !!meta.locked,
      updatedAt: new Date().toISOString(),
      source: meta.source || 'visualize',
    },
    { merge: true },
  );
  return id;
}

/** One visual guide by DOC ID — what the artifact route serves. The id comes
 *  from the /api/visualize response, so the client never re-derives the slug. */
export async function getVisualGuideById(id) {
  const doc = await db.collection(COL.visualGuides).doc(String(id || '')).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/** Drop a scope's cached visual guide (used before a regenerate). */
export async function deleteVisualGuide(scope) {
  await db.collection(COL.visualGuides).doc(visualGuideId(scope)).delete();
}

/**
 * Every cached visual guide, for the offline app's Sync. Same rationale as
 * getAllStudyGuides: regenerating these on a laptop LLM is hours of work for a
 * worse result.
 */
export async function getAllVisualGuides() {
  const snap = await db.collection(COL.visualGuides).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Raw topic documents, exactly as stored — including the legacy owner's embedded mastery stats.
 *
 * getCatalog() returns DERIVED rows (accuracy, priority) for rendering. The offline app instead
 * needs to reproduce the collection itself, so it can recompute the same way the cloud does and stay
 * a true mirror rather than a snapshot of one screen.
 */
export async function getAllTopicDocs() {
  const snap = await db.collection(COL.topics).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * A non-legacy user's per-topic stats (`users/{u}/topicStats`), for the offline mirror.
 * Empty for the legacy owner, whose stats live embedded on the topic docs themselves.
 */
export async function getUserTopicStats(userKey) {
  if (!userKey || isLegacy(userKey)) return [];
  const snap = await statsCol(userKey).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Map of cardId -> status label for `userKey` over the given card ids. */
export async function getFlashcardStatuses(userKey, cardIds = []) {
  const out = {};
  if (!userKey || !cardIds.length) return out;
  const col = flashcardStatusCol(userKey);
  // Firestore getAll in chunks; ids are our own doc ids.
  for (let i = 0; i < cardIds.length; i += 300) {
    const chunk = cardIds.slice(i, i + 300).map((id) => col.doc(id));
    const snaps = await db.getAll(...chunk);
    snaps.forEach((s) => { if (s.exists) out[s.id] = s.get('status'); });
  }
  return out;
}

/** Set (or clear, when status is falsy) a user's label for one card. */
export async function setFlashcardStatus(userKey, cardId, status) {
  if (!userKey || !cardId) return;
  const ref = flashcardStatusCol(userKey).doc(cardId);
  const valid = ['mastered', 'learning', 'important'];
  if (!status || !valid.includes(status)) {
    await ref.delete();
  } else {
    await ref.set({ status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
}

/* ------------------------------ Graph links -------------------------------- */
/*
 * Knowledge-graph prerequisite links, SHARED across users (like the question
 * bank). One doc per topic, keyed by the topic's own catalog doc id (the stable
 * slug(track,course,lesson,topic)), holding that topic's DIRECT prerequisites:
 *   graphLinks/{topicId} = { topic, prereqs: [{id, why}], source, updatedAt }
 * A doc with an EMPTY prereqs array still counts as "linked" (the AI decided the
 * topic has no prerequisites), which is what coverage tracking needs. The
 * curriculum "flow" edges are NOT stored — lib/graph.js derives them from the
 * catalog on every read.
 */

/** Every stored link doc: [{id, topic, prereqs:[{id, why}]}]. */
export async function getGraphLinks() {
  const snap = await db.collection(COL.graphLinks).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      topic: x.topic || '',
      // 'hand-authored' docs are protected from /api/admin/build-graph?refresh=1
      // (the LLM linker would otherwise replace the curated edges with its own).
      source: x.source || '',
      prereqs: Array.isArray(x.prereqs)
        ? x.prereqs.filter((p) => p && p.id).map((p) => ({
            id: p.id,
            why: p.why || '',
            // Importance 1 (helpful) .. 3 (critical). Older edges have none — leave
            // it undefined so buildPrereqEdges applies PREREQ_WEIGHT_DEFAULT.
            ...(Number.isFinite(p.weight) ? { weight: p.weight } : {}),
          }))
        : [],
    };
  });
}

/** Upsert link docs [{id, topic, prereqs}] in chunked batches. Returns count. */
export async function saveGraphLinks(items) {
  let batch = db.batch();
  let ops = 0;
  let n = 0;
  for (const it of items) {
    if (!it?.id) continue;
    batch.set(
      db.collection(COL.graphLinks).doc(it.id),
      {
        topic: it.topic || '',
        prereqs: Array.isArray(it.prereqs)
          ? it.prereqs.map((p) => ({
              id: p.id,
              why: p.why || '',
              // Persist the AI-authored importance (1..3) so runtime readiness can
              // weight critical prerequisites above nice-to-haves.
              ...(Number.isFinite(p.weight) ? { weight: Math.min(3, Math.max(1, p.weight)) } : {}),
            }))
          : [],
        source: 'ai',
        updatedAt: FieldValue.serverTimestamp(),
      },
    );
    n += 1;
    if (++ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return n;
}

/* ----------------------------- Card chat ----------------------------------- */
/*
 * Per-user, per-card tutor chat. The shared `flashcards` docs are never touched;
 * a user's conversation AND their personalized "rewrite in place" of the card
 * (intuition/formula/visual) live privately under
 * `users/{userKey}/cardChats/{cardId}`. On read, packageFlashcards overlays any
 * personalized fields so the user sees their own version of the card.
 */
const cardChatCol = (userKey) =>
  db.collection('users').doc(normKey(userKey)).collection('cardChats');

/** This user's chat + personalized overlay for one card (or null). */
export async function getCardChat(userKey, cardId) {
  if (!userKey || !cardId) return null;
  const doc = await cardChatCol(userKey).doc(cardId).get();
  return doc.exists ? doc.data() : null;
}

/** Merge-write this user's chat thread + personalized card fields for one card. */
export async function saveCardChat(userKey, cardId, { messages, intuition, formula, visual }) {
  if (!userKey || !cardId) return;
  await cardChatCol(userKey).doc(cardId).set(
    {
      messages: Array.isArray(messages) ? messages : [],
      intuition: intuition ?? '',
      formula: formula ?? '',
      visual: visual ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** Revert this user's card to the shared original (drops chat + overlay). */
export async function resetCardChat(userKey, cardId) {
  if (!userKey || !cardId) return;
  await cardChatCol(userKey).doc(cardId).delete();
}

/**
 * Map cardId -> { intuition, formula, visual, personalized:true } for any of the
 * given cards this user has personalized. Batched getAll, like getFlashcardStatuses.
 */
export async function getCardOverlays(userKey, cardIds = []) {
  const out = {};
  if (!userKey || !cardIds.length) return out;
  const col = cardChatCol(userKey);
  for (let i = 0; i < cardIds.length; i += 300) {
    const chunk = cardIds.slice(i, i + 300).map((id) => col.doc(id));
    const snaps = await db.getAll(...chunk);
    snaps.forEach((s) => {
      if (!s.exists) return;
      const d = s.data();
      // Only counts as an overlay once the user has personalized the intuition.
      if (d && d.intuition) {
        out[s.id] = { intuition: d.intuition, formula: d.formula || '', visual: d.visual || null, personalized: true };
      }
    });
  }
  return out;
}

/* ---------------------------- Scope chat ----------------------------------- */
/* Per-user chat thread for a whole lesson/course scope (AI Support > Chat). */
const scopeChatCol = (userKey) =>
  db.collection('users').doc(normKey(userKey)).collection('scopeChats');

export async function getScopeChat(userKey, scopeId) {
  if (!userKey || !scopeId) return [];
  const doc = await scopeChatCol(userKey).doc(scopeId).get();
  const msgs = doc.exists ? doc.get('messages') : null;
  return Array.isArray(msgs) ? msgs : [];
}

export async function saveScopeChat(userKey, scopeId, messages) {
  if (!userKey || !scopeId) return;
  await scopeChatCol(userKey).doc(scopeId).set(
    { messages: Array.isArray(messages) ? messages : [], updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

/** Delete one scope chat thread (the section chat's clear/forget action). */
export async function deleteScopeChat(userKey, scopeId) {
  if (!userKey || !scopeId) return;
  await scopeChatCol(userKey).doc(scopeId).delete();
}

/* --------------------------- Global assistant chat ------------------------- */
/* The floating assistant now keeps MULTIPLE saved conversations per user, one
 * doc each under users/{user}/assistantChats. Context is passed per message, so
 * conversations aren't scoped to a lesson. Each doc: { messages[], title,
 * createdAt, updatedAt }. The old single running thread (scopeChats/assistant)
 * is migrated in on first read so no history is lost. */
const ASSISTANT_ID = 'assistant';
const ASSISTANT_CAP = 40; // keep the last N messages per conversation

const assistantChatCol = (userKey) =>
  db.collection('users').doc(normKey(userKey)).collection('assistantChats');

/** Millis from a Firestore Timestamp (or 0 if not set yet). */
const tsMillis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0));

/** A short conversation title derived from its first user message. */
function chatTitle(messages) {
  const first = (messages || []).find((m) => m && m.role === 'user' && m.text);
  const t = first ? String(first.text).trim().replace(/\s+/g, ' ') : '';
  return t.slice(0, 60) || 'New conversation';
}

/**
 * One-time lazy migration: if a user has no conversations yet but still has the
 * legacy single thread, import it as their first conversation and drop the
 * legacy doc (so deleting all conversations later can't resurrect it).
 */
async function migrateLegacyAssistantChat(userKey) {
  const col = assistantChatCol(userKey);
  const any = await col.limit(1).get();
  if (!any.empty) return;
  const legacy = await getScopeChat(userKey, ASSISTANT_ID);
  if (!legacy.length) return;
  const msgs = legacy.slice(-ASSISTANT_CAP);
  await col.doc().set({
    messages: msgs,
    title: chatTitle(msgs),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await scopeChatCol(userKey).doc(ASSISTANT_ID).delete().catch(() => {});
}

/** List a user's conversations (metadata only), newest first. */
export async function listAssistantChats(userKey) {
  if (!userKey) return [];
  await migrateLegacyAssistantChat(userKey);
  const snap = await assistantChatCol(userKey).orderBy('updatedAt', 'desc').get();
  return snap.docs.map((d) => {
    const m = d.get('messages');
    return {
      id: d.id,
      title: d.get('title') || 'Conversation',
      count: Array.isArray(m) ? m.length : 0,
      updatedAt: tsMillis(d.get('updatedAt')),
    };
  });
}

/** Load one conversation's messages, or null if it doesn't exist. */
export async function getAssistantChat(userKey, id) {
  if (!userKey || !id) return null;
  const doc = await assistantChatCol(userKey).doc(id).get();
  if (!doc.exists) return null;
  const m = doc.get('messages');
  return { id: doc.id, title: doc.get('title') || 'Conversation', messages: Array.isArray(m) ? m : [] };
}

/**
 * Create (id omitted/blank) or update a conversation. Auto-titles from the first
 * user message and caps history. Returns { id, title }.
 */
export async function saveAssistantChat(userKey, id, messages) {
  if (!userKey) return null;
  const msgs = (Array.isArray(messages) ? messages : []).slice(-ASSISTANT_CAP);
  const title = chatTitle(msgs);
  const col = assistantChatCol(userKey);
  const isNew = !id;
  const ref = isNew ? col.doc() : col.doc(id);
  await ref.set(
    {
      messages: msgs,
      title,
      updatedAt: FieldValue.serverTimestamp(),
      ...(isNew ? { createdAt: FieldValue.serverTimestamp() } : {}),
    },
    { merge: true },
  );
  return { id: ref.id, title };
}

/** Delete one conversation. */
export async function deleteAssistantChat(userKey, id) {
  if (!userKey || !id) return;
  await assistantChatCol(userKey).doc(id).delete();
}

/* ------------------------------- AI usage --------------------------------- */
/* Persistent per-user text-token/TTS cost tally for the on-screen cost calculator.
 * One doc per user accumulates lifetime totals + a per-model breakdown. */
const usageDoc = (userKey) => db.collection('users').doc(normKey(userKey)).collection('meta').doc('usage');

export async function getUsage(userKey) {
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    ttsChars: 0,
    ttsInputTokens: 0,
    ttsAudioTokens: 0,
    costUsd: 0,
    calls: 0,
    byModel: {},
  };
  if (!userKey) return zero;
  const doc = await usageDoc(userKey).get();
  return doc.exists ? { ...zero, ...doc.data() } : zero;
}

/** Add a request's usage delta (tokens/TTS/cost, optionally per-model) to the user's tally. */
export async function addUsage(userKey, delta = {}) {
  if (!userKey) return;
  const inc = FieldValue.increment;
  // Build a NESTED object (not dotted keys): model ids like "gemini-2.5-flash"
  // contain dots, and set({merge:true}) treats dotted keys as literal names.
  const byModel = {};
  for (const [model, m] of Object.entries(delta.byModel || {})) {
    byModel[model] = {
      inputTokens: inc(m.inputTokens || 0),
      outputTokens: inc(m.outputTokens || 0),
      ttsChars: inc(m.ttsChars || 0),
      ttsInputTokens: inc(m.ttsInputTokens || 0),
      ttsAudioTokens: inc(m.ttsAudioTokens || 0),
      costUsd: inc(m.costUsd || 0),
      calls: inc(m.calls || 0),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.kind ? { kind: m.kind } : {}),
      ...(m.label ? { label: m.label } : {}),
    };
  }
  await usageDoc(userKey).set(
    {
      inputTokens: inc(delta.inputTokens || 0),
      outputTokens: inc(delta.outputTokens || 0),
      ttsChars: inc(delta.ttsChars || 0),
      ttsInputTokens: inc(delta.ttsInputTokens || 0),
      ttsAudioTokens: inc(delta.ttsAudioTokens || 0),
      costUsd: inc(delta.costUsd || 0),
      calls: inc(delta.calls || 1),
      byModel,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/* ------------------------------- Time spent -------------------------------- */
/* Minute-bucket activity: users/{email}/activity/{YYYY-MM-DD} holds `m`, a map of
 * "HHMM" -> { p (program id), v (view), tr, co, le, to } for every minute the learner was
 * ACTIVE in the engine (server.js /api/activity/beat defines "active"). One doc per person per
 * day, and a minute is a KEY — so three frames stamping the same minute (Sentinel's Professional
 * tab + a growth tab + the Coach FAB) count it once, and a day's reading is a count of keys.
 * Day and minute boundaries are in the engine's ACTIVITY_TZ (Asia/Manila — Sentinel's today_ph).
 * Written as a nested map with set({merge:true}): a merge deep-merges maps, so each beat adds its
 * minutes without ever reading the doc back. Worst case 1,440 keys × ~120 B ≈ 170 KB, well under
 * the 1 MB document limit. */
const activityDoc = (userKey, day) =>
  db.collection('users').doc(normKey(userKey)).collection('activity').doc(day);

/** Merge `minutes` ({ HHMM: ctx }) into one person's day. Idempotent per minute key. */
export async function stampActiveMinutes(userKey, day, minutes) {
  if (!userKey || !day || !minutes || !Object.keys(minutes).length) return;
  await activityDoc(userKey, day).set(
    { m: minutes, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

/** Remove minute keys from one person's day — the learner's own correction ("I wasn't really
 *  focusing"). FieldValue.delete() inside a nested map under set({merge:true}) removes exactly those
 *  keys and nothing else; a key that isn't there is a no-op. Returns nothing: the caller re-reads. */
export async function removeActiveMinutes(userKey, day, keys) {
  if (!userKey || !day || !Array.isArray(keys) || !keys.length) return;
  const m = {};
  for (const k of keys) m[k] = FieldValue.delete();
  await activityDoc(userKey, day).set({ m, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** The minute maps for each listed day (YYYY-MM-DD) — { day: { HHMM: ctx } }. Days with no doc
 *  are simply absent. One read per day; the internal readers cap the range. */
export async function getActivityDays(userKey, days) {
  if (!userKey || !Array.isArray(days) || !days.length) return {};
  const snaps = await Promise.all(days.map((d) => activityDoc(userKey, d).get()));
  const out = {};
  snaps.forEach((snap, i) => {
    const m = snap.exists ? (snap.data() || {}).m : null;
    if (m && typeof m === 'object' && Object.keys(m).length) out[days[i]] = m;
  });
  return out;
}

/* -------------------------------- AI access -------------------------------- */
/* Per-user AI provider allowlist (admin-managed from the Academy Admin Team tab).
 * Lives at users/{u}/meta/ai, following the enrollment/shelf/usage pattern. An
 * ABSENT doc means the default policy — Kimi only (flat-rate subscription, $0
 * marginal) — for non-admins; admins are never policed (server.js resolves their
 * policy to null). Enforced at the complete()/completeStream() choke point. */
const aiAccessDoc = (userKey) => db.collection('users').doc(normKey(userKey)).collection('meta').doc('ai');

export const AI_PROVIDERS = ['kimi', 'gemini', 'deepseek', 'anthropic', 'ollama', 'lmstudio'];
export const DEFAULT_AI_PROVIDERS = ['kimi'];

function normalizeAiProviders(list) {
  const out = [...new Set(
    (Array.isArray(list) ? list : [])
      .map((p) => String(p).trim().toLowerCase())
      .filter((p) => AI_PROVIDERS.includes(p)),
  )];
  return out.length ? out : [...DEFAULT_AI_PROVIDERS];
}

/** The user's AI allowlist: { providers, configured }. Absent doc → the Kimi-only default. */
export async function getAiAccess(userKey) {
  if (!userKey) return { providers: [...DEFAULT_AI_PROVIDERS], configured: false };
  const doc = await aiAccessDoc(userKey).get();
  if (!doc.exists) return { providers: [...DEFAULT_AI_PROVIDERS], configured: false };
  return { providers: normalizeAiProviders(doc.data().providers), configured: true };
}

/** Replace the user's AI allowlist (unknown ids dropped; empty → the Kimi-only default). */
export async function setAiAccess(userKey, providers) {
  if (!userKey) return null;
  const normed = normalizeAiProviders(providers);
  await aiAccessDoc(userKey).set(
    { providers: normed, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return { providers: normed, configured: true };
}

/**
 * How many Speaker-Mode "explain aloud" attempts a user has logged. The explain
 * handler records each graded attempt as a quizLog row whose question carries a
 * fixed marker prefix (server.js /api/flashcards/explain), so a prefix range +
 * COUNT aggregation answers this in ~1 read per 1,000 entries. Works for the
 * legacy owner too — logCol() routes them to the shared quizLog.
 */
export async function countExplainLogs(userKey) {
  if (!userKey) return 0;
  const pre = '🎙️ Explained aloud: ';
  // Standard prefix range: [pre, pre-with-last-char-incremented). The last char
  // is a space, so the bound is '...aloud:!' and covers ANY suffix, including
  // concepts that start above U+F8FF (a \uf8ff sentinel would miss those).
  const hi = pre.slice(0, -1) + String.fromCharCode(pre.charCodeAt(pre.length - 1) + 1);
  const snap = await logCol(userKey)
    .where('question', '>=', pre)
    .where('question', '<', hi)
    .count()
    .get();
  return snap.data().count || 0;
}

/* --------------------------------- Quiz Log -------------------------------- */

/** A control-char-joined (track,course,lesson,topic) key — a name can't contain  . */
export const tupleKey = (track, course, lesson, topic) =>
  [track || '', course || '', lesson || '', topic || ''].join(' ');

/**
 * Build a CURRENT (track,course,lesson,topic) tuple -> real Firestore doc id map
 * from catalog rows (each `{ id, track, course, lesson, topic, questionCount }`).
 * Pure (no IO) so it is unit-testable; catalogIdIndex feeds it the live catalog.
 *
 * WHY this exists: a topic doc keeps a STABLE id across re-filing — `moveTopics`
 * and the curriculum editor change the track/course/lesson FIELDS but deliberately
 * keep the doc id (so per-user stats, banked questions and graph edges, all keyed
 * by id, survive the move). Renames behave the same. The upshot is that a moved or
 * renamed topic's id no longer equals `slug(its current fields)`.
 *
 * If `logResults` keyed stats by `slug(current fields)` (as it used to) it would:
 *   (a) write to an id the read path never looks up  -> the section shows
 *       "Not started / 0%" even after a finished quiz; and
 *   (b) for the legacy owner, CREATE a phantom zero-question `topics` doc at that
 *       slug (its `set(..., {merge:true})` writes the doc if absent), which then
 *       shadows the real content doc in the tree.
 * Resolving through this index keys every attempt on the doc that actually holds
 * the content, so read, write and display all agree. Where two docs share a tuple
 * (legacy duplicates), the one that holds the questions wins; a further tie breaks
 * to the doc whose id already equals its canonical slug.
 */
export function buildTopicIdIndex(rows) {
  const byTuple = new Map();
  for (const t of rows) {
    const key = tupleKey(t.track, t.course, t.lesson, t.topic);
    const qc = t.questionCount || 0;
    const canonical = t.id === slug(t.track, t.course, t.lesson, t.topic);
    const prev = byTuple.get(key);
    if (!prev || qc > prev.qc || (qc === prev.qc && canonical && !prev.canonical)) {
      byTuple.set(key, { id: t.id, qc, canonical });
    }
  }
  return byTuple;
}

async function catalogIdIndex() {
  const snap = await db.collection(COL.topics).get();
  return buildTopicIdIndex(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}

/**
 * Append `userKey`'s results to their log AND update their running mastery stats. Mirrors the old
 * sheet (append rows) + its formulas (recompute accuracy / days-since / priority). For the legacy
 * owner this writes the original `topics`/`quizLog`; for others, their subcollections.
 */
export async function logResults(userKey, results) {
  if (!userKey) return 0;
  const now = new Date();
  const legacy = isLegacy(userKey);
  const batch = db.batch();

  // 1. Append each attempt to the user's quizLog.
  const logRef = logCol(userKey);
  for (const r of results) {
    batch.set(logRef.doc(), {
      track: r.track || '',
      course: r.course || '',
      lesson: r.lesson || '',
      topic: r.topic || '',
      question: r.question || '',
      result: r.isCorrect ? 1 : 0,
      reviewFlag: r.reviewFlag ? 1 : 0,
      date: Timestamp.fromDate(now),
    });
  }

  // 2. Aggregate per-topic deltas from this session, keyed by each topic's REAL
  //    catalog doc id (see catalogIdIndex). Falls back to slug(fields) only for a
  //    result whose topic no longer exists in the catalog (e.g. deleted mid-quiz).
  const idIndex = await catalogIdIndex();
  const deltas = new Map(); // topicDocId -> { meta, correct, total }
  for (const r of results) {
    const id = idIndex.get(tupleKey(r.track, r.course, r.lesson, r.topic))?.id
      || slug(r.track, r.course, r.lesson, r.topic);
    const cur = deltas.get(id) || { meta: r, correct: 0, total: 0 };
    cur.correct += r.isCorrect ? 1 : 0;
    cur.total += 1;
    deltas.set(id, cur);
  }

  // 3. Read current stats, then update counters + recompute priority.
  for (const [id, delta] of deltas) {
    const ref = statsDoc(userKey, id);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : {};
    const correctCount = (prev.correctCount || 0) + delta.correct;
    const totalAttempts = (prev.totalAttempts || 0) + delta.total;
    const stats = { correctCount, totalAttempts, lastAttempted: now };
    if (legacy) {
      // Preserve the catalog fields living on the shared `topics` doc (original behaviour).
      batch.set(
        ref,
        {
          track: prev.track ?? delta.meta.track ?? '',
          course: prev.course ?? delta.meta.course ?? '',
          lesson: prev.lesson ?? delta.meta.lesson ?? '',
          topic: prev.topic ?? delta.meta.topic ?? '',
          questionCount: prev.questionCount ?? 0,
          correctCount,
          totalAttempts,
          lastAttempted: Timestamp.fromDate(now),
          priority: computePriority(stats, now),
        },
        { merge: true },
      );
    } else {
      // A lean per-user stats doc (catalog stays on the shared `topics` doc, overlaid on read).
      batch.set(
        ref,
        {
          topic: delta.meta.topic ?? '',
          correctCount,
          totalAttempts,
          lastAttempted: Timestamp.fromDate(now),
          priority: computePriority(stats, now),
        },
        { merge: true },
      );
    }
  }

  await batch.commit();
  return deltas.size;
}
