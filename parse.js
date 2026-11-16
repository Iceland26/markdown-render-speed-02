// A fast, dependency-free Markdown renderer that produces exactly the HTML
// marked 18.1.3 produces with default options (GFM enabled), written from
// scratch for the make.fun markdown-render-speed-02 bounty.
//
// Design: a chunk-style block parser (fences, ATX/setext headings, thematic
// breaks, block quotes, lists, tables, HTML blocks, link reference
// definitions, indented code, paragraphs) builds a small block tree while
// collecting link reference definitions document-wide; a second pass renders
// the tree, running a scanner + delimiter-stack inline parser per text span.

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape a raw string the way marked escapes code content: every & < > " '.
function escapeCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape an attribute value (href, title, alt, lang): & < > " ' are escaped,
// except an & that begins an entity-looking reference, which marked leaves.
const ATTR_ENTITY_RE = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/;
function escapeAttr(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      if (ATTR_ENTITY_RE.test(s.slice(i, i + 40))) continue;
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    } else if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += s.slice(start, i) + ESC_MAP[c]; start = i + 1;
    }
  }
  return out + s.slice(start);
}

const NAMED_ENTITY_RE = /^&\w+;/;

// Escape paragraph text: like escapeCode, except an & that begins an
// entity-looking reference (&word;) is left alone. Numeric references never
// reach this function (the inline scanner decodes them into plain characters
// first); named ones are emitted as raw nodes by the scanner, so in practice
// only stray & characters are handled here.
function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const m = NAMED_ENTITY_RE.exec(s.slice(i, i + 40));
      if (m) { out += s.slice(start, i) + m[0]; i += m[0].length - 1; start = i + 1; }
      else { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    } else if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += s.slice(start, i) + ESC_MAP[c]; start = i + 1;
    }
  }
  return out + s.slice(start);
}

// marked's cleanUrl: percent-encode the href (URI encoding, but a literal %
// is kept as %, and [ ] are encoded too).
function cleanUrl(href) {
  try {
    let out = encodeURI(href).replace(/%25/g, '%');
    if (out.indexOf('[') !== -1) out = out.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    return out;
  } catch {
    return href;
  }
}

function escapeHref(href) {
  return escapeAttr(href);
}

// ---------------------------------------------------------------------------
// Small character helpers
// ---------------------------------------------------------------------------

function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const WS_RE = /\s/;
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n'; }

// Unicode punctuation test for flanking rules (ASCII fast path first).
// marked treats symbols (currency, math) as punctuation here too.
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  if (ch === undefined) return false;
  if (isAsciiPunct(ch)) return true;
  if (ch.charCodeAt(0) < 128) return false;
  return PUNCT_RE.test(ch);
}

function isWs(ch) {
  if (ch === undefined) return true;
  return WS_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Line / tab machinery (columns are tab-aware, tab stops every 4)
// ---------------------------------------------------------------------------

// Columns of leading whitespace in `line` starting at offset `from`, and the
// offset just past it.
function leadingIndent(line, from) {
  let cols = 0, i = from;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { cols += 1; i++; }
    else if (c === '\t') { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, end: i };
}

// Remove up to `cols` columns of indentation from the start of `line`
// (starting at offset `from`). A partially consumed tab leaves spaces.
// Returns the remaining string.
function stripColumns(line, from, cols) {
  let i = from, remaining = cols, col = 0;
  while (remaining > 0 && i < line.length) {
    const c = line[i];
    if (c === ' ') { i++; remaining--; col++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (w <= remaining) { i++; remaining -= w; col += w; }
      else {
        // partial tab: remainder becomes spaces
        return ' '.repeat(w - remaining) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Parse a link destination starting at s[pos]: either <...> or a bare run
// with balanced parentheses. Returns { href, end } or null.
function scanDest(s, pos, inDef) {
  const n = s.length;
  if (pos < n && s[pos] === '<') {
    let i = pos + 1;
    while (i < n) {
      const c = s[i];
      if (c === '>') return { href: s.slice(pos + 1, i), end: i + 1 };
      if (c === '\n' || c === '<') return null;
      if (c === '\\' && i + 1 < n) i++;
      i++;
    }
    return null;
  }
  let i = pos, depth = 0;
  const start = pos;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(s[i + 1])) { i += 2; continue; }
    if (c <= ' ') break;
    if (c === '(') { depth++; }
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  if (depth !== 0) return null;
  if (i === start) return null;
  return { href: unescapePunct(s.slice(start, i)), end: i };
}

function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// Parse a title at s[pos]: "..." or '...' or (...). Returns { title, end }.
function scanTitle(s, pos) {
  const n = s.length;
  const open = s[pos];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let i = pos + 1;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) { i += 2; continue; }
    if (c === close) {
      const title = s.slice(pos + 1, i);
      if (/\n[ \t]*\n/.test(title)) return null; // titles cannot span a blank line
      return { title: unescapePunct(title), end: i + 1 };
    }
    if (open === '(' && c === '(') return null;
    i++;
  }
  return null;
}

// Skip spaces/tabs and at most one newline (with following indent) in s.
function skipInlineWs(s, pos, allowNewline) {
  let i = pos;
  let sawNl = false;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') i++;
    else if (c === '\n' && allowNewline && !sawNl) { sawNl = true; i++; }
    else break;
  }
  return i;
}

// Try to parse a link reference definition at the start of text `s` (which
// begins at a line start). On success returns { end } where end is the index
// just past the definition's final newline (or EOF), and registers the def.
function scanDef(s, refs) {
  const n = s.length;
  let i = 0;
  let ind = 0;
  while (i < n && s[i] === ' ' && ind < 4) { i++; ind++; }
  if (ind > 3) return null;
  if (s[i] === '\t') return null;
  if (s[i] !== '[') return null;
  let j = i + 1;
  let labelEnd = -1;
  while (j < n && j - i <= 1000) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { labelEnd = j; break; }
    j++;
  }
  if (labelEnd === -1) return null;
  const rawLabel = s.slice(i + 1, labelEnd);
  if (rawLabel.trim() === '') return null;
  j = labelEnd + 1;
  if (s[j] !== ':') return null;
  j++;
  j = skipInlineWs(s, j, true);
  const dest = scanDest(s, j, true);
  if (!dest) return null;
  j = dest.end;
  let title = null;
  const afterDest = j;
  const k = skipInlineWs(s, j, true);
  if (k !== afterDest && k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    // a title is attempted: if it parses and ends the line, it is the title
    const t = scanTitle(s, k);
    let okTitle = false;
    if (t) {
      let m = t.end;
      while (m < n && (s[m] === ' ' || s[m] === '\t')) m++;
      if (m >= n || s[m] === '\n') {
        title = t.title;
        j = m;
        okTitle = true;
      }
    }
    if (!okTitle) {
      // a failed title on the destination's own line invalidates the whole
      // definition; one starting on a later line falls back to a title-less
      // definition that ends at the destination line
      if (!s.slice(afterDest, k).includes('\n')) return null;
      j = afterDest;
    }
  }
  if (title === null) {
    let m = afterDest;
    while (m < n && (s[m] === ' ' || s[m] === '\t')) m++;
    if (m < n && s[m] !== '\n') return null;
    j = m;
  }
  if (j < n && s[j] === '\n') j++;
  const label = normalizeLabel(rawLabel);
  if (!refs.has(label)) refs.set(label, { href: dest.href, title });
  return { end: j };
}

// ---------------------------------------------------------------------------
// Block parsing. Works on arrays of lines (no trailing \n in each line).
// Node shapes:
//   {t:'heading', level, text}   {t:'para', text}      {t:'code', text, lang}
//   {t:'html', text}             {t:'hr'}              {t:'quote', children}
//   {t:'list', ordered, start, loose, items}           {t:'table', header, align, rows}
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const RAW_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

// Expand the leading whitespace run of line starting at offset i (whose
// original column is `col`): each tab becomes the spaces to the next tab
// stop. The rest of the line is verbatim.
function expandLeading(line, i, col) {
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + line.slice(i);
}

// Consume `cols` columns of whitespace starting at offset `offset` (whose
// original column is `col`), then expand the remainder's leading whitespace
// run by original columns. Used for container prefixes (quote markers, list
// indentation): a partially consumed tab leaves spaces.
function stripFrom(line, offset, col, cols) {
  let i = offset, remaining = cols;
  while (remaining > 0 && i < line.length) {
    const c = line[i];
    if (c === ' ') { i++; col++; remaining--; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (w <= remaining) { i++; col += w; remaining -= w; }
      else {
        const out = ' '.repeat(w - remaining);
        return out + expandLeading(line, i + 1, col + w);
      }
    } else break;
  }
  return expandLeading(line, i, col);
}

