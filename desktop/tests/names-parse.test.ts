// Reading pasted and imported name lists: encodings, quotes, commas in names, headers, blank lines, long lines, formula cells,
// emails with plus and capitals, spreadsheet ranges, CSV and XLSX. Fictional names only.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { decodeText, detectDelimiter, detectMapping, normaliseDate, parseDelimited, parsePaste, rowsFromTable, splitPerson } from '../main/names-parse.ts';
import { readXlsx, SpreadsheetError, unescapeXml } from '../main/xlsx-read.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf16le = (s: string, bom = true): Uint8Array => {
  const b = Buffer.from(s, 'utf16le');
  return bom ? new Uint8Array([0xff, 0xfe, ...b]) : new Uint8Array(b);
};
const pick = (rows: Array<{ name: string; email: string }>): string[][] => rows.map((r) => [r.name, r.email]);

describe('encodings', () => {
  test('UTF-8 with and without a BOM, UTF-16 from Excel "Unicode text" (both byte orders, BOM or not), and Windows-1252', () => {
    const text = 'Name\tEmail\r\nZoë Ångström\tzoe@example.ac.uk\r\n';
    expect(decodeText(enc(text))).toBe(text);
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(text)]))).toBe(text);
    expect(decodeText(utf16le(text))).toBe(text);
    expect(decodeText(utf16le(text, false))).toBe(text);
    const be = Buffer.from(text, 'utf16le').swap16();
    expect(decodeText(new Uint8Array([0xfe, 0xff, ...be]))).toBe(text);
    expect(decodeText(new Uint8Array([0x5a, 0x6f, 0xeb, 0x20, 0x93, 0x51, 0x94, 0x80]))).toBe('Zoë “Q”€');
  });
});

describe('pasted lists', () => {
  test('one person per line: "Name, email", "Name <email>", name only, and an email anywhere on the line', () => {
    const p = parsePaste('Aisha Rahman, aisha.rahman@example.ac.uk\nHenrik Olsen\nSofia Marchetti <Sofia.Marchetti@Example.ac.uk>\n"Tom Whitfield" tom+workshop@example.ac.uk\n');
    expect(pick(p.rows)).toEqual([['Aisha Rahman', 'aisha.rahman@example.ac.uk'], ['Henrik Olsen', ''], ['Sofia Marchetti', 'Sofia.Marchetti@Example.ac.uk'], ['Tom Whitfield', 'tom+workshop@example.ac.uk']]);
    expect(p.table).toBeNull();
  });
  test('a comma with no address after it belongs to the name; a broken address stays an address so it can be refused', () => {
    expect(splitPerson('Rahman, Aisha')).toEqual({ name: 'Rahman, Aisha', email: '' });
    expect(splitPerson('Lars Eriksson, lars@')).toEqual({ name: 'Lars Eriksson', email: 'lars@' });
    expect(splitPerson('mailto:yuki@example.ac.uk')).toEqual({ name: '', email: 'yuki@example.ac.uk' });
  });
  test('a header line is skipped, blank lines are kept (and counted), trailing blank lines are dropped, row numbers are line numbers', () => {
    const p = parsePaste('Name, Email\nImogen Pryce\n\nLars Eriksson\n\n\n');
    expect(p.rows.map((r) => [r.row, r.name])).toEqual([[2, 'Imogen Pryce'], [3, ''], [4, 'Lars Eriksson']]);
  });
  test('a range pasted from a spreadsheet (tab-separated) is a table; its header names the columns', () => {
    const p = parsePaste('First name\tSurname\tE-mail\nCallum\tMacLeod\tCALLUM@example.ac.uk\nYuki\tTanaka\t\n');
    expect(p.mapping).toMatchObject({ header: true, first: 0, last: 1, email: 2, name: null });
    expect(pick(p.rows)).toEqual([['Callum MacLeod', 'CALLUM@example.ac.uk'], ['Yuki Tanaka', '']]);
  });
  test('a range with no header: the email column is found by its content, the name column is the first with letters', () => {
    const p = parsePaste('17\tNgozi Adeyemi\tngozi@example.ac.uk\n18\tMateusz Nowak\tmateusz@example.ac.uk\n');
    expect(p.mapping).toMatchObject({ header: false, name: 1, email: 2 });
    expect(p.rows.map((r) => r.row)).toEqual([1, 2]);
  });
  test('comma-separated lines under a header are a table, so a status column is read', () => {
    const p = parsePaste('Name,Email,Status\nPriya Venkataraman,priya@example.ac.uk,Cancelled\n');
    expect(p.rows).toEqual([{ row: 2, name: 'Priya Venkataraman', email: 'priya@example.ac.uk', status: 'Cancelled' }]);
  });
  test('very long lines and formula-looking text are kept as text, never evaluated', () => {
    const long = 'A'.repeat(50_000);
    const p = parsePaste(`${long}\n=HYPERLINK("http://example.invalid","x"), formula@example.ac.uk\n+cmd|' /C calc'!A0\n`);
    expect(p.rows[0]!.name).toHaveLength(50_000);
    expect(p.rows[1]).toMatchObject({ name: '=HYPERLINK http://example.invalid , x', email: 'formula@example.ac.uk' });
    expect(p.rows[2]!.name).toBe("+cmd| /C calc !A0");
  });
});

