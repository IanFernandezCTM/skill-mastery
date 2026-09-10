/**
 * One-off data repair: give BOTH reading programs one shape.
 *
 *   COURSE      is always a THEME
 *   LESSON      is always one BOOK — or one PART of a long book, named with the book
 *   SUB-LESSON  is one key point, stated as a CLAIM (see topicNameRule, lib/gemini.js)
 *
 * WHY. Philosophy was running two shapes at once. Books filed through auto-file
 * ingest came out course=theme / lesson=book (Talent Is Overrated, Chatter…),
 * while books designed through the CORPUS PLANNER came out course=the book /
 * lesson=concept clusters — because `planFromSources` deliberately builds a
 * concept map and refuses to name anything after a source. The second shape is
 * not a style difference, it is broken: `buildBookDeck` is lesson-scoped
 * ("Book decks are built per lesson (the lesson is the book)"), so The Charisma
 * Myth and Do Hard Things could never produce a title card at all. All three
 * Spiritual courses had the same half-book/half-theme naming.
 *
 * WHAT IT DOES, in order (order matters — a lesson re-file must name its course
 * as it stands AT THAT MOMENT):
 *   1. renameScope at COURSE grain   — the Spiritual theme renames
 *   2. renameScope at LESSON grain   — 11 book parts get their book's name
 *   3. renameTopics                  — 60 sub-lessons become claims
 *   4. setTopicOrders                — stamps the Spiritual grains, which were never set
 *
 * 🔴 Steps 1 and 2 are `renameScope`, NOT `moveTopics`. A scope's NAME is the key
 * of its source transcript, its decks and its study guides; writing only the topic
 * rows keeps the questions and progress but silently strips the lesson of the book
 * it is grounded on. See lib/firestore.js.
 *
 * Doc ids never change, so per-user stats and the prereq graph are untouched, and
 * `renameTopics` carries each sub-lesson's banked questions across with it. The 42
 * Charisma / Do Hard Things sub-lessons have no bank yet; 13 of the 18 Spiritual ones
 * do, and travel fine because no name here is shared by two sub-lessons of one
 * program — preflight asserts exactly that, since a shared name is one pool that
 * cannot be split without naming question ids (as Philosophy's "Attention spotlight
 * and zooming" had to be).
 *
 * Run:
 *   node scripts/reshape-growth-books.mjs            # dry run, writes nothing
 *   node scripts/reshape-growth-books.mjs --apply    # writes
 *
 * Needs ADC for Firestore. Idempotent: a second run reports everything as already
 * done. Building the missing book DECKS is a separate, AI-costing step — see
 * scripts/build-book-decks.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  db, COL, renameScope, renameTopics, setTopicOrders, getCatalog, flashcardScopeId,
} from '../lib/firestore.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const { books } = JSON.parse(readFileSync(resolve(HERE, 'growth-books.json'), 'utf8'));

const problems = [];
const plan = [];

/* ------------------------------ preflight --------------------------------- */
for (const b of books) {
  const cat = (await getCatalog(null, { program: b.program })).filter((r) => r.topic && r.id);
  const inCourse = (co) => cat.filter((r) => r.track === b.track && r.course === co);

  // The course may already have been renamed by a previous run.
  const courseNow = inCourse(b.course).length ? b.course
    : (b.courseRename && inCourse(b.courseRename).length ? b.courseRename : null);
  if (!courseNow) { problems.push(`${b.program}: no course "${b.course}" in "${b.track}"`); continue; }

  const entry = {
    program: b.program,
    track: b.track,
    book: b.book,
    courseFrom: courseNow,
    courseTo: b.courseRename && courseNow !== b.courseRename ? b.courseRename : null,
    courseOrder: Number.isFinite(b.courseOrder) ? b.courseOrder : null,
    parts: [],
  };

  for (const p of b.parts) {
    const rows = inCourse(courseNow).filter((r) => r.lesson === p.lesson);
    const done = inCourse(courseNow).filter((r) => r.lesson === p.rename);
    const live = rows.length ? rows : done;
    if (!live.length) { problems.push(`${b.program}: no lesson "${p.lesson}" (nor "${p.rename}") in "${courseNow}"`); continue; }
    if (rows.length && done.length) { problems.push(`${b.program}: BOTH "${p.lesson}" and "${p.rename}" exist in "${courseNow}"`); continue; }

    const points = [];
    for (const [from, to] of Object.entries(p.points)) {
      const hit = live.filter((r) => r.topic === from);
      const already = live.filter((r) => r.topic === to);
      if (!hit.length && already.length) continue;              // previous run
      if (hit.length !== 1) {
        problems.push(`${b.program} / ${p.lesson}: "${from}" matched ${hit.length} rows`);
        continue;
      }
      points.push({ id: hit[0].id, from, to });
    }
    const named = new Set(Object.keys(p.points));
    for (const r of live) {
      if (!named.has(r.topic) && !Object.values(p.points).includes(r.topic)) {
        problems.push(`${b.program} / ${p.lesson}: sub-lesson "${r.topic}" is not in the plan`);
      }
    }

    entry.parts.push({
      lessonFrom: live[0].lesson,
      lessonTo: rows.length ? p.rename : null,
      lessonOrder: Number.isFinite(p.lessonOrder) ? p.lessonOrder : null,
      ids: live.map((r) => r.id),
      points,
    });
  }
  plan.push(entry);
}