// Does `line` begin a complete HTML tag (open or close) at offset 0? Returns
// the index just past `>` or -1. Tag syntax per CommonMark.
function scanTagEnd(s) {
  let i = 0;
  let closing = false;
  if (s[i] === '/') { closing = true; i++; }
  if (i >= s.length || !/[a-zA-Z]/.test(s[i])) return -1;
  i++;
  while (i < s.length && /[a-zA-Z0-9-]/.test(s[i])) i++;
  if (closing) {
    // a closing tag allows only whitespace before '>'
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
    return s[i] === '>' ? i + 1 : -1;
  }
  // attributes
  for (;;) {
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j >= s.length) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (j === i) return -1; // attributes must be preceded by whitespace
    // attribute name
    if (!/[a-zA-Z_:]/.test(s[j])) return -1;
    j++;
    while (j < s.length && /[a-zA-Z0-9_.:-]/.test(s[j])) j++;
    // optional value
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (s[k] === '=') {
      k++;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= s.length) return -1;
      const q = s[k];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, k + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        if (/[\s"'=<>`]/.test(q)) return -1;
        while (k < s.length && !/[\s"'=<>`]/.test(s[k])) k++;
        j = k;
      }
    }
    i = j;
  }
}

// Classify an HTML block start on this line (indent already known <= 3).
// Returns { kind, tag } or null. kind: 'raw' | 'comment' | 'pi' | 'decl' |
// 'cdata' | 'tag' (blank-line terminated).
function htmlBlockStart(line, indEnd) {
  const rest = line.slice(indEnd);
  if (rest.charCodeAt(0) !== 60) return null; // '<'
  if (rest.startsWith('<!--')) return { kind: 'comment' };
  if (rest.startsWith('<?')) return { kind: 'pi' };
  if (rest.startsWith('<![CDATA[')) return { kind: 'cdata' };
  if (/^<![A-Z]/.test(rest)) return { kind: 'decl' };
  const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  if (RAW_TAGS.has(tag) && rest[1] !== '/') {
    // raw text element: the char after the tag name must be ws, '>' or '/>'... or EOL
    const after = rest[m[0].length];
    if (after === undefined || after === ' ' || after === '\t' || after === '>' || (after === '/' )) return { kind: 'raw', tag };
    return null;
  }
  if (BLOCK_TAGS.has(tag)) {
    const after = rest[m[0].length];
    if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') return { kind: 'tag' };
    return null;
  }
  // type 7: a complete tag, alone on the line (only whitespace after it)
  const end = scanTagEnd(rest.slice(1));
  if (end === -1) return null;
  const after = rest.slice(1 + end);
  if (/^[ \t]*$/.test(after)) return { kind: 'tag' };
  return null;
}

function matchFence(line, ind) {
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.end);
  const c = rest[0];
  if (c !== '`' && c !== '~') return null;
  let len = 0;
  while (len < rest.length && rest[len] === c) len++;
  if (len < 3) return null;
  const info = rest.slice(len).trim();
  if (c === '`' && info.indexOf('`') !== -1) return null;
  return { ch: c, len, info, indent: ind.cols, indentChars: ind.end };
}

function matchAtx(line, ind) {
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.end);
  let len = 0;
  while (len < rest.length && rest[len] === '#') len++;
  if (len === 0 || len > 6) return null;
  const after = rest[len];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let content = rest.slice(len).replace(/[ \t]+$/, '');
  content = content.replace(/^[ \t]+/, '');
  if (!/^#+$/.test(content)) {
    content = content.replace(/[ \t]+#+$/, (m, off, s) => {
      // a closing sequence cannot be escaped: check char before the spaces
      return m; // handled below by re-check
    });
    // strip closing sequence: spaces + #'s at end, where the # run is not
    // immediately preceded by a backslash
    const cm = /[ \t]+(#+)$/.exec(content);
    if (cm) {
      const before = content.slice(0, cm.index);
      if (!before.endsWith('\\')) content = before.replace(/[ \t]+$/, '');
    }
  } else {
    content = '';
  }
  return { level: len, text: content };
}

function isHr(line, ind) {
  if (ind.cols > 3) return false;
  const rest = line.slice(ind.end);
  let ch = '', count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '-' && c !== '*' && c !== '_') return false;
    if (ch === '') ch = c;
    else if (c !== ch) return false;
    count++;
  }
  return count >= 3;
}

function setextLevel(line, ind) {
  if (ind.cols > 3) return 0;
  const rest = line.slice(ind.end);
  const c = rest[0];
  if (c !== '=' && c !== '-') return 0;
  for (let i = 1; i < rest.length; i++) {
    const x = rest[i];
    if (x === c) continue;
    if (x === ' ' || x === '\t') {
      // only trailing whitespace allowed
      for (let j = i; j < rest.length; j++) if (rest[j] !== ' ' && rest[j] !== '\t') return 0;
      return c === '=' ? 1 : 2;
    }
    return 0;
  }
  return c === '=' ? 1 : 2;
}

// Parse a list-item marker at the start of `line` (indent <= 3).
// Returns { ordered, bullet, delim, num, markerEndCol, contentIndent, contentCol0 } or null.
function matchListItem(line, ind) {
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.end);
  let ordered = false, bullet = '', delim = '', num = 0, mlen = 0;
  const c = rest[0];
  if (c === '-' || c === '+' || c === '*') {
    bullet = c; mlen = 1;
  } else if (c >= '0' && c <= '9') {
    let j = 0;
    while (j < rest.length && rest[j] >= '0' && rest[j] <= '9') j++;
    if (j > 9) return null;
    if (rest[j] !== '.' && rest[j] !== ')') return null;
    ordered = true; delim = rest[j]; num = parseInt(rest.slice(0, j), 10); mlen = j + 1;
  } else return null;
  // the marker must be followed by a space, a tab, or the end of the line
  const afterMarker = rest[mlen];
  if (afterMarker !== undefined && afterMarker !== ' ' && afterMarker !== '\t') return null;
  const markerEndCol = ind.cols + mlen;
  // whitespace after the marker, in columns from marker end
  let k = ind.end + mlen, col = markerEndCol, wsCols = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { wsCols++; col++; }
    else { const w = 4 - (col % 4); wsCols += w; col += w; }
    k++;
  }
  const hasContent = k < line.length;
  let contentIndent;
  if (!hasContent || wsCols > 4) contentIndent = markerEndCol + 1;
  else contentIndent = markerEndCol + wsCols;
  return { ordered, bullet, delim, num, markerEndCol, markerEndOffset: ind.end + mlen, contentIndent, hasContent };
}

function sameList(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (a.ordered) return a.delim === b.delim;
  return a.bullet === b.bullet;
}

// Split a table row into trimmed cells. Pipes escaped with a backslash do
// not split; code spans do NOT protect pipes (marked splits blindly there).
function splitRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const s = line;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  // drop phantom cells from leading/trailing pipes
  const trimmedLine = line.trim();
  if (cells.length > 1 && cells[0].trim() === '' && trimmedLine.startsWith('|')) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && /(^|[^\\])\|$/.test(trimmedLine)) cells.pop();
  return cells.map(c => c.trim());
}

function parseDelimiter(line) {
  // must contain at least one unescaped pipe
  if (!/(^|[^\\])\|/.test(line)) return null;
  const cells = splitRow(line);
  const align = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':'), right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return null;
  const ind = leadingIndent(lines[i], 0);
  if (ind.cols > 3) return null;
  const align = parseDelimiter(lines[i + 1]);
  if (!align) return null;
  const header = splitRow(lines[i]);
  if (header.length !== align.length) return null;
  return { header, align };
}

// Lines that stop a table's body rows.
function isTableRowStop(lines, i) {
  const line = lines[i];
  // a line of only spaces ending in one tab is an (empty) row in marked
  if (/^ *\t$/.test(line)) return false;
  if (isBlank(line)) return true;
  const ind = leadingIndent(line, 0);
  if (ind.cols >= 4) return true;
  if (matchFence(line, ind)) return true;
  if (matchAtx(line, ind)) return true;
  if (isHr(line, ind)) return true;
  if (ind.cols <= 3) {
    const rest = line.slice(ind.end);
    if (rest.startsWith('>')) return true;
    if (matchListItem(line, ind)) return true;
    if (htmlBlockStart(line, ind.end)) return true;
  }
  return false;
}

function parseTable(lines, i, start, endsWithNl) {
  const rows = [];
  let j = i + 2;
  while (j < lines.length && !isTableRowStop(lines, j)) {
    // a tab-only line at the very end of the source (no trailing newline)
    // does not form a row in marked
    if (j === lines.length - 1 && !endsWithNl && /^ *\t$/.test(lines[j])) break;
    const cells = splitRow(lines[j]);
    while (cells.length < start.header.length) cells.push('');
    rows.push(cells.slice(0, start.header.length));
    j++;
  }
  return { node: { t: 'table', header: start.header, align: start.align, rows }, end: j };
}

// Can this line start a block that interrupts a paragraph?
function interruptsParagraph(lines, i, inItem) {
  const line = lines[i];
  const ind = leadingIndent(line, 0);
  if (ind.cols <= 3) {
    if (matchFence(line, ind)) return true;
    if (matchAtx(line, ind)) return true;
    if (isHr(line, ind)) return true;
    const rest = line.slice(ind.end);
    if (rest.startsWith('>')) return true;
    const li = matchListItem(line, ind);
    if (li && li.hasContent) {
      // inside a list item, marked lets any ordered item interrupt too
      if (!li.ordered || li.num === 1 || inItem) return true;
    }
    const hb = htmlBlockStart(line, ind.end);
    if (hb && hb.kind !== 'tag') return true;
    if (hb && hb.kind === 'tag') {
      // only type-6 (block tags) interrupt; htmlBlockStart returns 'tag' for
      // both — distinguish by tag name
      const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
      if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return true;
    }
  }
  return false;
}

