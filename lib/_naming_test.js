/**
 * Off-cloud test for the sub-lesson NAMING rule (no Firestore, no network).
 *
 * A sub-lesson's name is the front of its recall card, so the two kinds of
 * curriculum need opposite names and every planner has to ask for the right one.
 * These guard the 2026-09-08 fix, after the Philosophy program shipped 28
 * label-only key points ("Myth of innate talent") whose cards taught nothing on
 * their own. See AGENTS.md §7 and `topicNameRule` in lib/gemini.js.
 *
 * Run:  node lib/_naming_test.js   (exit 0 = pass)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const { topicNameRule, scopeShapeRule } = await import('./gemini.js');

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failures += 1; }
};

console.log('topicNameRule');
const career = topicNameRule(false);
const reading = topicNameRule(true);

// The career rule is the one every technical program has always had. A claim-shaped
// name would assert ONE thing about a topic that has many, so it must not leak in.
ok(/short noun phrase/.test(career), 'career programs still ask for a short noun phrase');
ok(!/READING/.test(career), 'career rule says nothing about reading programs');
ok(topicNameRule() === career, 'omitting the flag keeps the career rule (every existing caller)');

// The reading rule has to do two things a softer instruction would not: forbid the
// label form outright, and cap the length, or the model returns a paragraph that
// no longer fits a card front.
ok(/CLAIM/.test(reading), 'reading rule asks for a claim');
ok(/14 words/.test(reading), 'reading rule caps the length');
ok(/Myth of innate talent/.test(reading), 'reading rule shows the label form it is rejecting');
ok(career !== reading, 'the two rules are actually different');

// Every planner that names a sub-lesson must interpolate the rule rather than
// hardcode one, or a program's names diverge by which door the content came in.
console.log('\nplanners interpolate the rule');
const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, 'gemini.js'), 'utf8');
for (const fn of ['classifyTranscript', 'digestSource', 'planFromSources', 'planCurriculum', 'planCurriculumEdit']) {
  const start = src.indexOf(`export async function ${fn}`);
  const body = src.slice(start, start + 12000);
  ok(start > -1 && /\{\s*reading\s*=\s*false\s*\}|reading = false/.test(body), `${fn} accepts a reading flag`);
  ok(body.includes('${topicNameRule(reading)}'), `${fn} interpolates topicNameRule`);
}

// The one hardcoded phrase this replaced must be gone from the prompts, or a
// planner would carry both rules and contradict itself for reading programs.
const prompts = src.slice(src.indexOf('const TOPIC_NAME_RULE_CONCEPT'));
const strays = prompts.split('named as a short noun phrase').length - 1;
ok(strays === 1, `only the shared constant says "named as a short noun phrase" (found ${strays})`);

// The SHAPE rule is separate from the NAMING rule and fixes the other half: where a
// book SITS. A reading program's lesson IS the book, because the book deck is built
// per lesson — get that backwards and the deck cannot exist, which is exactly what
// happened to The Charisma Myth and Do Hard Things.
console.log('\nscopeShapeRule');
ok(scopeShapeRule(false) === '', 'career programs get NO shape override (prompts byte-identical)');
ok(scopeShapeRule() === '', 'omitting the flag is the career case');
const shape = scopeShapeRule(true);
ok(/A LESSON is ONE BOOK/.test(shape), 'reading: the lesson is the book');
ok(/NEVER name a course after a book/.test(shape), 'reading: the course is a theme, not a book');
ok(/SEVERAL lessons/.test(shape), 'reading: a long book splits into lessons, not into a course');

// 🔴 planFromSources tells the model that sources are MATERIAL, never STRUCTURE. For a
// reading program that is exactly backwards, so the override has to be met AFTER it —
// the same top-to-bottom discipline deepBlock relies on (AGENTS §7). Moving the
// interpolation earlier still passes `node --check` and silently restores the bug.
console.log('\nthe override follows the rule it overrides');
{
  const start = src.indexOf('export async function planFromSources');
  const body = src.slice(start, start + 9000);
  const rule = body.indexOf('THE ONE RULE THAT MATTERS');
  const ovr = body.indexOf('${scopeShapeRule(reading)}');
  ok(rule > -1 && ovr > -1 && ovr > rule, 'planFromSources injects the reading override AFTER "sources are not structure"');
}
for (const fn of ['classifyTranscript', 'planCurriculumEdit']) {
  const start = src.indexOf(`export async function ${fn}`);
  ok(src.slice(start, start + 12000).includes('${scopeShapeRule(reading)}'), `${fn} carries the shape rule`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll naming tests passed.');
process.exit(failures ? 1 : 0);