// A banked question carries only {topic, program}, so a name shared by two
// sub-lessons of one program is ONE indistinguishable pool and `renameTopics`
// refuses to guess (it reports the name in `ambiguous` and leaves the questions
// where they are). Unshared names are re-keyed for free — most of Spiritual has a
// bank and travels fine. So the check is AMBIGUITY, not emptiness.
const banked = new Map();
{
  const wanted = plan.flatMap((e) => e.parts.flatMap((p) => p.points.map((x) => `${e.program}|${x.from}`)));
  const names = [...new Set(plan.flatMap((e) => e.parts.flatMap((p) => p.points.map((x) => x.from))))];
  for (let i = 0; i < names.length; i += 30) {
    const chunk = names.slice(i, i + 30);
    if (!chunk.length) continue;
    const snap = await db.collection(COL.questions).where('topic', 'in', chunk).get();
    for (const d of snap.docs) {
      const q = d.data();
      const k = `${q.program}|${q.topic}`;
      if (wanted.includes(k)) banked.set(k, (banked.get(k) || 0) + 1);
    }
  }
  // Claimants for each old name, from the catalog: >1 means the bank cannot be split by name.
  for (const e of plan) {
    const cat = await getCatalog(null, { program: e.program });
    for (const part of e.parts) {
      for (const t of part.points) {
        const claim = cat.filter((r) => r.topic === t.from).length;
        if (claim > 1 && banked.get(`${e.program}|${t.from}`)) {
          problems.push(`"${t.from}" (${e.program}) names ${claim} sub-lessons and has a shared bank — needs a questionIds split`);
        }
      }
    }
  }
}

if (problems.length) {
  console.error('\nPREFLIGHT FAILED — nothing written:');
  for (const p of [...new Set(problems)]) console.error('  ! ' + p);
  process.exit(1);
}

/* -------------------------------- report ---------------------------------- */
let nCourse = 0; let nLesson = 0; let nTopic = 0;
for (const e of plan) {
  console.log(`\n=== ${e.program} / ${e.track} / ${e.courseFrom}${e.courseTo ? `   ->  COURSE "${e.courseTo}"` : ''}`);
  if (e.courseTo) nCourse += 1;
  for (const p of e.parts) {
    console.log(`  LESSON "${p.lessonFrom}"${p.lessonTo ? `\n      -> "${p.lessonTo}"` : '   (already renamed)'}`);
    if (p.lessonTo) nLesson += 1;
    for (const t of p.points) { console.log(`        "${t.from}"\n          -> "${t.to}"`); nTopic += 1; }
  }
}
console.log(`\n${nCourse} course rename(s), ${nLesson} lesson rename(s), ${nTopic} sub-lesson rename(s).`);

if (!APPLY) {
  console.log('\nDry run — pass --apply to write.');
  process.exit(0);
}

/* --------------------------------- apply ---------------------------------- */
const totals = { topics: 0, transcripts: 0, cards: 0, guides: 0 };
const add = (r) => { for (const k of Object.keys(totals)) totals[k] += r[k] || 0; };