// Gather a paragraph starting at lines[i]; handles setext conversion and
// table conversion. Returns { nodes, end }.
function parseParagraph(lines, i, refs, noSetext, textLines, inItem, docTail, endsWithNl) {
  const paraLines = [lines[i]];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      // a whitespace-only final line with no trailing newline joins the
      // paragraph in marked (it cannot form a space token)
      if (docTail && j === lines.length - 1) { paraLines.push(line); j++; }
      break;
    }
    // a forced paragraph-text line (lazy/deep container continuation):
    // never a block start, setext underline, or table delimiter
    if (textLines && textLines.has(j)) { paraLines.push(line); j++; continue; }
    const ind = leadingIndent(line, 0);
    const sl = setextLevel(line, ind);
    if (sl && !(noSetext && noSetext.has(j))) {
      const text = paraLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      return { nodes: [{ t: 'heading', level: sl, text }], end: j + 1 };
    }
    // table: this line is a delimiter row and the last paragraph line is the header
    const align = parseDelimiter(line);
    if (align) {
      const header = splitRow(paraLines[paraLines.length - 1]);
      if (header.length === align.length) {
        const nodes = [];
        if (paraLines.length > 1) nodes.push({ t: 'para', text: paraLines.slice(0, -1).join('\n') });
        const t = parseTable(lines, j - 1, { header, align }, endsWithNl);
        nodes.push(t.node);
        return { nodes, end: t.end };
      }
    }
    if (interruptsParagraph(lines, j, inItem)) break;
    // table starting at this line (it is the header, next line the delimiter)
    if (isTableStart(lines, j)) break;
    // in a list item, marked lexes an indented (>= 4 cols) continuation
    // line as an indented code token and merges it into the text token
    // with 4 columns stripped (blockquote children keep the indent)
    if (inItem && ind.cols >= 4) { paraLines.push(stripFrom(line, 0, 0, 4)); j++; continue; }
    paraLines.push(line);
    j++;
  }
  return { nodes: [{ t: 'para', text: paraLines.join('\n') }], end: j };
}

// Consume an HTML block starting at lines[i]. Returns { node, end }.
function parseHtmlBlock(lines, i, endsWithNl) {
  const line = lines[i];
  const ind = leadingIndent(line, 0);
  const start = htmlBlockStart(line, ind.end);
  let j = i;
  if (start.kind === 'raw') {
    const close = '</' + start.tag;
    while (j < lines.length) {
      if (lines[j].toLowerCase().includes(close)) { j++; break; }
      j++;
    }
    if (j === i) j = i + 1;
  } else if (start.kind === 'comment') {
    while (j < lines.length) {
      if (lines[j].includes('-->')) { j++; break; }
      j++;
    }
    if (j === i) j = i + 1;
  } else if (start.kind === 'pi') {
    while (j < lines.length) {
      if (lines[j].includes('?>')) { j++; break; }
      j++;
    }
    if (j === i) j = i + 1;
  } else if (start.kind === 'cdata') {
    while (j < lines.length) {
      if (lines[j].includes(']]>')) { j++; break; }
      j++;
    }
    if (j === i) j = i + 1;
  } else if (start.kind === 'decl') {
    while (j < lines.length) {
      if (lines[j].includes('>')) { j++; break; }
      j++;
    }
    if (j === i) j = i + 1;
  } else {
    // 'tag': until blank line
    j = i;
    while (j < lines.length && !isBlank(lines[j])) j++;
  }
  const last = j - 1;
  let text = lines.slice(i, j).join('\n');
  // Trailing newline: the block keeps the line terminator of its last line.
  // For scan-terminated kinds (comment/raw/pi/cdata/decl) it is suppressed
  // only when the following line is exactly empty; for 'tag' blocks (which
  // run until a blank line) a following blank line suppresses it.
  const hasTerm = last < lines.length - 1 || endsWithNl;
  const nextLine = last + 1 < lines.length ? lines[last + 1] : null;
  const suppress = start.kind === 'tag'
    ? (nextLine !== null && isBlank(nextLine))
    : nextLine === '';
  if (hasTerm && !suppress) text += '\n';
  return { node: { t: 'html', text }, end: j };
}

// Try a link reference definition at lines[i] (only when it starts a block).
// Returns the line index just past the definition, or -1.
function tryDef(lines, i, refs) {
  const line = lines[i];
  const ind = leadingIndent(line, 0);
  if (ind.cols > 3) return -1;
  const rest = line.slice(ind.end);
  if (rest[0] !== '[') return -1;
  const seg = lines.slice(i, i + 10).join('\n');
  const r = scanDef(seg, refs);
  if (!r) return -1;
  // lines consumed = number of newlines in seg.slice(0, r.end), plus handling:
  // scanDef's end is just past the trailing newline when present.
  const consumed = seg.slice(0, r.end);
  const nlCount = (consumed.match(/\n/g) || []).length;
  if (r.end < seg.length || consumed.endsWith('\n')) return i + nlCount;
  // consumed to the very end of the segment without trailing newline: only
  // valid if the segment reached the true end of input lines.
  if (i + 10 >= lines.length) return i + nlCount + 1;
  return -1;
}

// Strip nested container prefixes (quote markers, list markers) from a
// line to find its core content line — used for laziness bookkeeping.
function deepStripCoreD(line) {
  let cur = line;
  let strips = 0;
  for (let depth = 0; depth < 8; depth++) {
    const ind = leadingIndent(cur, 0);
    if (ind.cols <= 3 && cur[ind.end] === '>') {
      const after = ind.end + 1;
      const hasWs = after < cur.length && (cur[after] === ' ' || cur[after] === '\t');
      cur = stripFrom(cur, after, ind.cols + 1, hasWs ? 1 : 0);
      strips++;
      continue;
    }
    const li = matchListItem(cur, ind);
    if (li) {
      cur = stripFrom(cur, li.markerEndOffset, li.markerEndCol, li.contentIndent - li.markerEndCol);
      strips++;
      continue;
    }
    return [cur, strips];
  }
  return [cur, strips];
}

function deepStripCore(line) {
  let cur = line;
  for (let depth = 0; depth < 8; depth++) {
    const ind = leadingIndent(cur, 0);
    if (ind.cols <= 3 && cur[ind.end] === '>') {
      const after = ind.end + 1;
      const hasWs = after < cur.length && (cur[after] === ' ' || cur[after] === '\t');
      cur = stripFrom(cur, after, ind.cols + 1, hasWs ? 1 : 0);
      continue;
    }
    const li = matchListItem(cur, ind);
    if (li) {
      cur = stripFrom(cur, li.markerEndOffset, li.markerEndCol, li.contentIndent - li.markerEndCol);
      continue;
    }
    return cur;
  }
  return cur;
}

function parseBlockquote(lines, i, refs, endsWithNl) {
  const inner = [];
  const noSetext = new Set();
  let j = i;
  let inFence = null; // {ch, len} when the inner text has an unclosed fence
  let inFenceDepth = 0; // container depth at which that fence opened
  let lastInnerKind = 'other'; // for laziness: 'para' | 'other'
  let lastWasLazy = false;
  while (j < lines.length) {
    const line = lines[j];
    const ind = leadingIndent(line, 0);
    if (ind.cols <= 3 && line[ind.end] === '>') {
      // strip '>' plus one optional column of following whitespace
      const after = ind.end + 1;
      const hasWs = after < line.length && (line[after] === ' ' || line[after] === '\t');
      const stripped = stripFrom(line, after, ind.cols + 1, hasWs ? 1 : 0);
      inner.push(stripped);
      lastWasLazy = false;
      // track fence state / last block kind for laziness decisions, looking
      // through nested containers (a paragraph may be open at any depth);
      // a fence opened inside a nested container stops mattering once a
      // line arrives from a shallower depth (that container has ended)
      const [core, coreDepth] = deepStripCoreD(stripped);
      const sind = leadingIndent(core, 0);
      const f = matchFence(core, sind);
      if (inFence && coreDepth < inFenceDepth) inFence = null;
      if (inFence) {
        if (f && f.ch === inFence.ch && f.len >= inFence.len && f.info === '') inFence = null;
        lastInnerKind = 'other';
      } else if (f) {
        inFence = { ch: f.ch, len: f.len };
        inFenceDepth = coreDepth;
        lastInnerKind = 'other';
      } else if (isBlank(core)) {
        lastInnerKind = 'other';
      } else if (lineStartsBlock(core)) {
        lastInnerKind = 'other';
      } else {
        lastInnerKind = 'para';
      }
      j++;
      continue;
    }
    if (isBlank(line)) break;
    // marked quirk: a setext-underline-shaped line can be a lazy paragraph
    // line inside a quote (never a heading there) — unless it is a thematic
    // break (---) or a lone '-' (a list item), which stay outside.
    const sl = setextLevel(line, ind);
    if (sl && lastInnerKind === 'para' && !inFence && !isHr(line, ind) && !(line.trim() === '-')) {
      noSetext.add(inner.length);
      if (lastWasLazy) {
        inner.push('    ' + line.replace(/^[ \t]+/, ''));
      } else {
        inner.push(line);
      }
      lastWasLazy = true;
      j++;
      continue;
    }
    // lazy continuation: only for an open inner paragraph, and the line must
    // not itself start an interrupting block; marked strips 4 columns from
    // deeply-indented lazy lines
    if (inner.length > 0 && lastInnerKind === 'para' && !inFence && !interruptsParagraph(lines, j) && !sl) {
      noSetext.add(inner.length);
      inner.push(ind.cols >= 4 ? stripFrom(line, 0, 0, 4) : line);
      lastWasLazy = true;
      j++;
      continue;
    }
    break;
  }
  const children = parseBlocks(inner, refs, false, noSetext, null, noSetext);
  // marked quirk: a final whitespace-only inner line (e.g. from '>  ') joins
  // the quote's last paragraph instead of acting as a blank separator
  const lastInner = inner[inner.length - 1];
  if (lastInner !== undefined && lastInner !== '' && isBlank(lastInner) && children.length) {
    const prev = inner[inner.length - 2];
    const last = children[children.length - 1];
    if (last.t === 'para' && prev !== undefined && !isBlank(prev)) last.text += '\n' + lastInner;
  }
  return { node: { t: 'quote', children }, end: j };
}

