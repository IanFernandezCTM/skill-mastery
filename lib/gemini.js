/**
 * Gemini-backed "Wise Teacher" question generator.
 * Ported from Code.gs handleGenSelection.
 *
 * BILLING: this calls Gemini through **Vertex AI** (aiplatform.googleapis.com),
 * so usage is billed to the GCP project's Vertex AI line — NOT the standalone
 * AI Studio "Gemini API" (generativelanguage.googleapis.com + ?key=API_KEY),
 * which is what this used to use. Auth is Application Default Credentials: the
 * Cloud Run runtime service account in prod (needs roles/aiplatform.user), or
 * `gcloud auth application-default login` locally — the same ADC Firestore uses.
 * No GEMINI_API_KEY is required anymore.
 */
import { GoogleAuth } from 'google-auth-library';
import { callOllama, streamOllama, DEFAULT_MODEL as OLLAMA_DEFAULT } from './ollama.js';
import { callLMStudio, streamLMStudio, DEFAULT_MODEL as LMSTUDIO_DEFAULT } from './lmstudio.js';
import { callDeepSeek, streamDeepSeek, deepseekConfigured, DEFAULT_MODEL as DEEPSEEK_DEFAULT } from './deepseek.js';
import { callKimi, streamKimi, kimiConfigured, DEFAULT_MODEL as KIMI_DEFAULT } from './kimi.js';
import { callAnthropic, streamAnthropic, anthropicConfigured, DEFAULT_MODEL as ANTHROPIC_DEFAULT } from './anthropic.js';
import { recordUsage, aiPolicy } from './usage.js';
// The neutral audience fallback. WHO a question is written for is a property of
// the program, so it lives in programs.js (pure, IO-free); this file only renders it.
import { DEFAULT_AUDIENCE } from './programs.js';
import { readFileSync } from 'node:fs';

// The assistant's "self-knowledge": a single authoritative doc (the same one humans read) describing
// how the engine works, its exact formulas, and the research it's built on. Loaded once and injected
// into the assistant prompt so it can answer "what's your mastery formula?" / "what research is this
// based on?" accurately. Missing file degrades gracefully (assistant still works, just less self-aware).
let _appKnowledge;   // undefined = not loaded yet; string (possibly '') once loaded
function appKnowledge() {
  if (_appKnowledge !== undefined) return _appKnowledge;
  try { _appKnowledge = readFileSync(new URL('../docs/HOW-IT-WORKS.md', import.meta.url), 'utf8').trim(); }
  catch { _appKnowledge = ''; }
  return _appKnowledge;
}
// Only spend the tokens on the FULL doc when the question is actually about the app/engine/research;
// otherwise a one-line identity is enough for a "explain this card" style turn.
const META_QUESTION_RE = /\b(you|your|yourself|this app|this tool|mastery engine|the engine|formula|priorit|spaced|repetition|algorithm|research|paper|study|based on|how (do(es)?|is) (you|it|this|the)|what are you|who (made|built)|architecture|academy|drill|weakness|mastery)\b/i;
const APP_IDENTITY = 'You are the built-in study assistant of the AGORA Mastery Engine, a spaced-repetition mastery-learning app.';
function knowledgeBlock(message) {
  const full = appKnowledge();
  if (full && META_QUESTION_RE.test(String(message || ''))) {
    return `ABOUT THIS APP — AUTHORITATIVE GROUND TRUTH (you ARE this app; answer questions about how it works, its exact formulas, and the research behind it from THIS, not from guesses):\n\n${full}`;
  }
  return APP_IDENTITY;
}

/** Record a Gemini call's token usage (thinking tokens are billed as output). */
function recordGeminiUsage(model, um) {
  if (!um) return;
  const input = um.promptTokenCount || 0;
  let output = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
  if (!output && um.totalTokenCount) output = Math.max(0, um.totalTokenCount - input);
  recordUsage({ provider: 'gemini', model, inputTokens: input, outputTokens: output });
}

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Vertex region. "global" serves the 2.5 models everywhere and avoids regional
// capacity errors; override with a region (e.g. us-central1) if data residency
// requires it.
const LOCATION = process.env.GEMINI_LOCATION || 'global';

// One ADC client for the whole process; it caches/refreshes access tokens itself.
const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
let projectIdPromise; // resolved once from the metadata server / ADC / env

async function projectId() {
  if (!projectIdPromise) {
    projectIdPromise = auth.getProjectId().catch((e) => {
      projectIdPromise = undefined; // let a later call retry
      throw new Error(
        `Could not determine the GCP project for Vertex AI (set GOOGLE_CLOUD_PROJECT or run 'gcloud auth application-default login'): ${e.message}`,
      );
    });
  }
  return projectIdPromise;
}

/** Build the Vertex REST target + a fresh bearer token for a model/method. */
async function vertexTarget(model, method, sse = false) {
  const project = await projectId();
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  // encodeURIComponent: the model id reaches us from a client-settable cookie, so
  // without encoding a crafted "../../<publisher>/models/x" pivots the URL path to
  // another Vertex publisher. Real ids (letters/digits/dots/dashes) are unaffected.
  const url = `https://${host}/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${encodeURIComponent(model)}:${method}${sse ? '?alt=sse' : ''}`;
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Vertex AI auth failed: no access token from ADC');
  return { url, token };
}

/**
 * Provider dispatcher. Every prompt builder calls this so the AI engine can be
 * switched per request: { provider: 'gemini'|'deepseek'|'kimi'|'ollama'|'lmstudio', model }
 * (defaults Gemini). `model` also selects the Gemini variant, e.g. gemini-2.5-pro.
 * `thinking` turns extended thinking on/off (Gemini via thinkingBudget; DeepSeek
 * V4 and Kimi K2.6 via the `thinking` toggle — which defaults ON server-side, so
 * we must pass it explicitly for the "fast" path); `schema` (Gemini only) is a
 * responseSchema that guarantees the JSON shape at decode time.
 */
/**
 * Enforce the per-user AI allowlist at the single choke point every AI path
 * funnels through (complete/completeStream are module-private, so no call can
 * bypass this — including the aiForFiles attachment reroute in server.js). The
 * policy is resolved per request by server.js middleware (admins → null =
 * unrestricted). A provider outside the allowlist silently falls back to the
 * user's cheapest permitted engine (Kimi when allowed) rather than erroring,
 * so a stale devtools cookie can't strand a learner mid-feature.
 */
/** Can this provider actually serve a request HERE? (Sync check only — the local
 *  engines are probe-based, so we never clamp ONTO them; gemini rides ADC and is
 *  always available on Cloud Run.) Prevents clamping a user onto a provider whose
 *  key isn't mounted, which would 500 their every AI feature. */
function providerUsable(p) {
  if (p === 'gemini') return true;
  if (p === 'kimi') return kimiConfigured();
  if (p === 'deepseek') return deepseekConfigured();
  if (p === 'anthropic') return anthropicConfigured();
  return false;
}

/**
 * The model id an adapter will ACTUALLY use when the caller passes none. Each
 * adapter owns its own `model || DEFAULT_MODEL` fallback, so this is the only
 * place the full pair can be known without duplicating that logic.
 */
const DEFAULT_MODELS = {
  gemini: () => MODEL,
  deepseek: () => DEEPSEEK_DEFAULT,
  kimi: () => KIMI_DEFAULT,
  anthropic: () => ANTHROPIC_DEFAULT,
  ollama: () => OLLAMA_DEFAULT,
  lmstudio: () => LMSTUDIO_DEFAULT,
};

/**
 * Report the provider/model a call RESOLVED to, for callers that must record
 * provenance ("which engine wrote this artifact?").
 *
 * It has to be an out-param rather than a return value because every prompt
 * builder returns the model's text, and there are ~35 of them. Pass
 * `{ ...ai, meta }` and read `meta.provider` / `meta.model` after the await.
 *
 * 🔴 Never record `aiChoice(req)` instead. That is the REQUEST. clampToPolicy
 * below can downgrade a disallowed provider — and when it does it clears
 * `model`, so the id that actually ran is the adapter's own default, which the
 * caller has no other way to see. Filled synchronously right after the clamp,
 * so concurrent calls (mapWithConcurrency / Promise.all) can't cross-write:
 * each one gets its own object.
 *
 * The adapters then add `meta.finishReason` — the provider's own word for WHY it
 * stopped (Gemini `finishReason`, the OpenAI-shaped ones `finish_reason`,
 * Anthropic `stop_reason`). It is the one fact that distinguishes "the model
 * wrote bad JSON" from "the model was cut off mid-JSON at the token ceiling",
 * and without it every malformed payload looks the same. See describeJsonFailure.
 */
function fillEngineMeta(meta, provider, model) {
  if (!meta) return;
  const p = provider || 'gemini';
  meta.provider = p;
  meta.model = model || (DEFAULT_MODELS[p] ? DEFAULT_MODELS[p]() : '');
}

function clampToPolicy(provider, model) {
  const pol = aiPolicy();
  if (!pol || !Array.isArray(pol.providers) || !pol.providers.length) return { provider, model };
  const effective = provider || 'gemini'; // no explicit provider = the Gemini fallthrough below
  if (pol.providers.includes(effective)) return { provider, model };
  // Cheapest USABLE permitted engine, Kimi first; if the allowlist names nothing
  // this deployment can actually serve (e.g. Kimi-only with no key in local dev),
  // availability beats policy — degrade to Gemini rather than brick every feature.
  const fallback = ['kimi', 'deepseek', 'gemini', 'anthropic']
    .find((p) => pol.providers.includes(p) && providerUsable(p)) || 'gemini';
  return { provider: fallback, model: undefined };
}

async function complete(prompt, { json = false, provider, model, thinking, schema, search = false, attachments = [], meta } = {}) {
  ({ provider, model } = clampToPolicy(provider, model));
  fillEngineMeta(meta, provider, model);
  // `search` (Google Search grounding / internet access) and file attachments are Gemini-via-Vertex
  // capabilities only; the other providers don't support them here, so they're ignored for them.
  // `meta` rides along so each adapter can report its own finishReason (see fillEngineMeta).
  if (provider === 'deepseek') return callDeepSeek(prompt, { json, model, thinking, meta });
  if (provider === 'kimi') return callKimi(prompt, { json, model, thinking, meta });
  if (provider === 'anthropic') return callAnthropic(prompt, { json, model, meta });
  if (provider === 'ollama') return callOllama(prompt, { json, model });
  if (provider === 'lmstudio') return callLMStudio(prompt, { json, model });
  return callGemini(prompt, { json, model, thinking, schema, search, attachments, meta });
}

/** Streaming dispatcher: invokes onToken(textChunk, kind) as tokens arrive, where
 * kind is 'content' or 'thinking'. `thoughts:true` asks Gemini for its thought
 * summaries too (the OpenAI-style providers stream reasoning_content regardless);
 * it's opt-in so the learner-facing streams are unchanged. */
async function completeStream(prompt, { provider, model, thinking, thoughts, search, attachments = [], meta } = {}, onToken) {
  ({ provider, model } = clampToPolicy(provider, model));
  fillEngineMeta(meta, provider, model);
  if (provider === 'deepseek') return streamDeepSeek(prompt, model, onToken, { thinking });
  if (provider === 'kimi') return streamKimi(prompt, model, onToken, { thinking });
  if (provider === 'anthropic') return streamAnthropic(prompt, model, onToken);
  if (provider === 'ollama') return streamOllama(prompt, model, onToken);
  if (provider === 'lmstudio') return streamLMStudio(prompt, model, onToken);
  // `search` (Google Search grounding) + file attachments are Gemini-via-Vertex capabilities only.
  return streamGemini(prompt, onToken, model, thinking, thoughts, !!search, attachments);
}

/**
 * Build the Gemini generationConfig shared by the blocking and streaming calls.
 * - JSON mode / responseSchema (schema implies JSON) guarantees a parseable shape.
 * - Extended thinking defaults to the model's own default. When the caller passes
 *   thinking === false we disable it, but ONLY on models that accept a zero budget
 *   (2.5 Flash / Flash-Lite). Pro keeps a minimum thinking budget and would reject
 *   thinkingBudget: 0, so we leave it alone there.
 */
// Turn user-uploaded files into Gemini inlineData parts (multimodal input). Only Gemini-via-Vertex
// gets these; other providers ignore attachments. We accept images, PDFs, and text, cap the count,
// and pass base64 straight through. Anything malformed/unsupported is silently dropped.
function attachmentParts(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => a && a.data && a.mimeType && /^(image\/|application\/pdf|text\/)/i.test(a.mimeType))
    .slice(0, 6)
    .map((a) => ({ inlineData: { mimeType: a.mimeType, data: String(a.data) } }));
}

// The user prompt as Gemini `parts`: the text, then any uploaded files.
function userParts(prompt, attachments) {
  return [{ text: prompt }, ...attachmentParts(attachments)];
}

function geminiGenConfig(model, { json = false, thinking, schema } = {}) {
  const gc = {};
  if (json || schema) gc.responseMimeType = 'application/json';
  if (schema) gc.responseSchema = schema;
  if (thinking === false && /flash/i.test(model)) gc.thinkingConfig = { thinkingBudget: 0 };
  return Object.keys(gc).length ? gc : undefined;
}

/**
 * Runs a prompt. If onToken is supplied, streams (calling onToken per chunk) and
 * returns the accumulated text; otherwise does a single blocking completion.
 *
 * The reasoning trace ('thinking' chunks) is deliberately NOT forwarded here nor
 * accumulated: this is the path the learner-facing endpoints (hint, explanation,
 * analysis, study guides) use, and they want only the answer. Callers that DO want
 * to surface the model's thinking use streamStructured below.
 */
async function run(prompt, opts = {}, onToken) {
  if (typeof onToken === 'function') {
    let acc = '';
    await completeStream(prompt, opts, (t, kind) => {
      if (kind === 'thinking') return;
      acc += t; onToken(t);
    });
    return acc;
  }
  return complete(prompt, opts);
}

/**
 * Stream a prompt while forwarding BOTH the reasoning trace and the answer to
 * `onToken(text, kind)` (kind: 'thinking' | 'content'), and return the accumulated
 * CONTENT only (thinking excluded) so the caller can parse structured JSON out of
 * it. This is what lets the Composing Room show what the model is thinking while it
 * drafts a placement / module plan.
 */
async function streamStructured(prompt, opts = {}, onToken) {
  let acc = '';
  await completeStream(prompt, { ...opts, thoughts: true }, (t, kind) => {
    const k = kind === 'thinking' ? 'thinking' : 'content';
    if (k === 'content') acc += t;
    if (typeof onToken === 'function') onToken(t, k);
  });
  return acc;
}

/**
 * Parse JSON returned by an LLM, which is not always pristine. Providers/models
 * vary: some wrap the JSON in a ```json fence, some (local/"thinking" models)
 * emit a <think>…</think> block before it, and — the big one for our chat and
 * flashcard prompts — models routinely UNDER-ESCAPE LaTeX backslashes ("\int",
 * "\alpha", "\cdot" …). Those are illegal JSON string escapes, so a bare
 * JSON.parse throws ("returned non-JSON content") even though the payload is
 * "obviously" a JSON object. We therefore (1) strip reasoning blocks and code
 * fences, (2) slice to the first balanced {...} / [...], (3) parse; and ONLY if
 * that throws, (4) escape every backslash that doesn't begin a valid JSON escape
 * and parse once more. Strict parsing is always attempted first, so this never
 * alters already-valid JSON. Throws (like JSON.parse) when truly unrecoverable.
 */
function parseLooseJson(raw) {
  if (typeof raw !== 'string') return raw; // already parsed upstream
  let s = raw.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); // drop reasoning leak
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); // unwrap a code fence
  if (fence) s = fence[1].trim();
  // Trim prose around the JSON: from the first { or [ to its matching last } or ].
  const open = s.search(/[{[]/);
  if (open > 0) s = s.slice(open);
  if (s[0] === '{' || s[0] === '[') {
    const close = s.lastIndexOf(s[0] === '{' ? '}' : ']');
    if (close > 0) s = s.slice(0, close + 1);
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    // Repair, then retry once. Two malformations dominate LLM JSON, and the
    // "fast" (thinking-off) Flash path emits BOTH far more often than the
    // reasoning path: (1) RAW control chars inside a string — a multi-line
    // markdown reply written with literal newlines/tabs instead of \n/\t, which
    // is illegal JSON ("Bad control character in string literal"); and (2)
    // UNDER-ESCAPED LaTeX — a lone "\" not starting a valid JSON escape
    // (\" \\ \/ \b \f \n \r \t \uXXXX). Fix (1) by escaping control chars that
    // sit INSIDE string literals (structural whitespace between tokens is left
    // alone), then (2) by doubling the stray backslashes.
    const repaired = escapeRawControlsInStrings(s).replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    if (repaired !== s) {
      try { return JSON.parse(repaired); } catch { /* unrecoverable — throw the original below */ }
    }
    throw e;
  }
}

// Escape raw control characters (U+0000–U+001F) that appear INSIDE a JSON string
// literal, converting each to its \-escape so the payload becomes legal JSON.
// Scans char-by-char tracking string state, so newlines/tabs used for structure
// BETWEEN tokens (e.g. pretty-printed JSON) are untouched. Idempotent on valid
// JSON. An unescaped inner double-quote still defeats it (genuinely ambiguous);
// a responseSchema is the only robust cure for that rarer case.
const CTRL_ESCAPES = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };
function escapeRawControlsInStrings(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      const code = s.charCodeAt(i);
      if (code < 0x20) { out += CTRL_ESCAPES[code] || `\\u${code.toString(16).padStart(4, '0')}`; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/* ------------------- AI failure diagnostics (the 🐞 panel) ------------------
 * Why this exists: a payload that would not parse used to surface as ONE
 * sentence — "<label> returned non-JSON content" — with the raw text dropped on
 * the floor inside the catch. So every occurrence was unexplainable after the
 * fact, and the same handful of causes got re-guessed at each time. These
 * helpers keep the evidence instead: what ran, why the parse died, and the text
 * around the break. server.js forwards it to the browser as `diag` on the error
 * body, and logs a `[ai-fail]` line for Cloud Logging.
 *
 * 🔴 The PROMPT body is deliberately never recorded — only its size. It carries
 * the learner's growth journal, their task board and (in deep mode) the answer
 * key, and none of that is needed to explain a broken reply.
 */
const DIAG_SAMPLE_CHARS = 700;   // head/tail of the payload kept for the panel
const DIAG_WINDOW_CHARS = 140;   // context quoted either side of the break

/** File one AI failure where a human can find it later. One structured line, so
 *  Cloud Logging can filter it:  logs read mastery-engine | Select-String ai-fail */
function logAiFailure(entry) {
  try { console.error('[ai-fail]', JSON.stringify(entry)); } catch { /* diagnostics are never load-bearing */ }
}

// V8 reports the offset it gave up at ("… in JSON at position 1234"), which is
// the single most useful fact about a broken payload — it points at the exact
// character to look at. Node 20 appends "(line X column Y)"; the position is in
// both shapes.
function parseErrorPosition(err) {
  const m = /position (\d+)/.exec(String((err && err.message) || ''));
  return m ? Number(m[1]) : -1;
}

/**
 * Explain, in a sentence a person can act on, why an LLM's "JSON" would not
 * parse. Ordered most-certain first: a finishReason the provider actually told
 * us beats a guess from the text, and a guess from the text beats quoting the
 * parser at someone. `cause` is a stable slug (the UI groups on it); `explain`
 * is prose for the panel.
 */
export function describeJsonFailure(raw, err, meta = {}) {
  const text = typeof raw === 'string' ? raw : '';
  const trimmed = text.trim();
  const pos = parseErrorPosition(err);
  const parserMessage = String((err && err.message) || 'JSON.parse failed');
  const finishReason = String(meta.finishReason || '');
  const closed = /[}\]]$/.test(trimmed);
  // The character the parser choked on, plus its neighbour — a stray " shows up here.
  const near = pos >= 0 ? text.slice(Math.max(0, pos - 1), pos + 1) : '';

  let cause = 'malformed';
  let explain = 'The payload is not valid JSON and the repair pass (control characters, stray backslashes) could not fix it.';

  if (!trimmed) {
    cause = 'empty';
    explain = 'The model returned an empty payload — nothing to parse. Usually a blocked prompt or a response that spent its whole budget on thinking.';
  } else if (/^(MAX_TOKENS|length|max_tokens)$/i.test(finishReason)) {
    cause = 'truncated';
    explain = `The model hit its output ceiling and was cut off mid-payload (finishReason: ${finishReason}), so the closing brace never arrived. Thinking tokens count against that ceiling. Ask for a shorter answer, or split the request.`;
  } else if (/^(SAFETY|RECITATION|PROHIBITED_CONTENT|BLOCKLIST|SPII|content_filter)$/i.test(finishReason)) {
    cause = 'blocked';
    explain = `The provider stopped the response for a policy reason (finishReason: ${finishReason}), so the payload is a fragment.`;
  } else if (!/[{[]/.test(text)) {
    cause = 'no-json';
    explain = 'The model answered in prose and never opened a JSON object at all, despite being asked for one — common on providers with no real JSON mode.';
  } else if (!closed && pos >= 0 && pos >= text.length - 2) {
    cause = 'truncated';
    explain = 'The payload stops mid-value with no closing brace, and the parser gave up at the very end — it was cut off in transit or at the token ceiling.';
  } else if (/control character/i.test(parserMessage)) {
    cause = 'raw-control-char';
    explain = 'A literal newline or tab sits inside a JSON string (legal in markdown, illegal in JSON). The repair pass escapes these, so seeing it here means the payload is broken in a second way too.';
  } else if (/escaped character|Bad escaped/i.test(parserMessage)) {
    cause = 'latex-backslash';
    explain = 'An under-escaped backslash — almost always LaTeX ("\\alpha", "\\frac") written with one backslash where JSON needs two. The repair pass doubles these, so it survived that too.';
  } else if (near.includes('"')) {
    cause = 'stray-quote';
    explain = 'An unescaped double quote inside a string value: from that character on, the parser reads prose as JSON structure. This is the one malformation the repair pass genuinely cannot fix — where the string ends is ambiguous.';
  }

  return {
    cause,
    explain,
    parserMessage,
    position: pos,
    chars: text.length,
    finishReason: finishReason || null,
    provider: meta.provider || null,
    model: meta.model || null,
    // The break, quoted in context, with a marker at the exact offset.
    excerpt: pos >= 0
      ? `${text.slice(Math.max(0, pos - DIAG_WINDOW_CHARS), pos)}⟪break⟫${text.slice(pos, pos + DIAG_WINDOW_CHARS)}`
      : '',
    head: text.slice(0, DIAG_SAMPLE_CHARS),
    tail: text.length > DIAG_SAMPLE_CHARS ? text.slice(-DIAG_SAMPLE_CHARS) : '',
  };
}

/**
 * Parse an LLM's JSON the way every prompt here needs it — strictly, then with
 * the repair pass — and when both fail, throw a DIAGNOSED error instead of a
 * bare sentence. The Error carries `.diag` (describeJsonFailure's report), which
 * server.js hands to the browser for the 🐞 panel.
 *
 * Prefer this over a bare `try { parseLooseJson(x) } catch { throw new Error(…) }`
 * for anything a learner is sitting in front of.
 */
export function parseAiJson(label, raw, { meta = {}, route = '', promptChars = 0 } = {}) {
  try {
    return parseLooseJson(raw);
  } catch (e) {
    // promptChars, not the prompt: "48k of prompt in, 6k of reply cut off" is most of the diagnosis
    // for a truncation, and the prompt itself is the one thing that must not surface (see above).
    const diag = { label, route, kind: 'json-parse', promptChars: promptChars || null, ...describeJsonFailure(raw, e, meta) };
    logAiFailure({ ...diag, head: undefined, tail: undefined });
    throw Object.assign(new Error(`${label} returned non-JSON content (${diag.cause})`), { diag });
  }
}

const JSON_UNESCAPE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
/** Undo JSON string escapes WITHOUT parsing. An unknown escape is left exactly
 *  as written, which is what LaTeX needs: "\alpha" must stay "\alpha". */
function unescapeJsonish(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})|\\([\s\S])/g, (m, u, c) => {
    if (u) return String.fromCharCode(parseInt(u, 16));
    return JSON_UNESCAPE[c] !== undefined ? JSON_UNESCAPE[c] : m;
  });
}

/**
 * Pull one string field out of a payload that would NOT parse, so a broken
 * envelope costs the learner formatting rather than their whole answer.
 *
 * Deliberately not a JSON parser: it exists for the two malformations JSON.parse
 * cannot survive — a tail cut off at the token ceiling (no closing quote, no
 * closing brace) and an unescaped " inside the value. So it finds "<key>": ",
 * then takes everything up to the LAST quote that looks like the end of a value
 * (one followed by , or } or the end of input), which is the greedy reading a
 * stray inner quote needs. Returns '' when there is nothing worth showing.
 */
export function salvageJsonString(raw, key) {
  const s = typeof raw === 'string' ? raw : '';
  const at = new RegExp(`"${key}"\\s*:\\s*"`).exec(s);
  if (!at) return '';
  const start = at.index + at[0].length;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }              // escaped char — skip the pair
    if (s[i] !== '"') continue;
    const rest = s.slice(i + 1).replace(/^\s+/, '');
    if (rest === '' || rest[0] === ',' || rest[0] === '}') end = i;   // plausible end of the value
  }
  const body = s.slice(start, end >= 0 ? end : undefined);            // no end found ⇒ truncated: take the rest
  return unescapeJsonish(body).trim();
}

// The nastier cousin of the under-escape above: when a model single-escapes a
// LaTeX command whose first letter is a JSON escape char — "\texttt", "\frac",
// "\neq", "\beta", "\rho" — JSON.parse SUCCEEDS but turns the "\t \f \n \b \r"
// into a literal control CHARACTER, so "\texttt{x}" arrives as TAB+"exttt{x}"
// (renders as "exttt{"). parseLooseJson never sees it because parsing didn't
// fail. Reconstruct the command: a control char IMMEDIATELY followed by a
// LOWERCASE letter was a backslash escape (every LaTeX command that starts
// t/f/n/b/r continues lowercase), so restore the backslash. Requiring lowercase
// leaves genuine line breaks/tabs before capitals, digits, or "- " bullets
// untouched. Idempotent: correctly-stored "\texttt" has no control char.
const CTRL_TO_LATEX = { '\t': '\\t', '\f': '\\f', '\b': '\\b', '\r': '\\r', '\n': '\\n' };
export function restoreLatexEscapes(s) {
  return typeof s === 'string'
    ? s.replace(/[\t\f\b\r\n](?=[a-z])/g, (c) => CTRL_TO_LATEX[c] || c)
    : s;
}

/**
 * Shared formatting contract so all math AND code render in the app's renderer.
 * The frontend auto-renders $...$, $$...$$, \(...\) and \[...\] as KaTeX, and
 * turns \texttt{...} into inline code chips. It does NOT render raw HTML or
 * markdown backticks, so the model must never emit those for code.
 */
const LATEX_RULE = `MATH FORMATTING (the app renders math with KaTeX, so follow this exactly):
- Wrap ALL mathematical notation in LaTeX delimiters: inline math in single dollar signs like $x^2$, and standalone/display math in double dollar signs like $$\\int_0^1 x\\,dx$$.
- Use ONLY standard KaTeX-supported commands (e.g. \\frac, \\sqrt, \\sum, \\int, \\lim, \\partial, ^, _, \\cdot, \\times, \\le, \\ge, \\neq, \\to, \\infty, Greek letters like \\alpha \\beta \\theta, \\mathbf, \\vec, \\hat, and \\begin{aligned}...\\end{aligned} or \\begin{bmatrix}...\\end{bmatrix} for multi-line/matrix layouts).
- Do NOT use unsupported environments (no \\begin{align}, \\begin{equation}, \\label, \\tag, \\require) or custom macros, and do NOT wrap math in code fences or backticks.
- Never write bare Unicode math symbols (no raw ×, ÷, √, ², ∑, ∫, π, ≤): always express them in LaTeX inside the delimiters above.
- If you need a literal dollar sign (for example currency like five dollars), write it escaped as \\$ so it is NOT treated as the start of math.

CODE FORMATTING (the app renders code as inline chips, NOT with HTML or markdown):
- Wrap ALL programming syntax in \\texttt{...}: identifiers, keywords, function/method signatures, snippets, and calls (e.g. \\texttt{def demo(a, b, *args):}, \\texttt{*args}, \\texttt{__iter__}, \\texttt{StopIteration}, \\texttt{model.fit(X, y)}).
- NEVER use HTML tags (no <code>, <pre>, <b>, <i>, <br>, <sub>, <sup>) and NEVER use markdown backticks or asterisks for code — they render as literal characters, not formatting.
- Keep code and math separate: code goes in \\texttt{...}, math goes in $...$. Code must NEVER be placed inside $...$.`;

/** Low-level call to Gemini via Vertex AI. Returns the raw text part. `model` overrides the default (e.g. Pro). */
async function callGemini(prompt, { json = false, model, thinking, schema, search = false, attachments = [], meta } = {}) {
  const useModel = model || MODEL;
  const { url, token } = await vertexTarget(useModel, 'generateContent');
  const body = {
    contents: [{ role: 'user', parts: userParts(prompt, attachments) }],
  };
  // Google Search grounding (internet access). Vertex forbids pairing it with JSON / responseSchema
  // mode, so when search is on we drop the JSON constraint and take grounded plain text instead —
  // the caller (assistant chat) parses accordingly. Thinking config still applies.
  if (search) {
    body.tools = [{ googleSearch: {} }];
    const gc = geminiGenConfig(useModel, { thinking });
    if (gc) body.generationConfig = gc;
  } else {
    const gc = geminiGenConfig(useModel, { json, thinking, schema });
    if (gc) body.generationConfig = gc;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Vertex Gemini ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  // Concatenate all text parts — a grounded (search) reply can arrive split across several parts.
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text || '').join('') : parts?.[0]?.text;
  // Why it stopped, recorded BEFORE the empty check: MAX_TOKENS here is the difference between
  // "the model wrote broken JSON" and "the model was still writing when the budget ran out", and
  // dropping it is what made every truncated payload indistinguishable from a malformed one.
  const finish = data?.candidates?.[0]?.finishReason || '';
  if (meta) meta.finishReason = finish;
  if (!text) {
    // A blocked prompt and an all-thinking-no-answer response both land here; naming the reason
    // turns an unexplainable "returned no content" into something you can act on.
    const why = finish || data?.promptFeedback?.blockReason || '';
    throw new Error(`Gemini returned no content${why ? ` (${why})` : ''}`);
  }
  recordGeminiUsage(useModel, data.usageMetadata);
  return text;
}

/** Streaming call to Gemini via Vertex AI (SSE). Invokes onToken(textChunk, kind)
 * as tokens arrive, where kind is 'content' or 'thinking'. `thoughts` (opt-in) asks
 * for thought summaries so a caller can show what the model is thinking; without it
 * this behaves exactly as before (content only). `model` overrides the default. */