for (const e of plan) {
  // 1. COURSE grain first, so the lesson re-files below name the course as it now is.
  if (e.courseTo) {
    const r = await renameScope({ program: e.program, track: e.track, course: e.courseFrom }, { course: e.courseTo });
    add(r);
    console.log(`\ncourse "${e.courseFrom}" -> "${e.courseTo}"  ${JSON.stringify(r)}`);
  }
  const course = e.courseTo || e.courseFrom;

  // 2. LESSON grain — this is what carries the book's transcript with it.
  for (const p of e.parts) {
    if (!p.lessonTo) continue;
    const r = await renameScope(
      { program: e.program, track: e.track, course, lesson: p.lessonFrom },
      { lesson: p.lessonTo },
    );
    add(r);
    console.log(`  lesson "${p.lessonFrom}" -> "${p.lessonTo}"  ${JSON.stringify(r)}`);
  }
}

// 3. SUB-LESSONS. Ids were resolved before any re-file and never change.
const items = plan.flatMap((e) => e.parts.flatMap((p) => p.points.map((t) => ({ id: t.id, topic: t.to }))));
const res = await renameTopics(items);
console.log(`\nrenameTopics: ${JSON.stringify(res)}`);
if (res.skipped.length) for (const s of res.skipped) console.warn('  ! skipped', s.id, '-', s.reason);
if (res.ambiguous.length) console.warn('  ! questions left in place for:', res.ambiguous.join(', '));

// 4. The Spiritual grains were never stamped, so that program sorted by name.
{
  const orders = [];
  for (const e of plan) {
    for (const p of e.parts) {
      for (const id of p.ids) {
        const o = {};
        if (e.courseOrder != null) o.courseOrder = e.courseOrder;
        if (p.lessonOrder != null) o.lessonOrder = p.lessonOrder;
        if (Object.keys(o).length) orders.push({ id, ...o });
      }
    }
  }
  if (orders.length) console.log(`\nsetTopicOrders: stamped ${await setTopicOrders(orders)} rows`);
}

// 5. HEAL any deck whose scopeId still carries a pre-rename name.
//    A deck's scopeId is `flashcardScopeId(deckScope)` and the DECK's topic is ''
//    for a course- or lesson-level deck. `getFlashcards` queries on that id, so a
//    stale one makes the whole deck unreachable at the scope it now lives in — the
//    book deck simply vanishes while every card is still sitting there.
//    The OLD names are the ones written in growth-books.json (never rewritten), so
//    the old ids are computed EXACTLY rather than guessed, and only an exact match
//    is rewritten. That precision is what keeps this away from the Mathematics
//    track's ~900 LEGACY scopeIds, which are a different convention entirely (one
//    id per CARD, topic included) and must not be merged into deck-shaped ones.
{
  const pairs = [];
  for (const b of books) {
    const courseTo = b.courseRename || b.course;
    pairs.push({
      from: flashcardScopeId({ level: 'course', track: b.track, course: b.course, lesson: '', topic: '' }),
      to: flashcardScopeId({ level: 'course', track: b.track, course: courseTo, lesson: '', topic: '' }),
    });
    for (const part of b.parts) {
      pairs.push({
        from: flashcardScopeId({ level: 'lesson', track: b.track, course: b.course, lesson: part.lesson, topic: '' }),
        to: flashcardScopeId({ level: 'lesson', track: b.track, course: courseTo, lesson: part.rename, topic: '' }),
      });
    }
  }
  let healed = 0;
  for (const { from, to } of pairs) {
    if (from === to) continue;
    const snap = await db.collection(COL.flashcards).where('scopeId', '==', from).get();
    if (snap.empty) continue;
    const batch = db.batch();
    for (const d of snap.docs) batch.set(d.ref, { scopeId: to }, { merge: true });
    await batch.commit();
    healed += snap.size;
    console.log('  healed ' + snap.size + ' card(s)\n     ' + from + '\n  -> ' + to);
  }
  console.log('\nheal: ' + healed + " card(s) re-pointed at their deck's current scope.");
}

console.log(`\nDone. scope re-files touched ${totals.topics} rows, ${totals.transcripts} transcripts, ${totals.cards} cards, ${totals.guides} guides.`);
console.log('Next: node scripts/build-book-decks.mjs  (builds the missing book decks — costs AI).');