// Does this (already container-stripped) line start a non-paragraph block?
// Used to track whether a list item / quote currently ends in an open
// paragraph for laziness and deep-line decisions.
function lineStartsBlock(line) {
  const ind = leadingIndent(line, 0);
  if (ind.cols >= 4) return true;
  if (matchFence(line, ind) || matchAtx(line, ind) || isHr(line, ind)) return true;
  if (line[ind.end] === '>') return true;
  if (matchListItem(line, ind)) return true;
  if (htmlBlockStart(line, ind.end)) return true;
  return false;
}

// Fence content: drop exactly one trailing empty line, then the content
// keeps a single trailing newline when any line remains.
// marked's fence indent compensation: remove up to `count` whitespace
// CHARACTERS (spaces or tabs) from the start of a content line.
function stripWsChars(line, count) {
  let i = 0;
  while (i < line.length && i < count && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

function fenceText(content) {
  const ls = content.slice();
  if (ls.length && ls[ls.length - 1] === '') ls.pop();
  return ls.length ? ls.join('\n') + '\n' : '';
}

// marked's list-item gathering breaks: a block begin (fence, heading, html,
// quote, any list marker, hr) at an indent below the item's content indent
// ends the item. Regexes are cached per content indent.
const listBeginCache = new Map();
function listBegins(ci) {
  let b = listBeginCache.get(ci);
  if (b) return b;
  const p = '^ {0,' + Math.min(Math.max(0, ci - 1), 3) + '}';
  const tags = [...BLOCK_TAGS].join('|');
  b = {
    fence: new RegExp(p + '(?:```|~~~)'),
    heading: new RegExp(p + '#{1,6}(?:\\s|$)'),
    html: new RegExp(p + '(?:</?(?:' + tags + ')(?: +|$|/?>)|<(?:script|pre|style|textarea)(?:[\\s>]|$)|<!--|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'),
    quote: new RegExp(p + '>'),
    bullet: new RegExp(p + '(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)'),
    hr: new RegExp(p + '((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})$'),
  };
  listBeginCache.set(ci, b);
  return b;
}
function itemBeginBreak(line, ci) {
  const b = listBegins(ci);
  return b.fence.test(line) || b.heading.test(line) || b.html.test(line) ||
    b.quote.test(line) || b.bullet.test(line) || b.hr.test(line);
}
// Does the previous gathered (already-stripped) item line force a break
// before a dedented line? (blank handled separately; deep indent or a
// fence/heading/html/hr begin does)
function prevLineBreak(m, ci) {
  const expanded = m.replace(/\t/g, '    ');
  const ns = expanded.search(/[^ ]/);
  if (ns >= 4) return true;
  const b = listBegins(ci);
  return b.fence.test(m) || b.heading.test(m) || b.html.test(m) || b.hr.test(m);
}

function parseList(lines, i, refs, endsWithNl) {
  const first = matchListItem(lines[i], leadingIndent(lines[i], 0));
  const items = [];
  let betweenLoose = false;
  let j = i;
  let endList = false;
  while (j < lines.length && !endList) {
    const ind = leadingIndent(lines[j], 0);
    if (isHr(lines[j], ind)) break; // a thematic break ends the list
    const item = matchListItem(lines[j], ind);
    if (!item || !sameList(first, item)) break;
    const ci = item.contentIndent;
    const itemLines = [stripFrom(lines[j], item.markerEndOffset, item.markerEndCol, ci - item.markerEndCol)];
    const syntheticBlanks = new Set();
    const textLines = new Set();
    const firstLineBlank = !item.hasContent;
    // kind of the item's current last inner block: 'para' (an open paragraph
    // at any nesting depth), 'list', or 'other' — drives laziness/deep rules
    let lastKind = firstLineBlank ? 'other' : kindOfItemLine(itemLines[0]);
    let lastDeep = false;
    let prevBlank = firstLineBlank;
    // fence state of the item text built so far (classification only: the
    // gathering itself follows marked's indent/lazy rules either way)
    let inFence = null;
    {
      const f0 = matchFence(itemLines[0], leadingIndent(itemLines[0], 0));
      if (f0) inFence = { ch: f0.ch, len: f0.len };
    }
    j++;
    let itemDone = false;
    while (j < lines.length && !itemDone && !endList) {
      const L = lines[j];
      if (isBlank(L)) {
        // look ahead to the next non-blank line; when the list ends here,
        // the caller re-reads the blank run itself (it may carry looseness
        // information for an enclosing list), so report the run's start
        const blankStart = j;
        let k = j + 1;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k >= lines.length) { j = blankStart; endList = true; break; }
        const kind = leadingIndent(lines[k], 0);
        const nextItem = !isHr(lines[k], kind) && matchListItem(lines[k], kind);
        if (firstLineBlank) {
          // an item whose first line is blank: a following same-list item
          // continues the (loose) list; anything else ends it here
          if (nextItem && sameList(first, nextItem) && kind.cols < ci) {
            betweenLoose = true;
            j = k;
            itemDone = true;
          } else {
            j = blankStart;
            endList = true;
          }
          break;
        }
        if (nextItem && sameList(first, nextItem) && kind.cols < ci) {
          // blank line between items -> loose, item ends
          betweenLoose = true;
          j = k;
          itemDone = true;
          break;
        }
        if (kind.cols >= ci) {
          // blank line(s) inside the item
          for (let b = j; b < k; b++) itemLines.push('');
          lastKind = 'other';
          lastDeep = false;
          prevBlank = true;
          j = k;
          continue;
        }
        // next content belongs outside the list
        j = blankStart;
        endList = true;
        break;
      }
      const lind = leadingIndent(L, 0);
      // marked's gathering: a block begin at indent < ci ends the item
      if (itemBeginBreak(L, ci)) {
        const ni = !isHr(L, lind) && matchListItem(L, lind);
        if (ni && sameList(first, ni)) itemDone = true;
        else endList = true;
        break;
      }
      if (lind.cols >= ci) {
        const s = stripFrom(L, 0, 0, ci);
        itemLines.push(s);
        if (inFence) {
          const f = matchFence(s, leadingIndent(s, 0));
          if (f && f.ch === inFence.ch && f.len >= inFence.len && f.info === '') inFence = null;
          lastKind = 'other';
        } else {
          const f = matchFence(s, leadingIndent(s, 0));
          if (f) inFence = { ch: f.ch, len: f.len };
          lastKind = kindOfItemLine(s);
        }
        lastDeep = false;
        prevBlank = false;
        j++;
        continue;
      }
      // dedented line: appended lazily unless the previous gathered line
      // forces a break (blank, deep, or itself a block begin)
      const prevM = itemLines[itemLines.length - 1];
      if (prevBlank || prevLineBreak(prevM, ci)) { endList = true; break; }
      textLines.add(itemLines.length);
      if (/^ {0,3}(?:=+|-+) *$/.test(L) && lastKind === 'para') {
        // setext-shaped lazy line: rewritten with a 4-space prefix
        itemLines.push('    ' + L.replace(/^ {0,3}/, ''));
      } else {
        itemLines.push(lind.cols >= 4 ? stripFrom(L, 0, 0, 4) : L);
      }
      lastDeep = false;
      prevBlank = false;
      j++;
      continue;
    }
    // trailing blank lines in itemLines don't count toward looseness
    const trimmed = itemLines.slice();
    while (trimmed.length && isBlank(trimmed[trimmed.length - 1])) trimmed.pop();
    // marked trims the item's raw text: trailing spaces/tabs on the last
    // content line are dropped
    if (trimmed.length) trimmed[trimmed.length - 1] = trimmed[trimmed.length - 1].replace(/[ \t]+$/, '');
    const children = parseBlocks(trimmed, refs, false, null, syntheticBlanks, textLines, true);
    items.push(children);
    if (itemDone) continue;
  }
  let loose = betweenLoose;
  if (!loose) {
    for (const children of items) {
      for (let k = 1; k < children.length; k++) {
        if (children[k].blankBefore > 0) { loose = true; break; }
      }
      if (loose) break;
    }
  }
  return { node: { t: 'list', ordered: first.ordered, start: first.num, loose, items }, end: j };
}

// Classify a stripped list-item content line by the block it ends in:
// 'list' for a nested item line, 'para' when a paragraph is open at any
// nesting depth (through quotes/sub-lists), 'other' otherwise.
function kindOfItemLine(s) {
  const ind = leadingIndent(s, 0);
  if (ind.cols <= 3 && matchListItem(s, ind)) return 'list';
  const core = deepStripCore(s);
  if (isBlank(core)) return 'other';
  if (lineStartsBlock(core)) return 'other';
  return 'para';
}

// Is the last block of these (already collected) item lines a paragraph?
// Approximation: the last non-blank line is a plain text line.
function isLazyTextLine(itemLines) {
  for (let k = itemLines.length - 1; k >= 0; k--) {
    const l = itemLines[k];
    if (isBlank(l)) return false;
    const ind = leadingIndent(l, 0);
    if (ind.cols >= 4) return false;
    if (matchFence(l, ind) || matchAtx(l, ind) || isHr(l, ind)) return false;
    if (matchListItem(l, ind)) return false;
    if (l[ind.end] === '>') return false;
    return true;
  }
  return false;
}

function parseBlocks(lines, refs, endsWithNl, noSetext, syntheticBlanks, textLines, inItem, docTail) {
  const nodes = [];
  let i = 0;
  const n = lines.length;
  let blanksPending = 0;
  const push = (nd) => { nd.blankBefore = blanksPending; blanksPending = 0; nodes.push(nd); };
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { if (!(syntheticBlanks && syntheticBlanks.has(i))) blanksPending++; i++; continue; }
    const ind = leadingIndent(line, 0);
    // fenced code
    const fence = matchFence(line, ind);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < n) {
        const L = lines[j];
        const lind = leadingIndent(L, 0);
        if (lind.cols <= 3) {
          const rest = L.slice(lind.end);
          let len = 0;
          while (len < rest.length && rest[len] === fence.ch) len++;
          if (len >= fence.len && /^[ \t]*$/.test(rest.slice(len))) { j++; break; }
        }
        content.push(fence.ch === '`' ? stripWsChars(L, fence.indentChars) : L);
        j++;
      }
      const lang = fence.info === '' ? '' : unescapePunct(fence.info.split(/\s+/)[0]);
      push({ t: 'code', text: fenceText(content), lang });
      i = j;
      continue;
    }
    // ATX heading
    const atx = matchAtx(line, ind);
    if (atx) { push({ t: 'heading', level: atx.level, text: atx.text }); i++; continue; }
    // link reference definition (recorded as an invisible node so list
    // looseness can account for it)
    const defEnd = tryDef(lines, i, refs);
    if (defEnd !== -1) { push({ t: 'def' }); i = defEnd; continue; }
    // HTML block
    if (ind.cols <= 3 && htmlBlockStart(line, ind.end)) {
      const r = parseHtmlBlock(lines, i, endsWithNl);
      push(r.node); i = r.end; continue;
    }
    // blockquote
    if (ind.cols <= 3 && line[ind.end] === '>') {
      const r = parseBlockquote(lines, i, refs, endsWithNl);
      push(r.node); i = r.end; continue;
    }
    // thematic break
    if (isHr(line, ind)) { push({ t: 'hr' }); i++; continue; }
    // list
    if (matchListItem(line, ind)) {
      const r = parseList(lines, i, refs, endsWithNl);
      push(r.node); i = r.end; continue;
    }
    // table
    const ts = isTableStart(lines, i);
    if (ts) {
      const r = parseTable(lines, i, ts, endsWithNl);
      push(r.node); i = r.end; continue;
    }
    // indented code
    if (ind.cols >= 4) {
      const content = [];
      let j = i;
      while (j < n) {
        const L = lines[j];
        if (isBlank(L)) {
          // include blank lines only if a later line is indented code again
          let k = j + 1;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && leadingIndent(lines[k], 0).cols >= 4) {
            for (let b = j; b < k; b++) content.push(stripColumns(lines[b], 0, 4));
            j = k;
            continue;
          }
          break;
        }
        if (leadingIndent(L, 0).cols < 4) break;
        content.push(stripColumns(L, 0, 4));
        j++;
      }
      // strip trailing blank-ish content lines (they were added as '')
      while (content.length && content[content.length - 1] === '') content.pop();
      push({ t: 'code', text: content.join('\n') + '\n', lang: '' });
      i = j;
      continue;
    }
    // paragraph / setext heading / table conversion
    const r = parseParagraph(lines, i, refs, noSetext, textLines, inItem, docTail, endsWithNl);
    for (const nd of r.nodes) push(nd);
    i = r.end;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Inline parsing. A scanner builds a node list; link/image brackets are