async function streamGemini(prompt, onToken, model, thinking, thoughts, search = false, attachments = []) {
  const useModel = model || MODEL;
  const { url, token } = await vertexTarget(useModel, 'streamGenerateContent', true);
  const body = { contents: [{ role: 'user', parts: userParts(prompt, attachments) }] };
  // Google Search grounding: stream a grounded PLAIN-TEXT answer (no JSON/schema
  // conflict since streamed answers aren't JSON). Lets the web path stream + pause.
  if (search) body.tools = [{ googleSearch: {} }];
  const gc = geminiGenConfig(useModel, { thinking }) || {};
  // Thought summaries are opt-in (admin planners) and only when thinking isn't
  // explicitly disabled — so the learner-facing streams are byte-for-byte unchanged.
  // Grounding replaces the reasoning trace, so skip thoughts when searching.
  if (thoughts && thinking !== false && !search) gc.thinkingConfig = { ...(gc.thinkingConfig || {}), includeThoughts: true };
  if (Object.keys(gc).length) body.generationConfig = gc;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const txt = res.body ? await res.text().catch(() => '') : '';
    throw new Error(`Vertex Gemini ${res.status}: ${txt.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        // A chunk can carry several parts; thought summaries are flagged part.thought.
        for (const part of obj?.candidates?.[0]?.content?.parts || []) {
          if (part?.text) onToken(part.text, part.thought ? 'thinking' : 'content');
        }
        if (obj?.usageMetadata) usage = obj.usageMetadata; // cumulative; last one wins
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
  recordGeminiUsage(useModel, usage);
}

/**
 * A single hint that nudges WITHOUT revealing the answer.
 * The correct answer is passed only so the model aims the hint correctly,
 * but it is instructed never to state or hint at which option it is.
 */
export async function generateHint({ question, options, answer }, ai = {}, onToken) {
  const prompt = `You are a patient, encouraging tutor helping a student work through a multiple-choice question.

QUESTION: ${question}
OPTIONS:
${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}

(For your guidance only: the correct answer is: "${answer}". NEVER reveal this.)

Give ONE short hint (1 to 2 sentences, max ~40 words) that points the student toward the right way of thinking.

STRICT RULES:
- Do NOT state, quote, paraphrase, or letter-reference the correct option.
- Do NOT say which options are wrong or eliminate any.
- Point to the underlying concept, a definition to recall, or what to consider.
- Be warm and concise. Output ONLY the hint text, no preamble, no quotes.

${LATEX_RULE}`;
  return (await run(prompt, ai, onToken)).trim();
}

/**
 * A from-scratch explanation aimed at a complete beginner, given after answering.
 */
export async function generateExplanation({ question, options, answer, userAnswer, isCorrect }, ai = {}, onToken) {
  const prompt = `You are a world-class teacher explaining a concept to someone with ZERO background knowledge; assume they are a complete beginner and define every term in plain language.

QUESTION: ${question}
OPTIONS:
${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}
CORRECT ANSWER: ${answer}
THE STUDENT ANSWERED: ${userAnswer || '(no answer recorded)'}, which was ${isCorrect ? 'CORRECT' : 'INCORRECT'}.

Teach them from scratch using this structure (use Markdown):

**The big idea**: In 1 to 2 plain sentences, what concept is this question really about? Define any jargon as if to a 12-year-old.

**Why the correct answer is right**: Explain clearly and simply why "${answer}" is correct. Build the reasoning step by step.

**Why the others miss**: Briefly, in a bullet list, why each other option is a tempting-but-wrong choice or common misconception.

${isCorrect ? 'Start with one short encouraging sentence acknowledging they got it right.' : 'Start with one short, kind sentence (no shaming) then gently clear up the likely misunderstanding.'}

Keep it clear, friendly, and concrete. Use short paragraphs and bullet points. Avoid unnecessary length.

${LATEX_RULE}`;
  return (await run(prompt, ai, onToken)).trim();
}

/**
 * The learner's own note about what was wrong with the PREVIOUS generation of
 * this artifact, rendered into the prompt. Empty on a first build.
 * `generateVisualGuide` and `generateVisualPanel` word their own, because they
 * are fixing a page rather than prose.
 */
function guideCritiqueBlock(critique) {
  return critique
    ? `\nTHE LEARNER READ AN EARLIER VERSION OF THIS GUIDE AND TOLD YOU WHAT WAS WRONG WITH IT. Fix exactly this, and keep what already worked:\n"""\n${String(critique).slice(0, 2000)}\n"""\n`
    : '';
}

/**
 * THE study guide for a section — one generator behind one button ("Lesson").
 *
 * Merged from the old Review/Lesson pair (2026-08-10). That split made the
 * learner choose between "teach me from scratch" and "build on what I know"
 * BEFORE reading either one, and cached two of everything: two guides and two
 * interactive visual pages per section. The merge keeps what each was good at,
 * and both halves are load-bearing:
 *
 * - **From Review: it teaches the section COMPLETELY.** Naming a prerequisite is
 *   not a licence to skip the idea. The old Lesson prompt said "do NOT re-explain
 *   them from scratch", which produced a thin delta — and then thin VISUALS,
 *   because this guide is the only source the visual generator gets.
 * - **From Lesson: it is prerequisite-AWARE.** It connects each idea to what the
 *   learner already covered, by name, and says where the section leads. Measured
 *   2026-08-10: 1,189 of 1,229 topics carry prereq links and 329 of 346
 *   lesson-grain scopes have at least one, so this is the normal case.
 *
 * 🔴 `source` is the authoritative lesson document for the scope when one exists
 * (the `transcripts` corpus — 82 of those are hand-authored, ~934k chars). Both
 * old prompts ignored it and re-derived the section from its own quiz questions,
 * which is backwards: it made the model guess at a lesson that was already
 * written. When a source is present it outranks the question sample entirely.
 */
export async function generateLesson(
  { scopeLabel, topics, questions, prereqs = [], dependents = [], source = '', critique = '' },
  ai = {},
  onToken,
) {
  const sourceBlock = source
    ? `\nTHE AUTHORITATIVE LESSON DOCUMENT for this section. This is the source of truth: teach THIS material, at this depth, and never contradict it or wander outside it. Reorganise it into a study guide for someone about to be quizzed — do not copy it out, and do not summarise away its worked examples.\n"""\n${String(source).slice(0, 24000)}\n"""\n`
    : '';
  const prereqBlock = prereqs.length
    ? `\nWHAT THE LEARNER HAS ALREADY COVERED, in earlier lessons. Land this section on top of these: connect to them BY NAME ("building on X…", "the same projection you used in Y"). Do NOT assume they remember the details — a one-clause reminder is right; silence is not, and re-teaching one from zero wastes their time.\n${prereqs.map((p) => `- ${p.topic}${p.why ? ` (relevant because: ${p.why})` : ''}`).join('\n')}\n`
    : '\n(No earlier prerequisites on record for this section — treat it as foundational and introduce its concepts plainly.)\n';
  const dependentBlock = dependents.length
    ? `\nWHAT THIS SECTION UNLOCKS NEXT (name these at the very end so the learner sees where it leads — do NOT teach them):\n${dependents.map((d) => `- ${d.topic}`).join('\n')}\n`
    : '';

  const prompt = `You are a world-class teacher writing the study guide a learner reads BEFORE being quizzed on a section. It is the only thing they will read on this material, and it is also the source an interactive visual guide is built from — so teach the section completely. Do not summarise it.

SECTION: "${scopeLabel}"
TOPICS COVERED (${topics.length}) — every one of these must be taught:
${topics.map((t) => `- ${t}`).join('\n')}
${sourceBlock}${prereqBlock}${dependentBlock}
${source ? 'A sample of the questions this section is quizzed on, so you can see where the emphasis falls. The document above outranks these' : 'A sample of the questions that exist for this section — use them ONLY to gauge scope and depth'} (never restate them, never reveal which option is correct):
${JSON.stringify(questions).slice(0, 6000)}

${guideCritiqueBlock(critique)}
HOW TO TEACH IT
- Lead with the MENTAL MODEL, then the machinery. Someone holding the right picture can re-derive the details; someone holding only details cannot.
- Give every concept three things: the MECHANISM (how it actually works, precisely — not just what it is called), the WHY (what breaks or degrades without it), and ONE concrete micro-example with real numbers, rows, queries or code-shaped detail. A worked example with real values teaches more than another paragraph of prose.
- Add the judgment layer wherever it exists: the tradeoff, the failure mode, when an expert would choose differently.
- Derive rather than assert whenever showing the steps is cheap.
- Define jargon in plain language the first time it appears — including jargon inherited from a prerequisite.
- Plain language, short paragraphs, bullets over prose. No filler: no "in this lesson we will", no motivational padding, no summary of what you are about to say.
- Accuracy is absolute. Where you are unsure of a detail, teach the stable core rather than guess, and state fast-moving product facts conservatively.

SHAPE — Markdown, in this order:

**The big idea**: 2 to 3 sentences on what this section is really about and why it is worth knowing.${prereqs.length ? ' Open by connecting it to the prerequisites above, by name.' : ''}

**Key concepts**: the core ideas, each a short bolded term followed by its mechanism, its why, and its micro-example. Group by topic where that helps.

**Formulas / rules to remember**: the essential formulas, definitions or rules as a bullet list (only if this section has any).

**Common pitfalls**: the mistakes and misconceptions that actually catch people here — each one paired with the correction.

**How to approach the questions**: 2 to 4 practical tips for reasoning through this section.
${dependents.length ? '\n**Where this leads**: one short line on what mastering this unlocks next, from the list above.\n' : ''}
Never include a quiz, and never reveal which option of a question is correct.

${LATEX_RULE}`;
  return (await run(prompt, ai, onToken)).trim();
}


/* ----------------------- Visual guides (Visualize this) -------------------
 * Turns a Lesson/Review study guide into a small set of NAMED, interactive
 * visuals — one self-contained HTML page with numbered tabs.
 *
 * Two things about this generator are load-bearing and not stylistic:
 *
 * 1. **The visuals are named and numbered so they can be SPOKEN.** The whole
 *    point is that the learner opens the guide and then talks to the study
 *    assistant (voice included) about "visual 2". That only works if what is
 *    printed on screen and what reaches `assistantContextBlock` are the same
 *    strings — which is why the model must emit the index as well as the page,
 *    and why the tab names are constrained to a few concrete words.
 * 2. **The page is rendered in an OPAQUE-ORIGIN sandbox** (server.js serves it
 *    with `CSP: sandbox allow-scripts; default-src 'none'`). So the prompt
 *    forbids every external resource and every storage API — not as good
 *    practice, but because a CDN <script>, a web font, an <img src="https://…">
 *    or a localStorage call is silently BLOCKED there and the visual breaks.
 */

// The two fences that split the model's answer. Deliberately not JSON: a whole
// HTML document inside a JSON string needs flawless escaping of quotes,
// newlines and backslashes, and the non-Gemini providers get no responseSchema
// to enforce it (schema is Gemini-only — see `complete`). Fences survive a
// model that would have produced unparseable JSON.
const VIZ_INDEX_FENCE = '===VISUAL-INDEX===';
const VIZ_HTML_FENCE = '===VISUAL-HTML===';

/**
 * Split the model's answer into { outline, html }. Tolerant on purpose: a model
 * that forgets the index fence but produces a page still yields a usable
 * artifact, and one that wraps the page in a ```html fence is unwrapped rather
 * than rejected.
 */
export function parseVisualGuide(raw) {
  const text = String(raw || '');
  const hi = text.indexOf(VIZ_HTML_FENCE);
  let outline = '';
  let html = text;
  if (hi !== -1) {
    const head = text.slice(0, hi);
    const ii = head.indexOf(VIZ_INDEX_FENCE);
    outline = (ii === -1 ? head : head.slice(ii + VIZ_INDEX_FENCE.length)).trim();
    html = text.slice(hi + VIZ_HTML_FENCE.length);
  }
  html = html.trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  // Some models preface the document with a sentence. Drop anything before the
  // first real tag so the browser never gets a text/html body starting in prose.
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  // ...and just as many sign off after it ("Let me know if you'd like more!").
  // That has to go here rather than by loosening visualGuideLooksComplete: the
  // end-anchor in that test is precisely what catches a REAL truncation, so a
  // complete page with a trailing sentence must be cleaned, not excused.
  const close = html.toLowerCase().lastIndexOf('</html>');
  if (close !== -1) html = html.slice(0, close + '</html>'.length);
  return { outline, html };
}

/**
 * Is this a COMPLETE page? `complete()` exposes no maxOutputTokens lever, so a
 * long artifact can stop mid-document — and a truncated page looks like a
 * working one until you reach the tab that isn't there. Caching a truncated
 * artifact would make the failure permanent, so the caller rejects on false.
 */
export function visualGuideLooksComplete(html) {
  const s = String(html || '').trim();
  if (s.length < 800) return false;
  if (!/<html[\s>]/i.test(s)) return false;
  // The closing pair is the tell: a page that ran out of tokens stops mid-tag.
  // Deliberately NOT also requiring the data-viz-panel hooks — a model that built
  // its own tab widget instead has still produced a working page, and rejecting
  // it would send the learner round a regeneration loop for a page that is fine.
  return /<\/body>\s*<\/html>$/i.test(s);
}

/**
 * Build the interactive visual guide for one section.
 *
 * `guide` is the study guide the learner is looking at (the cached Lesson or
 * Review markdown) — this teaches the SAME material, so the visuals must follow
 * that text rather than re-deriving the section from the question bank.
 * `critique` is the learner's own note about what was wrong with the previous
 * attempt; empty on a first build.
 */
export async function generateVisualGuide(
  { scopeLabel, kind = 'lesson', topics = [], guide = '', questions = [], prereqs = [], dependents = [], critique = '' },
  ai = {},
  onToken,
) {
  const critiqueBlock = critique
    ? `\nTHE LEARNER TRIED AN EARLIER VERSION OF THIS VISUAL GUIDE AND TOLD YOU WHAT WAS WRONG WITH IT. Fix exactly this, and keep everything else that worked:\n"""\n${String(critique).slice(0, 2000)}\n"""\n`
    : '\nThis is a fresh build — there is no earlier version to fix.\n';
  // 🔴 The graph reaches the VISUALS, not just the written guide (added
  // 2026-08-10). A diagram of the ground you are standing on is the cheapest
  // thing a visual medium can give and the most expensive thing prose can — and
  // it is skippable, because it is a tab. Conditional on purpose: with no
  // prereqs on record, a "what you already know" panel would be invented.
  const bridgeBlock = prereqs.length
    ? `\nWHAT THE LEARNER ALREADY COVERED, from the curriculum's prerequisite graph:\n${prereqs.slice(0, 12).map((p) => `- ${p.topic}${p.why ? ` (connects because: ${p.why})` : ''}`).join('\n')}\n\n🔴 MAKE VISUAL 1 THE BRIDGE. One picture with the familiar ground on one side, this section on the other, and the connection between them drawn — named arrows, a shared axis, a before/after of the same object. Name the prerequisites on it, exactly as written above. It must stand on its own for someone who half-remembers them: this is a reminder they can see, not a re-teaching. Then visuals 2 onward teach this section.\n`
    : '';
  const leadsBlock = dependents.length
    ? `\nWHAT THIS SECTION UNLOCKS NEXT — you may name these on the LAST visual as where the path continues, but never teach them:\n${dependents.slice(0, 12).map((d) => `- ${d.topic}`).join('\n')}\n`
    : '';

  const prompt = `You are a VISUAL TEACHER. You turn a written lesson into a small set of named, interactive visuals that make the ideas intuitive.

The learner will open your page and then TALK TO A STUDY ASSISTANT ABOUT IT OUT LOUD, saying things like "teach me visual 2". So every visual must be numbered, named, and easy to say. You are not writing prose — the visuals ARE the lesson.

SECTION: "${scopeLabel}"
TOPICS COVERED (${topics.length}):
${topics.map((t) => `- ${t}`).join('\n')}
${critiqueBlock}${bridgeBlock}${leadsBlock}
THE WRITTEN LESSON THE LEARNER IS READING — visualise THIS material, do not invent a different syllabus:
"""
${String(guide).slice(0, 24000)}
"""
${questions.length ? `\nA sample of the questions this section is quizzed on, so you can see what depth actually matters (do NOT put these questions in the page, and do not reveal answers):\n${JSON.stringify(questions).slice(0, 3000)}\n` : ''}
HOW TO CHOOSE THE VISUALS
1. Read the whole lesson first. Pick the ${prereqs.length ? '2 to 5 ideas beyond the bridge' : '3 to 6 ideas'} that matter most for real understanding. Skip trivia.
2. For each idea, choose the form that teaches it best:
   - a process or sequence -> a numbered flow with click-to-advance steps
   - cause and effect, or a trade-off -> a slider where changing X visibly changes Y
   - a comparison -> a side-by-side toggle or a bar chart
   - a structure and its parts -> a labelled diagram with tap-to-reveal explanations
   - change over time -> a line or area chart with the turning points annotated
   - categories and relationships -> a simple map or tree, never more than 2 levels deep
3. Order them simple to complex. ${prereqs.length ? 'Visual 1 is the bridge described above; visual 2 must then make sense to anyone who has followed it' : 'Visual 1 must make sense to a complete beginner'}, and later ones may go deeper.

TEACHING RULES
- ONE idea per visual. If a visual needs a paragraph to explain itself, split it or simplify it.
- Interactivity must TEACH: the learner changes an input and sees the consequence. Decoration is not interactivity.
- Use an everyday analogy and write it onto the visual as one short line.
- Plain language everywhere. Define jargon in a small caption the first time it appears.
- Minimal text: labels and one-line captions, nothing longer.
- Never rely on colour alone to carry meaning — always pair it with a label, shape or pattern.
- Label every control (a slider needs a name and a live value).
- Write mathematics as readable plain text or SVG (x^2, sqrt(x), a/b). Do NOT emit LaTeX or $…$ — nothing renders it here.

NAMING RULES (the learner will say these out loud — this is the most important section)
- Each visual gets a number and a name of 2 to 4 concrete words, unique within the page, easy to pronounce. e.g. "1. The Leaky Bucket", "2. Compounding Curve".
- Print "N. Name" in large text at the top of that visual's panel, so what is on screen matches what they say.

OUTPUT FORMAT — return EXACTLY these two fenced blocks and nothing else:

${VIZ_INDEX_FENCE}
Title: <short lesson name>: Visual Guide
1. <Name> | <one line: what it shows> | <one line: the key takeaway>
2. <Name> | <one line> | <one line>
(one line per visual, same numbers and names as the tabs)

${VIZ_HTML_FENCE}
<!doctype html>
…the complete page…

THE PAGE — a single self-contained HTML document:
- Start with <!doctype html> and end with </body></html>. Close every tag. Nothing after </html>.
- All CSS and JavaScript inline in the document, plain vanilla JavaScript — no external files.
- 🔴 KEEP EACH VISUAL SELF-CONTAINED. Put the CSS and the JavaScript a visual needs INSIDE its own panel — a <style> and a <script> element within that <section>, the <script> LAST so the markup it drives already exists — and prefix its ids and class names with its number (v1-, v2-, …). A page-level <style>/<script> is for shared chrome only and must NEVER reach into a panel by id. The learner can ask to rewrite ONE visual later; that only works if nothing outside a panel depends on its insides.
- 🔴 NO external resources of any kind: no CDN scripts, no <link> stylesheets, no web fonts, no remote images, no fetch/XHR. They are BLOCKED and your visual will silently break. Draw with inline SVG, HTML and CSS. Images only as data: URIs, and prefer SVG over images.
- 🔴 NO localStorage, sessionStorage or cookies — they THROW here. Keep all state in JavaScript variables.
- Tabs across the top, one column below. It must read well on a phone at 390px wide, with touch targets at least 44px tall.

TAB MARKUP — use these exact hooks; the app reads them to know which visual the learner is looking at:
<nav class="viz-tabs">
  <button class="viz-tab" data-viz-tab="1">1. Name</button>
  <button class="viz-tab" data-viz-tab="2">2. Name</button>
</nav>
<section class="viz-panel" data-viz-panel="1"> …visual 1… </section>
<section class="viz-panel" data-viz-panel="2"> …visual 2… </section>
The app supplies the tab-switching behaviour and hides inactive panels itself. So do not write your own show/hide logic, and do NOT declare a display value on .viz-panel anywhere — not in your CSS, not inline. Writing ".viz-panel { display: none }" and leaving the reveal to us is the one thing that breaks the page. Everything INSIDE a panel is yours.

COLOURS — the page is themed light or dark by the app. Use these CSS variables so it matches, and never hard-code a background or text colour:
  var(--viz-bg) page background      var(--viz-surface) card background
  var(--viz-ink) body text           var(--viz-muted) secondary text
  var(--viz-line) borders            var(--viz-accent) primary accent
  var(--viz-green) var(--viz-red) var(--viz-amber) var(--viz-violet) data colours
Keep the whole document under about 90,000 characters.`;

  return (await run(prompt, ai, onToken)).trim();
}


/* -------------------- Editing ONE visual, not the whole page ---------------
 * "Visual 3 is wrong" used to cost a full re-authoring of the document: the old
 * page was never shown to the model, so the three visuals that WERE working got
 * re-rolled along with the broken one — and the learner paid ~90 KB of output to
 * fix ~8 KB of it.
 *
 * The panel is the unit of repair. A generated page is a flat list of
 * `data-viz-panel` sections, so one can be cut out and a freshly generated one
 * dropped in its place while every other byte of the document stays identical.
 *
 * Two things make that safe, and both are enforced here rather than hoped for:
 *
 * 1. **Balance is the completeness test.** These scanners only ever return an
 *    element whose closing tag they actually found. A truncated answer therefore
 *    yields nothing rather than a half-panel — the same posture as
 *    `visualGuideLooksComplete`, for the same reason: caching it makes it permanent.
 * 2. **A panel is only swappable if nothing outside it reaches in.** Older pages
 *    wire every control from ONE shared <script>; pull the markup out from under
 *    it and that script throws on the first missing element, taking the panels
 *    AFTER it down too. `canSwapVisualPanel` refuses those, so the failure is a
 *    sentence the learner can act on instead of a page that half-works.
 */

const plainText = (s) => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeText = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// The opening tag of a panel / a tab button. Deliberately tag-agnostic: the
// prompt asks for <section> and <button>, and models routinely send <div>.
const PANEL_OPEN = '<([a-z][\\w-]*)\\b[^>]*?\\bdata-viz-panel\\s*=\\s*["\']?([^"\'\\s>]+)["\']?[^>]*>';
const TAB_OPEN = '<([a-z][\\w-]*)\\b[^>]*?\\bdata-viz-tab\\s*=\\s*["\']?([^"\'\\s>]+)["\']?[^>]*>';

/**
 * Index one past the `</tag>` that closes an element opened at `from`, or -1.
 *
 * Depth-counted, because a panel legitimately contains nested <section>s and a
 * lazy regex would stop at the first one. It can be fooled by a tag name inside
 * a JavaScript string, and that is fine: a miscount fails to balance, returns
 * -1, and the caller falls back to rebuilding the whole page. Never the reverse.
 */
function closeTagEnd(src, tag, from) {
  const re = new RegExp(`<(/?)${escapeRe(tag)}\\b`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(src))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      const gt = src.indexOf('>', m.index);
      return gt === -1 ? -1 : gt + 1;
    }
  }
  return -1;
}

/** Every panel in a generated page, in document order, with its exact bounds. */
export function splitVisualPanels(html) {
  const src = String(html || '');
  const re = new RegExp(PANEL_OPEN, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const end = closeTagEnd(src, m[1], m.index + m[0].length);
    if (end === -1) continue;
    out.push({ key: String(m[2]).trim(), tag: m[1], start: m.index, end, html: src.slice(m.index, end) });
    re.lastIndex = end;   // a panel nested inside a panel is not a second visual
  }
  return out;
}

/**
 * The page's visuals as the learner sees them — `{key, name}` per panel, named
 * from its TAB button. This is what the picker checkboxes are built from, so it
 * must agree with the tab strip rather than with the stored outline (which a
 * model can leave stale).
 */
export function visualPanelIndex(html) {
  const src = String(html || '');
  const re = new RegExp(TAB_OPEN, 'gi');
  const names = new Map();
  let m;
  while ((m = re.exec(src))) {
    const openEnd = m.index + m[0].length;
    const end = closeTagEnd(src, m[1], openEnd);
    if (end === -1) continue;
    names.set(String(m[2]).trim(), plainText(src.slice(openEnd, end)));
    re.lastIndex = end;
  }
  return splitVisualPanels(src).map((p) => ({ key: p.key, name: names.get(p.key) || '' }));
}

/** Every <script> body that is NOT inside a panel, concatenated. */
function sharedScripts(src, panels) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let out = '';
  let m;
  while ((m = re.exec(src))) {
    if (!panels.some((p) => m.index >= p.start && m.index < p.end)) out += `${m[1]}\n`;
  }
  return out;
}

/**
 * Can visual `key` be rewritten on its own, or must the whole page be rebuilt?
 *
 * Conservative by construction: a shared script is fine (tab widgets are the
 * common case and touch nothing panel-specific), but a shared script that names
 * an id living inside this panel, or selects the panel by number, owns that
 * panel's behaviour. Replacing the markup would leave that code querying
 * elements that no longer exist — it throws on the first one and every later
 * visual it also wired goes dead. Checked BEFORE any model call, so the refusal
 * costs nothing.
 */
export function canSwapVisualPanel(html, key) {
  const src = String(html || '');
  const k = String(key);
  const panels = splitVisualPanels(src);
  const target = panels.find((p) => p.key === k);
  if (!target) return { ok: false, reason: `this page has no visual ${k}` };
  const shared = sharedScripts(src, panels);
  if (!shared.trim()) return { ok: true, reason: '' };
  const ids = [...target.html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).filter(Boolean);
  const held = ids.find((id) => shared.includes(id));
  if (held) return { ok: false, reason: `a script shared with the other visuals drives #${held} inside it` };
  if (new RegExp(`data-viz-panel\\s*=\\s*["']?${escapeRe(k)}\\b`).test(shared)) {
    return { ok: false, reason: 'a script shared with the other visuals selects this panel by number' };
  }
  return { ok: true, reason: '' };
}

/**
 * Re-label one tab button. The injected runtime reads a button's text and posts
 * it up as "what the learner is looking at" — so a renamed visual whose TAB still
 * carries the old name would have the assistant teach "visual 2" under a name
 * that is nowhere on screen. Renaming is allowed; a silent mismatch is not.
 */
function setVisualTabLabel(html, key, label) {
  const re = new RegExp(
    `(<([a-z][\\w-]*)\\b[^>]*?\\bdata-viz-tab\\s*=\\s*["']?${escapeRe(String(key))}["']?[^>]*>)([\\s\\S]*?)(</\\2\\s*>)`,
    'i',
  );
  return html.replace(re, (whole, open, tag, inner, close) => open + escapeText(label) + close);
}

/** Splice a replacement panel into a page. Returns null if that panel is not in it. */
export function replaceVisualPanel(html, key, fragment, name = '') {
  const src = String(html || '');
  const target = splitVisualPanels(src).find((p) => p.key === String(key));
  if (!target) return null;
  const next = src.slice(0, target.start) + String(fragment || '').trim() + src.slice(target.end);
  return name ? setVisualTabLabel(next, key, name) : next;
}

/** "2. Step Size Dial | what it shows | takeaway" -> "2. Step Size Dial" (the tab label). */
export function visualTabLabelFrom(line, key) {
  const first = String(line || '').split('|')[0].trim();
  if (!first) return '';
  return /^\s*\d+\s*[.)]/.test(first)
    ? first.replace(/^\s*(\d+)\s*[.)]\s*/, '$1. ')
    : `${key}. ${first}`;
}

/** Swap one numbered row of the stored index, leaving the others untouched. */
export function replaceOutlineLine(outline, key, line) {
  const src = String(outline || '');
  const next = String(line || '').trim();
  if (!next) return src;
  const rows = src.split(/\r?\n/);
  const at = rows.findIndex((r) => new RegExp(`^\\s*${escapeRe(String(key))}\\s*[.)]`).test(r));
  if (at === -1) return `${src.replace(/\s*$/, '')}\n${next}`;
  rows[at] = next;
  return rows.join('\n');
}

/** Re-stamp a fragment's panel number with the one we actually asked for. */
function forcePanelKey(frag, key) {
  return frag.replace(/(\bdata-viz-panel\s*=\s*)(["']?)[^"'\s>]*\2/i, `$1"${escapeText(key)}"`);
}

/** Tolerant of a model that forgot the wrapper, strict about a truncated one. */
function fragmentLooksBalanced(frag) {
  const count = (re) => (frag.match(re) || []).length;
  return count(/<script\b/gi) === count(/<\/script\s*>/gi)
    && count(/<style\b/gi) === count(/<\/style\s*>/gi)
    && /<\/[a-z][\w-]*\s*>\s*$/i.test(frag);
}

/**
 * Split a panel rewrite into { line, html }. Same fence contract as
 * `parseVisualGuide`, same tolerance — and the same hard floor: it returns null
 * rather than a fragment whose element never closed, because that is precisely
 * what a run out of tokens produces and it must not reach the cache.
 */
export function parseVisualPanel(raw, key) {
  const text = String(raw || '');
  const k = String(key);
  const hi = text.indexOf(VIZ_HTML_FENCE);
  let line = '';
  let frag = text;
  if (hi !== -1) {
    const head = text.slice(0, hi);
    const ii = head.indexOf(VIZ_INDEX_FENCE);
    const rows = (ii === -1 ? head : head.slice(ii + VIZ_INDEX_FENCE.length))
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    line = rows.find((r) => new RegExp(`^${escapeRe(k)}\\s*[.)]`).test(r)) || rows[rows.length - 1] || '';
    frag = text.slice(hi + VIZ_HTML_FENCE.length);
  }
  frag = frag.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();

  const found = splitVisualPanels(frag);
  const hit = found.find((p) => p.key === k) || found[0];
  // The NUMBER is ours, not the model's. A fragment that came back labelled 3
  // would otherwise be spliced into slot 2 and leave the page with two visual 3s
  // — one of which the tab strip cannot reach.
  if (hit) return { line, html: hit.key === k ? hit.html : forcePanelKey(hit.html, k) };
  // No wrapper, but a balanced block: wrap it rather than throw away a good
  // visual. Balance is what separates that from a truncation — this is the only
  // branch where the panel attribute is ours rather than the model's, so the
  // number can never drift from the one we asked for.
  if (frag.length > 200 && fragmentLooksBalanced(frag)) {
    return { line, html: `<section class="viz-panel" data-viz-panel="${escapeText(k)}">\n${frag}\n</section>` };
  }
  return null;
}

/**
 * Rewrite ONE visual of an existing page.
 *
 * Unlike `generateVisualGuide` this is shown the artifact it is fixing: the
 * panel's current markup is in the prompt, so "keep what worked" is an
 * instruction it can actually follow rather than a hope. Output is one panel —
 * a few KB against the ~90 KB of a full rebuild.
 */
export async function generateVisualPanel(
  { scopeLabel, kind = 'review', number, name = '', current = '', outline = '', guide = '', critique = '' },
  ai = {},
  onToken,
) {
  const prompt = `You are a VISUAL TEACHER fixing ONE visual inside a page you already built. Everything else on the page stays exactly as it is — you are rewriting visual ${number} only.

SECTION: "${scopeLabel}"
THE VISUAL YOU ARE FIXING: ${number}${name ? `. ${name}` : ''}

${critique
    ? `WHAT THE LEARNER SAYS IS WRONG WITH IT — fix exactly this, and keep everything else about this visual that already worked:\n"""\n${String(critique).slice(0, 2000)}\n"""`
    : 'The learner did not say what was wrong, only that this one is not good enough. Rethink how it teaches the idea — a different form, a sharper interaction, a better analogy — rather than nudging the current version.'}

THE WHOLE PAGE'S INDEX (the other visuals stay as they are — do NOT duplicate what they already teach, and do not renumber):
"""
${String(outline).slice(0, 2000)}
"""

THE CURRENT VERSION OF VISUAL ${number} — this is the markup you are replacing:
"""
${String(current).slice(0, 20000)}
"""

THE WRITTEN ${kind === 'lesson' ? 'LESSON' : 'REVIEW'} THIS PAGE TEACHES — stay inside this material:
"""
${String(guide).slice(0, 16000)}
"""

RULES FOR THE REPLACEMENT
- Keep the number ${number}. The name may change if a better one fits; keep it 2 to 4 concrete words, easy to say out loud, and print "${number}. Name" in large text at the top of the panel.
- ONE idea. Interactivity must TEACH — the learner changes an input and sees the consequence. Decoration is not interactivity.
- Use an everyday analogy, written onto the visual as one short line. Plain language; label every control with a name and a live value.
- Never rely on colour alone — pair it with a label, shape or pattern.
- Write mathematics as readable plain text or SVG (x^2, sqrt(x), a/b). NO LaTeX, no $…$ — nothing renders it here.
- 🔴 SELF-CONTAINED: the panel carries its own <style> and <script> INSIDE the section, with the <script> LAST so the markup it drives already exists. Prefix every id and class with "v${number}-" so it cannot collide with the rest of the page — including the version you are replacing. Never reference anything outside this panel, and never let anything outside it need to reference in.
- 🔴 NO external resources (no CDN scripts, no <link>, no web fonts, no remote images, no fetch) and NO localStorage/sessionStorage/cookies — all of it is BLOCKED or throws here. Draw with inline SVG, HTML and CSS.
- Do NOT declare a display value on the panel itself — the app shows and hides panels. Everything inside it is yours.
- Reads well on a phone at 390px wide; touch targets at least 44px tall.
- Colours: use only var(--viz-bg) var(--viz-surface) var(--viz-ink) var(--viz-muted) var(--viz-line) var(--viz-accent) var(--viz-green) var(--viz-red) var(--viz-amber) var(--viz-violet). Never hard-code a background or text colour.

OUTPUT FORMAT — return EXACTLY these two fenced blocks and nothing else. No preamble, no sign-off:

${VIZ_INDEX_FENCE}
${number}. <Name> | <one line: what it shows> | <one line: the key takeaway>

${VIZ_HTML_FENCE}
<section class="viz-panel" data-viz-panel="${number}">
…the complete replacement panel…
</section>

Emit the section element and nothing else — no <!doctype>, no <html>, no <body>. Close every tag.`;

  return (await run(prompt, ai, onToken)).trim();
}

/**
 * Analyze the learner's overall progress and give an encouraging, actionable
 * read-out: where they stand, strengths, what to prioritise, and a plan.
 */
export async function generateAnalysis({ overall, byCourse, weakest, graph }, ai = {}, onToken) {
  // Knowledge-graph signals (optional): what the prerequisite links say about
  // where to go next — sharper than accuracy tables alone.
  const graphBlock = graph && (graph.frontier?.length || graph.keystones?.length)
    ? `\nKNOWLEDGE-GRAPH SIGNALS (from prerequisite links between topics):
${graph.frontier?.length ? `Ready to start (never attempted, but every prerequisite is strong):
${graph.frontier.slice(0, 8).map((f) => `- ${f.topic} [${f.course}] — groundwork done: ${f.readyBecause.join(', ')}`).join('\n')}` : ''}
${graph.keystones?.length ? `Weak links blocking the most downstream topics:
${graph.keystones.slice(0, 8).map((k) => `- ${k.topic} [${k.course}]: ${k.state === 'untouched' ? 'never attempted' : `${k.accuracy}% over ${k.attempts} attempts`} — blocks ${k.blocked} downstream topic(s)`).join('\n')}` : ''}
`
    : '';
  const prompt = `You are a supportive, sharp learning coach analyzing a student's progress dashboard. "Progress" for any area is the average mastery across all its topics (a topic never attempted counts as 0%).

OVERALL: ${overall.overallProgress}% average progress across ${overall.topics} topics; ${overall.attempted} have been practised, ${overall.topics - overall.attempted} are untouched.

PROGRESS BY COURSE (weakest first):
${byCourse.map((c) => `- ${c.course} (${c.track}): ${c.progress}%, ${c.attempted}/${c.topics} topics practised`).join('\n')}

WEAKEST TOPICS (lowest progress first):
${weakest.map((t) => `- ${t.topic} [${t.course}]: ${t.progress}%${t.attempts ? ` (${t.attempts} attempts)` : ' (never attempted)'}`).join('\n')}
${graphBlock}
Write a concise analysis in Markdown using this shape:

**Where you stand**: 2 to 3 sentences summarising the overall picture honestly but encouragingly.

**Strengths**: a short bullet list of what's going well (highest-progress / well-practised areas).

**Focus next**: a short bullet list of the 3 to 5 areas that will move the needle most, with a one-line reason each. Distinguish "weak because untouched" from "weak because struggling". When knowledge-graph signals are provided, weight them heavily: keystone weak links unblock the most downstream material, and "ready to start" topics are momentum wins where the groundwork is already done.

**A suggested plan**: 3 to 4 concrete, ordered steps for the next study sessions.

Be warm, specific, and motivating. Avoid generic filler. Keep it tight.

${LATEX_RULE}`;
  return (await run(prompt, ai, onToken)).trim();
}

/* ---------------------------- Knowledge graph ----------------------------- */

/** Gemini responseSchema for a batch of topic-link results. Candidates are
 *  referenced by their 1-based NUMBER in the prompt's list (numbers can't be
 *  mistyped the way long slug ids can); the caller maps them back to ids. */
const TOPIC_LINKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      t: { type: 'integer' }, // target's number in the candidate list
      prereqs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' }, // prerequisite's number in the candidate list
            why: { type: 'string' },
            w: { type: 'integer' }, // importance: 1 helpful, 2 useful, 3 critical
          },
          required: ['n'],
          propertyOrdering: ['n', 'why', 'w'],
        },
      },
    },
    required: ['t', 'prereqs'],
    propertyOrdering: ['t', 'prereqs'],
  },
};

/**
 * Identify each TARGET topic's direct prerequisites from the full catalog, for
 * the knowledge graph. `candidates` is every topic [{id, topic, course, track}]
 * (the search space — cross-course and cross-track links are the point:
 * Limits -> Derivatives -> Gradient Descent -> Neural Networks); `targets` is
 * the subset to link on this call (keep it <= ~20 so the model stays careful).
 *
 * Returns [{id, topic, prereqs: [{id, why}]}] — one entry per target, EMPTY
 * prereqs when a topic is genuinely foundational, so callers can persist
 * "linked, no prereqs" and not re-ask forever.
 */
export async function generateTopicLinks({ targets, candidates }, ai = {}) {
  if (!targets?.length || !candidates?.length) return [];
  const numOf = new Map(candidates.map((c, i) => [c.id, i + 1])); // id -> 1-based number
  const line = (c, i) => `${i + 1}. ${c.topic} — ${c.course}${c.track ? ` (${c.track})` : ''}`;
  const targetNums = targets.map((t) => numOf.get(t.id)).filter(Boolean);

  const prompt = `You are an expert curriculum designer mapping the PREREQUISITE structure of a learning catalog (a knowledge graph). Below is the full numbered list of topics. For each TARGET topic, identify its DIRECT prerequisites: the specific topics a learner must already understand to grasp the target.

RULES:
- 0 to 4 prerequisites per target. Only DIRECT ones (list "Derivatives" for "Gradient Descent", not "Limits" — Limits is a prerequisite of Derivatives, and chains are followed transitively).
- Prerequisites may come from ANY course or track — cross-course and cross-track links (e.g. a Calculus topic underpinning a Machine Learning topic) are the most valuable.
- Prefer prerequisites from EARLIER material; do NOT list a topic that merely follows the target in its own lesson sequence.
- A truly foundational target (nothing in the catalog comes before it) gets an empty list — do not invent tenuous links.
- "why" is a short phrase (max 8 words) naming what the prerequisite supplies, e.g. "supplies the limit definition".
- "w" is the prerequisite's IMPORTANCE to the target: 3 = critical (you cannot understand the target without it), 2 = useful, 1 = helpful background. Default to 2 if unsure.
- Reference topics ONLY by their NUMBER in the list.

ALL TOPICS:
${candidates.map(line).join('\n')}

TARGETS (link each of these): ${targetNums.join(', ')}

Return ONLY a JSON array, one object per target: [{"t": <target number>, "prereqs": [{"n": <prerequisite number>, "why": "short phrase", "w": 2}]}]`;

  const text = await complete(prompt, { json: true, schema: TOPIC_LINKS_SCHEMA, ...ai });
  let arr;
  try {
    arr = parseLooseJson(text);
  } catch {
    throw new Error('topic links: returned non-JSON content');
  }
  if (!Array.isArray(arr)) throw new Error('topic links: not a JSON array');

  // Map numbers back to ids and validate hard: unknown numbers, self-links and
  // duplicates are dropped; every requested target gets a result (missing ones
  // come back with empty prereqs so the sweep can persist-and-move-on).
  const byNum = new Map(candidates.map((c, i) => [i + 1, c]));
  const out = new Map(targets.map((t) => [t.id, { id: t.id, topic: t.topic, prereqs: [] }]));
  for (const item of arr) {
    const target = byNum.get(item?.t);
    if (!target || !out.has(target.id)) continue;
    const seen = new Set();
    const prereqs = [];
    for (const p of Array.isArray(item.prereqs) ? item.prereqs : []) {
      const cand = byNum.get(p?.n);
      if (!cand || cand.id === target.id || seen.has(cand.id)) continue;
      seen.add(cand.id);
      const w = Number.isFinite(p?.w) ? Math.min(3, Math.max(1, Math.round(p.w))) : 2;
      prereqs.push({ id: cand.id, why: String(p.why || '').slice(0, 80), weight: w });
      if (prereqs.length >= 4) break;
    }
    out.get(target.id).prereqs = prereqs;
  }
  return [...out.values()];
}

