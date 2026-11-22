// A fast drop-in for makefun-site 1.0.0 (site-generator-speed-01): run(input) returns, for every input, exactly the
// output tree makefun-site 1.0.0's build returns, byte for byte — the same front matter, Markdown, template dialect,
// slug rule, link resolution and report — reimplemented as one dependency-free ES module engineered for low CPU time:
// char-code dispatch instead of per-line regexes, single-pass scanners, plain-run batching in the inline renderer,
// cached slug/date computations and no whole-body split in the front-matter reader.
//
// The reference's code is the spec; every quirk of it (check order, error text, sort order, uniqueness rule) is kept.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** HTML escape replacements by char code: & < > " ' (and nothing else). */
const ESC = new Array(128);
ESC[38] = '&amp;';
ESC[60] = '&lt;';
ESC[62] = '&gt;';
ESC[34] = '&quot;';
ESC[39] = '&#39;';

/** `text` with & < > " and ' escaped; the input itself when it holds none of them. */
function escapeHtml(text) {
  let out = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const rep = ESC[text.charCodeAt(i)];
    if (rep !== undefined) {
      if (out === null) out = '';
      out += text.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? text : out + text.slice(last);
}

const SLUG_MAX = 64;

/** The slug of `text`, uncached (see slugify): NFKD, marks dropped, A-Z lowered, runs of other chars one "-". */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  let end = out.length > SLUG_MAX ? SLUG_MAX : out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDateRaw(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether char code `c` is JavaScript whitespace (the \s class), for word counting and link targets. */
function isWs(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace (the ASCII members of \s tested inline). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || (c > 127 && isWs(c))) {
      inWord = false;
    } else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // starts with '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
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
      const m = FM_DATE.exec(raw);
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
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. Scans only the front matter's own lines; the body is one slice, never a whole-file split and rejoin.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // Find the closing --- line, collecting the lines between (the close is located before any line is judged).
  const fmLines = [];
  let pos = firstNl + 1;
  let bodyStart = -1;
  for (;;) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? text.length : e;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    fmLines.push(text.slice(pos, lineEnd));
    if (e === -1) break;
    pos = e + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    // blank (spaces and tabs only) or a comment
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of a-z and _, a colon, then end of line or one space and the value
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    let raw = null;
    if (j > 0 && line.charCodeAt(j) === 58) {
      if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    }
    if (raw === null) return { error: `line ${k + 2} is not "key: value"` };
    const key = line.slice(0, j);
    // the value's trailing spaces and tabs dropped
    let re = raw.length;
    while (re > 0 && (raw.charCodeAt(re - 1) === 32 || raw.charCodeAt(re - 1) === 9)) re--;
    if (re !== raw.length) raw = raw.slice(0, re);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-opening line's language, or null: three backticks, language chars, then spaces or tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const langEnd = j;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else break;
  }
  return j === line.length ? line.slice(3, langEnd) : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (1 to 6 #, at least one space or tab, non-empty text, ends trimmed). */
function headingOf(line) {
  let c = 0;
  while (line.charCodeAt(c) === 35) c++;
  if (c === 0 || c > 6) return null;
  const ch = line.charCodeAt(c);
  if (ch !== 32 && ch !== 9) return null;
  let s = c;
  while (s < line.length) {
    const cc = line.charCodeAt(s);
    if (cc === 32 || cc === 9) s++;
    else break;
  }
  let e = line.length;
  while (e > s) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e <= s) return null;
  return { depth: c, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (!((c === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) || (c === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A line as paragraphs and list items render it: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e) {
    const c = line.charCodeAt(s);
    if (c === 32 || c === 9) s++;
    else break;
  }
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** Whether `line` continues a list item: two or more spaces then a non-space character. */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWs(line.charCodeAt(j));
}

/** A bullet item's content from `line` ("- " or "* "), or null. */
function bulletContent(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item's number and content from `line` ("<1-9 digits>. "), or null. */
function orderedContent(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0 || d > 9 || line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: Number(line.slice(0, d)), content: line.slice(d + 2) };
}

/** The characters a backslash escapes, by char code. */
const ESCAPABLE = new Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = true;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  const w0 = what.charCodeAt(0);
  for (let j = from; j <= s.length - wlen; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === true) {
      j++;
      continue;
    }
    if (c === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === true) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds a whitespace character (the \s class a link target must not hold). */
function hasSpace(s) {
  for (let i = 0; i < s.length; i++) if (isWs(s.charCodeAt(i))) return true;
  return false;
}

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs are copied in bulk between specials. */
function inline(s, env) {
  const len = s.length;
  let out = '';
  let i = 0;
  while (i < len) {
    // a run of plain characters: not a construct opener and not in the escape table
    let run = i;
    while (run < len) {
      const c = s.charCodeAt(run);
      if (c === 92 || c === 96 || c === 42 || c === 91 || ESC[c] !== undefined) break;
      run++;
    }
    if (run > i) {
      out += s.slice(i, run);
      i = run;
      if (i >= len) break;
    }
    const c = s.charCodeAt(i);
    if (c === 38) {
      out += '&amp;';
      i++;
    } else if (c === 60) {
      out += '&lt;';
      i++;
    } else if (c === 62) {
      out += '&gt;';
      i++;
    } else if (c === 34) {
      out += '&quot;';
      i++;
    } else if (c === 39) {
      out += '&#39;';
      i++;
    } else if (c === 92) {
      if (i + 1 < len && ESCAPABLE[s.charCodeAt(i + 1)] === true) {
        const n = s[i + 1];
        out += n === '>' ? '&gt;' : n;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
    } else if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
    } else if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasSpace(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
      } else {
        out += '[';
        i++;
      }
    } else {
      // unreachable for the codes that break a run; kept so every character has the reference's answer
      out += escapeHtml(s[i]);
      i++;
    }
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or ""). Lexing and
 * rendering are fused into one pass over the lines; `slugify` is the build's cached slug function.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      let buf = '';
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        buf += escapeHtml(lines[i]) + '\n';
        i++;
      }
      i++;
      parts.push(lang === '' ? `<pre><code>${buf}</code></pre>\n` : `<pre><code class="language-${escapeHtml(lang)}">${buf}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const stripped = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      parts.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bc = bulletContent(line);
    const oc = bc === null ? orderedContent(line) : null;
    if (bc !== null || oc !== null) {
      const ordered = oc !== null;
      const items = [];
      let start = 1;
      let first = true;
      while (i < n) {
        const l = lines[i];
        const om = ordered ? orderedContent(l) : null;
        const content = ordered ? (om === null ? null : om.content) : bulletContent(l);
        if (content !== null) {
          if (first) {
            start = ordered ? om.num : 1;
            first = false;
          }
          items.push([trimLine(content)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let buf = `${open}\n`;
      for (const parts2 of items) buf += `<li>${inline(parts2.join('\n'), env)}</li>\n`;
      parts.push(`${buf}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` is nothing but spaces and tabs. */
function onlyBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
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
    const standalone = onlyBlank(src.slice(lineStart, open)) && onlyBlank(src.slice(end, lineEnd));
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
function parseTemplate(name, src) {
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
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
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
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
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
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), appending to `out`. `ctx` holds the templates and the escape. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
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
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
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

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

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

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's for the same input. */
export function run(input) {
  // per-build caches: slugs and long dates repeat heavily across a site's titles, tags and headings
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const dateCache = new Map();
  const longDate = (date) => {
    let v = dateCache.get(date);
    if (v === undefined) {
      v = longDateRaw(date);
      dateCache.set(date, v);
    }
    return v;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      return set;
    };
    for (const s of kept) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    // a body's links come from a small set of targets repeated many times; resolve each once per source
    // (a repeated broken target re-adds the same line to a Set, which is the reference's outcome too)
    const linkCache = new Map();
    const env = {
      link: (target) => {
        let v = linkCache.get(target);
        if (v !== undefined) return v;
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) {
          v = target;
        } else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) v = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) v = `${base}/${path}${frag}`;
          else {
            broken.add(`broken-link ${s.path} -> ${target}`);
            v = target;
          }
        }
        linkCache.set(target, v);
        return v;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const list = s.data.tags ?? [];
    const out = [];
    for (const name of list) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