// resolved during the scan, emphasis/delimiters afterwards (CommonMark-style
// delimiter processing, with marked's strikethrough rule).
//
// Node kinds:
//   {k:'text', s, code?:true}  literal text (code = escape & unconditionally)
//   {k:'raw', s}               emitted verbatim (named entities, inline HTML)
//   {k:'codespan', s}          code span content
//   {k:'br'}                   hard break
//   {k:'delim', ch, len, origLen, canOpen, canClose}
//   {k:'bracket', image}       unresolved [ or ![ (renders literally)
//   {k:'link', href, title, image, children}
//   {k:'autolink', href, text}
//   {k:'em'|'strong'|'del', children}
// ---------------------------------------------------------------------------

const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const NUM_ENTITY_RE = /^&#(\d{1,7});/;
const HEX_ENTITY_RE = /^&#[xX]([0-9a-fA-F]{1,6});/;
const NAMED_ENT_RE = /^&(\w+);/;
const SCHEME_AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK_RE = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;

function decodeNumeric(v) {
  if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(v);
}

// Scan an inline link destination/title after '(' at s[pos] (pos is at '(').
// Returns { href, title, end } or null.
function scanInlineLink(s, pos) {
  let i = skipInlineWs(s, pos + 1, true);
  let href = '';
  if (s[i] === ')') {
    return { href: '', title: null, end: i + 1 };
  }
  const dest = scanDest(s, i, false);
  if (dest) { href = dest.href; i = dest.end; }
  else if (s[i] === '<') return null;
  else return null;
  // after dest: optional title then ')'
  const wsEnd = skipInlineWs(s, i, true);
  if (s[wsEnd] === ')') return { href, title: null, end: wsEnd + 1 };
  if (wsEnd === i) return null; // junk directly after dest
  const t = scanTitle(s, wsEnd);
  if (!t) return null;
  const after = skipInlineWs(s, t.end, true);
  if (s[after] !== ')') return null;
  return { href, title: t.title, end: after + 1 };
}

// Scan a reference label starting at s[pos] === '['. Returns { label, end }.
function scanRefLabel(s, pos) {
  let i = pos + 1;
  while (i < s.length && i - pos <= 1000) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label: s.slice(pos + 1, i), end: i + 1 };
    i++;
  }
  return null;
}

// marked's _backpedal: repeatedly keep the longest prefix made of plain
// runs, balanced paren groups, lone '&' (not an entity tail), and
// punctuation runs that are not at the very end.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(url) {
  let prev;
  do {
    prev = url;
    const m = BACKPEDAL_RE.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return url;
}

const URL_TRAILING_PUNCT = '?!.,:*_~';
function trimAutolink(url) {
  // GFM-style trailing trimming
  for (;;) {
    if (url.length === 0) return url;
    const last = url[url.length - 1];
    if (URL_TRAILING_PUNCT.indexOf(last) !== -1) { url = url.slice(0, -1); continue; }
    if (last === ';') {
      const m = /&(?:#\d+|#[xX][0-9a-fA-F]+|\w+);$/.exec(url);
      if (m) { url = url.slice(0, url.length - m[0].length); continue; }
      url = url.slice(0, -1); continue;
    }
    if (last === ')') {
      let open = 0, close = 0;
      for (let i = 0; i < url.length; i++) {
        if (url[i] === '(') open++;
        else if (url[i] === ')') close++;
      }
      if (close > open) { url = url.slice(0, -1); continue; }
    }
    return url;
  }
}

// Try a GFM autolink (www. / http(s)://) at s[pos]. Returns { text, end }.
// The scheme matches case-insensitively; 'www.' is lowercase-only (marked).
function scanWwwOrUrl(s, pos) {
  let prefix = 0;
  if (s.startsWith('www.', pos)) prefix = 4;
  else if (/^https:\/\//i.test(s.slice(pos, pos + 8))) prefix = 8;
  else if (/^http:\/\//i.test(s.slice(pos, pos + 7))) prefix = 7;
  else return null;
  let i = pos;
  while (i < s.length) {
    const c = s[i];
    if (c <= ' ' || c === '<') break;
    i++;
  }
  let url = s.slice(pos, i);
  url = backpedal(url);
  if (url.length <= prefix) return null;
  // there must be at least one character of domain after the prefix dots
  return { text: url, end: pos + url.length };
}

const EMAIL_LOCAL_SCAN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-";
const EMAIL_LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";

const EMAIL_LOCAL_END_RE = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+$/;
const EMAIL_DOMAIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?)*\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?/;

// Process emphasis delimiters in a node array (in place semantics: returns
// a new array with em/strong/del nodes formed).
// ---------------------------------------------------------------------------
// Emphasis / strikethrough, following marked's scan-time algorithm: the
// inline text is first masked (code spans, links, tags and escapes are
// blanked so their delimiters cannot be seen), then at a delimiter run an
// LDelim check plus a forward RDelim scan over the masked text counts
// nested opener-like runs and applies marked's rule-of-three variant.
// The content is tokenized recursively.
// ---------------------------------------------------------------------------

const OPEN_QUOTE_RE = /[\p{Pi}\p{Ps}"']/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

// marked's "punctuation" test for gate purposes: a whitespace or Unicode
// punctuation/symbol character other than '*' and '_'.
function punctSpaceExec(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && (isWs(ch) || isPunct(ch));
}

// --- the mask (marked's #mask): length-preserving blanking ----------------
const MASK_STEP_B = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_SKIP = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\(\\)]|\((?:\\[\s\S]|[^\\(\\)])*\))*\)|(^^|[^`])((`+)[^`]+\4(?!`))|<(?! )[^<>]*?>/g;
const MASK_REFLINK_SEARCH = /!?\[(?:\\.|[^\[\]\\])*\]\[(?:\\.|[^\[\]\\])*\]|!?\[(?:\\.|[^\[\]\\])*\](?:\[\])?/g;