/** Gemini responseSchema for a pedagogical ordering: a permutation of the
 *  candidate topic NUMBERS, foundational first. Numbers (not names) so the
 *  model can't paraphrase a topic and drift off the known set. */
const TOPIC_ORDER_SCHEMA = {
  type: 'array',
  items: { type: 'integer' },
};

/**
 * Order ONE lesson's topics (sub-lessons) into the best sequence to LEARN them:
 * foundational ideas and mechanisms before the concepts, tuning, and edge cases
 * that build on them. `topics` is [{id, topic}] for a SINGLE lesson.
 *
 * Returns the same topics as an ordered array [{id, topic}] — always a complete
 * permutation: unknown/duplicate numbers are dropped and any topics the model
 * omits are appended in their incoming order, so no topic is ever lost. On a
 * hard failure it throws and the caller keeps the existing order.
 */
export async function generateTopicOrder({ course = '', lesson = '', topics }, ai = {}) {
  if (!topics?.length) return [];
  if (topics.length === 1) return [{ id: topics[0].id, topic: topics[0].topic }];
  const line = (t, i) => `${i + 1}. ${t.topic}`;

  const prompt = `You are an expert curriculum designer sequencing the sub-lessons (topics) WITHIN a single lesson into the optimal order for a learner to study them.

Course: ${course}
Lesson: ${lesson}

Order the numbered topics below from the one to study FIRST to the one to study LAST.

RULES:
- Put foundational definitions and mechanisms BEFORE the concepts that build on them (e.g. "Cluster Centroids" and "K-Means Assignment Step" come before "Choosing the Number of Clusters K"; introduce a method before its evaluation, tuning, or edge cases).
- When two topics are independent, keep the more basic / more general one earlier.
- Return EVERY topic number exactly once — a complete permutation, nothing added or dropped.
- Reference topics ONLY by their NUMBER in the list.

TOPICS:
${topics.map(line).join('\n')}

Return ONLY a JSON array of the topic numbers in recommended study order, e.g. [3,1,4,2].`;

  const text = await complete(prompt, { json: true, schema: TOPIC_ORDER_SCHEMA, ...ai });
  let arr;
  try {
    arr = parseLooseJson(text);
  } catch {
    throw new Error('topic order: returned non-JSON content');
  }
  if (!Array.isArray(arr)) throw new Error('topic order: not a JSON array');

  // Map numbers back to topics; keep first occurrence, drop unknown/duplicate,
  // then append any topics the model left out so the result is a full permutation.
  const byNum = new Map(topics.map((t, i) => [i + 1, t]));
  const ordered = [];
  const seen = new Set();
  for (const n of arr) {
    const t = byNum.get(n);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    ordered.push({ id: t.id, topic: t.topic });
  }
  for (const t of topics) if (!seen.has(t.id)) ordered.push({ id: t.id, topic: t.topic });
  return ordered;
}

/** Gemini responseSchema for a whole-track curriculum ordering: the courses in
 *  study order, each with its own lessons in study order. Numbers throughout —
 *  the model picks from a known set instead of paraphrasing a unit name. */
const CURRICULUM_ORDER_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      course: { type: 'integer' },
      lessons: { type: 'array', items: { type: 'integer' } },
    },
    required: ['course', 'lessons'],
  },
};

/**
 * Sequence a whole TRACK: the courses within it, and the lessons within each
 * course, into the order a learner should meet them. The sibling of
 * generateTopicOrder one and two grains up — together the three cover every
 * level of the tree, so nothing has to fall back to alphabetical.
 *
 * `courses` is [{course, lessons:[names]}] in their CURRENT display order.
 * Returns the same shape, always a complete permutation at both grains:
 * unknown/duplicate numbers are dropped, omissions are appended in their
 * incoming order, and a lesson number belonging to another course is ignored.
 * Throws on a hard failure so the caller can keep the existing order.
 */
export async function generateCurriculumOrder({ track = '', courses }, ai = {}) {
  const src = (courses || []).filter((c) => c && c.course);
  if (src.length === 0) return [];

  // One flat numbering for lessons across the track, so the model never has to
  // hold two number spaces at once and a stray number resolves unambiguously.
  const lessonNo = new Map(); // number -> {courseIdx, lesson}
  let n = 0;
  const block = src.map((c, ci) => {
    const lines = (c.lessons || []).map((l) => { n += 1; lessonNo.set(n, { ci, lesson: l }); return `    ${n}. ${l}`; });
    return `  C${ci + 1}. ${c.course}\n${lines.join('\n') || '    (no lessons)'}`;
  }).join('\n');

  const prompt = `You are an expert curriculum designer sequencing a learning TRACK.

Track: ${track}

Below are the track's courses (numbered C1, C2, …) and, indented under each, that course's lessons (numbered 1, 2, 3, … across the whole track).

Put the whole track into the order a learner should study it:
- COURSES: foundations and prerequisites first, then what builds on them, then applications, evaluation and advanced practice last.
- LESSONS within each course: the same rule one level down — motivation and core mechanism before the components, then tuning, evaluation and edge cases.
- Judge by what a topic REQUIRES, not by its name. A course that explains why a technique exists comes before the course that details its parts.
- Return EVERY course number exactly once, and every lesson number exactly once inside its OWN course. Nothing added, nothing dropped.
- Reference units ONLY by their number.

CURRICULUM:
${block}

Return ONLY a JSON array like [{"course":2,"lessons":[5,4,6]},{"course":1,"lessons":[1,3,2]}] — the courses in study order, each with its own lessons in study order.`;

  const text = await complete(prompt, { json: true, schema: CURRICULUM_ORDER_SCHEMA, ...ai });
  let arr;
  try {
    arr = parseLooseJson(text);
  } catch {
    throw new Error('curriculum order: returned non-JSON content');
  }
  if (!Array.isArray(arr)) throw new Error('curriculum order: not a JSON array');

  const out = [];
  const usedCourse = new Set();
  const takeCourse = (ci, wantLessons) => {
    if (!src[ci] || usedCourse.has(ci)) return;
    usedCourse.add(ci);
    const own = (src[ci].lessons || []).filter(Boolean);
    const lessons = [];
    const seenL = new Set();
    for (const num of (Array.isArray(wantLessons) ? wantLessons : [])) {
      const hit = lessonNo.get(num);
      if (!hit || hit.ci !== ci || seenL.has(hit.lesson)) continue;
      seenL.add(hit.lesson);
      lessons.push(hit.lesson);
    }
    for (const l of own) if (!seenL.has(l)) { seenL.add(l); lessons.push(l); }
    out.push({ course: src[ci].course, lessons });
  };
  for (const row of arr) takeCourse(Number(row?.course) - 1, row?.lessons);
  for (let ci = 0; ci < src.length; ci++) takeCourse(ci, []);
  return out;
}

/**
 * Convert a batch of existing questions' informal math notation into KaTeX
 * LaTeX, WITHOUT changing wording or meaning. Returns objects keyed by id.
 */
export async function latexifyQuestions(items, ai = {}) {
  const prompt = `You reformat the math notation in quiz questions into KaTeX LaTeX. The app renders LaTeX with KaTeX.

For EACH item, rewrite "question", every entry of "options", and "answer" so that ALL mathematical notation becomes valid KaTeX wrapped in $...$ (inline) or $$...$$ (display).

STRICT RULES:
- Do NOT change wording, numbers, ordering, or meaning. ONLY convert math notation into LaTeX.
- Convert informal notation correctly. Examples:
  - "cos^-1(0)" becomes "$\\cos^{-1}(0)$"
  - "x^2" becomes "$x^2$"   |   "x^0.4" becomes "$x^{0.4}$"
  - "(x^2 - 9)/(x - 3)" becomes "$\\frac{x^2 - 9}{x - 3}$"
  - "lim x->3" or "x→3" becomes "$\\lim_{x \\to 3}$" or "$x \\to 3$"
  - bare symbols like ×, ÷, √, ≤, ≥, ≠, π, ∑, ∫ become \\times, \\div, \\sqrt{}, \\le, \\ge, \\neq, \\pi, \\sum, \\int inside $...$
- Use ONLY standard KaTeX commands. Wrap function names as \\sin, \\cos, \\log, \\ln, etc.
- Escape any literal currency dollar sign as \\$ so it is not treated as math.
- The "answer" string MUST end up EXACTLY equal (character for character) to one of the converted "options".
- If an item genuinely contains no math, return its fields unchanged.

Return ONLY a JSON array; each object keeps the same "id" and has the converted "question", "options" (same length and order) and "answer".

ITEMS:
${JSON.stringify(items)}`;

  const text = await complete(prompt, { json: true, ...ai });
  let arr;
  try {
    arr = parseLooseJson(text);
  } catch {
    throw new Error('latexify: Gemini returned non-JSON');
  }
  if (!Array.isArray(arr)) throw new Error('latexify: not a JSON array');
  return arr.map(cleanQuestionEscapes);
}

// Repair control-char-mangled LaTeX (see restoreLatexEscapes) across a
// reformatted/latexified question's text fields, keeping the answer<->option
// match intact because every field is cleaned the same way.
function cleanQuestionEscapes(o) {
  if (!o || typeof o !== 'object') return o;
  return {
    ...o,
    question: restoreLatexEscapes(o.question),
    options: Array.isArray(o.options) ? o.options.map(restoreLatexEscapes) : o.options,
    answer: restoreLatexEscapes(o.answer),
  };
}

/**
 * Reformat flashcards so their CODE and MATH render correctly, WITHOUT changing
 * any wording or meaning. The frontend renders a card's fields like this:
 *   - code wrapped as \texttt{...} becomes an inline <code> chip (stashCode),
 *   - $...$ / $$...$$ is typeset as math by KaTeX,
 *   - everything else is plain prose ("intuition" also supports **bold** + "- " bullets).
 * The breakage this fixes is code (e.g. "def f(self):") crammed inside a $...$
 * span, or prose glued on with \text{...}/\implies, which KaTeX then prints as
 * garbled red source. Returns the same items ({id, concept, intuition, formula})
 * with cleaned fields; a field that already renders fine is returned unchanged.
 */
export async function reformatFlashcards(items, ai = {}) {
  const prompt = `You fix ONLY the formatting of study flashcards so they render correctly. You must NOT change wording, meaning, facts, numbers, or ordering.

The app renders each field like this:
- CODE wrapped as \\texttt{...} renders as an inline code chip. Put ALL programming syntax here: identifiers, function signatures, snippets (e.g. \\texttt{def method(self, args):}, \\texttt{*args}, \\texttt{model.fit(X, y)}). Code must NEVER go inside $...$.
- MATH inside $...$ (inline) or $$...$$ (display) is typeset by KaTeX. Put ONLY genuine mathematical notation here, using valid KaTeX (\\frac, \\sum, \\to, \\times, \\le, \\cos, ...).
- Everything else is plain prose ("intuition" also supports **bold** and lines starting with "- " as bullets).

FIX these mistakes (this is the whole job):
- ALWAYS REWRITE (never leave as-is): a field of the form $\\texttt{...} \\implies \\text{...}$ (a code chip and prose wrapped together inside ONE $...$). A \\texttt{} chip inside $...$ breaks KaTeX delimiter matching, so it renders as literal "$" and raw "\\implies \\text{}". Unwrap it: drop the outer $...$, keep each code piece as its own \\texttt{...}, turn every \\text{...} into plain prose, and replace \\implies / \\to with a plain arrow -> (or a word like "gives"/"means"). Example: "$\\texttt{obj.get(k)} \\implies \\text{None if missing}$" becomes "\\texttt{obj.get(k)} -> None if missing".
- Code placed inside $...$  ->  move it out of the math span and wrap it in \\texttt{...}.
- Prose glued into math with \\text{...}, \\implies, \\rightarrow etc.  ->  write it as a normal sentence OUTSIDE any $...$; render a real "implies" as the word "implies".
- Stray $ around plain text  ->  remove them.
- Invalid KaTeX inside a real math span  ->  correct it to valid KaTeX.
- A field that is just a code snippet followed by an English explanation  ->  emit the code as \\texttt{...} then the explanation as plain prose.

STRICT RULES:
- Preserve the exact wording and meaning. Reformat ONLY. Do not add, drop, or reword content.
- If a field already renders correctly, return it UNCHANGED (character for character).
- Escape a literal currency dollar sign as \\$.

For EACH item return the same "id" with cleaned "concept", "intuition" and "formula" (all three present, even when unchanged).

Return ONLY a JSON array of {"id", "concept", "intuition", "formula"} objects.

ITEMS:
${JSON.stringify(items)}`;

  const text = await complete(prompt, { json: true, ...ai });
  let arr;
  try {
    arr = parseLooseJson(text);
  } catch {
    throw new Error('reformat: model returned non-JSON');
  }
  if (!Array.isArray(arr)) throw new Error('reformat: not a JSON array');
  return arr;
}

/**
 * Apply a natural-language EDIT to ONE flashcard and return its updated fields.
 * Unlike reformatFlashcards (formatting only), this MAY change wording/content —
 * but ONLY as the instruction asks; everything else is preserved verbatim. The
 * output follows the app's render contract (LATEX_RULE): code in \texttt{}, math
 * in $...$, no HTML/markdown. Returns { concept, intuition, formula }.
 */
export async function editFlashcard(card, instruction, ai = {}) {
  const current = {
    concept: card.concept || '',
    intuition: card.intuition || '',
    formula: card.formula || '',
  };
  const prompt = `You are editing ONE study flashcard. Apply the user's requested change, and nothing more.

The card has three fields:
- "concept": the front prompt (a question or a term to recall).
- "intuition": the plain-language explanation (supports **bold** and lines starting with "- " as bullets).
- "formula": the key formula or code snippet (may be empty, or "—" when there is none).

USER'S REQUESTED CHANGE:
${instruction}

RULES:
- Make ONLY the change the user asked for. Preserve every other field, and every untouched part of an edited field, verbatim (character for character).
- Keep the card accurate and self-consistent. If the requested change makes another field wrong, update just enough to keep it correct.
- Do not invent unrelated content, do not pad, and do not remove content the user did not ask to remove.
- If the request is unclear, off-topic, or does not apply to this card, return all three fields UNCHANGED.
- Never blank a field that had content unless the user explicitly asked to clear it.

${LATEX_RULE}

CURRENT CARD (JSON):
${JSON.stringify(current)}

Return ONLY a JSON object {"concept": "...", "intuition": "...", "formula": "..."} with all three fields present.`;

  const text = await complete(prompt, { json: true, ...ai });
  let obj;
  try {
    obj = parseLooseJson(text);
  } catch {
    throw new Error('edit: model returned non-JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('edit: not a JSON object');
  return {
    concept: restoreLatexEscapes(String(obj.concept ?? current.concept)),
    intuition: restoreLatexEscapes(String(obj.intuition ?? current.intuition)),
    formula: restoreLatexEscapes(String(obj.formula ?? current.formula)),
  };
}

/**
 * Speaker Mode: grade a learner's SPOKEN (or typed) explanation of a flashcard's
 * concept. The learner is trying to teach the idea back in their own words; we
 * score how well they understand it out of 3 and hand back warm, specific
 * feedback. The transcript comes from browser speech-to-text, so expect run-on
 * phrasing, filler words ("um", "like"), and mis-heard technical terms — judge
 * the UNDERSTANDING, not the wording, and read charitably through obvious
 * transcription slips (e.g. "grade in dissent" for "gradient descent").
 *
 * Rubric (0–3):
 *   3 = accurate AND complete; captures the core idea and the "why".
 *   2 = essentially right with a minor gap or imprecision.
 *   1 = a real spark of the idea but significant gaps or a notable error.
 *   0 = incorrect, off-topic, or no genuine explanation attempted.
 *
 * Returns { score, verdict, strengths[], gaps[], modelAnswer, encouragement }.
 */
export async function gradeExplanation({ concept, intuition, formula, scopeLabel, transcript }, ai = {}) {
  const said = String(transcript || '').trim();
  const prompt = `You are a warm, encouraging tutor grading how well a student EXPLAINED a concept back to you in their own words (they are trying to teach it to you). Reward genuine understanding, not vocabulary or polish.

THE CONCEPT THEY WERE ASKED TO EXPLAIN:
${concept}

REFERENCE MATERIAL (the correct understanding — grade the student against THIS, do not just repeat it back):
- Intuition: ${intuition || '(none provided)'}
- Formula / key detail: ${formula || '(none)'}
${scopeLabel ? `- Where this sits: ${scopeLabel}` : ''}

THE STUDENT'S SPOKEN EXPLANATION (auto-transcribed — may contain filler words, run-ons, and mis-heard technical terms; read charitably and correct obvious transcription errors in your head):
"""
${said || '(the student did not say anything)'}
"""

Score their UNDERSTANDING out of 3 using this rubric:
- 3 = accurate AND complete: they capture the core idea and the reasoning / "why".
- 2 = essentially correct with a minor gap or imprecision.
- 1 = a real spark of the right idea, but significant gaps or a notable error.
- 0 = incorrect, off-topic, or no genuine explanation attempted (including an empty or nonsense transcript).

RULES:
- Judge only what they actually conveyed. Do NOT give credit for things they did not say.
- Be generous about phrasing and word choice; be strict about the actual idea being right.
- Feedback must be specific to what they said — quote or paraphrase their words. No generic filler.
- Tone: kind and motivating, never shaming. Even a 0 gets a gentle, hopeful nudge.
- "modelAnswer" is a short, clear ideal explanation of the concept (2–4 sentences) they can compare against.

${LATEX_RULE}

Return ONLY a JSON object with exactly these keys:
{
  "score": 0 | 1 | 2 | 3,
  "verdict": "one short sentence summarizing how they did",
  "strengths": ["specific thing they got right", "..."],
  "gaps": ["specific thing they missed or got wrong", "..."],
  "modelAnswer": "a short ideal explanation of the concept",
  "encouragement": "one warm, motivating sentence"
}
"strengths" and "gaps" are arrays of short strings (each may be empty []). Every key must be present.`;

  const text = await complete(prompt, { json: true, ...ai });
  let obj;
  try {
    obj = parseLooseJson(text);
  } catch {
    throw new Error('grade: model returned non-JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('grade: not a JSON object');
  const score = Math.max(0, Math.min(3, Math.round(Number(obj.score) || 0)));
  const cleanList = (v) => (Array.isArray(v) ? v : [])
    .map((s) => restoreLatexEscapes(String(s || '')).trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    score,
    verdict: restoreLatexEscapes(String(obj.verdict || '')).trim(),
    strengths: cleanList(obj.strengths),
    gaps: cleanList(obj.gaps),
    modelAnswer: restoreLatexEscapes(String(obj.modelAnswer || intuition || '')).trim(),
    encouragement: restoreLatexEscapes(String(obj.encouragement || '')).trim(),
  };
}

/* -------------------------------- Book decks ------------------------------- */
/*
 * A BOOK deck is a lesson-level deck with a fixed shape: card 1 is the book
 * title (its back lists the key points — the lesson's sub-lessons), then one
 * card per point (its back is what you'd SAY when explaining that point). The
 * title card and the point fronts are deterministic — built by the caller from
 * the catalog — so the model's only job here is the point EXPLANATIONS, grounded
 * in the book summary/transcript already attached to the lesson.
 */

/** One back-of-card per point, matched to the numbered input by `index`. */
const BOOK_CARDS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      index: { type: 'integer' },
      intuition: { type: 'string' },
      formula: { type: 'string' },
    },
    required: ['index', 'intuition'],
    propertyOrdering: ['index', 'intuition', 'formula'],
  },
};

/** How much of the book source the card writer reads. Bigger than the generic
 *  genjob cap (12k): this is ONE call per book, and summaries run 10–25k chars. */
const BOOK_SOURCE_CHARS = 24000;

/**
 * Write the point-card backs for a book deck: for each key point, what the
 * learner should be able to SAY when they explain it (the author's actual
 * argument, with the book's concrete specifics), plus a one-line memory hook.
 * Returns [{intuition, formula}] aligned to the input `points` order (an index
 * the model failed to return comes back with empty strings — the caller still
 * builds the card so the deck stays complete).
 */
export async function generateBookPointCards({ book, points = [], transcript = '', instructions = '' }, ai = {}) {
  const names = points.map((p) => String(p || '').trim()).filter(Boolean);
  if (!names.length) return [];
  const source = String(transcript || '').trim().slice(0, BOOK_SOURCE_CHARS);
  const numbered = names.map((p, i) => `${i}. ${p}`).join('\n');

  const prompt = `You are helping a reader MASTER a book so they can discuss it from memory. The book has been distilled into key points; for each point you write the back of its flashcard: what the reader should be able to SAY, out loud, when they explain that point to a friend.

THE BOOK: ${book}

THE KEY POINTS (0-based index — return one object per index):
${numbered}
${source ? `\nSOURCE MATERIAL (a summary/transcript of the book — ground every explanation in THIS, using its concrete specifics: studies, names, numbers, examples):\n"""\n${source}\n"""\n` : ''}
FOR EACH POINT return:
- "intuition": the spoken explanation — 2 to 5 sentences capturing the author's actual argument for this point, in plain conversational language, with the book's concrete specifics where the source gives them. This is the answer key a discussion will be graded against, so it must stand on its own.
- "formula": one short memory hook — a single punchy line that snaps the whole point back (a rule, a phrase from the book, or a vivid image). Plain text.
${instructions ? `\nEXTRA GUIDANCE FROM THE ADMIN:\n${instructions}\n` : ''}
RULES:
- Ground everything in the source material; if the source doesn't cover a detail, rely on well-known facts about this book — and if you are unsure, leave the detail out rather than invent it.
- Do not repeat the point's name as the explanation; explain the IDEA behind it.
- No greetings, no meta-commentary, no "this point is about".

${NO_LATEX_RULE}

Return ONLY a JSON array with exactly one object per point: [{"index":0,"intuition":"...","formula":"..."}, ...]. Every index from 0 to ${names.length - 1} must appear exactly once.`;

  const text = await complete(prompt, { json: true, schema: BOOK_CARDS_SCHEMA, ...ai });
  let arr;
  try { arr = parseLooseJson(text); } catch { throw new Error('book cards: model returned non-JSON'); }
  if (!Array.isArray(arr)) throw new Error('book cards: not a JSON array');
  const byIndex = new Map();
  for (const o of arr) {
    const i = Math.round(Number(o && o.index));
    if (!Number.isFinite(i) || i < 0 || i >= names.length || byIndex.has(i)) continue;
    byIndex.set(i, {
      intuition: restoreLatexEscapes(String(o.intuition || '')).trim(),
      formula: restoreLatexEscapes(String(o.formula || '')).trim(),
    });
  }
  return names.map((_, i) => byIndex.get(i) || { intuition: '', formula: '' });
}

/** Per-point coverage verdicts for a spoken run-through of a book's points. */
const BOOK_RECALL_SCHEMA = {
  type: 'object',
  properties: {
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          covered: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['index', 'covered'],
        propertyOrdering: ['index', 'covered', 'note'],
      },
    },
    verdict: { type: 'string' },
    encouragement: { type: 'string' },
  },
  required: ['coverage', 'verdict', 'encouragement'],
  propertyOrdering: ['coverage', 'verdict', 'encouragement'],
};

/**
 * Grade a book-title recall: the learner tried to name and briefly explain EVERY
 * key point of the book from memory. Returns per-point covered/missed (aligned
 * to the input order) rather than one blended score, so the caller can log an
 * attempt against each point's own topic.
 *
 * `points` is [{point, intuition}] — the deck's point cards, whose backs are the
 * answer key a paraphrase is judged against.
 */
export async function gradeBookRecall({ book, points = [], transcript }, ai = {}) {
  const said = String(transcript || '').trim();
  const list = points.map((p, i) =>
    `${i}. ${p.point}${p.intuition ? `\n   The idea: ${String(p.intuition).replace(/\s+/g, ' ').slice(0, 400)}` : ''}`).join('\n');

  const prompt = `You are a warm, encouraging reading coach. A learner is trying to recall a book's KEY POINTS from memory — naming each point and saying a line or two about it. Judge WHICH points they genuinely covered.

THE BOOK: ${book}

THE KEY POINTS (0-based index — judge each one):
${list}

WHAT THE LEARNER SAID (auto-transcribed speech — filler words, run-ons and mis-heard terms are normal; read charitably and correct obvious transcription slips in your head):
"""
${said || '(the learner did not say anything)'}
"""

For EACH point decide "covered":
- true = they named it OR clearly paraphrased its core idea (exact wording never matters — the idea does).
- false = they never touched it, or got its idea substantively wrong.
Each "note" is one short, specific sentence: for a covered point, what they said that earned it; for a missed one, the one-line cue that would have earned it. Quote or paraphrase their words where you can.

Also return:
- "verdict": one sentence on the run-through as a whole (e.g. how many points landed, what pattern you see).
- "encouragement": one warm, motivating sentence. Never shaming — even a blank attempt gets a hopeful nudge.

${NO_LATEX_RULE}

Return ONLY a JSON object: {"coverage":[{"index":0,"covered":true,"note":"..."}, ...],"verdict":"...","encouragement":"..."}. Every index from 0 to ${points.length - 1} must appear exactly once.`;

  const text = await complete(prompt, { json: true, schema: BOOK_RECALL_SCHEMA, ...ai });
  let obj;
  try { obj = parseLooseJson(text); } catch { throw new Error('book recall: model returned non-JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('book recall: not a JSON object');
  const byIndex = new Map();
  for (const c of (Array.isArray(obj.coverage) ? obj.coverage : [])) {
    const i = Math.round(Number(c && c.index));
    if (!Number.isFinite(i) || i < 0 || i >= points.length || byIndex.has(i)) continue;
    byIndex.set(i, { covered: !!c.covered, note: restoreLatexEscapes(String(c.note || '')).trim() });
  }
  return {
    // A point the model failed to judge counts as missed — never silently passed.
    coverage: points.map((p, i) => ({ point: p.point, ...(byIndex.get(i) || { covered: false, note: '' }) })),
    verdict: restoreLatexEscapes(String(obj.verdict || '')).trim(),
    encouragement: restoreLatexEscapes(String(obj.encouragement || '')).trim(),
  };
}

/**
 * Reformat quiz QUESTIONS so their code and math render correctly, WITHOUT
 * changing wording or meaning. The frontend renders a question, its options and
 * its answer with the SAME code+math pipeline as flashcards:
 *   - code wrapped as \texttt{...} becomes an inline <code> chip,
 *   - $...$ / $$...$$ is typeset by KaTeX,
 *   - everything else is plain text (NO markdown: **bold**, bullets or raw HTML
 *     do NOT render — they show as literal characters).
 * The breakage this fixes: raw HTML tags left in the text (e.g. literal
 * "<code>def demo(a, b, *args):</code>" printing angle brackets and all), code
 * crammed inside a $...$ span, or malformed KaTeX. Returns the same items
 * ({id, question, options, answer}); a field that already renders fine is
 * returned unchanged. The answer MUST stay exactly equal to one option.
 */
export async function reformatQuestions(items, ai = {}) {
  const prompt = `You fix ONLY the formatting of multiple-choice quiz questions so they render correctly. You must NOT change wording, meaning, facts, numbers, the options, or their order.

The app renders "question", each entry of "options", and "answer" like this:
- CODE wrapped as \\texttt{...} renders as an inline code chip. Put ALL programming syntax here: identifiers, function signatures, snippets (e.g. \\texttt{def demo(a, b, *args):}, \\texttt{*args}, \\texttt{model.fit(X, y)}). Code must NEVER go inside $...$.
- MATH inside $...$ (inline) or $$...$$ (display) is typeset by KaTeX. Put ONLY genuine mathematical notation here, using valid KaTeX (\\frac, \\sum, \\to, \\times, \\le, \\cos, ...).
- Everything else is PLAIN TEXT. There is NO markdown and NO HTML: **bold**, backticks, and tags like <code>, <pre>, <b>, <br>, <sub> do NOT render — they print literally. Never output any of them.

FIX these mistakes (this is the whole job):
- ALWAYS REWRITE (never leave as-is): raw HTML tags in the text. Convert <code>...</code> and <pre>...</pre> content into \\texttt{...}; drop tags like <b>/<i>/<strong>/<em>/<u>/<span> and keep their inner text as plain prose; turn <br> into a space; convert <sub>x</sub>/<sup>2</sup> into KaTeX subscripts/superscripts inside $...$ when they are math. Example: "the call <code>demo(1, 2, 3, x=4)</code>" becomes "the call \\texttt{demo(1, 2, 3, x=4)}".
- Code placed inside $...$  ->  move it out of the math span and wrap it in \\texttt{...}.
- Prose glued into math with \\text{...}, \\implies, \\rightarrow etc.  ->  write it as a normal sentence OUTSIDE any $...$.
- Stray or unbalanced $ around plain text  ->  remove them.
- Invalid KaTeX inside a real math span  ->  correct it to valid KaTeX.
- Any **markdown** or backtick styling  ->  convert code to \\texttt{...} and drop the rest to plain text.

STRICT RULES:
- Preserve the exact wording and meaning. Reformat ONLY. Do not add, drop, or reword content.
- Keep "options" the SAME length and order. Reformat each option the same way.
- The "answer" string MUST end up EXACTLY equal (character for character) to one of the reformatted "options".
- Escape a literal currency dollar sign as \\$.
- If a field already renders correctly, return it UNCHANGED (character for character).

For EACH item return the same "id" with cleaned "question", "options" (same length and order) and "answer".

Return ONLY a JSON array of {"id", "question", "options", "answer"} objects.

ITEMS:
${JSON.stringify(items)}`;

  const text = await complete(prompt, { json: true, ...ai });
  let arr;
  try {
    arr = parseLooseJson(text);
  } catch {
    throw new Error('reformat-questions: model returned non-JSON');
  }
  if (!Array.isArray(arr)) throw new Error('reformat-questions: not a JSON array');
  return arr.map(cleanQuestionEscapes);
}

/**
 * The visual-spec contract shared by the flashcard prompts. The frontend renders
 * these with a small, SAFE function-plotter (no raw SVG from the model), so the
 * model must describe a plot declaratively. Keeping the schema tight is what lets
 * a "visual learner" get clean, on-brand diagrams (tangent lines, shaded areas,
 * limit approaches) instead of unreliable AI-drawn SVG.
 */
const VISUAL_RULE = `OPTIONAL VISUAL (include ONLY when a graph genuinely aids intuition; omit otherwise by leaving "visual" as null):
- "visual" must be an object describing a 2-D function plot that our app draws. NEVER output SVG, image URLs, or ASCII art.
- Shape: {"caption": "one short line under the graph", "domain": [xmin, xmax], "curves": [{"fn": "expr in x", "label": "optional", "color": "green|violet|red|muted"}], "tangentAt": x0 (optional), "area": [a, b] (optional, shades under curves[0]), "secant": [a, b] (optional), "points": [{"x": n, "label": "P"}] (optional), "vlines": [{"x": n, "label": "x→c"}] (optional)}.
- "fn" expressions may use ONLY: the variable x, numbers, + - * / ^, parentheses, the constants pi and e, and the functions sin, cos, tan, exp, ln, log, sqrt, abs. Example fns: "x^2", "sin(x)", "1/x", "exp(x)", "x^3 - 3*x".
- Use "tangentAt" for derivative/slope intuition, "area" for integral/area intuition, "secant" for average-vs-instantaneous rate, "vlines" for limits/asymptotes. Pick a domain that frames the interesting behaviour.
- Keep it to at most 2 curves and one or two annotations, so the picture stays clean.`;

/**
 * Generate a COMPREHENSIVE flashcard deck for a Course- or Lesson-level scope.
 * Each card focuses on two labelled parts — Intuition and Formula — and may carry
 * an optional declarative visual. The deck must be complete enough that mastering
 * it means answering any quiz question in scope; a subset is tagged `highway` for
 * rapid review (highest-impact + concepts that recur across lessons). Every card
 * is mapped to one real `topic` from the provided list so "quiz me" feeds mastery.
 */
export async function generateFlashcards({ scopeLabel, level, topics, questions, instructions = '' }, ai = {}) {
  const count = level === 'course' ? '18 to 30' : level === 'lesson' ? '8 to 14' : '5 to 9';
  const prompt = `You are a world-class teacher who makes highly technical subjects feel simple and intuitive. Build a set of STUDY FLASHCARDS for this ${level}-level section so a student can master it.
${guidanceBlock(instructions)}

SECTION: "${scopeLabel}" (${level} level)
TOPICS IN SCOPE (map every card to EXACTLY ONE of these, verbatim, in its "topic" field):
${topics.map((t) => `- ${t}`).join('\n')}

Here is a sample of the quiz questions that exist for this section (use them to gauge the required scope and depth; do NOT copy them or reveal answers):
${JSON.stringify(questions).slice(0, 6000)}

YOUR MISSION:
1. Write ${count} flashcards that COMPREHENSIVELY cover this section. Mastering every card MUST be enough to answer any question above. Cover each distinct idea; do not leave gaps.
2. Each card has a short "concept" (the FRONT: the idea/term/skill being learned, phrased as a crisp prompt) and a two-part BACK:
   - "intuition": explain the idea in plain, vivid language a beginner grasps immediately. Use analogies and a "why it works" angle. This is where a visual learner should feel it click. Define jargon.
   - "formula": the essential formula, rule, or precise definition to memorize, in LaTeX. If the card is purely conceptual, give the concise rule/definition; only use "—" when truly none applies.
3. HIGHWAY (rapid review): set "highway": true on the SMALLEST set of highest-impact cards — the foundational ideas and the concepts that recur across multiple lessons/topics — so reviewing only those gives the fastest meaningful refresh. Set "highway": false on the rest. Aim for roughly a third of the deck as highway.
4. Map each card to the single best-fitting "topic" from the list above (verbatim).

${VISUAL_RULE}

${LATEX_RULE}
Do NOT use em dashes; use commas, colons, or simple hyphens.

Return ONLY a JSON array, each element:
{"concept": "front text", "intuition": "plain-language explanation", "formula": "LaTeX formula/rule or —", "topic": "one topic verbatim", "highway": true|false, "visual": null | {plot object as specified}}`;

  const text = await complete(prompt, { json: true, ...ai });
  let arr;
  try {
    arr = parseLooseJson(text);
  } catch {
    throw new Error('Flashcard generation returned non-JSON content');
  }
  if (!Array.isArray(arr)) throw new Error('Flashcard generation did not return a JSON array');

  const topicSet = new Set(topics);
  return arr
    .filter((c) => c && c.concept && c.intuition)
    .map((c) => ({
      concept: String(c.concept).trim(),
      intuition: String(c.intuition).trim(),
      formula: c.formula ? String(c.formula).trim() : '—',
      // Snap the topic to a real one; fall back to the first in scope if the model drifted.
      topic: topicSet.has(String(c.topic).trim()) ? String(c.topic).trim() : topics[0] || '',
      highway: !!c.highway,
      visual: sanitizeVisual(c.visual),
    }));
}

/** Whitelist a model-supplied visual spec down to the safe declarative shape the plotter accepts. */
function sanitizeVisual(v) {
  if (!v || typeof v !== 'object') return null;
  const FN_OK = /^[\s0-9x.+\-*/^(),a-z]+$/i; // chars only; the plotter's parser is the real guard
  const COLORS = new Set(['green', 'violet', 'red', 'muted']);
  const num = (n) => (typeof n === 'number' && isFinite(n) ? n : null);
  const pair = (p) => (Array.isArray(p) && num(p[0]) != null && num(p[1]) != null ? [p[0], p[1]] : null);

  const curves = (Array.isArray(v.curves) ? v.curves : [])
    .filter((c) => c && typeof c.fn === 'string' && c.fn.length <= 120 && FN_OK.test(c.fn))
    .slice(0, 2)
    .map((c) => ({
      fn: c.fn.trim(),
      label: c.label ? String(c.label).slice(0, 40) : '',
      color: COLORS.has(c.color) ? c.color : 'green',
    }));
  if (!curves.length) return null;

  const out = { caption: v.caption ? String(v.caption).slice(0, 140) : '', curves };
  const dom = pair(v.domain);
  out.domain = dom && dom[0] < dom[1] ? dom : [-3, 3];
  if (num(v.tangentAt) != null) out.tangentAt = v.tangentAt;
  if (pair(v.area)) out.area = pair(v.area);
  if (pair(v.secant)) out.secant = pair(v.secant);
  if (Array.isArray(v.points)) {
    out.points = v.points.filter((p) => p && num(p.x) != null)
      .slice(0, 4).map((p) => ({ x: p.x, label: p.label ? String(p.label).slice(0, 12) : '' }));
  }
  if (Array.isArray(v.vlines)) {
    out.vlines = v.vlines.filter((p) => p && num(p.x) != null)
      .slice(0, 3).map((p) => ({ x: p.x, label: p.label ? String(p.label).slice(0, 16) : '' }));
  }
  return out;
}

/**
 * Generate ONE mastery MCQ that tests a specific flashcard's concept, staying on
 * the card's real `topic` so the banked question feeds that topic's mastery just
 * like any other. Mirrors generateDrillQuestion's validation (answer must match
 * an option exactly). Retries once on an unusable shape.
 */
export async function generateFlashcardQuestion({ topic, scopeLabel, concept, intuition, formula }, ai = {}, { brief = '', siblings = [], mode = '', difficulty = 'balanced' } = {}) {
  const others = (Array.isArray(siblings) ? siblings : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 9);
  const briefBlock = brief
    ? `THIS QUESTION'S BRIEF (write a question that does exactly this):\n${brief}\n${
        mode === 'procedural'
          ? 'This is a PROCEDURAL skill: it is fine to mirror the structure of the sibling questions — vary the specific given, not the wording for its own sake.'
          : mode === 'conceptual'
            ? 'This is a CONCEPTUAL skill: come at it from the specific angle named in the brief.'
            : ''
      }\n\n`
    : '';
  const siblingBlock = others.length
    ? `OTHER QUESTIONS IN THIS SET (yours must NOT be interchangeable with any of them):\n${others.map((s) => `- ${s}`).join('\n')}\n\n`
    : '';
  const prompt = `You are a Wise Master Educator and Professional Test Developer. Write ONE multiple-choice question that checks whether a student has truly mastered the specific concept on the flashcard below. Staying on the SAME sub-topic, test understanding (not mere recall).

SUB-LESSON / TOPIC: "${topic}"${scopeLabel && scopeLabel !== topic ? ` (within: ${scopeLabel})` : ''}

FLASHCARD BEING TESTED:
- Concept: ${concept}
- Intuition: ${intuition}
- Formula/Rule: ${formula || '(none)'}

${briefBlock}${siblingBlock}REQUIREMENTS:
1. The question must directly test the concept above, so that answering it correctly demonstrates understanding of this card.
2. It MUST stay on the topic "${topic}". Do NOT drift to a different sub-lesson.
3. Prefer a question that applies the idea, not one that just quotes the definition.

${DIFFICULTY_DIRECTIVE[difficulty] || DIFFICULTY_DIRECTIVE.balanced}

CRITICAL FORMATTING RULES (TO PREVENT TEST-HACKING):
- OPTION UNIFORMITY: all 4 options approximately the same character length.
- No "Length Bias": the correct answer is not the longest or most detailed.
- PARALLEL STRUCTURE: keep the phrasing of all options symmetrical.
- SOPHISTICATED DISTRACTORS: wrong answers should be plausible common misconceptions.

Do NOT use em dashes; use commas, colons, or simple hyphens.

${LATEX_RULE}
${ANSWER_INDEX_RULE}

Return ONLY a JSON object: {"question": "text", "options": ["A", "B", "C", "D"], "answerIndex": 0}`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let obj;
    try {
      obj = parseLooseJson(await complete(prompt, { json: true, schema: MCQ_SCHEMA, ...ai }));
    } catch {
      lastErr = new Error('flashcard quiz: returned non-JSON content');
      continue;
    }
    if (Array.isArray(obj)) obj = obj[0];
    const q = normalizeMcq(obj, topic);
    if (q) return q;
    lastErr = new Error('flashcard quiz: invalid question shape');
  }
  throw new Error(`Flashcard question generation failed (${lastErr?.message || 'unknown'})`);
}

/**
 * Generate `count` DISTINCT MCQs for a flashcard's concept (the "quiz me on this"
 * count picker), using a plan-then-parallel-write pipeline:
 *   1. planQuestions() decides, in ONE call, how the concept is mastered
 *      (procedural vs conceptual) and emits one brief per question, so a
 *      chain-rule card gets varied-given practice while a definition card gets
 *      varied angles — divergence by design, not by luck.
 *   2. Each brief is written IN PARALLEL by generateFlashcardQuestion. Short,
 *      independent writes stay fast and dodge the output-token truncation a
 *      single N-question call risks; each worker sees its siblings so it can't
 *      collide with them.
 *   3. Exact-text dedupe as a final safety net.
 * If the planner is unavailable it degrades to N blank briefs — i.e. the old
 * "N independent questions" behaviour — so the feature never dead-ends.
 *
 * `ctx.existing` (banked stems for the topic) and `ctx.performance` are passed
 * through to the planner as an avoid-list and a difficulty target.
 */
export async function generateFlashcardQuestions(card, count, ai = {}, ctx = {}) {
  const n = Math.min(10, Math.max(1, parseInt(count, 10) || 1));
  const { existing = [], performance = null, difficulty = 'auto', prereqs = [] } = ctx;
  // Resolve "auto" from this topic's history ONCE, so the plan and every parallel
  // writer aim at the same level (build up from what the learner has answered).
  const level = resolveDifficulty(difficulty, performance);

  // 1) Plan distinct briefs (best-effort — fall back to blank briefs on failure).
  let mode = '';
  let briefs = [];
  try {
    const plan = await planQuestions({
      label: card.scopeLabel || card.topic,
      context: `Concept: ${card.concept}\nIntuition: ${card.intuition}\nFormula/Rule: ${card.formula || '(none)'}`,
      existing,
      performance,
      difficulty,
      prereqs,
      count: n,
    }, ai);
    mode = plan.mode;
    briefs = plan.briefs;
  } catch { /* planner unavailable — fall through to blank briefs */ }
  if (!briefs.length) briefs = Array.from({ length: n }, () => '');

  // 2) Write each brief in parallel; a single failed write yields null, not a throw.
  const results = await mapWithConcurrency(briefs, 4, (brief, i) =>
    generateFlashcardQuestion(card, ai, { brief, mode, siblings: briefs.filter((_, j) => j !== i), difficulty: level })
      .catch(() => null));

  // 3) Drop failures and exact-duplicate stems.
  const out = [];
  const seen = new Set();
  for (const q of results) {
    if (!q) continue;
    const key = q.question.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  if (!out.length) throw new Error('No usable questions were generated');
  return out;
}

/* -------------------------- MCQ shape & contract -------------------------- */

/**
 * The single MCQ shape every question generator now asks for. The correct
 * answer is given as a 0-based INDEX into `options` rather than a copy of the
 * option text: an index can't drift out of sync with the options the way a
 * duplicated string can, so it removes a whole class of "answer didn't match an
 * option" failures (and saves the tokens of re-emitting the answer text).
 */
const ANSWER_INDEX_RULE =
  'Set "answerIndex" to the 0-based position (an integer 0-3) of the correct option within the "options" array. Do NOT repeat the answer text; the index alone identifies it.';

/** Gemini responseSchema for one MCQ (guarantees the shape at decode time). */
const MCQ_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    answerIndex: { type: 'integer' },
  },
  required: ['question', 'options', 'answerIndex'],
  propertyOrdering: ['question', 'options', 'answerIndex'],
};
/** Gemini responseSchema for a batch of MCQs. */
const MCQ_ARRAY_SCHEMA = { type: 'array', items: MCQ_SCHEMA };

