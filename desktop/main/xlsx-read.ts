// The first worksheet of an .xlsx file as rows of text, with no dependency beyond Node's zlib: a booking-system export needs the
// cells' text and nothing more. What it never does: evaluate a formula (a formula cell gives the value Excel saved with it), follow
// an external link, load a DTD or entity (a file that declares one is refused), or inflate past a fixed size (a "zip bomb" stops at
// the cap). Encrypted, ZIP64 and multi-disk archives are refused with a plain sentence.
import { inflateRawSync } from 'node:zlib';
import { MAX_COLUMNS, MAX_ROWS } from './names-parse.ts';

export class SpreadsheetError extends Error {}

/** Largest single part of the archive AttendWell will unpack. */
export const MAX_PART = 32 * 1024 * 1024;

const NOT_XLSX = 'This file is not an Excel workbook AttendWell can read. Save it as .xlsx or CSV, then try again.';

interface Entry { name: string; method: number; flags: number; compressed: number; size: number; offset: number }

function entries(b: Buffer): Map<string, Entry> {
  // End of central directory: the last 22 bytes, or up to 64 KB before them when there is an archive comment.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i -= 1) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new SpreadsheetError(NOT_XLSX);
  if (b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0) throw new SpreadsheetError(NOT_XLSX);
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new SpreadsheetError(NOT_XLSX);
  const out = new Map<string, Entry>();
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new SpreadsheetError(NOT_XLSX);
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const compressed = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const offset = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 1) throw new SpreadsheetError('This workbook is protected with a password. Save a copy without one, then try again.');
    out.set(name.replace(/^\/+/, ''), { name, method, flags, compressed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function read(b: Buffer, all: Map<string, Entry>, name: string): string | null {
  const e = all.get(name);
  if (!e) return null;
  if (e.size > MAX_PART) throw new SpreadsheetError('This workbook is too large to be a name list.');
  const h = e.offset;
  if (h + 30 > b.length || b.readUInt32LE(h) !== 0x04034b50) throw new SpreadsheetError(NOT_XLSX);
  const start = h + 30 + b.readUInt16LE(h + 26) + b.readUInt16LE(h + 28);
  const data = b.subarray(start, start + e.compressed);
  if (data.length !== e.compressed) throw new SpreadsheetError(NOT_XLSX);
  let raw: Buffer;
  if (e.method === 0) raw = data;
  else if (e.method === 8) {
    try { raw = inflateRawSync(data, { maxOutputLength: MAX_PART }); } catch { throw new SpreadsheetError('This workbook is damaged or too large to be a name list.'); }
  } else throw new SpreadsheetError(NOT_XLSX);
  const xml = raw.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SpreadsheetError(NOT_XLSX);
  return xml;
}

/** XML text to plain text: the five named entities and numeric references only (no DTD is ever read). */
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });
}

/** Most XML elements one part may hold, and most shared strings, rows and cells a sheet may hold. A real name list is far below each. */
export const MAX_ELEMENTS = 2_000_000;
export const MAX_SHARED = 500_000;
export const MAX_ROW_ELEMENTS = 200_000;
export const MAX_CELLS = 500_000;
const TOO_MANY = 'This workbook holds far more than a name list. Save the list on its own sheet as .xlsx or CSV, then try again.';

interface Tag { name: string; attrs: Map<string, string>; close: boolean; selfClose: boolean }

/** Attributes of one start tag, in one pass over it. */
function attributes(src: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i]!)) i += 1;
    const ks = i;
    while (i < n && src[i] !== '=' && !/\s/.test(src[i]!)) i += 1;
    const key = src.slice(ks, i);
    while (i < n && /\s/.test(src[i]!)) i += 1;
    if (src[i] !== '=') { i += 1; continue; }
    i += 1;
    while (i < n && /\s/.test(src[i]!)) i += 1;
    const q = src[i];
    if (q !== '"' && q !== "'") { i += 1; continue; }
    const end = src.indexOf(q, i + 1);
    if (end < 0) break;
    if (key && !out.has(key)) out.set(key, unescapeXml(src.slice(i + 1, end)));
    i = end + 1;
  }
  return out;
}

/** The local part of a (possibly prefixed) element name: "x:row" is "row". */
const local = (name: string): string => name.slice(name.indexOf(':') + 1);