describe('pasted lists: hostile lines', () => {
  const timed = (text: string): number => { const t0 = performance.now(); parsePaste(text); return performance.now() - t0; };
  const best = (text: string): number => Math.min(timed(text), timed(text), timed(text));
  test('a very long line with no address, and one of many "@", are read in linear time: well under 100 ms, four times the input about four times as long', () => {
    for (const make of [(n: number) => 'A'.repeat(n), (n: number) => '@'.repeat(n), (n: number) => 'a@'.repeat(n / 2), (n: number) => `x${' '.repeat(n)}y`, (n: number) => 'a@b.'.repeat(n / 4)]) {
      const small = make(20_000);
      const large = make(80_000);
      timed(small); timed(large); // warm up
      const a = best(small);
      const b = best(large);
      expect(b).toBeLessThan(100);
      expect(b).toBeLessThan(Math.max(6 * a, 20));
    }
    // The same through the spreadsheet path (tab-separated cells).
    expect(best(`Name\tEmail\n${'A'.repeat(80_000)}\t${'b@'.repeat(40_000)}\n`)).toBeLessThan(100);
  }, 30_000);
  test('a line too long to be a row is kept whole as a name (refused as too long), never scanned for an address', () => {
    const r = splitPerson(`${'A'.repeat(2000)} someone@example.ac.uk`);
    expect(r.email).toBe('');
    expect(r.name.length).toBeGreaterThan(200);
    expect(splitPerson('Ngozi Adeyemi (ngozi@example.ac.uk)')).toEqual({ name: 'Ngozi Adeyemi', email: 'ngozi@example.ac.uk' });
    expect(splitPerson('x@ a@b.c')).toEqual({ name: 'x@', email: 'a@b.c' });
  });
});