/**
 * Normalize one raw MCQ (from any provider) into the stored shape
 * {topic, question, options, answer}. Prefers the numeric `answerIndex`; falls
 * back to a legacy `answer` string if a provider ignored the index. Returns null
 * if the item is unusable (missing text, too few options, or no resolvable
 * answer), so callers can filter a batch without throwing.
 */
function normalizeMcq(raw, topic) {
  if (!raw || !raw.question || !Array.isArray(raw.options)) return null;
  // restoreLatexEscapes repairs "\texttt"/"\frac"/... mangled into control chars
  // by JSON parsing, so generated questions are stored with valid LaTeX.
  const options = raw.options.map((o) => restoreLatexEscapes(String(o).trim()));
  if (options.length < 2 || options.some((o) => !o)) return null;

  let idx = raw.answerIndex;
  if (typeof idx === 'string' && /^\d+$/.test(idx.trim())) idx = parseInt(idx, 10);

  let answer;
  if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
    answer = options[idx];
  } else if (raw.answer != null) {
    // Fallback for providers that emitted the answer text instead of an index.
    const a = restoreLatexEscapes(String(raw.answer).trim());
    if (options.includes(a)) answer = a;
  }
  if (!answer) return null;

  return { topic, question: restoreLatexEscapes(String(raw.question).trim()), options, answer };
}

/**
 * Fan `fn` across `items` with at most `limit` promises in flight, preserving
 * order. Local copy of the server's helper so this module's generators can
 * parallelize their per-question writes without importing the server.
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Render learner performance for a generation prompt (null-safe). Summary only;
 *  how HARD to aim is decided separately by the difficulty directive below. */
function performanceBlock(performance) {
  if (!performance || performance.accuracy == null) {
    return 'LEARNER PERFORMANCE: no attempts recorded on this topic yet (treat as a first pass).';
  }
  const missed = Array.isArray(performance.missed) ? performance.missed.filter(Boolean).slice(0, 12) : [];
  return `LEARNER PERFORMANCE ON THIS TOPIC: ${performance.accuracy}% accuracy over ${performance.attempts || 0} attempt(s).${
    missed.length ? `\nRecently MISSED (bias new questions toward closing these gaps):\n${missed.map((m) => `- ${m}`).join('\n')}` : ''
  }`;
}

/**
 * Difficulty control. "auto" ramps from the learner's history on THIS topic —
 * untouched or shaky topics get CORE (rebuild fundamentals), solid topics get
 * BALANCED, well-mastered topics get CHALLENGE (edge-case stress test). A manual
 * pick (core|balanced|challenge) overrides the ramp. The CHALLENGE directive
 * keeps a fairness guard so "hard" never means "unfair/ambiguous".
 */
export const DIFFICULTIES = ['auto', 'core', 'balanced', 'challenge'];
export function resolveDifficulty(level, performance) {
  if (level === 'core' || level === 'balanced' || level === 'challenge') return level;
  const acc = performance && performance.accuracy != null ? performance.accuracy : null;
  const attempts = (performance && performance.attempts) || 0;
  if (acc == null || attempts < 2) return 'core'; // first pass / barely seen -> rebuild
  if (acc < 70) return 'core';                     // still shaky -> fundamentals
  if (acc < 90) return 'balanced';                 // solid -> apply under pressure
  return 'challenge';                              // mastered -> stress-test edges
}
const DIFFICULTY_DIRECTIVE = {
  core: `DIFFICULTY: CORE (reactivation / first pass). Write a FAIR question that checks the learner can APPLY the core idea in a straightforward, representative case. Do NOT use trick questions, obscure edge cases, or answers that hinge on an error/exception the learner could not anticipate. Aim so someone who just studied this gets it right roughly 85% of the time. Distractors are honest common mistakes, not adversarial traps.`,
  balanced: `DIFFICULTY: BALANCED. Write a question that needs genuine understanding — apply the idea in a slightly non-obvious case, with plausible-misconception distractors. Mild edge-awareness is fine; avoid adversarial trickery and ambiguous corner cases.`,
  challenge: `DIFFICULTY: CHALLENGE. Push into edge cases, boundary conditions, and subtle misconceptions that separate deep mastery from surface familiarity. It MUST remain FAIR: exactly one defensibly-correct answer, unambiguous, and never dependent on an error/exception or trivia the learner cannot reason out from the concept itself.`,
};
/** Performance summary + difficulty directive for a generation prompt. `level` is
 *  the raw choice ('auto'|'core'|'balanced'|'challenge'); 'auto' ramps from history. */
function difficultyBlock(level, performance) {
  return `${performanceBlock(performance)}\n\n${DIFFICULTY_DIRECTIVE[resolveDifficulty(level, performance)]}`;
}

/** Render the "already asked, do not repeat" avoid-list (bounded to keep prompts small). */
function avoidBlock(existing, verb = 'do NOT duplicate or paraphrase any of these') {
  // 80, not 60: this list now spans the whole LESSON (this topic's questions first,
  // then its siblings'), because a batch that can only see its own topic writes the
  // same question as the topic next door — see siblingTopicsBlock.
  const list = (Array.isArray(existing) ? existing : []).map((q) => String(q || '').trim()).filter(Boolean).slice(0, 80);
  if (!list.length) return '';
  return `ALREADY IN THE BANK (${verb}):\n${list.map((q) => `- ${q}`).join('\n')}\n`;
}

/**
 * The OTHER sub-lessons of the same lesson — the ones sibling calls in this run
 * are covering. (Named for the grain: `generateFlashcardQuestion` has its own
 * local block listing sibling QUESTIONS; this one lists sibling TOPICS.)
 *
 * Generation is per TOPIC, but a transcript is filed per LESSON, so every topic in
 * a lesson is handed identical material and told to test it. Without this block
 * each call is blind to the other five and mines the same passage: measured on the
 * RAG bank, one worked example appeared in all five topics of a lesson, and 18
 * questions covered 6 ideas. Telling the model where its topic ENDS is what the
 * avoid-list alone cannot do, because a sibling's questions often do not exist yet
 * when this call runs.
 */
function siblingTopicsBlock(siblings, topic) {
  const here = String(topic || '').trim().toLowerCase();
  const list = (Array.isArray(siblings) ? siblings : [])
    .map((s) => String(s || '').trim())
    .filter((s) => s && s.toLowerCase() !== here);
  if (!list.length) return '';
  return `BELONGS TO A SIBLING SUB-LESSON (questions on these are being written separately, so do NOT test them here and do not let them take over your scenarios):
${list.map((s) => `- ${s}`).join('\n')}
`;
}

/**
 * Optional steer for a generation run — whoever triggered it describing what kind
 * of questions/cards they want (e.g. "more application scenarios", "focus on RNNs",
 * "harder edge cases", or a weakness to drill). Used by both the admin generator
 * and the learner's Generate-Questions box. Injected as high-priority guidance on
 * emphasis/style, but it never overrides accuracy or the formatting rules. Empty
 * when no guidance is given.
 */
function guidanceBlock(instructions) {
  const s = String(instructions || '').trim().slice(0, 2000);
  if (!s) return '';
  return `\nREQUESTED FOCUS (what kind of questions to write — follow this closely for emphasis, angle and difficulty, but NEVER at the expense of accuracy, grounding, or the formatting rules):\n"""\n${s}\n"""\n`;
}

/**
 * Optional source material the learner chose to base generated questions on
 * (concatenated transcript text). Questions may draw on its specifics; it is a
 * reference, not a hard grounding contract (generateQuestions stays a
 * knowledge-based generator). Empty when no transcripts were selected.
 */
function referenceBlock(reference) {
  const s = String(reference || '').trim().slice(0, 8000);
  if (!s) return '';
  return `\nREFERENCE MATERIAL the learner chose to base these questions on (draw on its specifics and terminology where relevant; do not contradict it):\n"""\n${s}\n"""\n`;
}

/**
 * Render the knowledge graph's prerequisite context for a generation prompt:
 * what this topic builds on and where the learner stands on each piece
 * ([{topic, accuracy, attempts, why}] from lib/graph.js prereqContext). Weak or
 * untouched prerequisites steer questions to exercise them as sub-steps —
 * that's how the graph "tells the algorithm what to include in the prompt".
 */
function prereqBlock(prereqs) {
  const list = (Array.isArray(prereqs) ? prereqs : []).filter((p) => p && p.topic).slice(0, 6);
  if (!list.length) return '';
  const line = (p) => {
    const standing = p.attempts > 0
      ? `learner at ${p.accuracy}% over ${p.attempts} attempt(s)${(p.accuracy ?? 0) < 70 ? ' — WEAK' : ''}`
      : 'never practised — assume NO fluency';
    return `- ${p.topic}: ${standing}${p.why ? ` (${p.why})` : ''}`;
  };
  return `PREREQUISITE CONTEXT (knowledge graph — what this topic builds on, and the learner's standing on each):
${list.map(line).join('\n')}
Use it: where a prerequisite is WEAK or never practised, prefer questions whose solution path exercises that prerequisite as a natural sub-step (practising this topic should also repair the gap), and never let a correct answer HINGE on unexplained fluency in it. Where prerequisites are strong, build on them freely for depth.
`;
}

/**
 * Plan a set of DISTINCT questions BEFORE any are written. One cheap call reads
 * the concept, decides HOW mastery is actually built for it, and emits one
 * "brief" per question so the parallel writers diverge by design instead of by
 * luck.
 *
 * The key idea (the chain-rule case): "distinct" does NOT mean "differently
 * worded". For a PROCEDURAL skill, mastery comes from repeating the SAME process
 * over varied givens, so the briefs vary the inputs and the questions SHOULD look
 * structurally parallel. For a CONCEPTUAL skill, mastery comes from probing
 * different facets, so the briefs vary the angle. The planner classifies the
 * skill first, then varies along the right axis.
 *
 * `existing` (already-banked stems) is an avoid-list so plans don't recreate what
 * the learner has seen; `performance` ({accuracy, attempts, missed}) aims the
 * plan at real weak spots. Returns up to `count` briefs — callers MUST degrade
 * gracefully when fewer (or none) come back.
 *
 * @returns {Promise<{mode: string, briefs: string[]}>}
 */
export async function planQuestions({ label, context, existing = [], performance = null, difficulty = 'auto', prereqs = [], count }, ai = {}) {
  const n = Math.min(10, Math.max(1, parseInt(count, 10) || 1));
  const prompt = `You are an expert instructional designer planning a set of up to ${n} quiz questions that TOGETHER make a student fully master ONE concept. You are NOT writing the questions yet — only a one-line brief for each, so specialist writers can produce them in parallel without overlapping.

CONCEPT / SCOPE: "${label}"
WHAT IS BEING TESTED:
${context}

${difficultyBlock(difficulty, performance)}

${prereqBlock(prereqs)}
${avoidBlock(existing, 'do NOT plan a question that duplicates or paraphrases any of these')}
STEP 1 — Decide how THIS concept is actually mastered:
- "procedural": a process/skill mastered by REPEATED PRACTICE over varied givens (e.g. applying the chain rule, integrating by parts, matrix multiplication). Different questions run the SAME procedure on DIFFERENT inputs and SHOULD look structurally similar — that is correct practice, not repetition.
- "conceptual": an idea mastered by understanding it from multiple ANGLES (definitions, implications, edge cases, comparisons, common misconceptions).
- "mixed": needs a few conceptual anchors plus several practice repetitions.

STEP 2 — Produce up to ${n} briefs that TOGETHER give full coverage with NO wasted question (no two briefs may be interchangeable):
- If procedural: each brief names a DIFFERENT given/input/scenario to run the process on (vary functions, numbers, contexts, difficulty), holding the process constant.
- If conceptual: each brief names a DIFFERENT facet, angle, or misconception to target.
- If the concept is narrow and genuinely supports fewer than ${n} distinct, non-redundant questions, return FEWER briefs rather than padding with near-duplicates.

Each brief is ONE sentence: what THIS question should test and, where relevant, the exact given to use or the misconception to bait.

Return ONLY JSON: {"mode": "procedural|conceptual|mixed", "briefs": ["brief 1", "brief 2"]}`;

  const obj = parseLooseJson(await complete(prompt, { json: true, ...ai }));
  const rawBriefs = Array.isArray(obj?.briefs) ? obj.briefs : Array.isArray(obj) ? obj : [];
  const briefs = rawBriefs.map((b) => String(b || '').trim()).filter(Boolean).slice(0, n);
  const mode = ['procedural', 'conceptual', 'mixed'].includes(obj?.mode) ? obj.mode : 'mixed';
  return { mode, briefs };
}

function buildPrompt(topic, baseline, count, { existing = [], siblings = [], performance = null, difficulty = 'auto', prereqs = [], instructions = '', reference = '' } = {}) {
  return `You are a Wise Master Educator and Professional Test Developer.
Below are a few "Baseline Questions" from my database for the topic: "${topic}", shown ONLY so you can calibrate the expected depth.

BASELINE DATA (depth calibration only):
${JSON.stringify(baseline)}

${difficultyBlock(difficulty, performance)}

${prereqBlock(prereqs)}
${siblingTopicsBlock(siblings, topic)}${avoidBlock(existing)}${referenceBlock(reference)}${guidanceBlock(instructions)}
YOUR MISSION:
1. Build ON TOP of the baseline: increase rigor beyond simple definitions toward conceptual mechanics, implications, and multi-step reasoning.
2. First decide how THIS topic is mastered, then make the ${count} new questions DISTINCT accordingly:
   - PROCEDURAL skill (a process practised over varied inputs, e.g. applying the chain rule): each question runs the same process on a DIFFERENT given; questions MAY share structure — that is correct practice, not repetition.
   - CONCEPTUAL skill: each question probes a DIFFERENT facet, angle, or misconception.
3. No two of the new questions may be interchangeable, and none may duplicate or paraphrase anything already in the bank (above).

CRITICAL FORMATTING RULES (TO PREVENT TEST-HACKING):
- OPTION UNIFORMITY: All 4 options must be of approximately the same character length.
- No "Length Bias": Do not make the correct answer the longest or most detailed.
- PARALLEL STRUCTURE: If one option starts with a verb, all must start with a verb. Keep the phrasing symmetrical.
- SOPHISTICATED DISTRACTORS: Ensure wrong answers are plausible and address common high-level misconceptions.

Generate ${count} NEW "Mastery Level" MCQs.
Do NOT use em dashes (the long dash). Use commas, colons, or simple hyphens instead.

${LATEX_RULE}
${ANSWER_INDEX_RULE}

Return ONLY a JSON array: [{"question": "text", "options": ["A", "B", "C", "D"], "answerIndex": 0}]`;
}

/* ------------------- Transcript-grounded generation (Academy) --------------- */
/*
 * The prompts above are a DATA-SCIENCE profile: they exist to produce maths, and
 * LATEX_RULE is the giveaway. The Academy profile below is the opposite —
 * applied, scenario-shaped questions with NO KaTeX anywhere (a stray "$500" would
 * render as broken math, since $...$ IS the math delimiter — hence the explicit
 * rule below).
 *
 * 🔴 The Academy profile is NOT a marketing profile, though it was born as one and
 * read like one until 2026-09-08: all three builders opened "an assessment for a
 * working digital marketer" and illustrated their rules with ad campaigns. The
 * Academy now also hosts AI engineering, data engineering and RAG, so every one of
 * those questions was being framed for a marketer. WHO the assessment is for is a
 * property of the program (`audienceFor` in programs.js) and is passed in; the
 * rules here must stay subject-neutral so they bias no domain.
 *
 * 🔴 NO_LATEX_RULE is still unconditional, and that is now a real constraint on
 * technical subjects: a BM25 or cosine-similarity formula cannot be typeset here.
 * Lifting it needs the $-collision above solved first, not just the rule deleted.
 *
 * The other difference is where the truth comes from. generateQuestions() draws
 * on the model's own knowledge, calibrated by baseline questions. Here the
 * TRANSCRIPT is the source of truth: it is the actual course material, and a
 * question about something the video never said is worse than no question at
 * all. So the prompt is strictly grounded and the model is told to write fewer
 * questions rather than invent.
 */

/** One MCQ plus the difficulty tag the Academy's selector uses. */
const TRANSCRIPT_MCQ_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    answerIndex: { type: 'integer' },
    difficulty: { type: 'string', enum: ['core', 'balanced', 'challenge'] },
  },
  required: ['question', 'options', 'answerIndex', 'difficulty'],
  propertyOrdering: ['question', 'options', 'answerIndex', 'difficulty'],
};
const TRANSCRIPT_MCQ_ARRAY_SCHEMA = { type: 'array', items: TRANSCRIPT_MCQ_SCHEMA };

const NO_LATEX_RULE = `PLAIN-TEXT RULE (this course is NOT maths — the app renders $...$ as LaTeX):
- Never use dollar-sign delimiters. Write money as "USD 500" or "500 dollars", NEVER "$500" (a lone $ would be parsed as the start of a formula and mangle the question).
- No LaTeX commands, no backslash macros, no code fences, no backticks.
- Percentages, ratios and simple arithmetic go in plain words/digits: "a 3.2% CTR", "2x ROAS".`;

const DIFFICULTY_MIX_RULE = `DIFFICULTY: tag every question "core", "balanced", or "challenge".
- core: can they recall/recognise what was taught?
- balanced: can they apply it to a straightforward situation?
- challenge: can they judge a realistic trade-off, diagnose a problem, or pick between two defensible options?
Aim for a spread across the batch rather than all one level.`;

/* ------------------------- naming a sub-lesson ------------------------------
 * A sub-lesson's NAME is not a filing label — it is the front of a flashcard and
 * the title card's recall list, where it appears with nothing else on screen. So
 * the two kinds of curriculum want opposite names, and every planner asks for the
 * right one through `topicNameRule(reading)`:
 *
 *   CONCEPT programs (career: data science, marketing, RAG …) want a short noun
 *   phrase. "Frequency capping" is the standard name of a thing that exists, it
 *   is what a practitioner would search for, and turning it into a sentence would
 *   assert one claim about a topic that has many.
 *
 *   READING programs (category 'growth' — the Philosophical / Spiritual tabs)
 *   want the CLAIM. A book's sub-lesson is one of its key points, and a key point
 *   is an argument, not a term: "Myth of innate talent" names a subject the
 *   reader must already know to decode, while "Innate talent is a myth — the
 *   future stars showed no early edge" teaches on its own. The engine's book deck
 *   makes this decisive: the title card asks the reader to name and explain every
 *   point from memory, so a list of bare labels is a list of things they have to
 *   remember rather than a list of things they can think with.
 *
 * The reading rule was written after the Philosophy program shipped 28 label-only
 * sub-lessons (2026-09-08) — see AGENTS.md §7.
 */
const TOPIC_NAME_RULE_CONCEPT = 'A topic is ONE testable idea named as a short noun phrase ("Frequency capping", "UTM parameters"). Do not make a topic per sentence; group into a handful of meaningful ones.';

const TOPIC_NAME_RULE_READING = `🔴 NAME EACH TOPIC AS THE POINT ITSELF, NOT AS A LABEL FOR IT. This is a READING program: a topic is one of the book's key points, and its name is the only thing the reader sees on the front of the recall card. So write the name as a short declarative CLAIM that carries the insight and could be argued with.
- ✗ "Myth of innate talent" → ✓ "Innate talent is a myth — the future stars showed no early edge"
- ✗ "Limits of IQ as a predictor" → ✓ "High IQ does not predict high performance"
- ✗ "Deliberate practice" → ✓ "Deliberate practice means drilling the weak link with feedback"
- ✗ "Ten-year rule of mastery" → ✓ "Mastery has a ten-year on-ramp"
- Say what the book actually argues, in the book's own terms — never a generic truism ("Practice is important"), never a question, never a chapter heading ("How to practise"), never a how-to instruction.
- Under about 14 words. No trailing period, no quotation marks, no numbering, no "The author says…".
- One claim each, and each must stand apart from its siblings: two points that would collapse into the same sentence are ONE point.`;

/**
 * The topic-naming rule for a program's planners. `reading` is true for a
 * category 'growth' program (see `isReadingProgram` in server.js), which is the
 * same switch that puts a lesson into book-deck shape.
 */
export function topicNameRule(reading = false) {
  return reading ? TOPIC_NAME_RULE_READING : TOPIC_NAME_RULE_CONCEPT;
}

/* --------------------- the SHAPE of a reading program ----------------------
 * `topicNameRule` fixes what a sub-lesson is CALLED. This fixes where the book
 * SITS, which is a separate decision and the one that actually broke.
 *
 * A reading program's tree is not a concept map — it is a shelf. The engine
 * builds its book deck per LESSON (`buildBookDeck`: "the lesson is the book"),
 * so a book filed as a COURSE with its themes as lessons can never produce a
 * title card, and the reader loses the recall exercise the whole program exists
 * for. `planFromSources` had produced exactly that for The Charisma Myth and Do
 * Hard Things, because its strongest instruction is that sources are material
 * and never structure — correct for a career curriculum and precisely wrong for
 * a shelf, where the source IS the unit of study.
 *
 * 🔴 That contradiction is why this block must be injected AFTER the rule it
 * overrides, never before: a model reading top-to-bottom has to meet the
 * exception after the general case. Same discipline as `deepBlock` (AGENTS §7).
 */
const SCOPE_SHAPE_RULE_READING = `
🔴 OVERRIDE FOR THIS PROGRAM — IT IS A READING PROGRAM, SO THE SHELF IS THE STRUCTURE. Everything above about never naming a unit after a source is REVERSED at the lesson grain, and only there:
- A LESSON is ONE BOOK, named with its real title and author — "Talent Is Overrated by Geoff Colvin", "Mere Christianity by C.S. Lewis". This is the one place a source's own name is required rather than forbidden.
- A COURSE is a THEME several different books can sit under — "Peak Performance", "Stoic Philosophy", "Emotion Regulation". NEVER name a course after a book, and never let a course hold exactly one book's worth of chapters.
- A long book becomes SEVERAL lessons, each carrying the book's name — "The Charisma Myth — Presence", "The Charisma Myth — First Impressions". Never one lesson with twenty key points, and never a course of its own.
- Aim for 4 to 8 key points per lesson: that is one recall card's worth, which is the unit the reader is actually tested on.
- Anything not a book — a podcast episode, a talk — is still a LESSON, named for what it is and who said it.`;

/**
 * The scope-shape rule for a program's planners: empty for a concept (career)
 * program, so their prompts are byte-identical to before, and the override above
 * for a reading program. Interpolate it AFTER the sources-are-not-structure rule.
 */
export function scopeShapeRule(reading = false) {
  return reading ? SCOPE_SHAPE_RULE_READING : '';
}

/* --------------------------- auto-file router ------------------------------ */
/**
 * The shape the router returns: where a piece of source material belongs, and
 * which topics it should build. New-vs-existing is decided by the CALLER from
 * these names against the live catalog, so the model is never trusted to know
 * what already exists — only to place the material sensibly.
 */
const PLACEMENT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    track: { type: 'string' },
    course: { type: 'string' },
    lesson: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'track', 'course', 'lesson', 'topics'],
  propertyOrdering: ['title', 'summary', 'track', 'course', 'lesson', 'topics'],
};

/** Longest slice of a transcript worth reading just to decide WHERE it belongs. */
const CLASSIFY_TRANSCRIPT_CHARS = 9000;