/**
 * One forward pass over an XML part: every start, end and empty tag, and the text between them. The cursor only ever moves
 * forward (indexOf from the cursor, never a pattern that rescans), so time grows with the length of the part, whatever it holds.
 * Comments, processing instructions and CDATA are passed over (CDATA is text). A tag left unclosed ends the part.
 */
function scan(xml: string, onTag: (t: Tag) => void, onText: (raw: string, cdata: boolean) => void): void {
  let i = 0;
  let count = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { onText(xml.slice(i), false); return; }
    if (lt > i) onText(xml.slice(i, lt), false);
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e < 0) return; i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); if (e < 0) return; onText(xml.slice(lt + 9, e), true); i = e + 3; continue; }
    // A processing instruction runs to "?>", not to the first ">": text inside one (even text that looks like an element) is never read.
    if (xml[lt + 1] === '?') { const e = xml.indexOf('?>', lt + 2); if (e < 0) return; i = e + 2; continue; }
    // Any other declaration ("<!" that is not a comment or CDATA; DOCTYPE and ENTITY are refused before scanning) runs to its ">".
    if (xml[lt + 1] === '!') { const e = xml.indexOf('>', lt + 2); if (e < 0) return; i = e + 1; continue; }
    // The end of the tag: the first ">" outside a quoted attribute value.
    let j = lt + 1;
    let q = '';
    for (; j < n; j += 1) {
      const ch = xml[j]!;
      if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break;
    }
    if (j >= n) return;
    count += 1;
    if (count > MAX_ELEMENTS) throw new SpreadsheetError(TOO_MANY);
    let body = xml.slice(lt + 1, j);
    const close = body.startsWith('/');
    const selfClose = !close && body.endsWith('/');
    if (close) body = body.slice(1);
    if (selfClose) body = body.slice(0, -1);
    let k = 0;
    while (k < body.length && !/[\s/]/.test(body[k]!)) k += 1;
    onTag({ name: local(body.slice(0, k)), attrs: close ? new Map() : attributes(body.slice(k)), close, selfClose });
    i = j + 1;
  }
}

/**
 * Each string item's text: every <t> run, without phonetic guides (<rPh>). An item opened again before it closed starts a new
 * item; an item still open at the end of the part is kept.
 */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let inT = 0;
  let inPh = 0;
  const push = (): void => {
    if (cur === null) return;
    if (out.length >= MAX_SHARED) throw new SpreadsheetError(TOO_MANY);
    out.push(cur);
    cur = null;
  };
  scan(xml, (t) => {
    if (t.name === 'si') {
      if (t.close) { push(); inT = 0; inPh = 0; return; }
      push();
      cur = '';
      inT = 0; inPh = 0;
      if (t.selfClose) push();
    } else if (t.name === 'rPh') {
      if (!t.selfClose) inPh = Math.max(0, inPh + (t.close ? -1 : 1));
    } else if (t.name === 't') {
      if (!t.selfClose) inT = Math.max(0, inT + (t.close ? -1 : 1));
    }
  }, (raw, cdata) => {
    if (cur !== null && inT > 0 && inPh === 0) cur += cdata ? raw : unescapeXml(raw);
  });
  push();
  return out;
}