describe('CSV', () => {
  test('quotes, commas and line breaks inside quoted cells, doubled quotes, and semicolon files', () => {
    const rows = parseDelimited('Name,Email\r\n"Rahman, Aisha","a@example.ac.uk"\r\n"Tom ""TJ"" Whitfield",tj@example.ac.uk\r\n"Two\nLines",\r\n');
    expect(rows).toEqual([['Name', 'Email'], ['Rahman, Aisha', 'a@example.ac.uk'], ['Tom "TJ" Whitfield', 'tj@example.ac.uk'], ['Two\nLines', '']]);
    expect(detectDelimiter('Name;Email\nA;b@example.ac.uk\n')).toBe(';');
    expect(detectDelimiter('Name,Email\nA,b@example.ac.uk\n')).toBe(',');
  });
  test('booking-export headers map name, email, booking status and date', () => {
    const table = parseDelimited('User Fullname,User Email,Start Date,Status\nFelix Grant,felix@example.ac.uk,06/11/2026 14:00,Booked\n');
    const m = detectMapping(table);
    expect(m).toMatchObject({ header: true, name: 0, email: 1, date: 2, status: 3 });
    expect(rowsFromTable(table, m)).toEqual([{ row: 2, name: 'Felix Grant', email: 'felix@example.ac.uk', status: 'Booked', date: '2026-11-06' }]);
  });
  test('dates: ISO, British day-first, month names, and spreadsheet serials in both date systems', () => {
    expect(normaliseDate('2026-10-30T14:00')).toBe('2026-10-30');
    expect(normaliseDate('30/10/2026')).toBe('2026-10-30');
    expect(normaliseDate('6.11.26')).toBe('2026-11-06');
    expect(normaliseDate('Thu 6 Nov 2026')).toBe('2026-11-06');
    expect(normaliseDate('6-Sept-2026')).toBe('2026-09-06');
    expect(normaliseDate('46325.58333')).toBe('2026-10-30');
    expect(normaliseDate('44863', true)).toBe('2026-10-30');
    for (const bad of ['', 'soon', '31/02/2026', '12', '2026-13-01']) expect(normaliseDate(bad), bad).toBeNull();
  });
});