function maskRefLinks(t, refs) {
  return t.replace(MASK_REFLINK_SEARCH, (full) => {
    const lastOpen = full.lastIndexOf('[');
    const label = full.slice(lastOpen + 1, -1);
    if (!refs.has(normalizeLabel(label))) return full;
    if (lastOpen > 1 && full[0] !== '!') {
      const innerText = full.slice(1, lastOpen - 1);
      if (linkInText(innerText, refs)) {
        return '[' + maskRefLinks(innerText, refs) + '][' + 'a'.repeat(full.length - lastOpen - 2) + ']';
      }
    }
    return '[' + 'a'.repeat(Math.max(0, full.length - 2)) + ']';
  });
}

function linkInText(t, refs) {
  if (!t.includes('[')) return false;
  for (const m of t.matchAll(MASK_BLOCK_SKIP)) {
    if (m[0].startsWith('[') && t[m.index - 1] !== '!') return true;
  }
  for (const m of t.matchAll(MASK_REFLINK_SEARCH)) {
    const full = m[0];
    const lastOpen = full.lastIndexOf('[');
    if (full[0] === '!' || !refs.has(normalizeLabel(full.slice(lastOpen + 1, -1)))) continue;
    if (!(lastOpen > 1 && linkInText(full.slice(1, lastOpen - 1), refs))) return true;
  }
  return false;
}

function maskText(text, refs) {
  let t = text;
  if (t.includes('[') && refs && refs.size > 0) t = maskRefLinks(t, refs);
  t = t.replace(MASK_STEP_B, (n, s, r) => r ? '+'.repeat(n.length)
    : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(MASK_BLOCK_SKIP, (n, g1, prefix) => {
    const o = prefix ? prefix.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(Math.max(0, n.length - o - 2)) + ']';
  });
  return t;
}

// marked's RDelim patterns: alternatives either skip plain text (no capture)
// or capture a closer run in groups 1..6, classified by the classes of the
// characters around the run. GFM set: Ast uses (?!~) classes; Und/Del use
// plain punctuation classes, and Und has no intraword closer alternative.
function rdelimAst() {
  return /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
}
function rdelimUnd() {
  return /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
}
function rdelimDel() {
  return /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
}

// Start index of the last run of `ch` in the masked text whose preceding
// character is not blank (marked's lastPossible(EmStrong|Del)CloserIndex).
function lastPossibleCloser(masked, ch) {
  let idx = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    const prev = s === 0 ? '\n' : masked[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f' && r === ch) idx = s;
    s = i - 1;
  }
  return idx;
}

// Try to form an em/strong token at text[pos] (a run of '*' or '_').
// Returns { node, end } or null.
function tryEmStrong(text, masked, pos, refs, st) {
  const ch = text[pos];
  let run = 0;
  while (pos + run < text.length && text[pos + run] === ch) run++;
  const after = pos + run < text.length ? text[pos + run] : '';
  if (after === '' || isWs(after)) return null;
  // LDelim (on the raw text): the character after the run is either a
  // punctuation character (not '~', not the delimiter itself) or any
  // non-space character
  const afterPunct = isPunct(after) && after !== '~' && after !== ch;
  const d = afterPunct ? after : '';
  // walk back over the run in the masked text; p = char before the run there
  let l = pos;
  while (l > 0 && masked[l - 1] === ch) l--;
  const p = l > 0 ? masked[l - 1] : '';
  const h = p !== '' && (isWs(p) || isPunct(p));
  const rawPrev = pos > 0 ? text[pos - 1] : '';
  const n = l < pos ? p : rawPrev;
  const u = l < pos ? h : punctSpaceExec(rawPrev);
  if (ch === '_' && !afterPunct && n !== '' && ALNUM_RE.test(n)) return null; // intraword '_'
  if (!(d === '' || n === '' || u)) return null;
  const k = run;
  const sameCharBefore = rawPrev === ch;
  const y = (pos - l) + k;
  const canAlsoClose = p !== '' && p.trim() !== '' && (d !== '' || (ch === '*' && !h));
  const v = lastPossibleCloser(masked, ch);
  const Q = pos + k;
  if (v < Q) return null;
  const ee = v - Q;
  const t = masked.slice(Q);
  const A = ch === '*' ? rdelimAst() : rdelimUnd();
  let m = k, f = 0, match;
  while ((match = A.exec(t)) !== null && !(match.index > ee)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g) continue;
    let b = g.length;
    if (match[3] || match[4]) { m += b; continue; }
    if (match[5] || match[6] || canAlsoClose) {
      if (sameCharBefore && (match[5] || match[6])) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    b = Math.min(b, b + m + f);
    const te = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const rawLen = k + match.index + te + b;
    const raw = text.slice(pos, pos + rawLen);
    if (Math.min(k, b) % 2 === 1) {
      return { node: { k: 'em', children: parseInline(raw.slice(1, -1), refs, st) }, end: pos + rawLen };
    }
    return { node: { k: 'strong', children: parseInline(raw.slice(2, -2), refs, st) }, end: pos + rawLen };
  }
  return null;
}

// Try to form a del token at text[pos] (a run of 1-2 '~').
function tryDel(text, masked, pos, refs, st) {
  let run = 0;
  while (pos + run < text.length && text[pos + run] === '~') run++;
  if (run > 2) return null;
  const after = pos + run < text.length ? text[pos + run] : '';
  if (after === '' || isWs(after) || after === '~') return null;
  const prevCh = pos > 0 ? text[pos - 1] : '';
  const s1 = isPunct(after) ? after : '';
  if (!(s1 === '' || prevCh === '' || punctSpaceExec(prevCh))) return null;
  const o = run;
  const u = lastPossibleCloser(masked, '~');
  const d0 = pos + o;
  if (u < d0) return null;
  const t = masked.slice(d0);
  const A = rdelimDel();
  let p = o, match;
  while ((match = A.exec(t)) !== null && !(match.index > u - d0)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g || g.length !== o) continue;
    if (match[3] || match[4]) { p += g.length; continue; }
    p -= g.length;
    if (p > 0) continue;
    const len = Math.min(g.length, g.length + p);
    const te = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const rawLen = o + match.index + te + len;
    const raw = text.slice(pos, pos + rawLen);
    return { node: { k: 'del', children: parseInline(raw.slice(o, raw.length - o), refs, st) }, end: pos + rawLen };
  }
  return null;
}

// Index of the ']' matching the '[' at openIdx (nesting, escapes and code
// spans respected), or -1.
// marked's link guard: a link is rejected when a tag or angle autolink
// starting inside the label extends past the label's end (the label scan
// skips escapes and code spans).
function codeSpanLenAt(text, pos) {
  let run = 0;
  while (text[pos + run] === '`') run++;
  if (run === 0) return 0;
  let j = pos + run;
  while (j < text.length) {
    if (text[j] === '`') {
      let r2 = 0;
      while (text[j + r2] === '`') r2++;
      if (r2 === run) return j + r2 - pos;
      j += r2;
    } else j++;
  }
  return 0;
}

function tagOrAutolinkLen(text, pos) {
  const rest = text.slice(pos, pos + 2000);
  if (rest.startsWith('<!--->')) return 6;
  if (rest.startsWith('<!-->')) return 5;
  if (rest.startsWith('<!--')) {
    const e = text.indexOf('-->', pos + 4);
    return e === -1 ? 0 : e + 3 - pos;
  }
  if (rest.startsWith('<?')) {
    const e = text.indexOf('?>', pos + 2);
    return e === -1 ? 0 : e + 2 - pos;
  }
  if (rest.startsWith('<![CDATA[')) {
    const e = text.indexOf(']]>', pos + 9);
    return e === -1 ? 0 : e + 3 - pos;
  }
  if (/^<![A-Z]/.test(rest)) {
    const e = text.indexOf('>', pos + 2);
    return e === -1 ? 0 : e + 1 - pos;
  }
  const m = SCHEME_AUTOLINK_RE.exec(rest) || EMAIL_AUTOLINK_RE.exec(rest);
  if (m) return m[0].length;
  const te = scanTagEnd(text.slice(pos + 1, pos + 2000));
  return te === -1 ? 0 : 1 + te;
}

function labelHasExtendingTag(text, pos, isImage, label) {
  if (!label.includes('<')) return false;
  const base = pos + (isImage ? 2 : 1);
  for (let s = 0; s < label.length; s++) {
    const c = label[s];
    if (c === '\\') { s++; continue; }
    if (c === '`') {
      const len = codeSpanLenAt(text, base + s);
      if (len > 0) { s += len - 1; continue; }
    }
    if (c !== '<') continue;
    const len = tagOrAutolinkLen(text, base + s);
    if (len > 0) {
      if (len > label.length - s) return true;
      s += len - 1;
    }
  }
  return false;
}