/** Render a catalog (rows of {track,course,lesson,topic}) as an indented outline for the router. */
function catalogOutline(catalog, cap = 12000, focus = '') {
  const tree = new Map();
  // In STUDY order, not doc order. The models that read this outline are asked to
  // reason about sequence ("what does this build on?", "resequence when it clearly
  // improves the learning order") — handed the rows in Firestore's doc-id order they
  // are reasoning about an alphabetical tree that nobody sees. Sorts on the three
  // stored grains (course / lesson / topic), each falling back to the name.
  const rank = (v) => (Number.isFinite(v) ? v : Infinity);
  const name = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  const rows = [...catalog].sort((a, b) => (
    name(a.track, b.track)
    || rank(a.courseOrder) - rank(b.courseOrder) || name(a.course, b.course)
    || rank(a.lessonOrder) - rank(b.lessonOrder) || name(a.lesson, b.lesson)
    || rank(a.order) - rank(b.order) || name(a.topic, b.topic)
  ));
  for (const r of rows) {
    const key = [r.track, r.course, r.lesson].join(' > ');
    if (!tree.has(key)) tree.set(key, []);
    if (r.topic) tree.get(key).push(r.topic);
  }
  const groups = [...tree].map(([key, topics]) => ({
    key,
    text: [key, ...topics.map((t) => `    - ${t}`)].join('\n'),
  }));
  const full = groups.map((g) => g.text).join('\n');
  // The common case: it fits, so emit the whole thing in curriculum order.
  if (full.length <= cap) return full;

  /*
   * It does not fit. Cutting the string at `cap` would keep whatever happens to sit first in
   * curriculum order, which is unrelated to what was asked — on a small local model that produced
   * answers like "I don't see a card on boosting" for a learner whose engine contains a whole
   * Ensemble Methods course, and then invented plausible topic names to fill the gap.
   *
   * So when we must drop content, drop the LEAST relevant: score each lesson group against the
   * words in the question and emit best-first. Ties keep curriculum order, so a question with no
   * usable keywords degrades to exactly the old behaviour.
   */
  const words = [...new Set(String(focus).toLowerCase().match(/[a-z][a-z+#.-]{2,}/g) || [])];
  const score = (g) => {
    const hay = g.text.toLowerCase();
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
  };
  const ranked = words.length
    ? groups.map((g, i) => ({ g, i, s: score(g) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.g)
    : groups;

  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const g of ranked) {
    if (used + g.text.length + 1 > cap) { dropped += 1; continue; }
    kept.push(g);
    used += g.text.length + 1;
  }
  // Re-sort what survived back into curriculum order so the outline still reads as a curriculum.
  const order = new Map(groups.map((g, i) => [g.key, i]));
  kept.sort((a, b) => order.get(a.key) - order.get(b.key));
  return `${kept.map((g) => g.text).join('\n')}\n… (${dropped} further lesson group(s) omitted — ask about one by name to see it)`;
}

/**
 * Ground the Study Assistant in the REAL curriculum so it can answer "which card /
 * topic / lesson teaches X" from what actually exists instead of inventing a name.
 * The caller passes the learner's catalog ONLY for content-location questions (so
 * ordinary turns don't pay the tokens); empty → no block. A "card"/"topic"/
 * "sub-lesson" the student can study IS one of these leaf items.
 */
/**
 * How much curriculum to paste into the assistant prompt.
 *
 * A hosted model swallows 32k characters of catalog without noticing. A local one on a laptop does
 * not: with ~900 topics that block alone overruns a typical 8k context, and generation slows from
 * seconds to many minutes — the answer is still correct, but nobody waits that long. So when the
 * engine is Ollama or LM Studio the grounding is trimmed to something a small model can actually
 * read. Raise it with LOCAL_GROUNDING_CHARS if you run a long-context local model.
 */
const LOCAL_GROUNDING_CHARS = parseInt(process.env.LOCAL_GROUNDING_CHARS || '6000', 10);
function groundingBudget(ai = {}) {
  const local = ai.provider === 'ollama' || ai.provider === 'lmstudio';
  return local
    ? { catalogChars: LOCAL_GROUNDING_CHARS, transcriptChars: Math.round(LOCAL_GROUNDING_CHARS / 3) }
    : { catalogChars: 32000, transcriptChars: 12000 };
}

function assistantCatalogBlock(catalog, transcripts = [], budget = {}, focus = '', actionsEnabled = false) {
  const { catalogChars = 32000, transcriptChars = 12000 } = budget;
  if ((!Array.isArray(catalog) || !catalog.length) && (!Array.isArray(transcripts) || !transcripts.length)) return '';
  // Rows flagged `removed` are sections the learner temporarily removed (parked): shown to
  // the assistant as their own labelled list so it KNOWS about them, but never mixed into
  // the active engine (they must not appear in study paths or "what am I studying" answers).
  const active = (catalog || []).filter((r) => !r.removed);
  const removed = (catalog || []).filter((r) => r.removed);
  let block = '';
  if (active.length) {
    block += `THE LEARNER'S MASTERY ENGINE — the EXACT set of content they've chosen to master: their tracks, courses, lessons and sub-lessons. Sections they removed are NOT here (they're listed separately below); sections they individually added ARE. When they ask "what's in my Mastery Engine" / "what am I studying" / to audit their engine, THIS list is the answer (not the whole catalog or a roadmap). Track > Course > Lesson, then each lesson's sub-lessons — these sub-lessons ARE the "cards"/"topics" they can study${actionsEnabled ? ' — you can also propose remove_section (or remove_sections for several at once) on any of these to park one the learner wants set aside' : ''}:
${catalogOutline(active, catalogChars, focus)}
`;
  }
  if (removed.length) {
    block += `\nSECTIONS TEMPORARILY REMOVED (PARKED) FROM THEIR ENGINE — the learner set these aside for now. They are hidden from their Progress, quizzes and drills, but NOT deleted: the content stays in the bank and is restorable anytime. You CAN see and discuss these, say plainly that they're parked when asked${actionsEnabled ? ', and propose restore_section (exact names from here) when the learner wants one back' : '; you have NO action tool in this conversation to restore them yourself — tell them to use "Customize my engine" → Restore in the app, or that a future message with actions enabled could do it'}. NEVER count them in "what's in my engine" answers or include them in a suggested study path unless the learner asks to bring them back:
${catalogOutline(removed, Math.min(8000, catalogChars), focus)}
`;
  }
  if (Array.isArray(transcripts) && transcripts.length) {
    const lines = transcripts.slice(0, 400)
      .map((t) => `    - "${t.title}"${[t.track, t.course, t.lesson].filter(Boolean).length ? `  (${[t.course, t.lesson].filter(Boolean).join(' > ')})` : ''}`);
    let txt = lines.join('\n');
    if (txt.length > transcriptChars) txt = `${txt.slice(0, transcriptChars)}\n    … (more)`;
    block += `\nSOURCE TRANSCRIPTS attached to the curriculum (videos/notes the questions were built from — these are the ONLY transcripts that exist; a "transcript"/"video" the student can point to is one of these):\n${txt}\n`;
  }
  return `${block}
HARD RULE — CONTENT LOCATION: when the student asks where something is taught, or which card / sub-lesson / lesson / course / track / transcript / video covers a concept, answer ONLY with names copied VERBATIM from the lists above. NEVER invent, rename, or guess a card/topic/lesson/section/transcript that is not listed. If nothing clearly matches, say so plainly (e.g. "I don't see a dedicated card on that exact thing") and point to the closest real items that do exist. Do not present an inferred or "should-exist" name as if it were real.`;
}

/**
 * COACH MODE grounding: the student's own progress (what they've mastered / are
 * weak on) plus the instruction to answer AND recommend a personalised drill path
 * of REAL sub-lessons. Only injected when the caller turns coach mode on (it rides
 * on top of the catalog/transcripts block, which the caller always supplies here).
 */
function assistantCoachBlock(coach, progress, admin = false) {
  if (!coach) return '';
  const prog = String(progress || '').trim();
  // Admins can generate new curriculum from Academy Admin → "Build with AI (From a
  // goal)": paste a goal, and the app drafts a course of lessons+topics on top of
  // what's already known, then generates questions + flashcards. So in coach mode an
  // admin can ask the assistant to write that goal for them, targeting their gaps.
  const buildTool = admin
    ? `\n\nBUILD-WITH-AI (you are talking to an ADMIN): the app can GENERATE new lessons from Academy Admin → "Build with AI" → "From a goal" — you paste a plain-English GOAL and it drafts a module (a course of lessons + sub-lessons) on top of what the learner already knows, then writes questions and flashcards. If the student asks you to fill their gaps, build content, or "write a prompt to Build with AI", produce a READY-TO-PASTE goal inside a fenced code block: one tight paragraph that (a) names the specific weak/missing areas from the progress above, (b) states what they've ALREADY mastered so the module builds on it instead of re-teaching, and (c) states the concrete can-do outcome to reach. Then tell them to paste it into Academy Admin → Build with AI → From a goal.`
    : '';
  return `${prog ? `THE STUDENT'S PROGRESS SO FAR (calibrate to this — do NOT re-teach what they've mastered; start where they're weak or haven't begun):\n${prog}\n\n` : ''}COACH MODE IS ON. WHEN — AND ONLY WHEN — the student's message is about their LEARNING (a concept or curriculum topic, what to study next, how to improve at something in the curriculum above, or their study progress), end that reply with a section headed exactly "**Suggested path to drill this**": a NUMBERED list of 2 to 6 real sub-lessons drawn VERBATIM from the curriculum above, in order (prerequisites first), tailored to their progress (skip what they've mastered, start where they're weak or haven't begun, end at whichever existing sub-lesson most directly covers what they asked about). Every item MUST be a sub-lesson that literally appears in the curriculum above — never invent one.
DO NOT append a study path when the conversation is not about studying the curriculum — e.g. logging a workout or body stats, career or goals, personal reflections, editing their profile, or small talk. In those cases just answer naturally, with no "Suggested path" section. Never force a curriculum tangent onto an unrelated topic.${buildTool}`;
}

/**
 * Decide where a piece of source material belongs in a program and what topics it
 * should build — the "auto-file" router behind the admin's paste-and-go flow.
 *
 * Given the transcript and the program's current Track > Course > Lesson > Topic
 * tree, it either slots the material into an EXISTING lesson (reusing names
 * exactly so nothing forks a near-duplicate) or proposes new track/course/lesson/
 * topic names. It only decides placement; the caller upserts the rows, attaches
 * the transcript, and runs the normal generation job — so this stays a pure,
 * side-effect-free classification.
 *
 * @returns {Promise<{title:string,summary:string,track:string,course:string,lesson:string,topics:string[]}>}
 */
export async function classifyTranscript({ transcript, catalog = [], programName = '', reading = false }, ai = {}, onToken) {
  const body = String(transcript || '').trim().slice(0, CLASSIFY_TRANSCRIPT_CHARS);
  if (!body) throw new Error('No source material to place');

  const outline = catalogOutline(catalog);
  const prompt = `You are the curriculum architect for a professional training program${programName ? ` ("${programName}")` : ''}. New source material has arrived and you must decide where it belongs.

CURRENT CURRICULUM (Track > Course > Lesson, with each lesson's topics):
${outline || '(the curriculum is empty — you are placing the very first material)'}

NEW SOURCE MATERIAL:
"""
${body}
"""

YOUR JOB — return a single placement:
1. Decide the Track, Course, and Lesson this material belongs under.
   - If it fits an EXISTING track/course/lesson above, reuse that name EXACTLY, character-for-character, so it merges instead of forking a near-duplicate ("Meta Ads" must not become "Facebook Ads").
   - If it is genuinely new, propose a clear, concise name. Only name a lesson "Unit N: Name" if that matches the course's existing style; otherwise a plain descriptive lesson name is fine.${scopeShapeRule(reading)}
2. Choose the TOPICS this material should build questions for (1 to 6):
   - Include existing topics in the chosen lesson that this material genuinely covers (reuse their exact names) so learners get reinforced on them.
   - Add new topics for distinct skills or concepts this material teaches that no existing topic covers.
   - ${topicNameRule(reading)}
3. Write a short "title" for this material (like a video or lesson title) and a one-sentence "summary" of what it teaches.

Ignore filler: greetings, sponsor reads, subscribe requests and tangents are not curriculum.

Return ONLY JSON: {"title":"...","summary":"...","track":"...","course":"...","lesson":"...","topics":["...","..."]}`;

  // Streaming path (onToken) forwards the reasoning trace live and drops the JSON
  // schema (the stream API can't carry it); parseLooseJson recovers the object.
  const text = onToken
    ? await streamStructured(prompt, ai, onToken)
    : await complete(prompt, { json: true, schema: PLACEMENT_SCHEMA, ...ai });
  let out;
  try { out = parseLooseJson(text); } catch { throw new Error('The model returned non-JSON content'); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('The model did not return a placement object');

  const clean = (v) => String(v == null ? '' : v).trim();
  const track = clean(out.track); const course = clean(out.course); const lesson = clean(out.lesson);
  if (!track || !course || !lesson) throw new Error('The model did not return a full Track / Course / Lesson placement');
  const topics = [...new Set((Array.isArray(out.topics) ? out.topics : []).map(clean).filter(Boolean))].slice(0, 8);
  if (!topics.length) throw new Error('The model did not propose any topics');

  return { title: clean(out.title) || 'Untitled', summary: clean(out.summary), track, course, lesson, topics };
}

/* --------------------- corpus planner (sources -> curriculum) -------------- */
/*
 * `classifyTranscript` files ONE source into an EXISTING tree; `planCurriculum`
 * designs a tree from a stated GOAL. Neither designs a tree from a CORPUS — a
 * pile of raw transcripts uploaded with no curriculum at all. That is what these
 * two do, and they are deliberately a MAP then a REDUCE:
 *
 *   digestSource()    map    — one cheap call per source, cached on the doc
 *   planFromSources() reduce — one call over all the digests, returns the tree
 *
 * The split is forced by size. A 40-video course is comfortably 800k characters;
 * `CLASSIFY_TRANSCRIPT_CHARS` caps a SINGLE source at 9k for placement. Feeding a
 * corpus to one prompt is impossible, and truncating each source to fit makes the
 * planner design from introductions. Digesting first costs N small calls once,
 * caches on the transcript (so re-planning and the library list are free), and
 * hands the planner a dense, complete view of every source at ~250 tokens each.
 */

/** One source's compact card: what it teaches, for the planner to design from. */
const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    abstract: { type: 'string' },
    concepts: { type: 'array', items: { type: 'string' } },
  },
  required: ['abstract', 'concepts'],
  propertyOrdering: ['abstract', 'concepts'],
};

/** How much of one source the digester reads. Generous: it summarises, not places. */
const DIGEST_SOURCE_CHARS = 24000;

/**
 * Summarise ONE raw source into the card the corpus planner designs from: a dense
 * abstract plus the concepts it actually teaches. Pure — the caller caches the
 * result on the transcript doc, so this runs once per source, ever.
 *
 * Concepts are named as TEACHABLE IDEAS, not as the source's own section titles,
 * because they become candidate topic names and the whole point of the corpus
 * planner is that the tree is concept-shaped rather than source-shaped.
 *
 * @returns {Promise<{abstract:string, concepts:string[]}>}
 */
export async function digestSource({ title = '', text = '', reading = false }, ai = {}) {
  const body = String(text || '').trim().slice(0, DIGEST_SOURCE_CHARS);
  if (!body) throw new Error('This source has no text to read');

  const prompt = `You are cataloguing raw source material for a curriculum architect. Read this source and describe what it TEACHES, densely and factually.

SOURCE TITLE: ${String(title || 'Untitled').trim()}
"""
${body}
"""

Return:
1. "abstract" — 100 to 180 words on what this source actually teaches. Lead with the substance, not the format. Never write "this video explains" or "the speaker discusses" — state the content itself, the way a textbook index entry would. Name the specific mechanisms, formulas, methods and examples it covers. If it is mostly filler (greetings, sponsor reads, announcements) say so plainly and keep it short.
2. "concepts" — 3 to 10 TEACHABLE IDEAS this source covers. These become candidate curriculum topics, so:
   - ${topicNameRule(reading)}
   - Name the IDEA, never the source's own packaging. Not "Introduction", not "Part 2", not "Recap".
   - One testable idea each. Split a concept that bundles two ideas; do not list a whole field as one concept.
   - Only what this source genuinely teaches — never what it merely mentions in passing.

Ignore filler entirely: greetings, sponsor reads, subscribe requests and tangents are not curriculum.

Return ONLY JSON: {"abstract":"...","concepts":["...","..."]}`;

  const text_ = await complete(prompt, { json: true, schema: DIGEST_SCHEMA, ...ai });
  let out;
  try { out = parseLooseJson(text_); } catch { throw new Error('The model returned non-JSON content'); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('The model did not return a digest');
  const clean = (v) => String(v == null ? '' : v).trim();
  return {
    abstract: clean(out.abstract),
    concepts: [...new Set((Array.isArray(out.concepts) ? out.concepts : []).map(clean).filter(Boolean))].slice(0, 12),
  };
}

/* ------------------------- splitting one big source ----------------------- */
/*
 * Why this exists. Every reader in this app is bounded: `digestSource` sees 24k
 * chars, `classifyTranscript` 9k, and generation's `sourceFor` 12k per lesson.
 * So one file holding a WHOLE module — all its videos concatenated — is a trap:
 * it catalogues from its opening third, and because grounding is scope-based
 * every lesson it grounds would then draw questions from the same first 12k.
 *
 * The fix is not a bigger window, it is the right GRAIN. A source should be
 * about the size of a lesson. This splits an oversized one into its natural
 * sections so everything downstream works unchanged.
 *
 * 🔴 The model never echoes the text back. It returns a title plus a VERBATIM
 * ANCHOR (the first few words of each section), and the cutting is done here with
 * indexOf, scanning forward from the previous cut so order is preserved. That
 * keeps a 150k-character transcript from ever having to survive a round trip
 * through a model's output, where it would be truncated or silently reworded.
 */

const SPLIT_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, anchor: { type: 'string' } },
        required: ['title', 'anchor'],
        propertyOrdering: ['title', 'anchor'],
      },
    },
  },
  required: ['sections'],
  propertyOrdering: ['sections'],
};

/** How much text one boundary-finding pass reads, and how much it re-reads. */
const SPLIT_WINDOW = 18000;
const SPLIT_OVERLAP = 600;
/** Refuse to grind forever on a pathologically large paste. */
const SPLIT_MAX_WINDOWS = 40;

/**
 * Find the section boundaries in one oversized source and cut it into parts.
 *
 * Scans the text in overlapping windows, asks each pass only for the boundaries
 * it can see, then locates every anchor in the ORIGINAL text and slices there.
 * Anchors that can't be found are dropped rather than guessed at, so a bad
 * suggestion costs one missed boundary, never mangled text.
 *
 * @param onProgress called as (windowIndex, windowCount) so a caller can report.
 * @returns {Promise<Array<{title:string,text:string}>>} sections in document order;
 *          a single-element array means "no boundaries found, leave it alone".
 */
export async function splitSource({ title = '', text = '' }, ai = {}, onProgress) {
  const body = String(text || '').trim();
  if (!body) throw new Error('This source has no text to split');

  // Collect candidate boundaries from each window.
  const step = SPLIT_WINDOW - SPLIT_OVERLAP;
  const starts = [];
  for (let i = 0; i < body.length && starts.length < SPLIT_MAX_WINDOWS; i += step) starts.push(i);

  const candidates = [];
  for (let w = 0; w < starts.length; w += 1) {
    const slice = body.slice(starts[w], starts[w] + SPLIT_WINDOW);
    if (onProgress) onProgress(w + 1, starts.length);
    const prompt = `You are splitting one long transcript into the separate LESSONS or SECTIONS it is made of. This is an excerpt from a larger document${title ? ` titled "${String(title).trim()}"` : ''}.

EXCERPT:
"""
${slice}
"""

Identify every point in this excerpt where a NEW lesson, video, chapter or major section BEGINS. For each one return:
- "title": a short descriptive name for that section, naming the CONCEPT it teaches (not "Section 2", not "Video 4").
- "anchor": the first 8 to 15 words of that section, copied **VERBATIM and EXACTLY** from the excerpt above, starting at the very first word of the section. This is used to locate the cut, so a single altered character makes it useless. Do not add quotes, ellipses or commentary.

Rules:
- Only report a boundary you can actually SEE beginning in this excerpt. Do not infer one that starts before it.
- A speaker changing subject mid-flow is NOT a boundary. Look for real starts: a title line, a greeting that restarts, "in this lesson/video…", a numbered heading, a topic announcement.
- If this excerpt is a continuation with no new section starting in it, return an empty array. That is a normal and useful answer.
- Ignore sponsor reads, subscribe requests and outros.

Return ONLY JSON: {"sections":[{"title":"...","anchor":"..."}]}`;

    let out;
    try {
      const raw = await complete(prompt, { json: true, schema: SPLIT_SCHEMA, ...ai });
      out = parseLooseJson(raw);
    } catch {
      continue;   // one bad window costs one window, never the whole split
    }
    for (const sec of (out && Array.isArray(out.sections) ? out.sections : [])) {
      const anchor = String(sec && sec.anchor || '').trim();
      const name = String(sec && sec.title || '').trim();
      if (anchor.length >= 12 && name) candidates.push({ title: name, anchor });
    }
  }

  return cutAtAnchors(body, candidates, title);
}

/**
 * Slice `body` at model-proposed anchors. Exported so it can be tested directly —
 * it decides where the learner's source material gets cut, and every failure mode
 * here is silent (text lost, duplicated, or attributed to the wrong lesson).
 *
 * Three properties are load-bearing, and `lib/_split_test.js` asserts each:
 *   1. Whitespace-insensitive. A model re-wraps lines and collapses spaces without
 *      meaning to, so matching happens on a normalised copy with a map back to
 *      real offsets. Exact-match-only would find almost nothing.
 *   2. An anchor that cannot be found is DROPPED, never approximated. A bad
 *      suggestion costs one missed boundary; guessing would mangle the text.
 *   3. Cuts strictly increase. Scanning forward from the last match means a phrase
 *      that recurs later can never send a section backwards, so no text is
 *      duplicated into two lessons.
 *
 * @returns {Array<{title:string,text:string}>} sections in document order; a
 *          single-element array means "no boundaries found, leave it alone".
 */
export function cutAtAnchors(body, candidates, title = '') {
  const norm = [];
  const map = [];
  let wasSpace = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (/\s/.test(ch)) {
      if (wasSpace) continue;
      norm.push(' '); map.push(i); wasSpace = true;
    } else {
      norm.push(ch); map.push(i); wasSpace = false;
    }
  }
  const hay = norm.join('');

  const cuts = [];
  let fromNorm = 0;
  for (const c of (candidates || [])) {
    const needle = String(c && c.anchor || '').replace(/\s+/g, ' ').trim();
    const name = String(c && c.title || '').trim();
    if (needle.length < 12 || !name) continue;
    let n = hay.indexOf(needle, fromNorm);
    // A long anchor may carry a stray trailing word; retry on its first half.
    if (n < 0 && needle.length > 30) n = hay.indexOf(needle.slice(0, Math.floor(needle.length / 2)).trim(), fromNorm);
    if (n < 0) continue;
    cuts.push({ at: map[n], title: name });
    fromNorm = n + 1;
  }
  const whole = [{ title: String(title || 'Untitled').trim() || 'Untitled', text: body }];
  if (!cuts.length) return whole;

  // Anything substantial before the first cut is its own opening section.
  const sections = [];
  if (cuts[0].at > 200) sections.push({ title: `${String(title || 'Source').trim()} — opening`, text: body.slice(0, cuts[0].at).trim() });
  for (let i = 0; i < cuts.length; i += 1) {
    const end = i + 1 < cuts.length ? cuts[i + 1].at : body.length;
    const part = body.slice(cuts[i].at, end).trim();
    if (part.length > 200) sections.push({ title: cuts[i].title, text: part });
  }
  return sections.length ? sections : whole;
}

/**
 * The shape the corpus planner returns. Sources are referenced ONLY by their
 * [index] into the enumerated list we hand the model — it never supplies an id or
 * a title — so every reference resolves to a REAL uploaded transcript here, the
 * same "the model proposes, the code decides existence" discipline as
 * planCurriculum and classifyTranscript.
 */
const SOURCE_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    track: { type: 'string' },
    summary: { type: 'string' },
    courses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          course: { type: 'string' },
          lessons: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                lesson: { type: 'string' },
                rationale: { type: 'string' },
                topics: { type: 'array', items: { type: 'string' } },
                sources: { type: 'array', items: { type: 'integer' } },
              },
              required: ['lesson', 'topics', 'sources'],
              propertyOrdering: ['lesson', 'rationale', 'topics', 'sources'],
            },
          },
        },
        required: ['course', 'lessons'],
        propertyOrdering: ['course', 'lessons'],
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          course: { type: 'string' },
          lesson: { type: 'string' },
          topic: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['course', 'lesson', 'topic'],
        propertyOrdering: ['course', 'lesson', 'topic', 'why'],
      },
    },
  },
  required: ['track', 'summary', 'courses'],
  propertyOrdering: ['track', 'summary', 'courses', 'gaps'],
};

/**
 * Design a CONCEPT-SHAPED curriculum from a pile of uploaded sources.
 *
 * This is the reduce half of the corpus flow: given each source's cached digest
 * (never its full text — see the note above) plus the program's existing tree, it
 * returns a Track > Course > Lesson > Topic design, a per-lesson manifest of which
 * sources ground it, and the GAPS — concepts the subject needs that the corpus
 * does not teach, seeded as topics with no source so they can be filled later.
 *
 * The prompt's one non-negotiable is that the tree must NOT mirror the sources'
 * own running order. A course's module structure is optimised for that course's
 * runtime; the tree has to be optimised so every future source about the subject
 * has an obvious home. Mirroring it produces lessons like "Week 3" that nothing
 * else can ever be filed under. See docs/COURSE-TO-CURRICULUM-SOP.md.
 *
 * Pure planning — the caller resolves source indices to real ids, decides
 * new-vs-existing against the live catalog, and only the commit step writes.
 *
 * @returns {Promise<{track:string,summary:string,courses:Array<{course:string,lessons:Array<{lesson:string,rationale:string,topics:string[],sources:number[]}>}>,gaps:Array<{course:string,lesson:string,topic:string,why:string}>}>}
 */
export async function planFromSources(
  { sources = [], catalog = [], programName = '', guidance = '', wantGaps = true, reading = false },
  ai = {},
  onToken,
) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && (s.abstract || s.title));
  if (!list.length) throw new Error('Pick at least one source to build from');

  // Enumerated for the model to reference by index — it never sees or supplies ids.
  const block = list.map((s, i) => {
    const concepts = (Array.isArray(s.concepts) ? s.concepts : []).filter(Boolean);
    return `[${i}] ${String(s.title || 'Untitled').trim()}\n${String(s.abstract || '(not yet summarised)').trim()}${concepts.length ? `\nConcepts: ${concepts.join(' · ')}` : ''}`;
  }).join('\n\n');

  const outline = catalogOutline(catalog, 14000);
  const steer = String(guidance || '').trim().slice(0, 2000);

  const prompt = `You are the curriculum architect for a spaced-repetition mastery program${programName ? ` ("${programName}")` : ''}. A pile of raw source material has been uploaded — videos, chapters, articles, notes — and you must design the curriculum it becomes.

THE SOURCES (each is one uploaded document; reference them by their [index] number):
${block}

${outline ? `THE PROGRAM'S EXISTING CURRICULUM — Track > Course > Lesson, with each lesson's topics. Where this material belongs somewhere that ALREADY EXISTS, reuse that name EXACTLY, character-for-character, so it merges instead of forking a near-duplicate:\n${outline}\n` : '(this program is empty — you are designing its first curriculum)\n'}
${steer ? `THE ADMIN'S INSTRUCTIONS — follow these over your own defaults:\n"""\n${steer}\n"""\n` : ''}
🔴 THE ONE RULE THAT MATTERS: **the sources are MATERIAL, not the STRUCTURE.** Do NOT mirror their running order, their numbering, or their packaging. A course's own module layout is built for that course's runtime; your tree has to be built so that every FUTURE source about this subject has one obvious home. Design the concept map a practitioner of this subject would recognise, then map the sources onto it.
- NEVER name a track, course, lesson or topic after a source, a week, a video, a module number or an instructor ("Week 3", "Module 2: Deep Dive", "Andrew Ng's course", "Part One"). Names are CONCEPTS.
- Several sources may ground ONE lesson. One source may ground SEVERAL lessons. A source that is pure filler grounds nothing — leave it out.
- If two sources teach the same concept from different angles, that is ONE topic with two sources, never two topics.
${scopeShapeRule(reading)}

YOUR DESIGN:
1. "track" — the field this material belongs to. Reuse an existing track name if it fits.
2. "courses" — one or more courses. A course is a subject someone could name as a skill ("Tree-Based Models", "Retrieval Evaluation"), never a source. Most corpora need 1 to 3; use more only if the material genuinely spans that many subjects. 🔴 **List them in TEACHING ORDER** — the course that motivates the subject and defines its vocabulary first, then the ones that build on it, then evaluation and advanced practice. The array order is stored as the curriculum's order and is what learners see.
3. Within each course, "lessons" — concept clusters, **in teaching order (prerequisites first) — the array order is stored, so a lesson listed third is the third lesson**. Each lesson carries:
   - "topics": 3 to 6 TOPICS. ${topicNameRule(reading)} It must be possible to write six distinct questions about each one: split anything you could only write two about, merge anything that would need twenty.
   - "sources": the [index] numbers of every source that teaches this lesson's material.${wantGaps ? ' Use an empty array only for a lesson you are adding to complete the subject.' : ' EVERY lesson must cite at least one source — you are not adding anything the sources do not cover.'}
   - "rationale": one short line on why this lesson exists and where it sits.
${wantGaps
  ? `4. "gaps" — concepts a competent practitioner of this subject needs that the sources do NOT teach. Place each under the course and lesson it belongs in (reuse names from your own design above), with a one-line "why". These get created as empty topics to fill later. Be honest and specific; 0 to 12 of them. Do not pad, and do not list things the sources do cover.`
  : `4. Cover ONLY what the sources actually teach. Do NOT add topics the sources do not support, do not round the subject out, and do not propose anything you would have to teach from your own knowledge. Return an empty "gaps" array.`}
5. "summary" — two or three sentences on the design: what the corpus turned out to be about and how you shaped it.

Return ONLY JSON in this shape:
{"track":"…","summary":"…","courses":[{"course":"…","lessons":[{"lesson":"…","rationale":"…","topics":["…"],"sources":[0,3]}]}],"gaps":[{"course":"…","lesson":"…","topic":"…","why":"…"}]}`;

  const raw = onToken
    ? await streamStructured(prompt, ai, onToken)
    : await complete(prompt, { json: true, schema: SOURCE_PLAN_SCHEMA, ...ai });
  let out;
  try { out = parseLooseJson(raw); } catch { throw new Error('The model returned non-JSON content'); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('The model did not return a curriculum design');

  const clean = (v) => String(v == null ? '' : v).trim();
  const track = clean(out.track);
  if (!track) throw new Error('The model did not name a track');

  // Source indices are resolved against the list WE supplied — anything out of
  // range is dropped rather than trusted, so a hallucinated index can never
  // attach a lesson to a transcript that was not selected.
  const inRange = (n) => Number.isInteger(n) && n >= 0 && n < list.length;
  const courses = (Array.isArray(out.courses) ? out.courses : [])
    .map((c) => ({
      course: clean(c && c.course),
      lessons: (Array.isArray(c && c.lessons) ? c.lessons : [])
        .map((l) => ({
          lesson: clean(l && l.lesson),
          rationale: clean(l && l.rationale),
          topics: [...new Set((Array.isArray(l && l.topics) ? l.topics : []).map(clean).filter(Boolean))].slice(0, 12),
          sources: [...new Set((Array.isArray(l && l.sources) ? l.sources : []).filter(inRange))],
        }))
        .filter((l) => l.lesson && l.topics.length),
    }))
    .filter((c) => c.course && c.lessons.length);
  if (!courses.length) throw new Error('The model did not design any courses');

  // Belt and braces: when gaps were not asked for, a model that emits some anyway is
  // simply ignored here, so the caller's choice always holds.
  const gaps = !wantGaps ? [] : (Array.isArray(out.gaps) ? out.gaps : [])
    .map((g) => ({ course: clean(g && g.course), lesson: clean(g && g.lesson), topic: clean(g && g.topic), why: clean(g && g.why) }))
    .filter((g) => g.course && g.lesson && g.topic)
    .slice(0, 20);

  return { track, summary: clean(out.summary), courses, gaps };
}

/* ----------------------- goal-based module planner ------------------------- */
/**
 * The shape the goal planner returns: a whole MODULE (one course, several lessons)
 * that builds toward a stated goal. New-vs-existing is decided by the CALLER from
 * these names against the live catalog, exactly like classifyTranscript — the
 * model only proposes a sensible structure, never asserts what already exists.
 */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    track: { type: 'string' },
    course: { type: 'string' },
    summary: { type: 'string' },
    assumedKnowledge: { type: 'array', items: { type: 'string' } },
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lesson: { type: 'string' },
          rationale: { type: 'string' },
          topics: { type: 'array', items: { type: 'string' } },
        },
        required: ['lesson', 'topics'],
        propertyOrdering: ['lesson', 'rationale', 'topics'],
      },
    },
  },
  required: ['track', 'course', 'summary', 'lessons'],
  propertyOrdering: ['track', 'course', 'summary', 'assumedKnowledge', 'lessons'],
};

/** Render a capped bullet list of topic names for the planner's baseline blocks. */
function nameList(names, cap = 120) {
  const list = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean))].slice(0, cap);
  return list.length ? list.map((n) => `- ${n}`).join('\n') : '';
}

/**
 * Draft a whole learning MODULE from a stated GOAL, building on what the learner
 * already knows — the "just-in-time / learn-a-goal" planner behind the admin's
 * goal box. It returns one course of several lessons (each with a handful of
 * topics), plus the prerequisites it is deliberately NOT re-teaching
 * (`assumedKnowledge`). It only proposes structure — the caller upserts the rows,
 * writes+attaches a brief per lesson, and runs the normal generation job — so this
 * stays a pure, side-effect-free classification, mirroring classifyTranscript.
 *
 * @returns {Promise<{track:string,course:string,summary:string,assumedKnowledge:string[],lessons:Array<{lesson:string,rationale:string,topics:string[]}>}>}
 */
export async function planCurriculum(
  { goal, known = [], learning = [], catalog = [], programName = '', reference = '', reading = false },
  ai = {},
  onToken,
) {
  const want = String(goal || '').trim();
  if (!want) throw new Error('Describe what you want to learn first');

  const outline = catalogOutline(catalog);
  const knownBlock = nameList(known);
  const learningBlock = nameList(learning);
  const ref = String(reference || '').trim().slice(0, 10000);
  const refBlock = ref
    ? `\nREFERENCE MATERIAL the learner supplied (e.g. their own code or docs — ground the plan in it where relevant, and prefer its concrete specifics over generic treatment):\n"""\n${ref}\n"""\n`
    : '';

  const prompt = `You are the curriculum architect for a personal, spaced-repetition mastery program${programName ? ` ("${programName}")` : ''}. A learner has told you a GOAL, and you must design a single MODULE (one course, broken into several lessons) that takes them there — building on what they already know rather than re-teaching it.

THE LEARNER'S GOAL:
"""
${want}
"""
${refBlock}
WHAT THE LEARNER HAS ALREADY MASTERED (do NOT create topics that re-teach these — treat them as prerequisites you build ON TOP of, and list the ones this module leans on under "assumedKnowledge"):
${knownBlock || '(no strong mastery on record — assume solid general fundamentals unless the goal says otherwise)'}

WHAT THE LEARNER IS STILL SHAKY ON (fair game to reinforce as a sub-step if the goal needs it):
${learningBlock || '(nothing on record)'}