// A tiny zip writer for hand-made workbooks (shared strings, rich text, refusals); the openpyxl fixture covers a real writer.
function zip(files: Record<string, string>, opts: { lieSize?: number } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const raw = Buffer.from(body, 'utf8');
    const data = deflateRawSync(raw);
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(opts.lieSize ?? raw.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(opts.lieSize ?? raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += local.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
const workbook = '<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="List" sheetId="1" r:id="rId7"/></sheets></workbook>';
const rels = '<Relationships><Relationship Id="rId7" Target="worksheets/list.xml"/></Relationships>';

describe('XLSX', () => {
  test('a workbook saved by a real writer (openpyxl): first sheet, inline strings, dates, a formula cell left unevaluated', () => {
    const sheet = readXlsx(readFileSync(join(import.meta.dir, 'fixtures/names-booking-export.xlsx')));
    expect(sheet.rows[0]).toEqual(['User Fullname', 'User Email', 'Start Date', 'Status']);
    const m = detectMapping(sheet.rows);
    expect(m).toMatchObject({ header: true, name: 0, email: 1, date: 2, status: 3 });
    const rows = rowsFromTable(sheet.rows, m, { date1904: sheet.date1904 });
    expect(rows[0]).toEqual({ row: 2, name: 'Aisha Rahman', email: 'aisha.rahman@example.ac.uk', status: 'Booked', date: '2026-10-30' });
    expect(rows.find((r) => r.row === 5)!.name).toBe('Zoë Ångström');
    expect(rows.find((r) => r.row === 7)!.name).toBe('');
    expect(rows.find((r) => r.row === 9)!.date).toBe('2026-11-06');
    expect(rows.find((r) => r.row === 10)!.name).toBe('Rahman, Aisha & Co');
    // A formula with no saved value reads as empty: it is never calculated. A text cell that starts with "=" stays text.
    expect(rows.find((r) => r.row === 11)!.name).toBe('');
    expect(rows.find((r) => r.row === 12)!.name).toBe('=HYPERLINK("http://example.invalid")');
    expect(sheet.rows.some((r) => r.includes('Not the list'))).toBe(false);
  });
  test('shared strings with rich-text runs and phonetic guides, cells without references, the 1904 date system, the sheet the workbook names', () => {
    const sst = '<sst><si><t>Name</t></si><si><t>Email</t></si><si><r><t>Yuki </t></r><r><t xml:space="preserve">Tanaka</t></r><rPh><t>ユキ</t></rPh></si><si><t>yuki&amp;co@example.ac.uk</t></si></sst>';
    const sheet = '<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c r="D1"><v>44863</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="s"><v>3</v></c><c r="C3" t="b"><v>1</v></c><c r="D3"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>';
    const s = readXlsx(zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': sst, 'xl/worksheets/list.xml': sheet }));
    expect(s.date1904).toBe(true);
    expect(s.rows).toEqual([['Name', 'Email', '', '44863'], [], ['Yuki Tanaka', 'yuki&co@example.ac.uk', 'TRUE', '#DIV/0!']]);
    expect(normaliseDate(s.rows[0]![3]!, s.date1904)).toBe('2026-10-30');
  });
  test('not a workbook, a declared DTD, an external sheet target and an oversized part are refused in plain words', () => {
    expect(() => readXlsx(enc('Name,Email\n'))).toThrow(SpreadsheetError);
    expect(() => readXlsx(zip({ 'xl/workbook.xml': '<!DOCTYPE x [<!ENTITY a "b">]><workbook/>' }))).toThrow('not an Excel workbook');
    const external = '<Relationships><Relationship Id="rId7" Target="http://example.invalid/x.xml" TargetMode="External"/></Relationships>';
    expect(() => readXlsx(zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': external }))).toThrow(SpreadsheetError);
    expect(() => readXlsx(zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/list.xml': '<worksheet/>' }, { lieSize: 64 * 1024 * 1024 }))).toThrow('too large');
    expect(unescapeXml('&lt;a&gt; &#233;&#x1F600; &unknown;')).toBe('<a> é😀 &unknown;');
  });
});

describe('XLSX: hostile files', () => {
  const book = (parts: Record<string, string>): Uint8Array => zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/list.xml': '<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>Name</t></is></c></row></sheetData></worksheet>', ...parts });
  const timed = (bytes: Uint8Array): number => {
    const t0 = performance.now();
    try { readXlsx(bytes); } catch (e) { if (!(e instanceof SpreadsheetError)) throw e; }
    return performance.now() - t0;
  };
  // Timing on a shared CI runner varies several-fold (a Windows runner took 100 ms where a laptop takes 28), so the check
  // is the ratio, best of five warmed runs: four times the input in about four times the time (under six; a pass that
  // searched again from each unclosed tag would take about sixteen). The absolute bounds only catch a pathological
  // slowdown on any machine.
  test('repeated unclosed tags are read in one pass: four times the input takes about four times as long', () => {
    const hostile = (n: number): Uint8Array => book({
      'xl/sharedStrings.xml': '<sst>' + '<si><t>x'.repeat(n),
      'xl/worksheets/list.xml': '<worksheet><sheetData>' + '<row r="1"><c t="s"><v>0'.repeat(n),
    });
    const small = hostile(40_000);
    const large = hostile(160_000);
    timed(small); timed(large); // warm up
    const best = (bytes: Uint8Array) => Math.min(...Array.from({ length: 5 }, () => timed(bytes)));
    const a = best(small);
    const b = best(large);
    expect(a).toBeLessThan(1000);
    expect(b).toBeLessThan(Math.max(6 * a, 25));
    // Tag names that never close at all (no ">") end the part instead of being searched for again: faster than the
    // smaller hostile file above on the same machine (about 1 ms against 28 on a laptop).
    expect(best(book({ 'xl/sharedStrings.xml': '<sst>' + '<si '.repeat(160_000), 'xl/workbook.xml': workbook.replace('<sheets>', '<workbookPr '.repeat(1000) + '<sheets>') }))).toBeLessThan(Math.max(100, a));
  }, 60_000);
  test('markup inside a processing instruction, comment or CDATA is never read as an element: a decoy sheet there is not imported', () => {
    const decoySheet = '<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>Decoy Person</t></is></c></row></sheetData></worksheet>';
    const realFirstExternal = '<Relationships><Relationship Id="decoy" Target="worksheets/decoy.xml"/><Relationship Id="rId7" Target="http://example.invalid/list.xml" TargetMode="External"/></Relationships>';
    for (const hide of [(x: string) => `<?hint > ${x} ?>`, (x: string) => `<!-- > ${x} -->`, (x: string) => `<![CDATA[ > ${x} ]]>`]) {
      const wb = `<workbook xmlns:r="r">${hide('<sheet name="Decoy" r:id="decoy"/>')}<sheets><sheet name="List" sheetId="1" r:id="rId7"/></sheets></workbook>`;
      let rows: string[][] | null = null;
      try { rows = readXlsx(zip({ 'xl/workbook.xml': wb, 'xl/_rels/workbook.xml.rels': realFirstExternal, 'xl/worksheets/decoy.xml': decoySheet })).rows; } catch (e) { expect(e).toBeInstanceOf(SpreadsheetError); }
      expect(rows).toBeNull();
      // The same trick in the relationships part: a hidden relationship never answers for the real one.
      const relsHidden = `<Relationships>${hide('<Relationship Id="rId7" Target="worksheets/decoy.xml"/>')}<Relationship Id="rId7" Target="http://example.invalid/x.xml" TargetMode="External"/></Relationships>`;
      expect(() => readXlsx(zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': relsHidden, 'xl/worksheets/decoy.xml': decoySheet }))).toThrow(SpreadsheetError);
    }
    // An unterminated processing instruction ends the part: nothing after it is read.
    const open = `<workbook xmlns:r="r"><?hint > <sheets><sheet name="List" sheetId="1" r:id="rId7"/></sheets></workbook>`;
    expect(() => readXlsx(zip({ 'xl/workbook.xml': open, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/list.xml': decoySheet }))).toThrow(SpreadsheetError);
  });
  test('far more shared strings or cells than any name list are refused in plain words', () => {
    expect(() => readXlsx(book({ 'xl/sharedStrings.xml': '<sst>' + '<si/>'.repeat(500_001) + '</sst>' }))).toThrow('far more than a name list');
    expect(() => readXlsx(book({ 'xl/worksheets/list.xml': '<worksheet><sheetData><row r="1">' + '<c/>'.repeat(500_001) + '</row></sheetData></worksheet>' }))).toThrow('far more than a name list');
    expect(() => readXlsx(book({ 'xl/worksheets/list.xml': '<worksheet><sheetData>' + '<row/>'.repeat(200_001) + '</sheetData></worksheet>' }))).toThrow('far more than a name list');
  });
  test('the first sheet must be the one its relationship names, inside the package: never a fallback to sheet1.xml', () => {
    const decoy = '<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>Not the list</t></is></c></row></sheetData></worksheet>';
    const withRels = (r: string | null, extra: Record<string, string> = {}): Uint8Array => {
      const parts: Record<string, string> = { 'xl/workbook.xml': workbook, 'xl/worksheets/sheet1.xml': decoy, ...extra };
      if (r !== null) parts['xl/_rels/workbook.xml.rels'] = r;
      return zip(parts);
    };
    const rel = (attrs: string): string => `<Relationships><Relationship Id="rId7" ${attrs}/></Relationships>`;
    for (const bytes of [
      withRels(rel('Target="worksheets/list.xml" TargetMode="External"'), { 'xl/worksheets/list.xml': decoy }),
      withRels(rel('Target="http://example.invalid/list.xml" TargetMode="External"')),
      withRels(rel('Target="http://example.invalid/list.xml"'), { 'xl/http:/example.invalid/list.xml': decoy }),
      withRels(rel('Target="worksheets/missing.xml"')),
      withRels(rel('Target="../../outside.xml"'), { 'outside.xml': decoy }),
      withRels(rel('Target=""')),
      withRels('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      withRels(null),
      zip({ 'xl/workbook.xml': '<workbook><sheets/></workbook>', 'xl/_rels/workbook.xml.rels': rel('Target="worksheets/sheet1.xml"'), 'xl/worksheets/sheet1.xml': decoy }),
    ]) expect(() => readXlsx(bytes)).toThrow(SpreadsheetError);
    // A relative path with "./" or "../" that stays inside the package, and an absolute one, are read.
    const list = '<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>Name</t></is></c></row></sheetData></worksheet>';
    expect(readXlsx(withRels(rel('Target="./worksheets/../worksheets/list.xml"'), { 'xl/worksheets/list.xml': list })).rows).toEqual([['Name']]);
    expect(readXlsx(withRels(rel('Target="/xl/worksheets/list.xml"'), { 'xl/worksheets/list.xml': list })).rows).toEqual([['Name']]);
  });
});