function findMatchingBracket(text, openIdx) {
  // marked's label pattern consumes a backtick region as: a run, content
  // with no backticks, then the first following run (any length) as the
  // closer. If that region path cannot complete the label, the pattern
  // falls back to treating a run of 2+ backticks directly before the
  // closing ']' as literal label content; any other unmatched run makes
  // the label invalid for inline/full-ref links (ltValid=false) though
  // the bracket scan itself continues. Modelled as a backtracking scan.
  const n = text.length;
  function scan(i, depth, ltValid) {
    while (i < n) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        let run = 0;
        while (i + run < n && text[i + run] === '`') run++;
        let j = i + run;
        while (j < n && text[j] !== '`') j++;
        if (j < n) {
          let r2 = 0;
          while (j + r2 < n && text[j + r2] === '`') r2++;
          const r = scan(j + r2, depth, ltValid);
          if (r && r.ltValid) return r;
          // the region path is dead for marked's label pattern (either no
          // close, or the label was poisoned by an unmatched run inside):
          // fall back to a 2+ run directly before ']' as literal content
          if (run >= 2 && text[i + run] === ']') { i += run; continue; }
          if (r) return r; // bracket structure still closes (shortcut path)
          ltValid = false;
          i += run;
          continue;
        }
        if (run >= 2 && text[i + run] === ']') { i += run; continue; }
        ltValid = false;
        i += run;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return { close: i, ltValid };
      }
      i++;
    }
    return null;
  }
  return scan(openIdx + 1, 1, true) || { close: -1, ltValid: false };
}

// Try to form a link or image at text[pos] ('[' or '!['), following marked:
// the label's matching ']' is found first, then an inline destination, a
// full/collapsed reference, or a shortcut reference is attempted. The link
// text is tokenized in its own unit with inLink set; if a (non-image) link
// is emitted inside the text of a non-image link, the outer link is
// rejected and the caller treats the opener as literal text.
function tryLinkOrImage(text, pos, isImage, refs, st) {
  const openLen = isImage ? 2 : 1;
  const mb = findMatchingBracket(text, pos + openLen - 1);
  const close = mb.close;
  if (close < 0) return null;
  const innerText = text.slice(pos + openLen, close);
  if (labelHasExtendingTag(text, pos, isImage, innerText)) return null;
  let formed = null;
  let endPos = close + 1;
  let refLabelSeen = false;
  if (mb.ltValid && st.linkParenPossible && text[close + 1] === '(') {
    const r = scanInlineLink(text, close + 1);
    if (r) { formed = { href: r.href, title: r.title }; endPos = r.end; }
  }
  if (!formed && mb.ltValid && text[close + 1] === '[') {
    const lab = scanRefLabel(text, close + 1);
    if (lab) {
      refLabelSeen = true;
      const label = lab.label === '' ? innerText : lab.label;
      const ref = refs.get(normalizeLabel(label));
      if (ref) { formed = { href: ref.href, title: ref.title }; endPos = lab.end; }
    }
  }
  if (!formed && !refLabelSeen) {
    const ref = refs.get(normalizeLabel(innerText));
    if (ref) { formed = { href: ref.href, title: ref.title }; endPos = close + 1; }
  }
  if (!formed) return null;
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const children = parseInline(innerText, refs, st);
  const innerEmitted = st.linkEmitted;
  st.inLink = savedInLink;
  st.linkEmitted = savedEmitted;
  if (!isImage && innerEmitted) return null;
  if (!isImage) st.linkEmitted = true;
  return { node: { k: 'link', href: formed.href, title: formed.title, image: isImage, children }, end: endPos };
}

function parseInline(text, refs, st) {
  const savedParenPossible = st.linkParenPossible;
  st.linkParenPossible = savedParenPossible && text.includes(')');
  const masked = (text.includes('*') || text.includes('_') || text.includes('~')) ? maskText(text, refs) : text;
  const nodes = [];
  let buf = '';
  const n = text.length;
  let i = 0;

  function flush() {
    if (buf) { nodes.push({ k: 'text', s: buf }); buf = ''; }
  }
  function pushLiteralChar(ch) {
    flush();
    nodes.push({ k: 'text', s: ch, code: true });
  }

  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        // hard break: trailing spaces already in buf are dropped
        buf = buf.replace(/[ \t]+$/, '');
        flush();
        nodes.push({ k: 'br' });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (next !== undefined && ESCAPABLE.indexOf(next) !== -1) {
        pushLiteralChar(next);
        i += 2;
        continue;
      }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let len = 0;
      while (i + len < n && text[i + len] === '`') len++;
      // find a closing run of exactly len
      let j = i + len, closeAt = -1;
      while (j < n) {
        if (text[j] === '`') {
          let l2 = 0;
          while (j + l2 < n && text[j + l2] === '`') l2++;
          if (l2 === len) { closeAt = j; break; }
          j += l2;
        } else j++;
      }
      if (closeAt === -1) { buf += text.slice(i, i + len); i += len; continue; }
      let content = text.slice(i + len, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ k: 'codespan', s: content });
      i = closeAt + len;
      continue;
    }
    if (c === '<') {
      const rest = text.slice(i, i + 2000);
      if (rest.startsWith('<!--')) {
        // marked accepts the abrupt comment closings as complete comments
        if (rest.startsWith('<!--->')) { flush(); nodes.push({ k: 'raw', s: '<!--->' }); i += 6; continue; }
        if (rest.startsWith('<!-->')) { flush(); nodes.push({ k: 'raw', s: '<!-->' }); i += 5; continue; }
        const e = text.indexOf('-->', i + 4);
        if (e !== -1) { flush(); nodes.push({ k: 'raw', s: text.slice(i, e + 3) }); i = e + 3; continue; }
      }
      if (rest.startsWith('<?')) {
        const e = text.indexOf('?>', i + 2);
        if (e !== -1) { flush(); nodes.push({ k: 'raw', s: text.slice(i, e + 2) }); i = e + 2; continue; }
      }
      if (rest.startsWith('<![CDATA[')) {
        const e = text.indexOf(']]>', i + 9);
        if (e !== -1) { flush(); nodes.push({ k: 'raw', s: text.slice(i, e + 3) }); i = e + 3; continue; }
      }
      if (/^<![A-Z]/.test(rest)) {
        const e = text.indexOf('>', i + 2);
        if (e !== -1) { flush(); nodes.push({ k: 'raw', s: text.slice(i, e + 1) }); i = e + 1; continue; }
      }
      let m = SCHEME_AUTOLINK_RE.exec(rest);
      if (m) {
        flush();
        nodes.push({ k: 'autolink', href: m[1], text: m[1] });
        i += m[0].length; continue;
      }
      m = EMAIL_AUTOLINK_RE.exec(rest);
      if (m) {
        flush();
        nodes.push({ k: 'autolink', href: 'mailto:' + m[1], text: m[1] });
        i += m[0].length; continue;
      }
      const te = scanTagEnd(text.slice(i + 1, i + 2000));
      if (te !== -1) {
        flush();
        const tagText = text.slice(i, i + 1 + te);
        nodes.push({ k: 'raw', s: tagText });
        // marked tracks a document-wide "in link" state from raw <a> tags:
        // '<a ' opens it, '</a>' / '</a >' closes it; while set, extension
        // autolinks (www / bare URL / bare email) do not form
        if (/^<a /i.test(tagText)) st.inLink = true;
        else if (/^<\/a[\s>]/i.test(tagText)) st.inLink = false;
        i += 1 + te; continue;
      }
      buf += c; i++; continue;
    }
    if (c === '&') {
      const rest = text.slice(i, i + 12);
      let m = NUM_ENTITY_RE.exec(rest);
      if (m) { pushLiteralChar(decodeNumeric(parseInt(m[1], 10))); i += m[0].length; continue; }
      m = HEX_ENTITY_RE.exec(rest);
      if (m) { pushLiteralChar(decodeNumeric(parseInt(m[1], 16))); i += m[0].length; continue; }
      m = NAMED_ENT_RE.exec(rest);
      if (m) { flush(); nodes.push({ k: 'raw', s: m[0] }); i += m[0].length; continue; }
      buf += c; i++; continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      const r = tryLinkOrImage(text, i, true, refs, st);
      if (r) { flush(); nodes.push(r.node); i = r.end; continue; }
      buf += c; i++; continue;
    }
    if (c === '[') {
      const r = tryLinkOrImage(text, i, false, refs, st);
      if (r) { flush(); nodes.push(r.node); i = r.end; continue; }
      buf += c; i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      const r = c === '~' ? tryDel(text, masked, i, refs, st) : tryEmStrong(text, masked, i, refs, st);
      if (r) { flush(); nodes.push(r.node); i = r.end; continue; }
      buf += c; i++; continue;
    }
    if (c === '@') {
      // GFM email autolink: the local part is the maximal run of email
      // characters in the source just before the @; it may span several
      // already-scanned nodes (text runs are broken by _ * etc.).
      let ls = i;
      while (ls > 0 && EMAIL_LOCAL_SCAN_CHARS.indexOf(text[ls - 1]) !== -1) ls--;
      const local = text.slice(ls, i);
      let linked = false;
      if (local.length > 0 && !st.inLink && !(ls > 0 && text[ls - 1] === '\\')) {
        const dm = EMAIL_DOMAIN_RE.exec(text.slice(i + 1, i + 300));
        if (dm) {
          const afterDom = text[i + 1 + dm[0].length];
          if (afterDom === undefined || !/[\w-]/.test(afterDom)) {
            // optional mailto: / xmpp: scheme directly before the local part
            let scheme = '';
            let linkStart = ls;
            for (const sch of ['mailto:', 'xmpp:']) {
              const st = ls - sch.length;
              if (st >= 0 && text.slice(st, ls).toLowerCase() === sch &&
                  (st === 0 || !/[a-zA-Z0-9]/.test(text[st - 1]))) {
                scheme = text.slice(st, ls);
                linkStart = st;
                break;
              }
            }
            let linkText = scheme + local + '@' + dm[0];
            let endPos = i + 1 + dm[0].length;
            if (scheme.toLowerCase() === 'xmpp:' && text[endPos] === '/') {
              let r = endPos + 1;
              while (r < n && text[r] > ' ' && text[r] !== '<' && text[r] !== '/') r++;
              const resource = trimAutolink(text.slice(endPos + 1, r));
              if (resource) { linkText += '/' + resource; endPos += 1 + resource.length; }
            }
            // absorb linkStart..i (local part + scheme) from buf + nodes
            let need = text.slice(linkStart, i);
            let ok = true;
            const takeBuf = Math.min(buf.length, need.length);
            if (buf.slice(buf.length - takeBuf) !== need.slice(need.length - takeBuf)) ok = false;
            else {
              need = need.slice(0, need.length - takeBuf);
              const removeIdx = [];
              let idx = nodes.length - 1;
              while (ok && need.length > 0 && idx >= 0) {
                const nd = nodes[idx];
                let s = null;
                if (nd.k === 'text') s = nd.s;
                else if (nd.k === 'delim') s = nd.ch.repeat(nd.len);
                else if (nd.k === 'raw') s = nd.s;
                if (s === null || s.length > need.length || !need.endsWith(s)) { ok = false; break; }
                need = need.slice(0, need.length - s.length);
                removeIdx.push(idx);
                idx--;
              }
              if (ok && need.length === 0) {
                buf = buf.slice(0, buf.length - takeBuf);
                for (const ri of removeIdx) nodes.splice(ri, 1);
                flush();
                nodes.push({ k: 'autolink', href: scheme ? linkText : 'mailto:' + linkText, text: linkText, ext: true });
                i = endPos;
                linked = true;
              }
            }
          }
        }
      }
      if (linked) continue;
      buf += c; i++; continue;
    }
    if ((c === 'w' || c === 'h' || c === 'W' || c === 'H')) {
      const prevCh = i > 0 ? text[i - 1] : '';
      const r = !st.inLink && !/[a-zA-Z0-9]/.test(prevCh) ? scanWwwOrUrl(text, i) : null;
      if (r) {
        flush();
        const href = r.text.startsWith('www.') ? 'http://' + r.text : r.text;
        nodes.push({ k: 'autolink', href, text: r.text, ext: true });
        i = r.end; continue;
      }
      buf += c; i++; continue;
    }
    if (c === '\n') {
      // hard break from trailing spaces?
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ k: 'br' });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      buf += c; i++; continue;
    }
    // plain text run: consume until the next special character
    let j = i + 1;
    while (j < n) {
      const x = text[j];
      if (x === '\\' || x === '`' || x === '<' || x === '&' || x === '[' || x === ']' || x === '!' ||
          x === '*' || x === '_' || x === '~' || x === '@' || x === '\n' || x === 'w' || x === 'h' ||
          x === 'W' || x === 'H') break;
      j++;
    }
    buf += text.slice(i, j);
    i = j;
  }
  flush();
  st.linkParenPossible = savedParenPossible;
  return nodes;
}

