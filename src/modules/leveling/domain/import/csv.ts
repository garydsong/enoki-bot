/**
 * XP import parsing (roadmap M15, `/xp import`).
 *
 * Pure, and in `domain/` for that reason: the interesting part of an import is
 * deciding what a human's file MEANS, and that deserves to be tested with
 * strings rather than with a database and a Discord attachment.
 *
 * THE DESIGN CONSTRAINT IS THAT THE FILE COMES FROM SOMEWHERE ELSE. A server
 * migrating from Arcane, MEE6, Tatsu or a hand-written spreadsheet has a file
 * whose exact shape we do not control, so the parser is permissive about layout
 * — headers or not, extra columns, quotes, BOM, CRLF, blank lines — and
 * completely unforgiving about VALUES. A misread column silently sets ten
 * thousand members to the wrong level, and the only defence against that is to
 * refuse anything ambiguous.
 */

export interface ParsedXpRow {
  readonly userId: string;
  readonly xp: number;
  /** 1-based line in the original file, for error reporting. */
  readonly line: number;
}

export interface XpImportError {
  readonly line: number;
  readonly reason: string;
  /** The offending text, truncated — echoed back so the admin can find it. */
  readonly text: string;
}

export interface ParsedXpFile {
  readonly rows: readonly ParsedXpRow[];
  readonly errors: readonly XpImportError[];
  /** True when the first line was consumed as column names. */
  readonly hadHeader: boolean;
  readonly idColumn: number;
  readonly xpColumn: number;
}

/** A Discord snowflake: 17–20 digits today, with room either side. */
const SNOWFLAKE = /^\d{15,21}$/;

/** The largest total we will accept. Comfortably inside a JS safe integer. */
export const MAX_IMPORT_XP = 1_000_000_000_000;

const ID_HEADERS = ['user_id', 'userid', 'user id', 'id', 'user', 'member_id', 'memberid', 'discord_id'];
const XP_HEADERS = ['xp', 'total_xp', 'totalxp', 'total xp', 'experience', 'exp', 'points', 'score'];

/**
 * Split one CSV line, honouring double quotes and doubled quotes inside them.
 *
 * Hand-written rather than pulled from a dependency because the grammar we
 * accept is one line of RFC 4180 without embedded newlines, and a parser small
 * enough to read is worth more here than one that handles everything.
 */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/**
 * Guess the delimiter from the first non-empty line.
 *
 * Semicolons matter in practice: Excel writes them when the machine's locale
 * uses a comma as the decimal separator, which is most of Europe, and a
 * semicolon file read as comma-delimited looks like one enormous column.
 */
function detectDelimiter(line: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

export function parseXpCsv(text: string): ParsedXpFile {
  // Strip a UTF-8 BOM: Excel writes one, and it becomes an invisible character
  // glued to the first header, so `user_id` matches nothing. Written as an
  // escape because the literal is, by construction, impossible to see.
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r\n|\n|\r/);

  const firstContent = lines.find((l) => l.trim() !== '' && !l.trimStart().startsWith('#')) ?? '';
  const delimiter = detectDelimiter(firstContent);

  const header = splitCsvLine(firstContent, delimiter).map((h) => h.toLowerCase());
  const headerIdColumn = header.findIndex((h) => ID_HEADERS.includes(h));
  const headerXpColumn = header.findIndex((h) => XP_HEADERS.includes(h));
  const hadHeader = headerIdColumn >= 0 && headerXpColumn >= 0;

  // No recognisable header: assume the two most common export shapes, which
  // both put the id first. The xp column is the SECOND field, not "the first
  // numeric one" — guessing there is how a message count becomes an XP total.
  const idColumn = hadHeader ? headerIdColumn : 0;
  const xpColumn = hadHeader ? headerXpColumn : 1;

  const rows: ParsedXpRow[] = [];
  const errors: XpImportError[] = [];
  const seen = new Map<string, number>();

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = raw.trim();

    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (hadHeader && raw === firstContent) continue;

    const fields = splitCsvLine(raw, delimiter);
    const idText = (fields[idColumn] ?? '').replace(/^["']|["']$/g, '').trim();
    const xpText = (fields[xpColumn] ?? '').trim();

    if (idText === '' && xpText === '') continue;

    // A header we did not RECOGNISE still has to be skipped rather than
    // reported as a broken row — otherwise every import of a file with an
    // unusual column name opens with a confusing error about line 1.
    if (index === 0 && !hadHeader && !SNOWFLAKE.test(idText) && !/^\d/.test(idText)) {
      continue;
    }

    if (!SNOWFLAKE.test(idText)) {
      errors.push({
        line,
        reason: 'not a Discord user id',
        text: truncate(raw),
      });
      continue;
    }

    // Accept "1 234" and "1,234" — a spreadsheet writes thousands separators
    // without being asked. Reject a decimal outright rather than rounding it:
    // a fractional XP total means the column is not what we think it is.
    const normalised = xpText.replace(/[\s,]/g, '');
    if (!/^\d+$/.test(normalised)) {
      errors.push({
        line,
        reason: xpText === '' ? 'no XP value' : `"${truncate(xpText, 30)}" is not a whole number`,
        text: truncate(raw),
      });
      continue;
    }

    const xp = Number(normalised);
    if (xp > MAX_IMPORT_XP) {
      errors.push({ line, reason: `XP above the ${MAX_IMPORT_XP.toExponential()} ceiling`, text: truncate(raw) });
      continue;
    }

    const previous = seen.get(idText);
    if (previous !== undefined) {
      errors.push({
        line,
        reason: `duplicate of line ${previous} — the file names this member twice`,
        text: truncate(raw),
      });
      continue;
    }

    seen.set(idText, line);
    rows.push({ userId: idText, xp, line });
  }

  return { rows, errors, hadHeader, idColumn, xpColumn };
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