function columnIndex(ref: string | undefined): number | null {
  const m = ref ? /^([A-Z]{1,3})\d+$/.exec(ref) : null;
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "worksheets/list.xml" against the workbook's folder "xl/", or an absolute "/xl/…": a path inside the package, or null. */
function resolvePart(base: string, target: string): string | null {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.includes('\\')) return null;
  const parts = target.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

export interface Sheet { rows: string[][]; date1904: boolean }

/** The first worksheet's cells as text, row by row (empty rows kept so row numbers match the spreadsheet). */
export function readXlsx(bytes: Uint8Array): Sheet {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 22 || b.readUInt32LE(0) !== 0x04034b50) throw new SpreadsheetError(NOT_XLSX);
  const all = entries(b);
  const workbook = read(b, all, 'xl/workbook.xml');
  if (workbook === null) throw new SpreadsheetError(NOT_XLSX);
  let date1904 = false;
  let rid: string | null | undefined;
  scan(workbook, (t) => {
    if (t.close) return;
    if (t.name === 'workbookPr') date1904 = ['1', 'true'].includes(t.attrs.get('date1904') ?? '');
    else if (t.name === 'sheet' && rid === undefined) rid = [...t.attrs].find(([k]) => k === 'r:id' || k.endsWith(':id'))?.[1] ?? null;
  }, () => {});
  // The first sheet the workbook declares, through its relationship, and nothing else: a sheet that is external, missing or
  // outside the package refuses the file rather than reading some other sheet.
  const rels = read(b, all, 'xl/_rels/workbook.xml.rels');
  if (!rid || rels === null) throw new SpreadsheetError(NOT_XLSX);
  let rel: Map<string, string> | null = null;
  scan(rels, (t) => { if (!t.close && !rel && t.name === 'Relationship' && t.attrs.get('Id') === rid) rel = t.attrs; }, () => {});
  const found = rel as Map<string, string> | null;
  if (!found || (found.get('TargetMode') ?? '').toLowerCase() === 'external') throw new SpreadsheetError(NOT_XLSX);
  const sheetPath = resolvePart('xl', found.get('Target') ?? '');
  const sheet = sheetPath ? read(b, all, sheetPath) : null;
  if (sheet === null) throw new SpreadsheetError(NOT_XLSX);
  const sharedXml = read(b, all, 'xl/sharedStrings.xml');
  const shared = sharedXml ? sharedStrings(sharedXml) : [];

  const rows: string[][] = [];
  let rowCount = 0;
  let cellCount = 0;
  let row: string[] | null = null;
  let rowIndex = 0;
  let next = 0;
  let cell: { col: number; type: string | undefined } | null = null;
  let v: string | null = null;
  let inV = false;
  let inline: string | null = null;
  let inIs = false;
  let inT = 0;
  let inPh = 0;
  let done = false;
  const endCell = (): void => {
    if (!cell) return;
    if (row && cell.col < MAX_COLUMNS) {
      let text = '';
      if (cell.type === 's') text = v === null ? '' : shared[Number(v.trim())] ?? '';
      else if (cell.type === 'inlineStr') text = inline ?? '';
      else if (cell.type === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else if (cell.type === 'e') text = '';
      else text = v ?? '';
      while (row.length < cell.col) row.push('');
      row[cell.col] = text;
    }
    cell = null; v = null; inV = false; inline = null; inIs = false; inT = 0; inPh = 0;
  };
  const endRow = (): void => {
    endCell();
    if (row) rows[rowIndex] = row;
    row = null;
  };
  const startRow = (attrs: Map<string, string>): void => {
    endRow();
    const r = Number(attrs.get('r'));
    const index = Number.isInteger(r) && r > 0 ? r - 1 : rows.length;
    if (index >= MAX_ROWS) { done = true; return; }
    while (rows.length < index) rows.push([]);
    rowIndex = index;
    row = [];
    next = 0;
  };
  scan(sheet, (t) => {
    // Counted whether or not the row is read, so rows past the last one read still count towards the caps.
    if (!t.close && t.name === 'row' && ++rowCount > MAX_ROW_ELEMENTS) throw new SpreadsheetError(TOO_MANY);
    if (!t.close && t.name === 'c' && ++cellCount > MAX_CELLS) throw new SpreadsheetError(TOO_MANY);
    if (done) return;
    switch (t.name) {
      case 'row':
        if (t.close) endRow();
        else { startRow(t.attrs); if (t.selfClose) endRow(); }
        return;
      case 'c': {
        if (t.close) { endCell(); return; }
        endCell();
        const col = columnIndex(t.attrs.get('r')) ?? next;
        next = col + 1;
        cell = { col, type: t.attrs.get('t') };
        if (t.selfClose) endCell();
        return;
      }
      case 'v':
        if (!cell || t.selfClose) return;
        if (t.close) inV = false; else { inV = true; v = ''; }
        return;
      case 'is':
        if (!cell || t.selfClose) return;
        inIs = !t.close;
        if (!t.close) inline = '';
        return;
      case 'rPh':
        if (!t.selfClose) inPh = Math.max(0, inPh + (t.close ? -1 : 1));
        return;
      case 't':
        if (!t.selfClose) inT = Math.max(0, inT + (t.close ? -1 : 1));
        return;
      default:
    }
  }, (raw, cdata) => {
    if (done || !cell) return;
    const text = cdata ? raw : unescapeXml(raw);
    if (inV && v !== null) v += text;
    else if (inIs && inT > 0 && inPh === 0 && inline !== null) inline += text;
  });
  endRow();
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  while (rows.length && rows[rows.length - 1]!.every((c) => !c.trim())) rows.pop();
  return { rows, date1904 };
}