CURRENT CURRICULUM (Track > Course > Lesson, with each lesson's topics) — reuse an existing Track/Course name EXACTLY if this module belongs there, otherwise propose a clear new one:
${outline || '(the curriculum is empty)'}

YOUR JOB — return ONE module as JSON:
1. "track" and "course": where this module lives. Reuse an existing track name character-for-character if it fits; propose a concise new course name for the module.
2. "summary": one or two sentences on what the learner will be able to do after this module.
3. "assumedKnowledge": the specific things (prefer names from the mastered list above) this module assumes and will NOT re-teach. This is the whole point — build on their base.
4. "lessons": 3 to 8 lessons, ordered so each builds on the previous. Each lesson has:
   - "lesson": a short, clear name.
   - "rationale": one sentence on why it's here / what it unlocks.
   - "topics": 2 to 6 TOPICS. ${topicNameRule(reading)} Do not include anything already in "assumedKnowledge".

Return ONLY JSON: {"track":"...","course":"...","summary":"...","assumedKnowledge":["..."],"lessons":[{"lesson":"...","rationale":"...","topics":["...","..."]}]}`;

  // Streaming path (onToken) forwards the reasoning trace live and drops the JSON
  // schema (the stream API can't carry it); parseLooseJson recovers the object.
  const text = onToken
    ? await streamStructured(prompt, ai, onToken)
    : await complete(prompt, { json: true, schema: PLAN_SCHEMA, ...ai });
  let out;
  try { out = parseLooseJson(text); } catch { throw new Error('The model returned non-JSON content'); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('The model did not return a plan object');

  const clean = (v) => String(v == null ? '' : v).trim();
  const track = clean(out.track); const course = clean(out.course);
  if (!track || !course) throw new Error('The model did not return a Track / Course for the module');

  const seenLesson = new Set();
  const lessons = (Array.isArray(out.lessons) ? out.lessons : [])
    .map((l) => {
      const lesson = clean(l && l.lesson);
      const topics = [...new Set((Array.isArray(l && l.topics) ? l.topics : []).map(clean).filter(Boolean))].slice(0, 6);
      return { lesson, rationale: clean(l && l.rationale), topics };
    })
    .filter((l) => {
      if (!l.lesson || !l.topics.length) return false;
      const key = l.lesson.toLowerCase();
      if (seenLesson.has(key)) return false;
      seenLesson.add(key);
      return true;
    })
    .slice(0, 8);
  if (!lessons.length) throw new Error('The model did not propose any lessons');

  const assumedKnowledge = [...new Set((Array.isArray(out.assumedKnowledge) ? out.assumedKnowledge : []).map(clean).filter(Boolean))].slice(0, 24);
  return { track, course, summary: clean(out.summary), assumedKnowledge, lessons };
}

/* ----------------------- conversational curriculum editor ------------------ */
/**
 * The vocabulary of structural edits the AI curriculum editor may propose. Kept in
 * ONE place so the prompt, the client review UI and the server executor stay in
 * lock-step. Every op references EXISTING nodes by their exact names (track /
 * course / lesson / topic) — the server resolves those to real catalog rows and
 * REJECTS anything it can't find, so the model proposes and the code decides what
 * actually exists (same discipline as planCurriculum / classifyTranscript). New
 * names (rename targets, added sub-lessons, a merge target that doesn't exist yet)
 * are the only names allowed to be absent from the tree.
 */
const CURRICULUM_EDIT_OPS = `AVAILABLE OPERATIONS — every "op" is one JSON object. Reference existing Tracks, Courses, Lessons and Sub-lessons by their EXACT names from the tree above (copy them character-for-character). Always include "track". Add a short "note" (a few words) explaining WHY, shown to the admin.

- Merge one or more lessons into another (moves the sub-lessons in; overlapping sub-lessons are dropped):
  {"op":"merge_lessons","track":"…","course":"…","from":["Lesson A","Lesson B"],"into":"Target Lesson","drop":["duplicate sub-lesson name",…],"note":"…"}
  • "from": the lesson(s) being dissolved. "into": the lesson that survives (may be one of the existing lessons, or a brand-new name). "drop": sub-lessons to delete as redundant/overlapping (by name). Any moved sub-lesson whose name already exists in "into" is auto-dropped, so you only list genuinely-overlapping ones you want gone.

- Rename a lesson (keeps all its sub-lessons and learner progress):
  {"op":"rename_lesson","track":"…","course":"…","lesson":"Old name","newName":"New name","note":"…"}

- Rename a single sub-lesson (keeps its questions, cards, study guide and learner progress):
  {"op":"rename_topic","track":"…","course":"…","lesson":"…","topic":"Old name","newName":"New name","note":"…"}

- Rename a course:
  {"op":"rename_course","track":"…","course":"Old name","newName":"New name","note":"…"}

- Move a whole lesson into a different course (optionally a different track):
  {"op":"move_lesson","track":"…","course":"…","lesson":"…","toCourse":"…","toTrack":"…","note":"…"}   (omit toTrack to keep the track)

- Move a single sub-lesson into a different lesson (optionally a different course):
  {"op":"move_topic","track":"…","course":"…","lesson":"…","topic":"…","toLesson":"…","toCourse":"…","note":"…"}   (omit toCourse to keep the course)

- Delete a single sub-lesson:
  {"op":"delete_topic","track":"…","course":"…","lesson":"…","topic":"…","note":"…"}

- Delete a whole lesson and every sub-lesson under it:
  {"op":"delete_lesson","track":"…","course":"…","lesson":"…","note":"…"}

- Add a new sub-lesson (the course/lesson may be new):
  {"op":"add_topic","track":"…","course":"…","lesson":"…","topic":"…","note":"…"}

- Reorder the COURSES within a track (list the courses in the new order; any you omit keep their current relative order at the end):
  {"op":"reorder_courses","track":"…","order":["Course A","Course B",…],"note":"…"}

- Reorder the lessons within a course (list ALL of that course's lessons in the new order):
  {"op":"reorder_lessons","track":"…","course":"…","order":["Lesson 1","Lesson 2",…],"note":"…"}

- Reorder the sub-lessons within a lesson (list ALL of that lesson's sub-lessons in the new order):
  {"op":"reorder_topics","track":"…","course":"…","lesson":"…","order":["Sub-lesson 1","Sub-lesson 2",…],"note":"…"}`;

/**
 * A conversational curriculum editor. The admin describes a change in plain
 * English ("merge the Calculus and Calculus-for-ML lessons and drop the overlap");
 * given the live Track > Course > Lesson > Sub-lesson tree and the conversation so
 * far, the model returns a short chat reply PLUS a full set of structural
 * operations to propose. It is PURE planning — it never mutates anything; the
 * caller resolves the ops against the real catalog, shows them for review, and
 * only the companion apply step writes. Streams its reasoning like the other
 * Composing-Room planners.
 *
 * `history` is prior turns [{role:'user'|'assistant', content}]. Each turn the
 * model returns the COMPLETE proposed op set for the request so far (not a diff),
 * so the review panel always reflects the latest intent.
 *
 * @returns {Promise<{reply:string, summary:string, operations:Array<object>}>}
 */
export async function planCurriculumEdit(
  { message, history = [], catalog = [], programName = '', reading = false },
  ai = {},
  onToken,
) {
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Tell the editor what to change');

  const outline = catalogOutline(catalog, 24000);
  const turns = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((t) => `${t.role === 'assistant' ? 'YOU' : 'ADMIN'}: ${String(t.content || '').trim()}`)
    .filter((l) => l.length > 4)
    .join('\n');

  const prompt = `You are the curriculum editor for a spaced-repetition mastery program${programName ? ` ("${programName}")` : ''}. An ADMIN is reshaping the curriculum by talking to you. You suggest concrete structural edits; the admin reviews them and applies them with one click. You NEVER teach content or write questions here — you only restructure the tree (merge, split, move, rename, delete, add, reorder).

THE CURRENT CURRICULUM — Track > Course > Lesson, then each lesson's sub-lessons indented beneath it. These exact names are the ONLY things you may reference in operations:
${outline || '(the curriculum is empty)'}

${CURRICULUM_EDIT_OPS}

NAMING A NEW OR RENAMED SUB-LESSON: ${topicNameRule(reading)}${scopeShapeRule(reading)}

HOW TO WORK:
- Read what the admin wants, then propose the SMALLEST set of operations that achieves it well. Prefer merging/renaming/moving (which keep learner progress and banked questions) over deleting-and-re-adding.
- When two lessons overlap, MERGE them: move the unique sub-lessons into the one that should survive and "drop" the redundant duplicates. Judge overlap by meaning, not just identical names ("Derivatives" and "Differentiation" overlap).
- Resequence when it clearly improves the learning order (prerequisites before what builds on them). Do NOT reorder gratuitously if the admin didn't ask and the order is already fine.
- If the admin is only asking a question, chatting, or you need clarification, return an EMPTY operations array and just answer in "reply".
- NEVER invent a track/course/lesson/sub-lesson name that isn't in the tree above, except as a NEW name in a rename target, an added sub-lesson, or a merge "into" you are intentionally creating.

Return ONLY JSON in this shape (no prose outside it):
{"reply":"a short, friendly message to the admin explaining what you're proposing (or answering their question) — plain text, no markdown","summary":"one short headline for the whole change set, e.g. \\"Merge Calculus for ML into Calculus, drop 3 overlaps\\" (empty string if no operations)","operations":[ …ops… ]}

${turns ? `CONVERSATION SO FAR:\n${turns}\n\n` : ''}ADMIN: ${msg}`;

  const text = onToken
    ? await streamStructured(prompt, ai, onToken)
    : await complete(prompt, { json: true, ...ai });
  let out;
  try { out = parseLooseJson(text); } catch { throw new Error('The model returned non-JSON content'); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('The model did not return an editor response');

  const clean = (v) => String(v == null ? '' : v).trim();
  const operations = (Array.isArray(out.operations) ? out.operations : [])
    .filter((o) => o && typeof o === 'object' && clean(o.op))
    .slice(0, 40);
  return {
    reply: clean(out.reply) || (operations.length ? 'Here are the changes I propose — review them, then apply.' : ''),
    summary: clean(out.summary),
    operations,
  };
}

/* -------------------------- goal-based roadmap planner --------------------- */
/**
 * The shape the roadmap planner returns. The model references topics ONLY by their
 * [index] into the enumerated catalog we hand it — it never supplies a name — so
 * every selected topic is resolved from a REAL catalog row here, the same
 * "the model proposes, the code decides existence" discipline as planCurriculum.
 */
const ROADMAP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    stages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { ref: { type: 'integer' }, note: { type: 'string' } },
              required: ['ref'],
              propertyOrdering: ['ref', 'note'],
            },
          },
        },
        required: ['title', 'items'],
        propertyOrdering: ['title', 'summary', 'items'],
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'stages'],
  propertyOrdering: ['title', 'summary', 'stages', 'gaps'],
};

/**
 * Enumerate catalog topics as "[i] Track > Course > Lesson > Topic" so the planner
 * can reference exact rows by INDEX (never by a hallucinated name). Returns
 * `{ rows, text }` where `rows[i]` is the catalog row for index `i`.
 */
function enumerateTopics(catalog, cap = 600) {
  const rows = (Array.isArray(catalog) ? catalog : []).filter((r) => r && r.topic).slice(0, cap);
  const lines = rows.map((r, i) => `[${i}] ${[r.track, r.course, r.lesson, r.topic].filter(Boolean).join(' > ')}`);
  let text = lines.join('\n');
  if (text.length > 22000) text = `${text.slice(0, 22000)}\n… (only the indices above are selectable)`;
  return { rows, text };
}

/**
 * Draft a ROADMAP — an ordered learning PATH toward a GOAL — by SELECTING and
 * SEQUENCING topics that already exist in the catalog and grouping them into
 * STAGES that build on each other. It re-uses the shared bank as-is (it does not
 * create content); topics it thinks the goal NEEDS but the catalog lacks come back
 * as `gaps` (short names) so the caller can author them. Pure and side-effect-free
 * like the other planners: the model only picks indices, we resolve real rows.
 *
 * @returns {Promise<{title:string,summary:string,stages:Array<{title:string,summary:string,items:Array<{topicId:string,track:string,course:string,lesson:string,topic:string,note:string}>}>,gaps:string[]}>}
 */
export async function planRoadmap(
  { goal, title = '', catalog = [], programName = '', reference = '' },
  ai = {},
  onToken,
) {
  const want = String(goal || '').trim();
  if (!want) throw new Error('Describe the goal of the roadmap first');

  const { rows, text: enumText } = enumerateTopics(catalog);
  if (!rows.length) throw new Error('There are no topics to build a roadmap from yet');
  const ref = String(reference || '').trim().slice(0, 8000);
  const refBlock = ref
    ? `\nREFERENCE MATERIAL the admin supplied (ground the path in it where relevant):\n"""\n${ref}\n"""\n`
    : '';

  const prompt = `You are a senior curriculum architect designing a ROADMAP for a mastery program${programName ? ` ("${programName}")` : ''}: an ordered learning PATH that takes someone from zero to a concrete GOAL by SELECTING and SEQUENCING topics that ALREADY EXIST in the catalog and grouping them into STAGES that build on each other.

THE GOAL:
"""
${want}
"""
${refBlock}
AVAILABLE TOPICS — each line is "[index] Track > Course > Lesson > Topic". Reference topics ONLY by their [index] number; never invent a topic:
${enumText}

YOUR JOB — return a roadmap as JSON:
1. "title": a short, memorable name for this roadmap${title ? ` (the admin suggested "${String(title).trim().slice(0, 120)}" — use it unless a clearly better one fits)` : ''}.
2. "summary": one or two sentences — who this is for and what they will be able to do at the end.
3. "stages": ordered MILESTONES (aim for 4 to 8), each building on the ones before. Each stage has:
   - "title": a short milestone name written as an OUTCOME ("Read and run the code", "Understand the data layer").
   - "summary": one sentence on what the learner can do once this stage is complete.
   - "items": the topics for this stage, IN STUDY ORDER, as {"ref": <index>, "note": "<short: why it's here / what to focus on for the goal>"}. Pull ONLY from the indices above. Order stages AND items so a prerequisite always comes before whatever needs it. Pull topics from ANYWHERE in the catalog regardless of how they are currently filed — the roadmap does not have to respect the course structure.
4. "gaps": things the goal genuinely REQUIRES that NO available topic covers, as short topic names (so they can be authored later). Empty array if the catalog already covers the goal.

Be selective: a roadmap is the SHORTEST honest path to the goal, not a dump of everything. Skip topics that don't serve the goal. Never list the same topic in two stages.

Return ONLY JSON: {"title":"...","summary":"...","stages":[{"title":"...","summary":"...","items":[{"ref":0,"note":"..."}]}],"gaps":["..."]}`;

  // Streaming path (onToken) forwards the reasoning trace live and drops the JSON
  // schema (the stream API can't carry it); parseLooseJson recovers the object.
  const raw = onToken
    ? await streamStructured(prompt, ai, onToken)
    : await complete(prompt, { json: true, schema: ROADMAP_SCHEMA, ...ai });
  let out;
  try { out = parseLooseJson(raw); } catch { throw new Error('The model returned non-JSON content'); }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('The model did not return a roadmap object');

  const clean = (v) => String(v == null ? '' : v).trim();
  const used = new Set(); // a topic appears in the roadmap at most once (first stage wins)
  const stages = (Array.isArray(out.stages) ? out.stages : [])
    .map((s, si) => {
      const items = (Array.isArray(s && s.items) ? s.items : [])
        .map((it) => {
          const idx = Number(it && it.ref);
          const row = Number.isInteger(idx) ? rows[idx] : null;
          if (!row || used.has(row.id)) return null;
          used.add(row.id);
          return {
            topicId: row.id,
            track: row.track || '',
            course: row.course || '',
            lesson: row.lesson || '',
            topic: row.topic || '',
            note: clean(it && it.note).slice(0, 500),
          };
        })
        .filter(Boolean);
      return { title: clean(s && s.title) || `Stage ${si + 1}`, summary: clean(s && s.summary), items };
    })
    .filter((s) => s.items.length)
    .slice(0, 12);
  if (!stages.length) throw new Error('The model did not select any topics for the roadmap');

  const gaps = [...new Set((Array.isArray(out.gaps) ? out.gaps : []).map(clean).filter(Boolean))].slice(0, 24);
  return { title: clean(out.title) || clean(title) || 'Roadmap', summary: clean(out.summary), stages, gaps };
}

/**
 * Write a compact teaching brief for ONE lesson of a goal-planned module. This is
 * the stored "lesson" the learner can read AND the source material that grounds
 * the lesson's generated questions and flashcards. It is written for someone who
 * already knows `assumedKnowledge`, so it teaches only the delta — dense enough to
 * support real MCQs, not a wall of text. Plain prose (no JSON).
 *
 * @returns {Promise<string>}
 */
export async function writeLessonBrief(
  { course, lesson, topics = [], assumedKnowledge = [], goal = '', reference = '' },
  ai = {},
) {
  const topicList = nameList(topics, 12) || '(the lesson topics)';
  const assume = nameList(assumedKnowledge, 24);
  const ref = String(reference || '').trim().slice(0, 8000);
  const refBlock = ref
    ? `\nREFERENCE MATERIAL (prefer its concrete specifics where it covers a topic; ignore where it doesn't):\n"""\n${ref}\n"""\n`
    : '';

  const prompt = `You are an expert instructor writing a concise study brief for one lesson of a self-paced mastery course${course ? ` ("${course}")` : ''}.

LESSON: "${lesson}"
${goal ? `\nThe learner's overall goal: ${String(goal).trim().slice(0, 600)}\n` : ''}
THE LEARNER ALREADY KNOWS THIS (do NOT re-explain it — build on it, reference it freely):
${assume || '(assume solid general fundamentals)'}

TOPICS THIS LESSON TEACHES (cover every one clearly enough that a good multiple-choice question could be written from your brief):
${topicList}
${refBlock}
WRITE THE BRIEF:
- 250 to 500 words, markdown, aimed at a capable learner. Teach ONLY the delta beyond what they already know.
- For each topic: the intuition (why it works / when it matters) AND the concrete rule, mechanism, or steps. Include real specifics (names, behaviours, trade-offs), not vague generalities.
- Be accurate. If you are unsure a detail is correct, leave it out rather than guess.
- No filler, no "in this lesson we will", no motivational padding. Start straight into the material.

Return ONLY the markdown brief.`;

  const text = await complete(prompt, { ...ai });
  return String(text || '').trim().slice(0, 8000);
}

/**
 * Write MCQs for `topic` grounded STRICTLY in `transcript`.
 *
 * Returns questions carrying their own `difficulty` tag. Anything the model
 * emits that isn't usable is dropped by normalizeMcq rather than thrown, so one
 * bad item never loses the batch — the caller banks whatever survived.
 *
 * @returns {Promise<Array<{topic,question,options,answer,difficulty}>>}
 */
export async function generateQuestionsFromTranscript(
  { topic, scopeLabel = '', transcript = '', existing = [], siblings = [], audience = '', count = 5, instructions = '' },
  ai = {},
) {
  const body = String(transcript || '').trim();
  if (!body) return [];

  const prompt = `You are a Professional Test Developer building an assessment for ${audience || DEFAULT_AUDIENCE}.

TOPIC: "${topic}"${scopeLabel ? `\nWHERE IT SITS: ${scopeLabel}` : ''}

SOURCE MATERIAL (the ONLY thing you may test on):
"""
${body}
"""

${siblingTopicsBlock(siblings, topic)}${avoidBlock(existing)}${guidanceBlock(instructions)}
YOUR MISSION:
1. Write up to ${count} multiple-choice questions that test whether someone UNDERSTOOD the part of the source material that belongs to "${topic}".
2. GROUNDING IS ABSOLUTE: every question and every correct answer must be verifiable from the source material alone. If the material does not support ${count} good questions, write FEWER. Never invent facts, numbers, or claims it does not contain.
3. STAY INSIDE "${topic}". The material covers a whole lesson and much of it belongs to a sibling sub-lesson; test only your slice of it.
4. Test understanding, not recall of phrasing. Prefer a realistic situation this practitioner would actually face over "what did the speaker say".
5. No two questions may be interchangeable, and none may duplicate or reword anything already in the bank (above). Reusing one worked example with different numbers counts as duplicating it.
6. Ignore filler: greetings, sponsor reads, subscribe requests, and tangents are not course content.

CRITICAL FORMATTING RULES (TO PREVENT TEST-HACKING):
- OPTION UNIFORMITY: All 4 options must be of approximately the same character length.
- No "Length Bias": Do not make the correct answer the longest or most detailed.
- PARALLEL STRUCTURE: If one option starts with a verb, all must start with a verb. Keep the phrasing symmetrical.
- SOPHISTICATED DISTRACTORS: Wrong answers must be plausible to someone who half-understood the material — common misconceptions, not obvious nonsense.
- EVERY QUESTION MUST STAND ALONE. The learner cannot see the source material, so a question that points at it is unanswerable. Never refer to the material in ANY form — no "according to the source/material/transcript/video/speaker/author", no "what does the material recommend", no "in this lesson", no "as described above". Ask about the SUBJECT directly: turn "what does the material recommend when X happens?" into "when X happens, which approach achieves Y?" — the situation and the choices come from the subject itself, never from the fact that a document discussed it. This applies to the options as well as the question.

Do NOT use em dashes (the long dash). Use commas, colons, or simple hyphens instead.

${NO_LATEX_RULE}

${DIFFICULTY_MIX_RULE}

${ANSWER_INDEX_RULE}

Return ONLY a JSON array: [{"question": "text", "options": ["A", "B", "C", "D"], "answerIndex": 0, "difficulty": "core"}]`;

  const text = await complete(prompt, { json: true, schema: TRANSCRIPT_MCQ_ARRAY_SCHEMA, ...ai });
  let generated;
  try {
    generated = parseLooseJson(text);
  } catch {
    throw new Error('The model returned non-JSON content');
  }
  if (!Array.isArray(generated)) throw new Error('The model did not return a JSON array');

  const DIFFS = new Set(['core', 'balanced', 'challenge']);
  return generated
    .map((q) => {
      const mcq = normalizeMcq(q, topic);
      if (!mcq) return null;
      const d = String(q.difficulty || '').toLowerCase();
      return { ...mcq, difficulty: DIFFS.has(d) ? d : 'balanced' };
    })
    .filter(Boolean);
}

/**
 * Author `count` MCQs for `topic`, ANCHORED ON THE TOPIC, with an optional
 * transcript as supporting reference. This is the Academy's main generator for a
 * canonical curriculum: the topic (not the video) is the source of truth, so a
 * video that only partly covers a lesson can't drag a topic off-subject (a
 * value-rules video must not turn "Lookalike audiences" into value-rules
 * questions). Where the reference genuinely covers the topic, prefer its current,
 * concrete detail; otherwise author from expert knowledge — always staying
 * strictly on the topic and never testing a fact that isn't certainly correct.
 */
export async function generateAcademyQuestions(
  { topic, scopeLabel = '', reference = '', existing = [], siblings = [], audience = '', count = 5, instructions = '' },
  ai = {},
) {
  const hasRef = String(reference || '').trim().length > 0;
  const refBlock = hasRef
    ? `SUPPORTING REFERENCE (a practitioner video transcript; may only partly cover the topic):
"""
${String(reference).trim().slice(0, 14000)}
"""

HOW TO USE THE REFERENCE:
- Where it genuinely covers "${topic}", prefer its concrete, current specifics (real settings, steps, numbers, current platform behavior).
- Where it does NOT cover "${topic}" (or drifts to a neighbouring subject), IGNORE it and author from your own expert knowledge.
- Never let the reference pull a question off "${topic}" onto a different subject it happens to discuss.
`
    : '';

  const prompt = `You are a Professional Test Developer and a senior practitioner of this subject, building an assessment for ${audience || DEFAULT_AUDIENCE}.

TOPIC (the subject every question must test): "${topic}"${scopeLabel ? `\nWHERE IT SITS: ${scopeLabel}` : ''}

${refBlock}${siblingTopicsBlock(siblings, topic)}${avoidBlock(existing)}${guidanceBlock(instructions)}
YOUR MISSION:
1. Write ${count} multiple-choice questions that test whether someone genuinely UNDERSTANDS "${topic}" as it is practiced today.
2. ACCURACY IS ABSOLUTE: every correct answer must be factually correct and reflect current mainstream best practice. If you are not certain a fact is correct, do not use it.
3. STAY STRICTLY ON "${topic}". Do not drift to adjacent topics, even if a reference or your knowledge tempts you.
4. Test applied understanding, not vocabulary recall. Prefer a realistic situation this practitioner would actually face over "what is the definition of Y".
5. No two questions may be interchangeable, and none may duplicate or reword anything already in the bank (above). Reusing one worked example with different numbers counts as duplicating it.

CRITICAL FORMATTING RULES (TO PREVENT TEST-HACKING):
- OPTION UNIFORMITY: All 4 options must be of approximately the same character length.
- No "Length Bias": Do not make the correct answer the longest or most detailed.
- PARALLEL STRUCTURE: If one option starts with a verb, all must start with a verb. Keep the phrasing symmetrical.
- SOPHISTICATED DISTRACTORS: Wrong answers must be plausible to someone who half-understood the topic — common misconceptions, not obvious nonsense.
- EVERY QUESTION MUST STAND ALONE. Ask about the SUBJECT directly; never refer to "this lesson", "the material", "the reference", "the video", or any source.

Do NOT use em dashes (the long dash). Use commas, colons, or simple hyphens instead.

${NO_LATEX_RULE}

${DIFFICULTY_MIX_RULE}

${ANSWER_INDEX_RULE}

Return ONLY a JSON array: [{"question": "text", "options": ["A", "B", "C", "D"], "answerIndex": 0, "difficulty": "core"}]`;

  const text = await complete(prompt, { json: true, schema: TRANSCRIPT_MCQ_ARRAY_SCHEMA, ...ai });
  let generated;
  try {
    generated = parseLooseJson(text);
  } catch {
    throw new Error('The model returned non-JSON content');
  }
  if (!Array.isArray(generated)) throw new Error('The model did not return a JSON array');

  const DIFFS = new Set(['core', 'balanced', 'challenge']);
  return generated
    .map((q) => {
      const mcq = normalizeMcq(q, topic);
      if (!mcq) return null;
      const d = String(q.difficulty || '').toLowerCase();
      return { ...mcq, difficulty: DIFFS.has(d) ? d : 'balanced' };
    })
    .filter(Boolean);
}

/**
 * Author `count` MCQs for `topic` from the model's OWN expert knowledge, with NO
 * transcript. This is the hybrid fallback for curriculum areas the video library
 * doesn't cover (SQL, tag management, analytics fundamentals, email deliverability…)
 * where a strong model's knowledge is more accurate than a tangential video. Same
 * validated shape and formatting rules as the grounded generator; only the source
 * of truth differs (expertise vs transcript), which the caller records via `source`.
 */
export async function generateQuestionsFromKnowledge(
  { topic, scopeLabel = '', existing = [], siblings = [], audience = '', count = 5 },
  ai = {},
) {
  const prompt = `You are a Professional Test Developer and a senior practitioner of this subject, building an assessment for ${audience || DEFAULT_AUDIENCE}.

TOPIC: "${topic}"${scopeLabel ? `\nWHERE IT SITS: ${scopeLabel}` : ''}

${avoidBlock(existing)}
YOUR MISSION:
1. Write ${count} multiple-choice questions that test whether someone genuinely UNDERSTANDS "${topic}" as it is practiced today.
2. ACCURACY IS ABSOLUTE: every correct answer must be factually correct and reflect current, mainstream best practice. Do not test on niche edge cases, deprecated features, or anything ambiguous. If you are not certain a fact is correct, do not use it.
3. Test applied understanding, not vocabulary recall. Prefer a realistic situation this practitioner would actually face over "what is the definition of Y".
4. No two questions may be interchangeable, and none may duplicate anything already in the bank (above).
5. Stay strictly on THIS topic (as framed by where it sits above); do not drift into adjacent topics.

CRITICAL FORMATTING RULES (TO PREVENT TEST-HACKING):
- OPTION UNIFORMITY: All 4 options must be of approximately the same character length.
- No "Length Bias": Do not make the correct answer the longest or most detailed.
- PARALLEL STRUCTURE: If one option starts with a verb, all must start with a verb. Keep the phrasing symmetrical.
- SOPHISTICATED DISTRACTORS: Wrong answers must be plausible to someone who half-understood the topic — common misconceptions, not obvious nonsense.
- EVERY QUESTION MUST STAND ALONE. Ask about the SUBJECT directly; never refer to "this lesson", "the material", "the course", or any source.

Do NOT use em dashes (the long dash). Use commas, colons, or simple hyphens instead.

${NO_LATEX_RULE}

${DIFFICULTY_MIX_RULE}

${ANSWER_INDEX_RULE}

Return ONLY a JSON array: [{"question": "text", "options": ["A", "B", "C", "D"], "answerIndex": 0, "difficulty": "core"}]`;

  const text = await complete(prompt, { json: true, schema: TRANSCRIPT_MCQ_ARRAY_SCHEMA, ...ai });
  let generated;
  try {
    generated = parseLooseJson(text);
  } catch {
    throw new Error('The model returned non-JSON content');
  }
  if (!Array.isArray(generated)) throw new Error('The model did not return a JSON array');

  const DIFFS = new Set(['core', 'balanced', 'challenge']);
  return generated
    .map((q) => {
      const mcq = normalizeMcq(q, topic);
      if (!mcq) return null;
      const d = String(q.difficulty || '').toLowerCase();
      return { ...mcq, difficulty: DIFFS.has(d) ? d : 'balanced' };
    })
    .filter(Boolean);
}

/**
 * Generate `count` new questions for `topic`, given a few baseline questions.
 * `ctx.existing` (all banked stems for the topic) is an avoid-list so a re-run
 * doesn't recreate what's already there; `ctx.performance` aims difficulty. Bulk
 * seeding leaves performance null on purpose — the bank is shared across users,
 * so a mass seed stays neutral rather than skewing toward one learner's gaps.
 * @returns {Promise<Array<{topic,question,options,answer}>>}
 */
export async function generateQuestions(topic, baseline, count, ai = {}, ctx = {}) {
  const { existing = [], siblings = [], performance = null, difficulty = 'auto', prereqs = [], instructions = '', reference = '' } = ctx;
  const text = await complete(buildPrompt(topic, baseline, count, { existing, siblings, performance, difficulty, prereqs, instructions, reference }), { json: true, schema: MCQ_ARRAY_SCHEMA, ...ai });

  let generated;
  try {
    generated = parseLooseJson(text);
  } catch {
    throw new Error('Gemini returned non-JSON content');
  }
  if (!Array.isArray(generated)) throw new Error('Gemini did not return a JSON array');

  // Normalize/validate shape (answerIndex -> stored answer string).
  return generated.map((q) => normalizeMcq(q, topic)).filter(Boolean);
}

/**
 * Diagnose what might be confusing a learner about a question they just
 * answered. Returns up to 3 short, specific, first-person confusions to pick
 * from — the drill UI always appends its own 4th "let me explain" free-text
 * option, so this only produces the AI-suggested ones. Never throws: if the
 * model misbehaves it falls back to generic-but-useful confusions so the drill
 * flow can't dead-end.
 */
export async function generateConfusions({ question, options, answer, topic, userAnswer, isCorrect }, ai = {}) {
  const prompt = `You are a perceptive tutor diagnosing exactly what a student might be struggling with on a specific multiple-choice question they just answered.

TOPIC: ${topic || '(unspecified)'}
QUESTION: ${question}
OPTIONS:
${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}
CORRECT ANSWER: ${answer || '(unknown)'}
THE STUDENT ANSWERED: ${userAnswer || '(no answer recorded)'}, which was ${isCorrect ? 'CORRECT' : 'INCORRECT'}.

List the 3 MOST LIKELY specific things that could be confusing this student about THIS question or the concept behind it.

RULES:
- Write each as a short, concrete, first-person statement of a confusion, as the student would say it (e.g. "I don't get why ...", "I mixed up ... and ...", "I'm not sure how to ...").
- Make them SPECIFIC to this question's concept, not generic study advice.
- Cover three DISTINCT, plausible misconceptions (do not repeat the same idea).
- Max ~14 words each. No numbering, no quotes, no preamble.

${LATEX_RULE}

Return ONLY a JSON array of exactly 3 strings.`;

  try {
    const text = await complete(prompt, { json: true, ...ai });
    const arr = parseLooseJson(text);
    const cleaned = (Array.isArray(arr) ? arr : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 3);
    if (cleaned.length) return cleaned;
  } catch {
    /* fall through to the generic set below */
  }
  // Never dead-end the drill: generic but still useful confusions.
  return [
    "I don't really understand the core concept this question tests",
    "I don't get why the correct answer is right",
    "I can't see why the other options are wrong",
  ];
}

/**
 * Generate ONE new mastery question that drills into a SPECIFIC confusion the
 * learner has, while staying squarely on the SAME topic / sub-lesson. Returns
 * the normalized {topic, question, options, answer} (same shape as
 * generateQuestions) so it can be banked and served immediately. Retries once
 * if the model returns an unusable shape (e.g. answer not among the options).
 */
export async function generateDrillQuestion({ topic, scopeLabel, question, options, answer, confusion }, ai = {}) {
  const prompt = `You are a Wise Master Educator helping a student who just struggled with a question. They have told you exactly what is confusing them. Write ONE NEW multiple-choice question that directly targets and helps resolve that specific confusion, while staying on the SAME sub-topic.

SUB-LESSON / TOPIC: "${topic}"${scopeLabel && scopeLabel !== topic ? ` (within: ${scopeLabel})` : ''}

THE QUESTION THEY JUST STRUGGLED WITH:
${question}
OPTIONS: ${JSON.stringify(options || [])}
CORRECT ANSWER: ${answer || '(unknown)'}

WHAT THE STUDENT SAYS IS CONFUSING THEM:
"${confusion}"

YOUR MISSION:
1. Write ONE new MCQ that zeroes in on the exact point of confusion above, so that working through it builds the understanding they are missing.
2. It MUST stay on the topic "${topic}". Do NOT drift to a different sub-lesson or a broader subject.
3. Approach the SAME underlying idea from a slightly different angle than the original. Do NOT simply reword the original question.

CRITICAL FORMATTING RULES (TO PREVENT TEST-HACKING):
- OPTION UNIFORMITY: All 4 options must be of approximately the same character length.
- No "Length Bias": Do not make the correct answer the longest or most detailed.
- PARALLEL STRUCTURE: keep the phrasing of all options symmetrical.
- SOPHISTICATED DISTRACTORS: wrong answers should be plausible and reflect the very misconception described above.

Do NOT use em dashes (the long dash). Use commas, colons, or simple hyphens instead.

${LATEX_RULE}
${ANSWER_INDEX_RULE}

Return ONLY a JSON object: {"question": "text", "options": ["A", "B", "C", "D"], "answerIndex": 0}`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let obj;
    try {
      obj = parseLooseJson(await complete(prompt, { json: true, schema: MCQ_SCHEMA, ...ai }));
    } catch {
      lastErr = new Error('drill: returned non-JSON content');
      continue;
    }
    // The model may wrap the single question in an array.
    if (Array.isArray(obj)) obj = obj[0];
    const q = normalizeMcq(obj, topic);
    if (q) return q;
    lastErr = new Error('drill: invalid question shape');
  }
  throw new Error(`Drill generation failed (${lastErr?.message || 'unknown'})`);
}

/**
 * Generate `count` fresh questions "like" one the learner is looking at: same
 * sub-topic, same style and difficulty, new angles (NOT reworded copies). Used
 * by the in-quiz "Generate more like this" action. Returns normalized
 * {topic,question,options,answer} objects (same shape as generateQuestions) so
 * they can be banked and served immediately; any that come back malformed or
 * with a non-matching answer are dropped rather than failing the whole batch.
 *
 * The VARIETY REQUIREMENT block is load-bearing, especially for weaker models.
 * With only "approach from different angles" (the old item 3), Flash-class
 * models "vary" by re-lettering the SAME question: observed 2026-08-11, three
 * generated clones of one minimization item, identical except a,b → p,q → m,n
 * and the correct option always being the one saying the terms are "exactly
 * equal". Strong models (K3, V4 Pro) vary semantically on their own; the axes
 * list + self-check make the variation mechanical enough that weak models can
 * follow it too. Do not "simplify" the block back into a one-liner.
 */
export async function generateSimilarQuestions({ topic, scopeLabel, question, options, answer, existing = [] }, count, ai = {}) {
  const n = Math.min(10, Math.max(1, parseInt(count, 10) || 3));
  const prompt = `You are a Wise Master Educator and Professional Test Developer. A student is practising and wants MORE questions like the one below, so they can drill the same idea until it sticks.

SUB-LESSON / TOPIC: "${topic}"${scopeLabel && scopeLabel !== topic ? ` (within: ${scopeLabel})` : ''}

THE QUESTION THEY WANT MORE LIKE:
${question}
OPTIONS: ${JSON.stringify(options || [])}
CORRECT ANSWER: ${answer || '(unknown)'}

${avoidBlock(existing, 'do NOT reproduce or paraphrase any of these')}
YOUR MISSION:
1. Write ${n} NEW multiple-choice questions that test the SAME underlying concept as the question above.
2. Match its DIFFICULTY and STYLE - do not make them noticeably harder or easier.
3. Stay strictly on the topic "${topic}". Do NOT drift to a different sub-lesson.

VARIETY REQUIREMENT (this is the whole point of the exercise):
- A question that keeps the original's setup and only renames its variables, constants, or context label is a CLONE, and clones are useless here: the student answers them by recognizing the wording, not by understanding. Renaming "a, b" to "p, q", or "cost" to "total cost", is NOT a new question.
- Make each new question differ from the original AND from each other on at least TWO of these axes:
  1. THE ASK: what the solver must produce. If the original asks which relation holds between terms, one question can ask for the optimal value instead, another for the minimum value, another for a parameter or a condition.
  2. THE GIVENS: swap symbolic constants for concrete numbers, or the reverse. Never reuse the original's constants with fresh letter names.
  3. THE SCENARIO: a genuinely different real-world wrapping, or no wrapping at all.
  4. THE DIRECTION: forward (compute the outcome from the setup) vs backward (given the outcome, infer the setup or the condition).
- No two questions may be interchangeable. In particular, the correct answers must NOT share one telltale pattern across the batch (e.g. the right option is always the one claiming two terms are equal). Vary what the correct option says, and vary the distractor logic too; do not reuse the same wrong-answer family (twice / half / squared) on every question.
- SELF-CHECK each question before returning it: could a student who only memorized the original's answer wording get this one right WITHOUT doing any work? If yes, rewrite it.

CRITICAL FORMATTING RULES (TO PREVENT TEST-HACKING):
- OPTION UNIFORMITY: All 4 options must be of approximately the same character length.
- No "Length Bias": Do not make the correct answer the longest or most detailed.
- PARALLEL STRUCTURE: keep the phrasing of all options symmetrical.
- SOPHISTICATED DISTRACTORS: wrong answers should be plausible common misconceptions.

Do NOT use em dashes (the long dash). Use commas, colons, or simple hyphens instead.

${LATEX_RULE}
${ANSWER_INDEX_RULE}

Return ONLY a JSON array of ${n} objects: [{"question": "text", "options": ["A", "B", "C", "D"], "answerIndex": 0}]`;

  let generated;
  try {
    generated = parseLooseJson(await complete(prompt, { json: true, schema: MCQ_ARRAY_SCHEMA, ...ai }));
  } catch {
    throw new Error('generate-like: returned non-JSON content');
  }
  if (!Array.isArray(generated)) generated = [generated];

  const clean = generated
    .map((q) => normalizeMcq(q, topic))
    .filter(Boolean)
    .slice(0, n);

  if (!clean.length) throw new Error('generate-like: no usable questions came back');
  return clean;
}

/* --------------------------------- Chat ----------------------------------- */
// Render a stored chat thread as plain text for the prompt (oldest first).
function historyBlock(history = []) {
  if (!Array.isArray(history) || !history.length) return '(this is the first message)';
  return history
    .slice(-12) // keep the prompt bounded; recent turns matter most
    .map((m) => `${m.role === 'assistant' ? 'TUTOR' : 'STUDENT'}: ${String(m.text || '').slice(0, 1200)}`)
    .join('\n');
}

/**
 * Per-card tutor chat. Answers the student's message about ONE flashcard AND
 * returns an IMPROVED, rewritten personalized explanation for the card that
 * folds in what was just clarified. Because the student is a visual learner, it
 * leans on the declarative visual whenever a picture helps. Returns
 * { reply, intuition, formula, visual }; the caller stores intuition/formula/
 * visual as this user's private overlay on the (shared) card.
 */
export async function generateCardChat(
  { topic, scopeLabel, concept, intuition, formula, visual, questions = [], history = [], message },
  ai = {},
) {
  const prompt = `You are a world-class, patient tutor helping ONE student master a single flashcard through conversation. The student is a VISUAL learner, so prefer intuitive, concrete, picture-friendly explanations.

FLASHCARD (${scopeLabel || topic}):
- Concept (front): ${concept}
- Current intuition (this is the student's CURRENT personalized explanation; improve on it): ${intuition}
- Formula/Rule: ${formula || '(none)'}
${visual ? `- The card currently has a visual.` : ''}

For context, here is a sample of quiz questions from the same topic (use ONLY to judge the depth the student needs; do NOT reveal answers or quote them):
${JSON.stringify(questions).slice(0, 3000)}

CONVERSATION SO FAR:
${historyBlock(history)}

THE STUDENT'S NEW MESSAGE:
"${message}"

Do TWO things and return them as JSON:
1. "reply": a clear, friendly, direct answer to the student's message. Teach, use analogies, and lean visual. Markdown. Keep it focused, not padded.
2. "intuition": a REWRITTEN, improved version of the card's intuition explanation that incorporates what you just clarified, so that next time the student reads the card it makes complete sense to THEM. Keep it self-contained (do not reference "as we discussed"). Plain, vivid, beginner-friendly Markdown.
3. "formula": keep the existing formula unless the conversation genuinely requires correcting or clarifying it; then return the improved LaTeX. If unchanged, return it as-is. Use "—" only if truly none applies.
4. "visual": include or update the declarative visual ONLY when a graph genuinely helps this student see the idea; otherwise return null.

${VISUAL_RULE}

${LATEX_RULE}
Do NOT use em dashes; use commas, colons, or simple hyphens.

Return ONLY a JSON object: {"reply": "markdown answer", "intuition": "rewritten markdown", "formula": "LaTeX or —", "visual": null | {plot object as specified}}`;

  const text = await complete(prompt, { json: true, ...ai });
  let obj;
  try {
    obj = parseLooseJson(text);
  } catch {
    throw new Error('card chat returned non-JSON content');
  }
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj || !obj.reply) throw new Error('card chat returned an unusable shape');
  return {
    reply: String(obj.reply).trim(),
    intuition: obj.intuition ? String(obj.intuition).trim() : String(intuition || '').trim(),
    formula: obj.formula ? String(obj.formula).trim() : (formula || '—'),
    visual: sanitizeVisual(obj.visual),
  };
}

/**
 * Scope-level tutor chat. Reads the flashcards AND the quiz questions in a
 * lesson/course and answers big-picture questions ("why is this useful?", "how
 * does this relate to my work as an AI engineer?", "what are the prerequisites?").
 * Returns { reply, visual }. Stateless persistence lives in the caller.
 */
export async function generateScopeChat(
  { scopeLabel, topics = [], cards = [], questions = [], history = [], message },
  ai = {},
) {
  const cardsBlock = cards.length
    ? JSON.stringify(cards.map((c) => ({ concept: c.concept, intuition: c.intuition, formula: c.formula }))).slice(0, 4000)
    : '(no flashcards have been generated for this section yet)';

  const prompt = `You are a sharp, practical tutor for a working AI engineer who is studying to deepen their foundations. You answer questions about a whole study SECTION, grounded in its actual flashcards and quiz questions. When useful, connect ideas to real machine-learning / data / AI-engineering practice.

SECTION: "${scopeLabel}"
TOPICS IN SCOPE (${topics.length}):
${topics.map((t) => `- ${t}`).join('\n').slice(0, 2000)}

FLASHCARDS IN THIS SECTION (the concepts being taught):
${cardsBlock}

SAMPLE OF QUIZ QUESTIONS IN THIS SECTION (use to gauge scope/depth; do NOT reveal which option is correct):
${JSON.stringify(questions).slice(0, 3500)}

CONVERSATION SO FAR:
${historyBlock(history)}

THE STUDENT'S NEW MESSAGE:
"${message}"

Answer clearly and specifically, grounded in the material above. If they ask why something is useful, how it relates to their work as an AI engineer, or what the prerequisites are, be concrete and practical. Use Markdown, short paragraphs, and bullets where they help. Optionally include a declarative visual ONLY when a graph genuinely aids understanding.

${VISUAL_RULE}

${LATEX_RULE}
Do NOT use em dashes; use commas, colons, or simple hyphens.

Return ONLY a JSON object: {"reply": "markdown answer", "visual": null | {plot object as specified}}`;

  const text = await complete(prompt, { json: true, ...ai });
  let obj;
  try {
    obj = parseLooseJson(text);
  } catch {
    throw new Error('scope chat returned non-JSON content');
  }
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj || !obj.reply) throw new Error('scope chat returned an unusable shape');
  return { reply: String(obj.reply).trim(), visual: sanitizeVisual(obj.visual) };
}

/**
 * The always-available floating assistant. It answers the student's message
 * grounded in a STRUCTURED snapshot of what is on their screen right now (the
 * view, their track/course selection, the exact question they're looking at and
 * how they answered it, or the flashcard they're studying, plus recent results).
 * No image is sent — the caller assembles the context object. Returns
 * { reply, visual }.
 */
function assistantContextBlock(ctx = {}) {
  const lines = [];
  const viewName = {
    setup: 'the home screen (building a quiz / viewing progress)',
    quiz: 'a live quiz question',
    result: 'a quiz results screen',
    stats: 'their progress dashboard',
    flashcard: 'a flashcard',
    login: 'the sign-in screen',
  }[ctx.view] || ctx.view || 'the app';
  lines.push(`CURRENT SCREEN: ${viewName}.`);

  const scope = ctx.scope || {};
  const scopeStr = ['track', 'course', 'lesson', 'topic']
    .map((k) => scope[k]).filter((v) => v && !/^(review all|-- n\/a --)$/i.test(v)).join(' › ');
  if (scopeStr) lines.push(`CURRENT SELECTION: ${scopeStr}.`);

  if (ctx.question && ctx.question.question) {
    const q = ctx.question;
    lines.push(`QUESTION ON SCREEN: ${q.question}`);
    if (Array.isArray(q.options) && q.options.length) {
      lines.push(`OPTIONS:\n${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`);
    }
    if (q.answer) lines.push(`CORRECT ANSWER: ${q.answer}`);
    if (q.userAnswer != null) lines.push(`THE STUDENT ANSWERED: ${q.userAnswer} (${q.isCorrect ? 'correct' : 'incorrect'}).`);
    else lines.push('The student has NOT answered this question yet — do NOT reveal the correct option; guide them.');
  }

  if (ctx.card && ctx.card.concept) {
    lines.push(`FLASHCARD ON SCREEN — Concept: ${ctx.card.concept}`);
    if (ctx.card.intuition) lines.push(`Intuition: ${ctx.card.intuition}`);
    if (ctx.card.formula) lines.push(`Formula/Rule: ${ctx.card.formula}`);
    if (ctx.card.topic) lines.push(`Topic: ${ctx.card.topic}`);
  }

  // The interactive visual guide, when one is open over the section. The learner
  // is looking at NAMED, NUMBERED tabs and will say "explain visual 2" out loud in
  // voice mode, so the names here must be the ones printed on their screen — that
  // is the whole reason app.js sends the outline the generator emitted rather than
  // trying to read inside the sandboxed iframe.
  if (ctx.visual && (ctx.visual.title || ctx.visual.outline)) {
    const v = ctx.visual;
    lines.push(`INTERACTIVE VISUAL GUIDE ON SCREEN: "${v.title || 'Visual Guide'}"${v.scopeLabel ? ` — the visual companion to the ${v.kind === 'lesson' ? 'lesson' : 'review'} for ${v.scopeLabel}` : ''}.`);
    if (v.outline) lines.push(`ITS VISUALS (number | name | what it shows | the takeaway):\n${String(v.outline).slice(0, 4000)}`);
    if (v.activeTab && v.activeTab.name) {
      lines.push(`THE LEARNER IS LOOKING AT VISUAL ${v.activeTab.index}: "${v.activeTab.name}" right now. "This visual" / "this one" means that one.`);
    }
    lines.push('These are live, interactive diagrams — sliders, click-to-advance steps, labelled charts. Teach FROM them: name the visual by its number and name, say what to move or click, and describe what they will see happen. Never claim you cannot see the screen.');
  }

  if (Array.isArray(ctx.recent) && ctx.recent.length) {
    lines.push(`RECENT ANSWERS: ${ctx.recent.map((r) => `${r.topic || '?'}=${r.isCorrect ? '✓' : '✗'}`).join(', ')}`);
  }
  return lines.join('\n') || 'No specific on-screen context was provided.';
}

/**
 * DEEP MODE — the section on screen, loaded in full because the learner asked for it.
 *
 * Three sources the ordinary turn never pays for (see server.js deepGroundingFor): the REAL question
 * bank for this section with its answer key, the learner's own per-topic numbers, and the written
 * study guide verbatim. Returns '' when deep mode is off, so the ordinary prompt is byte-identical.
 *
 * 🔴 THE ANSWER KEY IS IN THIS PROMPT, AND ONE RULE HAS TO SURVIVE IT. The learner arms deep mode
 * to be quizzed, so withholding the key would defeat it — but `assistantContextBlock` may be
 * printing an UNANSWERED question from this very bank a few lines below, where the standing rule is
 * "do NOT reveal the correct option". Those two instructions meet here and the on-screen one wins:
 * whatever the bank says, the question they are mid-answer on stays unspoiled. Stated explicitly
 * below because a model handed a key and a matching question will otherwise resolve the conflict
 * the convenient way.
 *
 * 🔴 GAPS ARE DECLARED, same as the growth journal and the task board. A section with no cached
 * guide must read as "you haven't written notes on this yet", never as "there is nothing here" —
 * and a truncated bank must never be summarised as though it were the whole thing.
 */
export function deepBlock(hits) {
  if (!hits) return '';
  const parts = [];
  const gapLine = (hits.gaps && hits.gaps.length)
    ? `\n⚠️ NOT LOADED this turn: ${hits.gaps.join('; ')}. These are gaps in what you were handed, NOT`
      + ` absences in their work — never report the two the same way, and say plainly what you could not open.`
    : '';

  if (!hits.scopeLabel) {
    return `DEEP MODE IS ON but nothing could be loaded.${gapLine}\nTell them what you are missing and`
      + ` how to fix it (usually: pick a Track/Course/Lesson, or open the section they mean), then answer`
      + ` from what you do have. Do NOT pretend to have their questions, scores or notes.`;
  }

  parts.push(`DEEP MODE IS ON — the learner explicitly asked you to look inside their material for this`
    + ` turn, so you have the section they are on loaded in full: ${hits.scopeLabel}.`
    + ` Use it. This costs them time and money to load, so a deep turn should be visibly better than a`
    + ` normal one: cite their real numbers, quote their real notes, and rehearse their real questions`
    + ` rather than talking in general terms.${gapLine}`);

  if (Array.isArray(hits.progress) && hits.progress.length) {
    const rows = hits.progress.map((p) => {
      const bits = [];
      if (p.attempts) {
        bits.push(`${p.accuracy}% over ${p.attempts} attempt(s)`);
        bits.push(`mastery ${p.mastery}`);
        bits.push(`priority ${p.priority}`);
        if (p.daysSince != null) bits.push(`last practised ${p.daysSince}d ago`);
      } else {
        bits.push('NEVER ATTEMPTED');
        bits.push(`priority ${p.priority}`);
      }
      bits.push(`${p.questions} question(s) in the bank`);
      return `    - ${p.topic}${p.lesson ? ` (${p.lesson})` : ''}: ${bits.join(' · ')}`;
    });
    parts.push(`THEIR ACTUAL NUMBERS ON THIS SECTION, per sub-lesson:\n${rows.join('\n')}
HOW TO READ THESE — do not invent your own interpretation:
- ACCURACY is raw right/wrong. MASTERY (0-100) is the depth-aware score behind their own progress tree: it discounts a perfect run on two questions and never reaches 100, so "100% accuracy" and "mastery 41" are both true at once and the second is the honest one. PRIORITY (0-100) is what the app uses to pick their next question — high means weak, stale, or barely attempted.
- A topic with NEVER ATTEMPTED is a blind spot, not a weakness. Say which it is.
- Quote these numbers when they ask how they are doing. Vague encouragement is exactly what deep mode is meant to replace.`);
  }

  if (hits.guide) {
    parts.push(`THEIR WRITTEN STUDY GUIDE FOR THIS SECTION — the complete text, verbatim, exactly as it`
      + ` appears in their app (this is what they mean by "my notes on this"):\n\n--- begin guide ---\n${hits.guide}\n--- end guide ---\n`
      + `Teach FROM this where it covers the question: it is what they have already read, so building on it`
      + ` beats re-explaining the same idea in different words. If it is WRONG or thin on something, say so`
      + ` plainly rather than defending it.`);
  }

  if (Array.isArray(hits.questions) && hits.questions.length) {
    const qs = hits.questions.map((q, i) => {
      const opts = (q.options || []).map((o, j) => `${String.fromCharCode(65 + j)}. ${o}`).join('\n       ');
      return `  Q${i + 1} [${q.topic}] ${q.question}\n       ${opts}\n       KEY: ${q.answer}`;
    }).join('\n');
    parts.push(`THEIR REAL QUIZ BANK FOR THIS SECTION — ${hits.questions.length} of the ${hits.bankTotal} questions`
      + ` that can actually come up, WITH the answer key:\n${qs}

HOW TO USE THE BANK:
- This is what they will really be tested on, so it is the ground truth for READINESS. When they ask "am I ready?", answer from these: name the sub-lessons whose questions they would currently miss, and say yes or no plainly. A soft "you're doing great" here is a failure — they turned this on to get a straight answer.
- WHEN THEY ASK TO BE QUIZZED, run an ORAL rehearsal: ask one question at a time, in your own words rather than reading the options out, wait for their answer, then grade it against the KEY and explain the miss. Ask follow-ups that test whether they know WHY, since recognising a correct option is not the same as understanding it.
- Do NOT dump the bank, and do NOT recite the key unprompted. Rehearsing is the feature; handing them an answer sheet is not.
🔴 THE QUESTION CURRENTLY ON THEIR SCREEN IS STILL OFF-LIMITS. If the on-screen context below shows a question they have NOT answered yet, that one is unspoiled no matter what this bank says — guide them to reason it out, exactly as you would without deep mode. This rule OVERRIDES everything above.`);
  }

  return parts.join('\n\n');
}

/**
 * The learner's WHOLE-PERSON context, pulled from Sentinel (body-fat/PRs, career goals, required
 * reading, personal obstacles). This is what turns the Study Assistant into a holistic development
 * coach: the same bot can talk to their gym progress and career goals, not just their curriculum.
 * Returns '' when there's no profile (Sentinel unreachable/unconfigured) so the prompt is unchanged.
 */
function holisticBlock(profile) {
  if (!profile) return '';
  const lines = [];
  const phys = profile.physical || {};
  const physBits = [];
  if (phys.body_fat_pct != null) physBits.push(`body fat ${phys.body_fat_pct}%`);
  if (phys.weight_kg != null) physBits.push(`weight ${phys.weight_kg}kg`);
  if (physBits.length) lines.push(`- Physical: ${physBits.join(', ')}${phys.as_of ? ` (as of ${phys.as_of})` : ''}.`);
  if (Array.isArray(phys.recent_prs) && phys.recent_prs.length) lines.push(`- Personal records: ${phys.recent_prs.join('; ')}.`);
  if (Array.isArray(phys.targets) && phys.targets.length) lines.push(`- Physical TARGETS they're chasing (mean progress = their Physical ring; edit via update_physical_goal): ${phys.targets.join('; ')}.`);
  const gym = profile.gym || {};
  if (gym.weekly_split) {
    const cardio = gym.weekly_cardio || {};
    const split = Object.entries(gym.weekly_split).map(([d, t]) => `${d} ${t}${cardio[d] ? ` + ${cardio[d]}` : ''}`).join(', ');
    // The LOG is opt-out on Sentinel's Physical tab; the PLAN always ships. `logs_shared === false`
    // is a DECLARED withholding, not missing data — and the difference is the whole feature.
    //
    // 🔴 Never let a low or absent count stand as evidence about their TRAINING. Someone can train
    // six days a week and log none of it, in which case the number measures their logging habit.
    // The old text read `?? 0`, so an unshared log would have rendered as "Trained 0 time(s) in the
    // last 14 days" — the confident lie this setting exists to stop, stated more baldly than before.
    // Same rule as the growth journal and the task board: name the gap, don't leave one.
    const shared = gym.logs_shared !== false;   // undefined = an older Sentinel; assume shared
    const consistency = !shared
      ? `They have chosen NOT to share their workout log with you. This is a privacy setting, NOT a report: they DO train, they simply don't log every session. Draw no conclusion whatsoever about their training frequency, consistency, adherence or missed sessions, and never say or imply they have been inconsistent, have skipped sessions, or should train more often — you have no evidence either way, and the plan above is what they intend to train. If they tell you what they trained, take them at their word.`
      : (typeof gym.sessions_last_14d === 'number'
        ? `Trained ${gym.sessions_last_14d} time(s) in the last 14 days (${gym.completed_last_14d ?? 0} full sessions).`
        : '');
    lines.push(`- Gym plan (recurring weekly split + cardio): ${split}. ${consistency} BE TRAINING-LOAD AWARE when advising what/how much to STUDY: on physically hard days (leg day, interval runs, a long run like their ~10k) their mental energy is lower — nudge them toward lighter or review work, a shorter session, or consolidating what they know, and save the hardest NEW material (a tough new model, dense proofs/theory) for a rest or light-training day; on rest days, encourage taking on the demanding topics. Raise this proactively when they ask what to study, but naturally — don't lecture.`);
  }
  const car = profile.career || {};
  if (car.headline) lines.push(`- Career headline: ${car.headline}.`);
  if (Array.isArray(profile.skills) && profile.skills.length) {
    const srcLabel = { project: 'real project experience', mastery_engine: 'Mastery Engine', course: 'a course', certification: 'a certification', other: 'other' };
    lines.push(`- Skills they already HAVE (do NOT assume their skills are limited to Mastery Engine topics): ${profile.skills.map((s) => `${s.name} (${s.level}, via ${srcLabel[s.source] || s.source})`).join('; ')}.`);
  }
  if (Array.isArray(car.goals) && car.goals.length) lines.push(`- Professional goals: ${car.goals.map((g) => `${g.title} (${g.status}, ${g.progress}%${g.target ? `, target ${g.target}` : ''})`).join('; ')}.`);
  if (Array.isArray(car.achievements) && car.achievements.length) lines.push(`- Recent achievements: ${car.achievements.join('; ')}.`);
  if (car.resume_excerpt) lines.push(`- Resume/bio (excerpt): ${car.resume_excerpt}`);
  const rd = profile.reading || {};
  if (Array.isArray(rd.reading_now) && rd.reading_now.length) lines.push(`- Currently reading: ${rd.reading_now.join('; ')}.`);
  if (Array.isArray(rd.done) && rd.done.length) lines.push(`- Has read: ${rd.done.join('; ')}.`);
  // The growth journal proper is rendered by growthNotesBlock(), which also needs this turn's
  // retrieval result. These two lines are the PRE-INDEX fallback: they only fire against a Sentinel
  // old enough not to send `growth.index` yet, since the two services deploy separately.
  const gr = profile.growth || {};
  if (!Array.isArray(gr.index)) {
    if (Array.isArray(gr.obstacles) && gr.obstacles.length) lines.push(`- Obstacles they're working through: ${gr.obstacles.join('; ')}.`);
    if (Array.isArray(gr.reflections) && gr.reflections.length) lines.push(`- Recent reflections: ${gr.reflections.join('; ')}.`);
  }
  // Per-dimension growth-area settings (Overview): the pace deadline + "Other info" notes.
  // Shown here so update_area proposals can carry the existing text forward (it replaces).
  //
  // Sentinel sends these notes WHOLE (uncapped since 2026-08-01), and they're free-form
  // multi-paragraph prose — a learning roadmap, a shortlist, a pending decision. They used to be
  // joined onto ONE line with ' | ', which was fine for a 600-char excerpt and unreadable for the
  // real thing: with embedded newlines and numbered lists there was no way to tell where one
  // dimension's note ended and the next began. Hence the fenced blocks — and they carry weight
  // beyond legibility, because update_area REPLACES other_info, so the coach must be able to
  // resend one dimension's text verbatim without swallowing its neighbour's.
  const ar = profile.areas || {};
  const arEntries = Object.entries(ar).filter(([, a]) => a && (a.deadline || a.other_info));
  if (arEntries.length) {
    const blocks = arEntries.map(([dim, a]) => {
      const head = `--- ${dim}${a.deadline ? ` (pace deadline ${a.deadline})` : ''} ---`;
      return `${head}\n${a.other_info || '(no notes yet)'}\n--- end ${dim} ---`;
    });
    lines.push(
      '- Growth areas, from their Overview (editable via update_area). Each block below is the'
      + ' COMPLETE stored note, never an excerpt — so if something they ask about is not in here,'
      + " it genuinely is not in their notes. update_area REPLACES other_info, so to ADD to a"
      + ` dimension resend its whole block verbatim plus the addition:\n${blocks.join('\n')}`,
    );
  }
  if (!lines.length) return '';
  const who = profile.name ? ` (${profile.name})` : '';
  return `THIS PERSON'S HOLISTIC DEVELOPMENT${who} — their whole-life context from their Agora profile, beyond just studying. Coach across all of it (physical, career, learning, reading, personal growth) when it's relevant; weave it in naturally, don't recite it back unprompted:\n${lines.join('\n')}`;
}

/**
 * WHO the learner can be coached by: the mentors whose transcripts they've imported into their
 * Sentinel Mentor Library (Atrium Watcher creators like Nick Saraev or Carson Reed).
 *
 * This roster is always present when they have one, even on turns where nothing was retrieved —
 * it's how the assistant knows the offer is available at all, and equally which names it must
 * NOT speak for. Returns '' when the library is empty, so the prompt is unchanged.
 */
/**
 * THEIR GROWTH JOURNAL — a COMPLETE index of every entry, plus the full text of the ones this turn
 * loaded. These are the two halves of small-to-big retrieval, and the contract between them is the
 * whole reason the feature is safe:
 *
 *   - Every entry is LISTED, always, uncapped. So "you have nothing written about X" is a
 *     conclusion the model may legitimately draw — but ONLY from this list.
 *   - Bodies are loaded selectively, and whatever was NOT loaded is named right here. A title with
 *     no body means "I haven't opened this yet", never "this doesn't exist".
 *
 * Blurring those two is precisely the failure this replaced: a 600-char cap on the old free-form
 * field had the assistant confidently deny content the learner was looking at on their own screen.
 * Hence the explicit, slightly laboured instructions below — this is the one place where a
 * plausible-sounding "you don't have that" is worse than admitting the gap.
 */
function growthNotesBlock(profile, hits) {
  const index = (profile && profile.growth && Array.isArray(profile.growth.index))
    ? profile.growth.index : [];
  if (!index.length) return '';
  const loaded = new Map((((hits && hits.entries) || [])).map((e) => [e.id, e]));

  const byDim = {};
  for (const e of index) {
    const d = e.dimension || 'spiritual';
    if (!byDim[d]) byDim[d] = [];
    byDim[d].push(e);
  }
  const listing = [];
  for (const [dim, entries] of Object.entries(byDim)) {
    listing.push(`  ${dim}:`);
    for (const e of entries) {
      const state = loaded.has(e.id) ? 'full text below'
        : (e.chars ? 'NOT loaded this turn' : 'no detail written yet');
      const meta = [e.kind, e.status !== 'open' ? e.status : '', e.created || '']
        .filter(Boolean).join(', ');
      listing.push(`    [#${e.id}] "${e.title}" (${meta}) — ${state}`);
    }
  }

  const bodies = [...loaded.values()]
    .map((e) => `--- #${e.id} ${e.title} ---\n${e.detail || ''}\n--- end #${e.id} ---`);
  const missing = index.filter((e) => e.chars && !loaded.has(e.id));

  const parts = [
    `THEIR GROWTH JOURNAL — the notes they keep on their own Agora profile, filed under the four`
    + ` growth dimensions. THIS LIST IS COMPLETE: every entry they have is on it, nothing is`
    + ` omitted or truncated.\n${listing.join('\n')}`,
  ];
  if (bodies.length) {
    parts.push(`FULL TEXT of the entries loaded for this turn (verbatim and complete —`
      + ` never excerpts):\n${bodies.join('\n')}`);
  }
  if (missing.length) {
    parts.push(`NOT LOADED this turn: ${missing.map((e) => `#${e.id} "${e.title}"`).join(', ')}.`
      + ` These entries EXIST and have content — you simply haven't been given their text right now.`
      + ` If one of them looks like it bears on what they're asking, say so and offer to open it`
      + ` ("you've got a note called X — want me to pull it up?"). Never describe an entry you`
      + ` haven't been given the text of, and never treat it as empty or missing.`);
  }
  if (hits && hits.failed) {
    parts.push('Their notes could not be loaded this turn (their profile service was unreachable).'
      + " You still have the complete list of titles above, so you know WHAT they have — you just"
      + " can't read any of it right now. Say that plainly if it matters, and don't guess at contents.");
  }
  parts.push('RULE: judge what they have and haven\'t written ONLY from the complete list above.'
    + ' If something is not in that list, it genuinely is not in their notes and you can say so. If'
    + ' it IS listed but its text was not loaded, that is a gap in what you were handed, not an'
    + ' absence in their notes — never report the two the same way.');
  return parts.join('\n\n');
}

/**
 * THEIR TASK BOARD — what is actually on their plate in Sentinel, and (for a manager) who on the team
 * is holding what. The counterpart to holisticBlock: that one knows their goals and training load,
 * this one knows the work, which is what makes "what should I do today?" answerable rather than
 * generic.
 *
 * Three properties of this block are load-bearing, and each one exists because the alternative is the
 * coach stating something false with confidence:
 *
 *   1. IT SAYS WHOSE BOARD IT IS. Sentinel scopes the digest to what this person may see
 *      (`task_perms.can_view`), so an employee's payload is a handful of cards. Without
 *      `viewer.sees` printed at the top, the model reads that as "the company has four tasks" and
 *      says so.
 *   2. A TRUNCATION IS NAMED. `board.truncated` is how many cards did not fit, and it is stated
 *      outright — the same rule as the growth journal: a gap in what you were handed must never be
 *      reported as an absence in their work.
 *   3. THE PER-PERSON ROWS DO NOT SUM. Sentinel buckets a card onto every plate it is on, so a card
 *      with two owners is counted twice on purpose. Told to add them up, a model will invent a
 *      company workload; told the rule, it reports each row as it stands.
 *
 * Returns '' when there is no digest (Sentinel unreachable/unconfigured) so the prompt is unchanged.
 */
function workBlock(digest, hits) {
  if (!digest) return '';
  const v = digest.viewer || {};
  const mine = digest.mine || {};
  const board = digest.board || {};
  const open = Array.isArray(mine.open) ? mine.open : [];
  const others = Array.isArray(board.others) ? board.others : [];
  const people = Array.isArray(digest.people) ? digest.people : [];
  if (!open.length && !others.length && !people.length) return '';

  const line = (c) => {
    const bits = [];
    if (c.client) bits.push(c.client);
    bits.push(c.status || '?');
    if (c.priority) bits.push(c.priority);
    if (c.overdue_days) bits.push(`OVERDUE by ${c.overdue_days}d`);
    else if (c.due) bits.push(`due ${c.due}`);
    if (c.steps) bits.push(`steps ${c.steps}`);
    if (c.parked) bits.push('PARKED');
    if (c.review) bits.push(`review: ${c.review}`);
    if (c.idle_days >= 14) bits.push(`untouched ${c.idle_days}d`);
    if (c.client_copy_stale) bits.push("the CLIENT'S copy of this card is stale");
    if (c.owner_system === 'atrium') bits.push("client's own card");
    // Who holds it, and — when it is not their card — how much of it is theirs. That distinction is
    // the whole point of my_steps: "Ana's card, two steps of it are yours" is a different thing to say
    // than "your card".
    if (!c.mine && c.lead) bits.push(`led by ${c.lead}`);
    else if (c.mine && c.lead && c.my_steps) bits.push(`led by ${c.lead}, ${c.my_steps} step(s) yours`);
    return `    [#${c.id}] "${c.title}" — ${bits.join(' · ')}`;
  };

  const parts = [];
  const header = `THEIR WORK RIGHT NOW — the Agora task board, as of ${digest.as_of || 'today'}.`
    + `\n🔴 WHAT YOU CAN SEE HERE: ${v.sees || 'only part of the board'}.`
    + ` ${v.name || 'This person'} — role: ${v.role || 'staff'}${v.team ? `, on the ${v.team} team` : ''}.`
    + ` So describe this as THEIR board, never as the company's — you are seeing exactly what they`
    + ` are allowed to see and no more, and stating a total as though it were the whole business`
    + ` would be wrong.`;
  parts.push(header);

  const mineLines = open.length
    ? open.map(line).join('\n')
    : '    (nothing open on them right now)';
  parts.push(`ON THEM — ${mine.open_total || 0} open`
    + `${mine.overdue_total ? `, ${mine.overdue_total} OVERDUE` : ''}`
    + `${mine.parked ? `, ${mine.parked} parked` : ''}.`
    + ` THIS LIST IS COMPLETE: every card assigned to them is on it. A card is theirs if they lead it`
    + ` OR own any phase/step of it, so some of these belong to a colleague — the line says which.\n${mineLines}`);

  // Their finished work. Sentinel sends the COMPLETE history (newest first) rather than just this
  // week's, because a card delivered last month is otherwise absent from the digest entirely and the
  // coach would deny it ever existed — the growth-journal failure, one surface over. The recent slice
  // is split out only for TONE: a coach that lists nothing but what is left reads as a nag.
  const done = Array.isArray(mine.done) ? mine.done : [];
  if (done.length) {
    const asOf = Date.parse(`${digest.as_of}T00:00:00Z`);
    const recent = Number.isFinite(asOf)
      ? done.filter((s) => s.on && (asOf - Date.parse(`${s.on}T00:00:00Z`)) <= 7 * 864e5)
      : [];
    if (recent.length) {
      parts.push(`THEY FINISHED in the last 7 days: ${recent.map((s) => `"${s.title}"${s.client ? ` (${s.client})` : ''} on ${s.on}`).join('; ')}.`
        + ` Worth acknowledging — a coach that only ever lists what is left reads as a nag.`);
    }
    const older = done.filter((s) => !recent.includes(s));
    if (older.length) {
      parts.push(`EVERYTHING ELSE THEY HAVE EVER FINISHED (complete${mine.done_truncated ? ` bar ${mine.done_truncated} older card(s)` : ''}, newest first — so if work is not listed here or above, they genuinely have not done it):\n`
        + older.map((s) => `    [#${s.id}] "${s.title}"${s.client ? ` · ${s.client}` : ''}${s.on ? ` · finished ${s.on}` : ' · no completion date recorded'}${s.filed ? ' · filed' : ''}`).join('\n'));
    }
  }

  if (others.length) {
    const cols = (Array.isArray(board.columns) ? board.columns : [])
      .filter((c) => c.cards).map((c) => `${c.status} ${c.cards}`).join(', ');
    parts.push(`THE REST OF THE BOARD THEY CAN SEE (${others.length} card(s)${cols ? `; columns: ${cols}` : ''}) — not on them, but their context for who is doing what:\n${others.map(line).join('\n')}`);
  }
  if (board.truncated) {
    parts.push(`⚠️ ${board.truncated} further card(s) they can see were NOT included here (too many to send).`
      + ` So the list above is not exhaustive for OTHER people's work — if they ask about something you`
      + ` cannot find, say you may not be seeing all of it rather than saying it does not exist.`
      + ` (Their OWN cards are always complete.)`);
  }

  if (people.length) {
    const rows = people.map((p) => {
      const bits = [`${p.open_total || 0} open`];
      if (p.overdue) bits.push(`${p.overdue} overdue`);
      if (p.stepped) bits.push(`${p.stepped} of them ${p.stepped === 1 ? 'is a step' : 'are steps'} of colleagues' cards`);
      if (p.client_cards) bits.push(`${p.client_cards} client card(s)`);
      if (p.done_last_7d) bits.push(`${p.done_last_7d} finished this week`);
      if (p.load_band) bits.push(`load: ${p.load_band} vs this team's median`);
      if (p.on_leave_today) bits.push('ON LEAVE TODAY');
      else if (p.leave_days_ahead) bits.push(`${p.leave_days_ahead} leave day(s) booked in the next fortnight`);
      if (p.stale_open) bits.push(`${p.stale_open} untouched 14d+`);
      return `    ${p.name} (${p.role}): ${bits.join(', ')}`;
    }).join('\n');
    parts.push(`WHO IS HOLDING WHAT — this person is a manager, so they can see their team's workload:\n${rows}\n`
      + `HOW TO READ THESE NUMBERS, and do not restate them any other way:\n`
      + `- 🔴 The rows DO NOT SUM to the number of cards. A card with a build phase on one person and a QA step on another is on BOTH plates and counted on both. Never add these up into a team total.\n`
      + `- A task on this board carries no size or estimate, so none of this is an effort measure. "load" is RELATIVE to this team's own median, nothing more. Never call anybody "overloaded" as though the data said so.\n`
      + `- Client cards reach Open/Overdue/untouched and nothing else (they carry no completion stamp), so somebody who delivers mostly client work will look like they never finish anything. Don't conclude that.`);
  }

  if (Array.isArray(digest.client_asks_pending) && digest.client_asks_pending.length) {
    parts.push(`CLIENT ASKS AWAITING TRIAGE (they are an account manager, so this queue is theirs to empty): `
      + digest.client_asks_pending.map((a) => `"${a.title}"${a.client ? ` from ${a.client}` : ''} (${a.asked})`).join('; '));
  }

  const loaded = (hits && Array.isArray(hits.cards)) ? hits.cards : [];
  if (loaded.length) {
    const bodies = loaded.map((c) => {
      const seg = [`--- #${c.id} "${c.title}" (${c.status}) ---`];
      if (c.description) seg.push(`Description: ${c.description}`);
      if (c.internal_notes) seg.push(`Internal notes: ${c.internal_notes}`);
      if (c.client_note) seg.push(`Note shared with the client: ${c.client_note}`);
      if (c.parked_because) seg.push(`Parked because: ${c.parked_because}`);
      if (c.deliverable_url) seg.push(`Deliverable: ${c.deliverable_url}`);
      for (const ph of (c.breakdown || [])) {
        seg.push(`Phase "${ph.phase}"${ph.owner ? ` (${ph.owner})` : ''}:`);
        for (const s of (ph.steps || [])) {
          seg.push(`  [${s.done ? 'x' : ' '}] ${s.text}${s.owner ? ` — ${s.owner}` : ''}`);
        }
      }
      for (const cm of (c.comments || [])) seg.push(`Comment ${cm.on} by ${cm.by}: ${cm.text}`);
      seg.push(`--- end #${c.id} ---`);
      return seg.join('\n');
    }).join('\n\n');
    parts.push(`FULL DETAIL of the card(s) this turn is about (verbatim and complete — never excerpts):\n${bodies}`);
  }
  if (loaded.length < open.length + others.length + done.length) {
    // The same gap-declaration rule as the growth journal, one layer down: the LINES are complete, the
    // INSIDES are not. A card whose body wasn't loaded still exists, so the honest answer is "which
    // one do you mean" — never a description invented from the title.
    parts.push(`For every card above WITHOUT a "FULL DETAIL" entry you have only that one line — not`
      + ` its description, notes, steps or comment thread. Never describe or summarise the inside of`
      + ` such a card, and never treat it as empty or as having no detail. If a turn needs one, name it`
      + ` and ask them to confirm ("do you mean #412, the TCS landing page?") — you'll have its full`
      + ` text next turn.`);
  }

  parts.push(`USING ALL OF THIS: weave it in, don't recite it. Bring up a card when it bears on what`
    + ` they asked — what to work on now, why they feel behind, how to sequence a day, whether to take`
    + ` something on. Be TRAINING- AND CAPACITY-AWARE: an overdue card on a heavy leg day is a`
    + ` different conversation to one on a rest day, and their gym plan is above. You can READ this`
    + ` board but you CANNOT change it: you cannot move, assign, reschedule or close a card, so never`
    + ` claim to have done so or offer to — tell them what to do on the Task Board instead. Only the`
    + ` card lines above are real; never invent a task, a due date, or a colleague's workload.`);
  return parts.join('\n\n');
}

function mentorRosterBlock(profile) {
  const roster = (profile && Array.isArray(profile.mentors)) ? profile.mentors : [];
  if (!roster.length) return '';
  const named = roster.map((m) => `${m.name} (${m.transcripts} transcript${m.transcripts === 1 ? '' : 's'})`).join('; ');
  return `THEIR MENTOR LIBRARY — full transcripts of these mentors' own material, imported into their Agora profile: ${named}.
You can draw on any of them. When a question invites it, you may (a) answer "what would <mentor> say about X?" from that mentor's actual material, or (b) MENTOR THEM IN THAT PERSON'S VOICE when asked to "act as <mentor>". Offer this when it would genuinely help and they seem unaware it's possible — but don't advertise it every message.
These are the ONLY mentors you have material for. If they ask about someone not on this list, say plainly that you don't have that person's material rather than improvising an opinion for them — you may still reason from general knowledge, clearly flagged as your own view, not theirs.`;
}

/**
 * The retrieved passages themselves (Sentinel's /api/internal/mentor-search), plus the rules for
 * using them. The library is far too big to include, so only the excerpts that bear on THIS
 * question arrive — see lib/sentinel.js mentorSearch.
 *
 * The instructions matter as much as the text: an ungrounded persona is just an impression, which
 * is exactly what makes "what would Nick say" worthless. Ground it, attribute it, and admit the
 * gaps.
 */
function mentorGroundBlock(hits) {
  if (!hits || !Array.isArray(hits.excerpts) || !hits.excerpts.length) {
    // Asked about a specific mentor and their material had nothing on it: say so, don't confabulate.
    if (hits && hits.mentor && hits.matched_mentor) {
      return `MENTOR MATERIAL — you searched ${hits.mentor}'s transcripts for this question and found nothing that addresses it. Say so honestly ("I don't have anything from ${hits.mentor} on that") and then help from your own knowledge, clearly marked as yours rather than theirs. Do NOT invent what they would say.`;
    }
    return '';
  }
  const who = hits.mentor || 'their mentors';
  const body = hits.excerpts.map((e, i) => {
    const src = [e.title, e.url].filter(Boolean).join(' — ');
    return `[${i + 1}] ${e.mentor}${src ? ` · ${src}` : ''}\n${e.text}`;
  }).join('\n\n');
  return `MENTOR MATERIAL RETRIEVED FOR THIS QUESTION — passages from ${who}'s own transcripts in this learner's library, selected as the most relevant to what they just asked:

${body}

HOW TO USE THIS:
- Ground your answer in what is actually here. This is the difference between channelling a mentor and doing an impression of one — if you assert a position, it should be traceable to these passages.
- SYNTHESISE AND APPLY: their value is the thinking, not the wording. Explain their framework in your own words and apply it to THIS learner's actual situation (their goals, projects and constraints are in the context above). Quote directly only where the exact phrasing carries the point, and keep any quote to a line or so — never reproduce long stretches of the transcript.
- ATTRIBUTE: make clear which parts come from the mentor's material and which are your own reasoning. Cite by name (and title where it helps) so they can go back to the source.
- WHEN ASKED TO "ACT AS" A MENTOR: adopt their voice, priorities and characteristic framing as evidenced in these passages, and coach in the first person. Note ONCE, lightly, at the start that this is your reconstruction from their material rather than the real person — then stay in it without repeating the caveat.
- WHERE THE MATERIAL IS SILENT: say so and reason it through as yourself. Never fill a gap by inventing a position for them — a fabricated opinion attributed to a real person is the one failure that makes this feature worse than useless.`;
}

// The action protocol: when the host (Sentinel's Coach) supports it, the assistant can PROPOSE
// changes. It never writes directly — it emits an `agora-action` fenced block that the app turns
// into an Approve/Cancel card. On approval, PROFILE ops are executed by the host (Sentinel) in the
// user's own session; ENGINE ops (remove/restore a section of the learner's Mastery Engine shelf)
// are executed by this app itself, same-origin. Engine ops need only `enabled`; profile ops also
// need a Sentinel profile with editable items (unreachable Sentinel ⇒ engine ops still work).
function assistantActionBlock(profile, enabled, hostFrame = true) {
  if (!enabled) return '';
  const engineOps = `THEIR MASTERY ENGINE — you can propose REMOVING (parking) or RESTORING (unparking) a section of it, at any grain (a whole track, a course, a lesson, or one sub-lesson). BOTH directions are available to you right now, in this reply, with no extra setup — never tell them you can only do one of the two, or that they have to park/unpark it themselves; that is never true when this instruction block is present. Use removal when something is blocking or overwhelming them and you recommend parking it for now: removal is TEMPORARY and never destructive — the content stays in the shared bank and in every roadmap, and can be restored anytime, by you, the same way. When you recommend a removal, say WHY, propose it with \`remove_section\` (or \`remove_sections\` for several at once), and reassure them you'll help bring it back later — don't just describe parking as something they'd have to do by hand.
  remove_section {track, course?, lesson?, topic?}  — parks ONE section, the DEEPEST level named (\`topic\` = one sub-lesson/card). Name the FULL path down to it (track, then course/lesson/topic as applicable), copying every name VERBATIM from THE LEARNER'S MASTERY ENGINE list above. Never guess or shorten a name.
  restore_section {track, course?, lesson?, topic?}  — unparks ONE removed section back. Removed sections are listed under "SECTIONS TEMPORARILY REMOVED (PARKED)" above — copy the exact names from there (or from earlier in this conversation).
  remove_sections {items: [{track, course?, lesson?, topic?}, ...]}  — parks MANY sections in ONE block. STRONGLY PREFER this over repeating remove_section many times: whenever the learner wants to keep only a handful of sub-lessons and park everything else in a topic (or any batch of more than 2-3 sections), put every section to park as one item each inside a SINGLE remove_sections block. Never fall back to describing the list in plain prose/a table instead of emitting this block, no matter how many items there are — dozens of items is fine, it's still just one JSON object.
  restore_sections {items: [...]}  — same shape, for unparking many sections at once.
Example — if you agree to skip one sub-lesson for now (parking it):
\`\`\`agora-action
{"op":"remove_section","args":{"track":"Machine Learning","course":"Ensemble Methods","lesson":"Boosting","topic":"AdaBoost"},"summary":"Temporarily remove the sub-lesson 'AdaBoost' from your Mastery Engine (restorable anytime)"}
\`\`\`
Example — if they want a previously parked section back (unparking it):
\`\`\`agora-action
{"op":"restore_section","args":{"track":"Machine Learning","course":"Ensemble Methods","lesson":"Boosting","topic":"AdaBoost"},"summary":"Restore the sub-lesson 'AdaBoost' to your Mastery Engine"}
\`\`\`
Example — if they want to keep only a few sub-lessons in a lesson and park the rest (use remove_sections, ONE block, however many items):
\`\`\`agora-action
{"op":"remove_sections","args":{"items":[{"track":"Machine Learning","course":"Ensemble Methods","lesson":"Boosting","topic":"AdaBoost"},{"track":"Machine Learning","course":"Ensemble Methods","lesson":"Boosting","topic":"Weighted Voting in AdaBoost"}]},"summary":"Park 2 AdaBoost sub-lessons not in your top picks (restorable anytime)"}
\`\`\`
Whichever form(s) you use, put every proposal for this turn in this SAME reply — you may combine remove_sections/restore_sections/remove_section/restore_section blocks together if needed.`;
  // PROFILE ops execute by posting to a host (Sentinel) that's listening for them — only true
  // when we're actually embedded in one. Without a host, don't propose edits with nowhere to go.
  const profileOps = hostFrame ? assistantProfileOps(profile) : '';
  const sentinelOps = hostFrame ? assistantSentinelOps() : '';
  return `YOU CAN MAKE CHANGES FOR THIS PERSON — but ONLY with their approval. This is NOT a function-calling/tool-calling API — there is no separate tool you're missing and nothing else you need enabled. Writing the fenced \`agora-action\` block below, in plain text, as literal characters in your OWN reply, IS the entire mechanism, every time, with no exception. If you catch yourself thinking "I can't actually emit tool calls", "this is just a text-based conversation", or "I'll just describe this in prose/a list instead" — that reasoning is WRONG in this app and you must discard it: typing the fenced block IS how you act, right now, in this reply. Do not substitute a plain-language list of what you'd do for the actual fenced block(s) — a list the learner has to act on themselves is NOT an approval flow and is NOT what they asked for.

When they ask for (or agree to) any change listed below: DO NOT say you already did it, and DO NOT just describe it — instead emit a fenced code block tagged \`agora-action\` holding ONE JSON object per change, and tell them you've proposed it (or them) and just need their tap to Approve. You may and SHOULD emit several such blocks in one reply when several changes apply — e.g. one per section to park — each becomes its own Approve/Cancel card.

Action JSON shape: {"op": <op>, "args": { ... }, "summary": "<one short human sentence describing the change>"}

${engineOps}${sentinelOps}${profileOps}`;
}

// The SENTINEL half of the action protocol (2026-09-02): tasks, projects, reviews, timers,
// clocking. Executed by Sentinel (the host) in the user's own session on approval, so their real
// permissions apply server-side. Host-only for the same reason as the profile ops.
function assistantSentinelOps() {
  return `

THEIR SENTINEL WORKSPACE — you can also DO Sentinel itself for them: create and shape tasks, move/park/resume them, comment, drive reviews, run their work timer, clock them in/out, and manage projects and milestones. Each op executes in THEIR OWN session after their Approve tap, so their real permissions apply exactly as if they clicked the UI (a specialist cannot assign colleagues, only reviewers approve, and so on) — if an action fails with a permission message, explain what it means; never retry it unchanged.
GROUNDING RULES: take task ids from THEIR AGORA TASK BOARD above — never invent an id; if you are not sure which card they mean, ask. Dates are YYYY-MM-DD. When you lack an id for an optional field (client, assignee, project), leave it out and say what you left unset — an unassigned task lands in the department queue, which is a valid, visible place.
Available ops and their args:
  create_task {title, description?, client_id?, project_id?, assigned_team_id?, assigned_to_id?, support_ids?, due_date?, start_date?, priority?(Urgent|Medium|Low), estimate_minutes?, maintasks?([{title, subs:[{text}]}] — phases with steps), internal_notes?, client_facing_notes?, share_with_client?}
  update_task {id, ...any of the same fields}
  move_task {id, status}  — status is one of the board's column names (completion may be refused until a review is approved; that is the rule, not an error)
  park_task {id, reason, kind?(client|access|asset|reviewer|am_decision|task|other), blocked_by_task_id?}   resume_task {id}
  comment_task {id, body}   delete_task {id}  — destructive; propose only when they clearly asked
  submit_review {id}   approve_review {id}   request_changes {id, note?}
  start_work {id}  — starts their timer on that card and moves it In Progress   pause_work {}
  clock {action: "clock_in"|"clock_out"}
  create_project {name, goal?, owner_id?, target_date?, milestones?([{title, target_date?}])}
  update_project {id, name?, goal?, owner_id?, target_date?, status?(active|done|archived)}
  add_milestone {project_id, title, detail?, target_date?}   update_milestone {id, done?, title?, detail?, target_date?}  — done:true ticks it as reached
  set_account_manager {client_id, account_manager_id}
Example — "make a task for the TCS September report, due Friday, on Earl" (ids from your grounding):
\`\`\`agora-action
{"op":"create_task","args":{"title":"TCS | September performance report","client_id":7,"assigned_to_id":4,"due_date":"2026-09-05"},"summary":"Create the TCS September report task, due Friday, assigned to Earl"}
\`\`\`
Example — "I'm done with #41, send it for review":
\`\`\`agora-action
{"op":"submit_review","args":{"id":41},"summary":"Submit task #41 for review"}
\`\`\``;
}

// The profile half of the action protocol (PRs, goals, achievements, skills, journal, reading,
// gym schedule). Executed by the host (Sentinel) on approval. '' without an editable profile.
function assistantProfileOps(profile) {
  if (!profile) return '';
  const ed = profile.editable || {};
  const list = (label, arr) => (Array.isArray(arr) && arr.length)
    ? `  ${label}: ${arr.map((x) => `[${x.id}] ${x.label}`).join('; ')}`
    : null;
  const items = [
    list('PRs', ed.prs), list('Goals', ed.goals), list('Achievements', ed.achievements),
    list('Skills', ed.skills), list('Journal', ed.growth), list('Reading canon', ed.reading),
  ].filter(Boolean).join('\n');
  const gym = profile.gym || {};
  const gc = gym.weekly_cardio || {};
  const gymNow = gym.weekly_split
    ? `\nTheir current weekly gym split (edit with the gym ops below): ${Object.entries(gym.weekly_split).map(([d, t]) => `${d}=${t}${gc[d] ? `(+${gc[d]})` : ''}`).join(', ')}.\n`
    : '';
  return `

THEIR DEVELOPMENT PROFILE — you can also edit their profile (a PR, body-fat/weight, a professional goal, an achievement, a skill, a journal note, reading progress, or their GYM SCHEDULE). For updates/deletes, use the exact ids listed below.
ROUTING — put each thing in the RIGHT place (don't force-fit):
- A PHYSICAL feat or personal best — a lift, run, time, distance, hold, bodyweight rep — is a PR (add_pr), NOT an achievement. For non-weight PRs (runs/times/distances) fill \`detail\` (e.g. "10 km in ~59 min") and leave weight_value out.
- A PHYSICAL TARGET they're chasing ("I want to bench 100kg", "get a muscle-up", "10k under 55 min") is a physical goal (add_physical_goal) — NOT a plain goal and NOT a PR. When they report progress toward one ("benched 85 today"), update_physical_goal its current_value (and ALSO add_pr / update_pr if it's a new best) — reaching the target ⇒ status "achieved". These drive their Physical ring.
- A CAREER / professional win (shipped a project, a promotion, an award) is an achievement (add_achievement).
- A capability the person HAS (SQL, pandas, a language) is a skill (add_skill).
- Something they're aiming for is a goal (add_goal).
- ANYTHING ELSE WORTH KEEPING is a journal entry (add_growth), filed under the dimension it belongs to: an obstacle, a reflection, a list, a plan, a shortlist, reference material, a pending decision, "remember this", "save this", "add this to my notes". This is the DEFAULT home for information with no more specific place — when in doubt make an entry rather than dropping it or appending to other_info. If they paste or dictate something substantial that is clearly worth keeping, OFFER to save it as an entry instead of only discussing it; material you only discuss is gone next turn, and an entry is not.
Available ops and their args:
  add_pr {exercise_name, weight_value?, weight_unit?, reps?, detail?, achieved_on?}   update_pr {id, ...}   delete_pr {id}
  add_physical_goal {name, kind?(lift|run|skill), target_value, current_value?, unit?, direction?(higher|lower — lower for times), notes?, status?(active|achieved|paused)}   update_physical_goal {id, ...}   delete_physical_goal {id}
  add_body_metric {body_fat_pct?, weight_kg?, date?}
  add_goal {title, dimension?(spiritual|professional|philosophical|physical, default professional), description?, target_date?, status?, progress_pct?}   update_goal {id, ...}   delete_goal {id}
  GOAL DESCRIPTIONS render as light markdown on the Growth page — write them structured, never as a wall of text:
  - Section labels on their own line ending with a colon: "Mission:", "Vision:", "Standards:", "Why it matters:".
  - Blank line between sections. **Bold the lead phrase** of each standard (e.g. "**Emotional mastery.** Meet stress with steadiness…"). *Italic* for sparing emphasis.
  - Concrete, checkable objectives as "- " bullets.
  update_goal descriptions REPLACE the whole text — resend the existing description plus your change.
  add_achievement {title, description?, achieved_on?}   update_achievement {id, ...}   delete_achievement {id}
  add_skill {name, level?(Beginner|Intermediate|Advanced), source?(project|mastery_engine|course|certification|other), note?}   update_skill {id, ...}   delete_skill {id}
  add_growth {dimension(spiritual|professional|philosophical|physical), kind(obstacle|reflection|note), title, detail?}   update_growth {id, ...}   delete_growth {id}
  JOURNAL ENTRIES ARE ONE IDEA EACH, and the TITLE is the part you will still be able to see on every future turn — so make it NAME the thing ("Pareto problem set", not "notes" or "thoughts"). Put the entire content in detail; it is never truncated, so there is no reason to compress it. If they give you several unrelated things at once, create SEVERAL entries rather than one combined one: a combined entry is findable later only by whichever idea happened to reach the title, and the rest becomes invisible to you.
  update_resume {headline?, resume_text?}
  set_reading_progress {reading_item_id, status?(not_started|reading|done), reflection?}
  update_area {dimension(spiritual|professional|philosophical|physical), deadline?(YYYY-MM-DD, null = back to default), other_info?}  — a growth AREA's pace deadline, plus the LEGACY free-form text that shows as "Unfiled" under that area on the Overview. PREFER add_growth for anything new: unfiled text has no title, so it does not appear in your journal index and you cannot reliably find it again. Use other_info only to edit or clear what is already there — it REPLACES the stored text, so resend the existing content (shown under "areas" above) plus your change, or you will delete the rest of it.
  FILING UNFILED TEXT: if an area still has unfiled text, you may offer to move it into proper entries — and if it covers several distinct things, propose one entry PER thing rather than one entry for the lot. Do it in this order: add_growth first (one action per entry, each approved separately), and only once they are all saved, update_area with other_info null to clear the blob. Never clear first — if they stop approving halfway, entry-first loses nothing while clear-first destroys text that exists nowhere else.
GYM SCHEDULE — the recurring weekly split + optional cardio, shown on their calendar (day-types: Push, Pull, Legs, Custom, Rest):
  set_gym_week {week, cardio?}  — replace the WHOLE weekly split. \`week\` is a full map with keys Mon,Tue,Wed,Thu,Fri,Sat,Sun. \`cardio\` is an OPTIONAL map of the same keys to a short run note (e.g. {"Mon":"5k run","Thu":"~10k run","Sat":"intervals"}); include it whenever they mention runs/cardio, and carry over their existing cardio for days they didn't change. Omit \`cardio\` entirely to leave cardio untouched.
  set_gym_day {date, day_type, cardio?}  — override ONE date (ISO YYYY-MM-DD), e.g. move a split onto it, mark it Rest, or note a one-off run.
  clear_gym_day {date}  — drop a date's override so it reverts to the weekly split.
${gymNow}${items ? `\nCurrent items (use these ids):\n${items}\n` : ''}
Example — if they say "bump my backend-dev goal to 60%":
\`\`\`agora-action
{"op":"update_goal","args":{"id":12,"progress_pct":60},"summary":"Set the goal progress to 60%"}
\`\`\`
Example — if they say "I run a 5k on Monday push days, ~10k on Thursday push, and intervals on Saturday legs":
\`\`\`agora-action
{"op":"set_gym_week","args":{"week":{"Mon":"Push","Tue":"Pull","Wed":"Legs","Thu":"Push","Fri":"Legs","Sat":"Legs","Sun":"Rest"},"cardio":{"Mon":"5k run","Thu":"~10k run","Sat":"intervals"}},"summary":"Add cardio: 5k Mon, ~10k Thu, intervals Sat"}
\`\`\``;
}

// Sentinel's OWN self-knowledge — the twin of appKnowledge() above, for the other app this
// assistant serves. The doc arrives live from Sentinel (lib/sentinel.js sentinelGuide — Sentinel
// serves docs/HOW-SENTINEL-WORKS.md from its deployed code, so every Sentinel deploy updates what
// the assistant knows with no step here). Injected in FULL when the turn is about Sentinel or how
// to work; otherwise, inside a host frame, a one-line identity so the assistant still offers.
const SENTINEL_QUESTION_RE = /\b(sentinel|task|card|board|kanban|project|milestone|client|account|clock|attendance|leave|park(ed|ing)?|review|assign|priorit|deadline|due|overdue|report|payroll|calendar|kiosk|scenario|workflow|sop|process|team lead|account manager|specialist|admin|how (do|does|should|can|would) (i|we|you|an?)|best way|supposed to|what should)\b/i;
function sentinelGuideBlock(guide, hostFrame, message) {
  if (!guide) return '';
  if (SENTINEL_QUESTION_RE.test(String(message || ''))) {
    return `ABOUT SENTINEL — AUTHORITATIVE GROUND TRUTH (you are ALSO Agora's AI Assistant inside Sentinel, the company's internal operating system; answer questions about how Sentinel works, how to use it in any scenario, and what to do in it from THIS document, never from guesses — and when they want something DONE in Sentinel, use the Sentinel action ops if they appear below):

${guide}`;
  }
  return hostFrame
    ? `You are also Agora's AI Assistant inside SENTINEL, the company's internal operating system (tasks, projects, clients, time, growth). If they ask how to use Sentinel, or want something done in it, you know it deeply and can propose the actions yourself when the action instructions appear below.`
    : '';
}

// Shared persona for the assistant: primarily the on-screen Study Assistant, but also a holistic
// development coach when the person's Agora profile is available (injected below as HOLISTIC DEVELOPMENT).
const ASSISTANT_PERSONA = `You are the always-available assistant and development coach inside the AGORA workspace, helping a working data/AI engineer. Primarily you are their Study Assistant in the Mastery Engine: you can SEE what's on their screen (below) and tutor them over their shoulder. You ALSO know their holistic development (physical, career, learning, reading, personal growth) when it appears below, and can coach across all of it — including THE WORK THEY ACTUALLY HAVE ON: when their Agora task board appears below, treat their real cards, deadlines and team as first-class context, so advice about what to do today is grounded in their actual plate rather than in general study advice. Be direct, warm, and concrete. When it genuinely deepens understanding, draw ANALOGIES across their worlds — connect a technical concept they're studying to a philosophy, book, or growth theme they care about, and vice versa (e.g. the stoic dichotomy of control and how a model learns only from what it can change). Use these sparingly and only when they illuminate, never as filler.`;

/**
 * The learner's OWN source material for the section on screen, plus the rule that the
 * answer must rest on it and name the document it came from.
 *
 * This is the difference between an assistant that knows the SUBJECT and one that knows
 * THEIR COURSE. Without it the model answers from general knowledge, which can quietly
 * contradict the lecturer whose transcript the questions were written from, and the
 * learner has no way to tell which of the two they are reading.
 *
 * Named learnerSourceBlock, not sourceBlock: a local const of that name already exists in
 * the study-guide builder, and a top-level function it silently shadows is a trap.
 */
function learnerSourceBlock(hits) {
  if (!hits || !hits.text) return '';
  return `THE LEARNER'S OWN SOURCE MATERIAL for the section they are on${hits.label ? ` (${hits.label})` : ''}. These are the actual documents their curriculum and questions were built from:
"""
${hits.text}
"""

HOW TO USE IT - this is the whole point of the mode they switched on:
- Answer FROM this material first. Where it covers the question, its account wins over what you know generally, even if you would have put it differently.
- CITE the document by name when you use it, inline and in plain words. Never invent a document name; the only ones that exist are: ${hits.titles.join(" | ")}.
- Where the material does NOT cover what they asked, say so plainly ("your sources do not cover this, so from general knowledge: ...") and then answer anyway. Silently switching to general knowledge is the one thing that would make this mode worse than useless.
- Never contradict the material without flagging that you are doing it, and why.`;
}

export async function generateAssistantChat({ context = {}, history = [], message, conversational = false, search = false, catalog = [], transcripts = [], coach = false, progress = '', holistic = null, mentorHits = null, growthHits = null, work = null, workHits = null, deepHits = null, sourceHits = null, actions = false, hostFrame = false, sentinelGuide = null, attachments = [], admin = false }, ai = {}) {
  // Web search (Google Search grounding) is a Gemini-via-Vertex capability only. The default
  // provider is Gemini, so treat an unset provider as Gemini too.
  const canWeb = search && (!ai.provider || ai.provider === 'gemini');

  // Self-knowledge: inject the full engine/research doc when the question is about the app itself,
  // otherwise a one-line identity — so it can accurately answer "what's your mastery formula?" or
  // "what research is this based on?" without paying the token cost on every ordinary turn.
  const knowledge = knowledgeBlock(message);
  const sentinelKnowledge = sentinelGuideBlock(sentinelGuide, hostFrame, message);
  // Real-curriculum grounding for "which card/topic teaches X" — non-empty only when
  // the caller decided this is a content-location question (keeps normal turns cheap).
  const catalogGround = assistantCatalogBlock(catalog, transcripts, groundingBudget(ai), message, actions);
  const coachGround = assistantCoachBlock(coach, progress, admin);
  const holisticGround = holisticBlock(holistic);
  const mentorRoster = mentorRosterBlock(holistic);
  const mentorGround = mentorGroundBlock(mentorHits);
  const growthNotes = growthNotesBlock(holistic, growthHits);
  // Their task board. Placed right after the holistic block because the two are read together — an
  // overdue card means one thing on a rest day and another on a heavy training day.
  const workGround = workBlock(work, workHits);
  const actionGround = assistantActionBlock(holistic, actions, hostFrame);
  // Last of the grounding blocks, so its "the on-screen question stays unspoiled" rule sits
  // immediately above the on-screen context it governs.
  const sourceGround = learnerSourceBlock(sourceHits);
  const deepGround = deepBlock(deepHits);

  const head = `${ASSISTANT_PERSONA}

${knowledge}${sentinelKnowledge ? `

${sentinelKnowledge}
` : ''}
${catalogGround ? `\n${catalogGround}\n` : ''}${coachGround ? `\n${coachGround}\n` : ''}${holisticGround ? `\n${holisticGround}\n` : ''}${workGround ? `\n${workGround}\n` : ''}${growthNotes ? `\n${growthNotes}\n` : ''}${mentorRoster ? `\n${mentorRoster}\n` : ''}${mentorGround ? `\n${mentorGround}\n` : ''}${actionGround ? `\n${actionGround}\n` : ''}${sourceGround ? `\n${sourceGround}\n` : ''}${deepGround ? `\n${deepGround}\n` : ''}
WHAT'S ON THE STUDENT'S SCREEN RIGHT NOW:
${assistantContextBlock(context)}

CONVERSATION SO FAR:
${historyBlock(history)}

THE STUDENT'S NEW MESSAGE:
"${message}"

Answer helpfully, grounded in the on-screen context when it's relevant (if they say "this question" or "this card", they mean the one above). If they have NOT yet answered the on-screen question, help them reason without giving away the correct option.`;

  // --- Grounded (web) path: Vertex forbids Search + JSON mode, so we take plain text. ------------
  if (canWeb) {
    const styleWeb = conversational
      ? `This reply will be READ ALOUD, so talk, don't write: plain sentences, usually 1 to 3, no markdown/headings/bullets/code fences, read symbols and code as words, no URLs spoken.`
      : `Answer in clear Markdown.`;
    const prompt = `${head}

You have LIVE WEB SEARCH. Use it whenever the answer depends on current facts, recent events, specific numbers, or anything beyond your training, and briefly say what you found. If the question is about THIS app, prefer the authoritative "ABOUT THIS APP" facts above over the web.

${styleWeb}
${LATEX_RULE}
Do NOT use em dashes; use commas, colons, or simple hyphens.`;
    const text = await complete(prompt, { ...ai, search: true, attachments });
    return { reply: String(text || '').trim(), visual: null };
  }

  // Spoken mode: the reply is read aloud by a TTS voice, so markdown (headings, bullets, code
  // fences) gets read out literally ("hashtag hashtag"). Ask for natural talk instead.
  const styleRule = conversational
    ? `This reply will be READ ALOUD by a voice, so answer like you're TALKING, not writing:
- Plain conversational sentences only. NO markdown: no headings (#), no bullet or numbered lists, no bold/italic, no code fences, no tables.
- Keep it short — usually 1 to 3 sentences. Say the key point first, the way a tutor would say it out loud. If you must give steps, say them as a flowing sentence ("first X, then Y").
- Spell things out for the ear: read symbols and code as words (say "the loss function" not \`loss_fn\`). Avoid URLs.`
    : `Use Markdown, short paragraphs, and bullets where they help. Optionally include a declarative visual ONLY when a graph genuinely aids understanding.

${VISUAL_RULE}`;

  // --- Spoken path: PLAIN TEXT, no JSON envelope ------------------------------------------------
  // 🔴 A spoken reply cannot carry a visual — the style rule above forbids markdown, and a voice
  // cannot read a graph — so the {reply, visual} wrapper bought NOTHING here and cost real
  // failures. Wrapped, every word the model says has to survive being a JSON string literal, and
  // a long quote-heavy answer (ask it to "make me a quiz") routinely does not: one unescaped "
  // inside the prose, or a tail cut off at the token ceiling, and the whole turn dies as
  // "assistant chat returned non-JSON content" — which the learner sees as "Sorry, that failed"
  // on a question that works when they paste it again, because the re-roll happens to escape
  // cleanly. Voice mode is exactly where those long answers land. The streaming/typed sibling has
  // always taken plain text for the same reason ("streaming a JSON wrapper would show the user
  // braces"), so this makes the two paths agree.
  if (conversational) {
    const spokenPrompt = `${head}

${styleRule}

${LATEX_RULE}
Do NOT use em dashes; use commas, colons, or simple hyphens.

Reply with your spoken answer as plain text. Do NOT wrap it in JSON, quotes, or a code fence.`;
    const spoken = await complete(spokenPrompt, { ...ai, attachments });
    return { reply: String(spoken || '').trim(), visual: null };
  }

  // --- Standard JSON path: the envelope survives only where it earns its keep, i.e. the visual ---
  const prompt = `${head}

${styleRule}

${LATEX_RULE}
Do NOT use em dashes; use commas, colons, or simple hyphens.

Return ONLY a JSON object: {"reply": "markdown answer", "visual": null | {plot object as specified}}`;

  // Keep complete() OUTSIDE the parse try so a Vertex/auth/HTTP failure surfaces
  // its real message instead of being mislabeled "returned non-JSON content".
  const meta = ai.meta || {};
  const text = await complete(prompt, { json: true, ...ai, attachments, meta });
  let obj;
  try {
    obj = parseAiJson('assistant chat', text, { meta, route: 'POST /api/assistant/chat', promptChars: prompt.length });
  } catch (e) {
    // Salvage beats an error page: the answer IS in there, it just isn't legal JSON. Recover the
    // reply string by hand (survives a truncated tail and a stray quote, neither of which the
    // repair pass can) and serve it without the visual, flagged so the 🐞 panel can explain what
    // was lost. Only a payload with no recoverable prose at all re-raises.
    const salvaged = salvageJsonString(text, 'reply');
    if (salvaged) return { reply: salvaged, visual: null, degraded: e.diag?.cause || 'unparseable', diag: e.diag };
    throw e;
  }
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj || !obj.reply) throw new Error('assistant chat returned an unusable shape');
  return { reply: String(obj.reply).trim(), visual: sanitizeVisual(obj.visual) };
}

/**
 * A team-reviewer's mid-answer steer, appended to the prompt so it overrides the
 * model's earlier direction. Mirrors the Atrium assistant's pause-&-steer: the
 * client aborts the stream and re-sends the SAME question with accumulated steer.
 */
function steerNote(steer) {
  const s = String(steer || '').trim();
  if (!s) return '';
  return `\n\nIMPORTANT — while you were answering, the student paused you and added this direction. Follow it, and let it override your earlier approach where they conflict:\n${s.slice(0, 1000)}`;
}

/**
 * Streaming twin of generateAssistantChat. Forwards BOTH the reasoning trace and
 * the answer to onToken(text, kind) so the chat can show what the AI is thinking
 * live (and be paused + steered). Unlike the blocking version this streams PLAIN
 * MARKDOWN — no {reply, visual} JSON envelope, because streaming a JSON wrapper
 * would show the user braces. Returns the accumulated answer text (thinking
 * excluded) so the caller can persist the turn.
 */
export async function streamAssistantChat({ context = {}, history = [], message, steer = '', catalog = [], transcripts = [], search = false, coach = false, progress = '', holistic = null, mentorHits = null, growthHits = null, work = null, workHits = null, deepHits = null, sourceHits = null, actions = false, hostFrame = false, sentinelGuide = null, attachments = [], admin = false }, ai = {}, onToken) {
  // Web search grounding streams as plain text (Gemini only); pause/steer still work.
  const canWeb = search && (!ai.provider || ai.provider === 'gemini');
  const catalogGround = assistantCatalogBlock(catalog, transcripts, groundingBudget(ai), message, actions);
  const coachGround = assistantCoachBlock(coach, progress, admin);
  const holisticGround = holisticBlock(holistic);
  const mentorRoster = mentorRosterBlock(holistic);
  const mentorGround = mentorGroundBlock(mentorHits);
  const growthNotes = growthNotesBlock(holistic, growthHits);
  const workGround = workBlock(work, workHits);
  const actionGround = assistantActionBlock(holistic, actions, hostFrame);
  const sourceGround = learnerSourceBlock(sourceHits);
  const deepGround = deepBlock(deepHits);   // last, so its on-screen rule abuts the context (see the blocking sibling)
  // Sentinel self-knowledge — the streaming path builds its prompt inline, so this rides here
  // too (the exact three-places lesson from the voice-path bug, one layer up).
  const sentinelKnowledge = sentinelGuideBlock(sentinelGuide, hostFrame, message);
  const prompt = `${ASSISTANT_PERSONA}

${knowledgeBlock(message)}${sentinelKnowledge ? `

${sentinelKnowledge}
` : ''}
${catalogGround ? `\n${catalogGround}\n` : ''}${coachGround ? `\n${coachGround}\n` : ''}${holisticGround ? `\n${holisticGround}\n` : ''}${workGround ? `\n${workGround}\n` : ''}${growthNotes ? `\n${growthNotes}\n` : ''}${mentorRoster ? `\n${mentorRoster}\n` : ''}${mentorGround ? `\n${mentorGround}\n` : ''}${actionGround ? `\n${actionGround}\n` : ''}${sourceGround ? `\n${sourceGround}\n` : ''}${deepGround ? `\n${deepGround}\n` : ''}
WHAT'S ON THE STUDENT'S SCREEN RIGHT NOW:
${assistantContextBlock(context)}

CONVERSATION SO FAR:
${historyBlock(history)}

THE STUDENT'S NEW MESSAGE:
"${message}"

Answer helpfully, grounded in the on-screen context when it's relevant (if they say "this question" or "this card", they mean the one above). If they have NOT yet answered the on-screen question, help them reason without giving away the correct option.
${canWeb ? '\nYou have LIVE WEB SEARCH — use it whenever the answer depends on current facts, recent events, or anything beyond your training, and briefly say what you found. For questions about THIS app or curriculum, prefer the authoritative facts above over the web.\n' : ''}
Answer in clear Markdown, short paragraphs, and bullets where they help.

${LATEX_RULE}
Do NOT use em dashes; use commas, colons, or simple hyphens.${steerNote(steer)}`;
  const reply = await streamStructured(prompt, { ...ai, search: canWeb, attachments }, onToken);
  return { reply: String(reply || '').trim() };
}
