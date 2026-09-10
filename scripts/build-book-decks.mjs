/**
 * Build the BOOK DECK for every lesson of a reading program that has none.
 *
 * A book deck is the fixed title→points shape `buildBookDeck` produces: card 1 is
 * the book (its back is the ordered key-point list — the recall target), then one
 * card per point whose back is written from the lesson's own transcript. It is
 * built per LESSON, which is why the shape repair in
 * scripts/reshape-growth-books.mjs had to come first: The Charisma Myth and Do
 * Hard Things were filed as COURSES, so no lesson of theirs could have a deck.
 *
 * This runs against the DEPLOYED service rather than in-process, because the deck
 * is written by an AI call and every provider/policy/usage path lives behind the
 * API. It POSTs `/api/flashcards/generate` with `book:true`, one lesson at a
 * time, over the SSE transport (a deck is a long single model call — see AGENTS §7
 * "A slow AI POST dies with Failed to fetch"; a plain POST of this would be
 * dropped in front of us while the work still succeeded).
 *
 * Auth is an `ag_sso` cookie minted from `platform-sso-key` (AGENTS §4).
 *
 *   $env:SSO_SECRET = (gcloud secrets versions access latest --secret platform-sso-key --project agora-data-driven)
 *   node scripts/build-book-decks.mjs                 # list what is missing, build nothing
 *   node scripts/build-book-decks.mjs --apply         # build them
 *   node scripts/build-book-decks.mjs --apply --program spiritual
 *
 * 🔴 Never re-POST a lesson that appeared to time out — the first call is almost
 * certainly still running and would bank the deck twice. Re-run the script instead;
 * it skips any lesson that already has a title card.
 */
import { createHmac } from 'node:crypto';
import { getCatalog, getFlashcards, getPrograms } from '../lib/firestore.js';

const BASE = process.env.MASTERY_URL || 'https://mastery-engine-585951669065.us-central1.run.app';
const SECRET = process.env.SSO_SECRET || '';
const APPLY = process.argv.includes('--apply');
const ONLY = (() => {
  const i = process.argv.indexOf('--program');
  return i > -1 ? process.argv[i + 1] : null;
})();

if (!SECRET) {
  console.error('SSO_SECRET is not set. See the header of this file.');
  process.exit(1);
}

/** The ag_sso shape lib/auth.js verifies: base64url({sub,exp}).base64url(HMAC). */
function cookie(sub = 'info@agoradatadriven.com', minutes = 90) {
  const p = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + minutes * 60 })).toString('base64url');
  return `${p}.${createHmac('sha256', SECRET).update(p, 'ascii').digest('base64url')}`;
}
const COOKIE = cookie();

/** POST over SSE and resolve the single `result` frame (sseResult's transport). */
async function postSSE(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Cookie: `ag_sso=${COOKIE}` },
    body: JSON.stringify(body),
  });
  if (!res.ok && !String(res.headers.get('content-type') || '').includes('text/event-stream')) {
    throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = '';
  let out = null;
  let failure = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (!d) continue;
        let parsed; try { parsed = JSON.parse(d); } catch { continue; }
        if (event === 'result') out = parsed;
        if (event === 'error') failure = parsed.error || 'AI request failed';
      }
    }
  }
  if (failure) throw new Error(failure);
  if (!out) throw new Error('the stream closed without a result');
  return out;
}

/* --------------------------- what is missing ------------------------------ */
const programs = (await getPrograms()).filter((p) => (p.category || 'career') === 'growth' && (!ONLY || p.id === ONLY));
if (!programs.length) { console.error('no reading (category "growth") programs found'); process.exit(1); }

const jobs = [];
for (const p of programs) {
  const rows = (await getCatalog(null, { program: p.id })).filter((r) => r.topic);
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.track}|${r.course}|${r.lesson}`;
    if (!seen.has(k)) seen.set(k, { program: p.id, track: r.track, course: r.course, lesson: r.lesson, points: [] });
    seen.get(k).points.push(r);
  }
  for (const s of seen.values()) {
    const cards = await getFlashcards({ level: 'lesson', track: s.track, course: s.course, lesson: s.lesson });
    const has = cards.some((c) => c.kind === 'title');
    s.points.sort((a, b) => (Number.isFinite(a.order) ? a.order : 99) - (Number.isFinite(b.order) ? b.order : 99));
    console.log(`${has ? '  ok ' : '  -- '} ${p.id} / ${s.course} / ${s.lesson}  (${s.points.length} points)${has ? '' : '   NO BOOK DECK'}`);
    if (!has) jobs.push(s);
  }
}

console.log(`\n${jobs.length} lesson(s) need a book deck.`);
if (!jobs.length) process.exit(0);
if (!APPLY) { console.log('Dry run — pass --apply to build them.'); process.exit(0); }

/* ------------------------------- build ------------------------------------ */
let built = 0;
for (const [i, s] of jobs.entries()) {
  process.stdout.write(`\n[${i + 1}/${jobs.length}] ${s.lesson} … `);
  try {
    const r = await postSSE('/api/flashcards/generate', {
      program: s.program, level: 'lesson', track: s.track, course: s.course, lesson: s.lesson, book: true,
    });
    // The route packages the whole deck, so `cards` is the array itself, not a count.
    const n = Number.isFinite(r.count) ? r.count : (Array.isArray(r.cards) ? r.cards.length : '?');
    console.log(`built ${n} cards`);
    built += 1;
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }
}
console.log(`\nDone. ${built}/${jobs.length} decks built. Re-run to retry any that failed.`);
