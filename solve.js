// Fast site generator: a faster drop-in for makefun-site 1.0.0.
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input, byte for byte: every page's index.html, the
// index and tag pages, build-report.txt and each static file.
// The speed comes from doing the same work with less of it: one line split
// per source shared by the front matter and the Markdown pass, a fused
// Markdown lexer+renderer that never builds token objects, an inline scanner
// that walks each line once with a single regex instead of escaping it one
// character at a time, an ASCII fast path for slugs with a per-build cache,
// and word counts taken while the lines are scanned anyway.
// No network, no clock, no randomness: the answer is a function of the
// input alone, and every cache here is built fresh inside one run() call.

/** The directories the generator writes itself; no root slug may take one. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The directory of `path` ("" at the root). */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- text

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Whether `text` holds a character the escape table names. */
const HAS_ESCAPE = /[&<>"']/;
/** The escape table, applied to every such character. */
const ESCAPE_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped; returned untouched when it holds none of them. */
export function escapeHtml(text) {
  return HAS_ESCAPE.test(text) ? text.replace(ESCAPE_ALL, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/** Whether `text` holds anything outside ASCII (NFKD is the identity there, with no combining marks). */
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), and "untitled" when nothing
 * is left. `cache` (a Map, one per build) remembers past answers.
 */
export function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let out;
  if (!NON_ASCII.test(text)) {
    // ASCII fast path: no normalisation and no mark pass to pay for.
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  if (cache !== undefined) cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** ASCII whitespace (the whole of \s below code point 128), as a table. */
const WS_TABLE = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_TABLE[c] = 1;
/** Whether one character (outside ASCII) is whitespace. */
const WS_CHAR = /\s/;

/** How many words `line` holds: its runs of characters other than whitespace. */
function countWordsLine(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    const ws = c < 128 ? WS_TABLE[c] === 1 : WS_CHAR.test(line[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
export const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;
const TRAILING_WS = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and where its body starts, over the source's
 * lines: { data, bodyStart }, or { error } with the first reason it is
 * refused. The first line that fails is the one reported.
 */
export function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(TRAILING_WS, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const TRIM_LINE = /^[ \t]+|[ \t]+$/g;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return BLANK.test(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR.test(line);
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => line.replace(TRIM_LINE, '');

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
/** The next interesting character while rendering inline: a mark, or one the escape table names. */
const MARK = /[\\`*\[]|[&<>"']/g;
/** Whether a link target holds whitespace. */
const HAS_WS = /\s/;

/** The first index from `from` where `s` holds `what` outside a backslash escape (and inside `end`), or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j + what.length <= end; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape (and inside `end`), or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b]` rendered inline into `out`; `link(target)` is a link's href.
 * One regex walks the text and stops at the next mark or escapable
 * character, so a plain run is pushed whole instead of escaped one
 * character at a time, and nesting recurses on indices, never on slices.
 */
function inline(s, a, b, link, out) {
  let i = a;
  while (i < b) {
    MARK.lastIndex = i;
    const m = MARK.exec(s);
    const j = m !== null && m.index < b ? m.index : b;
    if (j > i) out.push(s.slice(i, j));
    if (j >= b) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        out.push(ESCAPES[s[j + 1]] ?? s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>');
          inline(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, b);
        if (k !== -1 && k > j + 1) {
          out.push('<em>');
          inline(s, j + 1, k, link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out.push(ESCAPES[c]);
      i = j + 1;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, b);
    if (k !== -1 && s[k + 1] === '(') {
      const m2 = s.indexOf(')', k + 2);
      if (m2 !== -1 && m2 < b) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !HAS_WS.test(target)) {
          out.push('<a href="', escapeHtml(link(target)), '">');
          inline(s, j + 1, k, link, out);
          out.push('</a>');
          i = m2 + 1;
          continue;
        }
      }
    }
    out.push('[');
    i = j + 1;
  }
}

/**
 * A body's lines from `start` rendered in one pass: its HTML (each block on
 * its own lines, a "\n" after the last), its table of contents (every level
 * 2 and 3 heading: level, id and its inline HTML), its excerpt (the first
 * paragraph's inline HTML, or "") and its word count. `link` resolves a
 * link's target; `slugCache` is the build's slug cache.
 */
function renderBody(lines, start, link, slugCache) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    words += countWordsLine(line);
    if (BLANK.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE.test(lines[i])) {
        words += countWordsLine(lines[i]);
        body.push(lines[i++]);
      }
      if (i < n) words += countWordsLine(lines[i]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      out.push(`<pre><code${cls}>`);
      for (const l of body) out.push(escapeHtml(l), '\n');
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const inner = [];
      inline(heading.text, 0, heading.text.length, link, inner);
      const html = inner.join('');
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      // The first line was already counted above; only the rest are counted here.
      const body = [line.replace(/^> ?/, '')];
      i++;
      while (i < n && QUOTE.test(lines[i])) {
        words += countWordsLine(lines[i]);
        body.push(lines[i++].replace(/^> ?/, ''));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        const inner = [];
        inline(joined, 0, joined.length, link, inner);
        out.push('<blockquote>\n<p>', inner.join(''), '</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      // The first line was already counted above; only the rest are counted here.
      const items = [[trimLine(isOrdered ? ordered[2] : bullet[1])]];
      i++;
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          words += countWordsLine(lines[i]);
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          words += countWordsLine(lines[i]);
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const startNo = isOrdered ? Number(ordered[1]) : 1;
      out.push(isOrdered && startNo !== 1 ? `<ol start="${startNo}">` : `<${tag}>`, '\n');
      for (const parts of items) {
        const text = parts.join('\n');
        const inner = [];
        inline(text, 0, text.length, link, inner);
        out.push('<li>', inner.join(''), '</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      words += countWordsLine(lines[i]);
      body.push(trimLine(lines[i++]));
    }
    const text = body.join('\n');
    const inner = [];
    inline(text, 0, text.length, link, inner);
    const html = inner.join('');
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) into `out`. `ctx` holds the
 * parsed templates (`templates`, a Map of name to nodes, a template that did
 * not parse absent), the HTML escape and the include depth.
 */
export function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template compilation

/** The value of `name` in the scope chain: the nearest scope holding it, or undefined. */
function lookupFirst(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** One step down a path: `v`'s own property `k`, or undefined. */
function seg(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/**
 * Compile a parsed template into a function
 *   fn(S, C, out, L, seg, txt, tru, D)
 * that renders it into `out`. S is the scope chain, C holds the compiled
 * templates and the escape, D the include depth. A name a for of this very
 * template binds is read from that for's own variable; any other first name
 * is read from the scope chain, exactly as the tree renderer reads it. The
 * function is built with new Function; a template that cannot compile falls
 * back to the tree renderer.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const parts = [];
  const expr = (path, env, loopJs, scopeVar) => {
    const first = path[0];
    let e = null;
    for (let i = env.length - 1; i >= 0; i--) {
      if (env[i].name === first) {
        e = env[i].js;
        break;
      }
    }
    if (e === null && first === 'loop' && loopJs !== null) e = loopJs;
    if (e === null) e = `L(${scopeVar},${JSON.stringify(first)})`;
    for (let k = 1; k < path.length; k++) e = `seg(${e},${JSON.stringify(path[k])})`;
    return e;
  };
  const emit = (list, env, loopJs, scopeVar) => {
    for (const n of list) {
      if (n.kind === 'text') {
        parts.push(`out.push(${JSON.stringify(n.text)});`);
        continue;
      }
      if (n.kind === 'var') {
        parts.push(`out.push(C.escape(txt(${expr(n.path, env, loopJs, scopeVar)})));`);
        continue;
      }
      if (n.kind === 'raw') {
        parts.push(`out.push(txt(${expr(n.path, env, loopJs, scopeVar)}));`);
        continue;
      }
      if (n.kind === 'if') {
        parts.push(`if(tru(${expr(n.path, env, loopJs, scopeVar)})!==${n.not}){`);
        emit(n.then, env, loopJs, scopeVar);
        parts.push('}');
        if (n.else !== null) {
          parts.push('else{');
          emit(n.else, env, loopJs, scopeVar);
          parts.push('}');
        }
        continue;
      }
      if (n.kind === 'for') {
        const id = uid++;
        const xs = `__x${id}`;
        const v = `__v${id}`;
        const l = `__l${id}`;
        const s = `__s${id}`;
        const head = `{const ${xs}=${expr(n.path, env, loopJs, scopeVar)};if(Array.isArray(${xs})){for(let __k${id}=0;__k${id}<${xs}.length;__k${id}++){const ${v}=${xs}[__k${id}];const ${l}={index:__k${id}+1,first:__k${id}===0,last:__k${id}===${xs}.length-1,length:${xs}.length};`;
        if (hasInclude(n.body)) {
          // An include below can read this for's variable through the chain,
          // so the for gets a scope of its own.
          parts.push(`${head}const ${s}={vars:{${JSON.stringify(n.name)}:${v},loop:${l}},parent:${scopeVar}};`);
          emit(n.body, [...env, { name: n.name, js: v }], l, s);
        } else {
          // No include below: nothing can read this for's variable except
          // its own body, which reads it from its variable, so no scope.
          parts.push(head);
          emit(n.body, [...env, { name: n.name, js: v }], l, scopeVar);
        }
        parts.push('}}}');
        continue;
      }
      const id = uid++;
      parts.push(`{const __t${id}=C.templates.get(${JSON.stringify(n.name)});if(__t${id}!==undefined&&D<8)__t${id}(${scopeVar},C,out,L,seg,txt,tru,D+1);}`);
    }
  };
  emit(nodes, [], null, 'S');
  return new Function('S', 'C', 'out', 'L', 'seg', 'txt', 'tru', 'D', parts.join(''));
}

/** Whether any include sits in `list` (through ifs and fors): only then can a template below read a for's variable. */
function hasInclude(list) {
  for (const n of list) {
    if (n.kind === 'include') return true;
    if (n.kind === 'if' && ((n.then && hasInclude(n.then)) || (n.else !== null && hasInclude(n.else)))) return true;
    if (n.kind === 'for' && hasInclude(n.body)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  const slugCache = new Map();
  const templateNodes = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templateNodes.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile every template that parsed; any failure at all falls back to
  // the tree renderer for the whole build.
  const templates = new Map();
  let compiled = true;
  for (const [name, nodes] of templateNodes) {
    try {
      templates.set(name, compileTemplate(nodes));
    } catch {
      compiled = false;
      break;
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    templateNodes,
    compiled,
    slugCache,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n";
  // a source that is not .md is static. Each source's lines are split once
  // here and shared by the front matter and the Markdown pass.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templateNodes.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, b.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (scheme.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
      b.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderBody(s.lines, s.bodyStart, link, b.slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once (the first spelling kept), in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, b.slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  /** A post's card, as lists show it; built once per source and shared. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cardCache = new Map();
  const card = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = cardOf(s);
      cardCache.set(s, c);
    }
    return c;
  };
  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...card(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, card(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctxCompiled = { templates: b.templates, escape: escapeHtml };
  const ctxTree = { templates: b.templateNodes, escape: escapeHtml };
  // One top-level scope, reused for every render of this build: rendering is
  // synchronous, so no render can see another's variables.
  const topScope = { vars: null, parent: null };
  const render = (name, V) => {
    topScope.vars = V;
    if (b.compiled) {
      const fn = b.templates.get(name);
      if (fn === undefined) return null;
      const out = [];
      fn(topScope, ctxCompiled, out, lookupFirst, seg, textOf, truthy, 0);
      return out.join('');
    }
    const nodes = b.templateNodes.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, topScope, ctxTree, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