// Raw source-ish text of nodes[from..] (used for reference labels / alt text).
function rawTextOf(nodes, from, refs) {
  let out = '';
  for (let k = from; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.k === 'text') out += nd.s;
    else if (nd.k === 'codespan') out += '`' + nd.s + '`';
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.k === 'bracket') out += nd.image ? '![' : '[';
    else if (nd.k === 'raw') out += nd.s;
    else if (nd.k === 'autolink') out += nd.text;
    else if (nd.k === 'link') out += rawTextOf(nd.children, 0, refs);
    else if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') out += rawTextOf(nd.children, 0, refs);
  }
  return out;
}

// Plain text of a node list (for image alt attributes).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text') out += nd.s;
    else if (nd.k === 'codespan') out += nd.s;
    else if (nd.k === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.k === 'bracket') out += nd.image ? '![' : '[';
    else if (nd.k === 'raw') out += nd.s;
    else if (nd.k === 'br') out += ' ';
    else if (nd.k === 'autolink') out += nd.text;
    else if (nd.k === 'link') out += plainText(nd.children);
    else if (nd.k === 'em' || nd.k === 'strong' || nd.k === 'del') out += plainText(nd.children);
  }
  return out;
}

// Replace extension-autolink nodes with plain text (used for link children,
// where marked suppresses www / bare-URL / bare-email autolinks).
function suppressExtAutolinks(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.k === 'autolink' && nd.ext) nodes[i] = { k: 'text', s: nd.text };
    else if (nd.children) suppressExtAutolinks(nd.children);
  }
}

function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += nd.code ? escapeCode(nd.s) : escapeText(nd.s); break;
      case 'raw': out += nd.s; break;
      case 'codespan': out += '<code>' + escapeCode(nd.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'bracket': out += nd.image ? '![' : '['; break;
      case 'autolink': out += '<a href="' + escapeHref(cleanUrl(nd.href)) + '">' + escapeText(nd.text) + '</a>'; break;
      case 'em': out += '<em>' + renderInlineNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineNodes(nd.children) + '</del>'; break;
      case 'link': {
        const href = escapeHref(cleanUrl(nd.href));
        if (nd.image) {
          out += '<img src="' + href + '" alt="' + escapeAttr(plainText(nd.children)) + '"' +
            (nd.title != null ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>';
        } else {
          out += '<a href="' + href + '"' +
            (nd.title != null ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>' +
            renderInlineNodes(nd.children) + '</a>';
        }
        break;
      }
    }
  }
  return out;
}

function renderInline(text, refs, st) {
  if (!/[*_~`[<\\!&@whWH]/.test(text)) {
    // fast path: nothing inline-ish except possibly hard breaks / entities
    if (text.indexOf('\n') === -1) return escapeText(text);
  }
  return renderInlineNodes(parseInline(text, refs, st));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(nodes, refs, tight, st) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'def': break;
      case 'heading': out += `<h${nd.level}>${renderInline(nd.text, refs, st)}</h${nd.level}>\n`; break;
      case 'para': out += tight ? renderInline(nd.text, refs, st) : `<p>${renderInline(nd.text, refs, st)}</p>\n`; break;
      case 'code': out += '<pre><code' + (nd.lang ? ` class="language-${escapeAttr(nd.lang)}"` : '') + '>' + escapeCode(nd.text) + '</code></pre>\n'; break;
      case 'html': out += nd.text; break;
      case 'hr': out += '<hr>\n'; break;
      case 'quote': out += '<blockquote>\n' + renderBlocks(nd.children, refs, false, st) + '</blockquote>\n'; break;
      case 'list': out += renderList(nd, refs, st); break;
      case 'table': out += renderTable(nd, refs, st); break;
    }
  }
  return out;
}

const TASK_RE = /^\[([ xX])\]\s+/;

function renderList(list, refs, st) {
  const tag = list.ordered ? 'ol' : 'ul';
  const startAttr = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  let out = `<${tag}${startAttr}>\n`;
  for (const item of list.items) {
    out += '<li>' + renderListItem(item, list.loose, refs, st) + '</li>\n';
  }
  return out + `</${tag}>\n`;
}

function renderListItem(blocks, loose, refs, st) {
  // task list checkbox: the item's first block is a paragraph whose text
  // starts with [ ], [x] or [X] followed by whitespace and more content
  if (blocks.length > 0 && blocks[0].t === 'para') {
    const m = TASK_RE.exec(blocks[0].text);
    if (m && m[0].length < blocks[0].text.length) {
      const checked = m[1] !== ' ';
      const checkbox = checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      const first = { t: 'para', text: blocks[0].text.slice(m[0].length) };
      const rest = blocks.slice(1);
      const firstHtml = loose
        ? `<p>${checkbox}${renderInline(first.text, refs, st)}</p>\n`
        : checkbox + renderInline(first.text, refs, st);
      return firstHtml + renderBlocks(rest, refs, !loose, st);
    }
  }
  return renderBlocks(blocks, refs, !loose, st);
}

// In table cells, \| is a table-level escape: it must reach the inline
// parser as a literal pipe (even inside code spans), so swap it for a
// placeholder first and restore it afterwards.
function renderCell(text, refs, st) {
  if (text.indexOf('\\|') === -1) return renderInline(text, refs, st);
  let t = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { t += '\u0001'; i++; }
    else if (text[i] === '\\' && text[i + 1] === '\\') { t += '\\\\'; i++; }
    else t += text[i];
  }
  return renderInline(t, refs, st).replace(/\u0001/g, '|');
}

function renderTable(table, refs, st) {
  let out = '<table>\n<thead>\n<tr>\n';
  table.header.forEach((cell, idx) => {
    const a = table.align[idx];
    out += `<th${a ? ` align="${a}"` : ''}>${renderCell(cell, refs, st)}</th>\n`;
  });
  out += '</tr>\n</thead>\n';
  if (table.rows.length > 0) {
    out += '<tbody>';
    for (const row of table.rows) {
      out += '<tr>\n';
      row.forEach((cell, idx) => {
        const a = table.align[idx];
        out += `<td${a ? ` align="${a}"` : ''}>${renderCell(cell, refs, st)}</td>\n`;
      });
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  let src = markdown;
  if (src.indexOf('\r') !== -1) src = src.replace(/\r\n?/g, '\n');
  const endsWithNl = src.endsWith('\n');
  let lines = src.split('\n');
  if (endsWithNl) lines.pop();
  const refs = new Map();
  const nodes = parseBlocks(lines, refs, endsWithNl, null, null, null, false, !endsWithNl);
  return renderBlocks(nodes, refs, false, { inLink: false, linkEmitted: false, linkParenPossible: true });
}
