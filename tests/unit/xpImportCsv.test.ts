import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_XP,
  parseXpCsv,
  splitCsvLine,
} from '../../src/modules/leveling/domain/import/csv.js';

/**
 * The import parser's job is to read a file WE DID NOT WRITE.
 *
 * Every case here is a real shape someone's export actually has — Excel's BOM
 * and semicolons, MEE6's extra columns, a hand-edited file with a blank line in
 * the middle — plus the ones that must be refused, because the expensive
 * failure is not "the import errored" but "the import read the wrong column and
 * silently set ten thousand members to their message count".
 */

const A = '111111111111111111';
const B = '222222222222222222';

describe('splitCsvLine', () => {
  it('splits on the delimiter', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a delimiter that is inside quotes', () => {
    expect(splitCsvLine('1,"Smith, John",300')).toEqual(['1', 'Smith, John', '300']);
  });

  it('understands a doubled quote as an escaped one', () => {
    expect(splitCsvLine('1,"say ""hi""",5')).toEqual(['1', 'say "hi"', '5']);
  });

  it('yields an empty field for an empty column', () => {
    expect(splitCsvLine('1,,3')).toEqual(['1', '', '3']);
  });

  it('takes an alternative delimiter', () => {
    expect(splitCsvLine('1;2;3', ';')).toEqual(['1', '2', '3']);
  });
});

describe('parseXpCsv', () => {
  it('reads the simplest possible file', () => {
    const result = parseXpCsv(`user_id,xp\n${A},500\n${B},250\n`);
    expect(result.hadHeader).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { userId: A, xp: 500, line: 2 },
      { userId: B, xp: 250, line: 3 },
    ]);
  });

  it('reads a file with NO header', () => {
    const result = parseXpCsv(`${A},500\n${B},250`);
    expect(result.hadHeader).toBe(false);
    expect(result.rows.map((r) => r.userId)).toEqual([A, B]);
  });

  it('finds the columns by name wherever they are', () => {
    // MEE6-shaped: the useful columns are third and fifth.
    const result = parseXpCsv(`rank,username,user_id,messages,total_xp\n1,alice,${A},900,4200`);
    expect(result.idColumn).toBe(2);
    expect(result.xpColumn).toBe(4);
    expect(result.rows).toEqual([{ userId: A, xp: 4200, line: 2 }]);
  });

  it('accepts the aliases other bots actually use', () => {
    for (const header of ['id,xp', 'userid,exp', 'member_id,points', 'discord_id,score']) {
      const result = parseXpCsv(`${header}\n${A},7`);
      expect(result.rows, header).toEqual([{ userId: A, xp: 7, line: 2 }]);
    }
  });

  it('survives Excel: a BOM, CRLF and semicolons', () => {
    const result = parseXpCsv(`\uFEFFuser_id;xp\r\n${A};1200\r\n`);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([{ userId: A, xp: 1200, line: 2 }]);
  });

  it('accepts thousands separators, because spreadsheets write them', () => {
    expect(parseXpCsv(`user_id,xp\n${A},"1,234"`).rows[0]?.xp).toBe(1234);
    expect(parseXpCsv(`user_id,xp\n${A},"1 234"`).rows[0]?.xp).toBe(1234);
  });

  it('ignores blank lines and # comments', () => {
    const result = parseXpCsv(`user_id,xp\n\n# exported 2026-01-01\n${A},10\n\n`);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('skips an unrecognised header instead of calling line 1 broken', () => {
    // The columns are in the default positions but named something we do not
    // know. Reporting "line 1: not a Discord user id" would be technically
    // true and completely unhelpful.
    const result = parseXpCsv(`snowflake,punten\n${A},10`);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([{ userId: A, xp: 10, line: 2 }]);
  });

  // --- the refusals --------------------------------------------------------

  it('refuses a row whose id is not a snowflake, naming the line', () => {
    const result = parseXpCsv(`user_id,xp\nalice,500\n${A},10`);
    expect(result.rows).toEqual([{ userId: A, xp: 10, line: 3 }]);
    expect(result.errors).toEqual([
      { line: 2, reason: 'not a Discord user id', text: 'alice,500' },
    ]);
  });

  it('refuses a DECIMAL rather than rounding it', () => {
    // A fractional XP total means the column is not what we think it is —
    // rounding would turn a misread into a successful, wrong import.
    const result = parseXpCsv(`user_id,xp\n${A},12.5`);
    expect(result.rows).toEqual([]);
    expect(result.errors[0]?.reason).toContain('not a whole number');
  });

  it('refuses a negative value', () => {
    const result = parseXpCsv(`user_id,xp\n${A},-5`);
    expect(result.rows).toEqual([]);
    expect(result.errors[0]?.reason).toContain('not a whole number');
  });

  it('refuses a value beyond the ceiling', () => {
    const result = parseXpCsv(`user_id,xp\n${A},${MAX_IMPORT_XP + 1}`);
    expect(result.rows).toEqual([]);
    expect(result.errors[0]?.reason).toContain('ceiling');
  });

  it('refuses a missing XP value', () => {
    const result = parseXpCsv(`user_id,xp\n${A},`);
    expect(result.errors[0]?.reason).toBe('no XP value');
  });

  it('KEEPS THE FIRST of a duplicated member and names the earlier line', () => {
    // Two rows for one member is ambiguous — "set" cannot mean both — so the
    // second is an error rather than a silent last-write-wins.
    const result = parseXpCsv(`user_id,xp\n${A},100\n${A},900`);
    expect(result.rows).toEqual([{ userId: A, xp: 100, line: 2 }]);
    expect(result.errors[0]?.reason).toContain('duplicate of line 2');
  });

  it('reports every bad row rather than stopping at the first', () => {
    const result = parseXpCsv(`user_id,xp\nx,1\ny,2\n${A},3`);
    expect(result.errors).toHaveLength(2);
    expect(result.rows).toHaveLength(1);
  });

  it('returns nothing at all for an empty file', () => {
    expect(parseXpCsv('').rows).toEqual([]);
    expect(parseXpCsv('   \n\n').rows).toEqual([]);
  });

  it('does not treat a lone header as data', () => {
    expect(parseXpCsv('user_id,xp\n').rows).toEqual([]);
  });

  it('truncates a very long line in the error, so one bad row cannot flood the reply', () => {
    const result = parseXpCsv(`user_id,xp\n${'z'.repeat(500)},1`);
    expect(result.errors[0]?.text.length).toBeLessThanOrEqual(80);
  });
});
