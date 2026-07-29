import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { numericId, nonNegativeNumber } from '../schema-utils.js';
import { extractList } from '../response-utils.js';

export const listJournalEntriesSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
  start_date: z.string().optional().describe('Filter from date (YYYY-MM-DD)'),
  end_date: z.string().optional().describe('Filter to date (YYYY-MM-DD)'),
});

export const getJournalEntrySchema = z.object({
  id: numericId.describe('Journal entry ID'),
});

export const createJournalEntrySchema = z.object({
  transaction_date: z.string().describe('Entry date in YYYY-MM-DD format'),
  transaction_no: z.string().optional().describe('Entry number (optional; Jurnal assigns the next one when omitted)'),
  memo: z.string().optional().describe('Memo describing the whole entry'),
  custom_id: z.string().optional().describe('Your own external reference for this entry (optional)'),
  tags: z.array(z.string()).optional().describe('Tags to attach to the entry'),
  lines: z.array(z.object({
    account_id: numericId.optional().describe(
      'Account ID, from get_accounts. Give either this or account_name, not both.'
    ),
    account_name: z.string().optional().describe(
      'Account name exactly as it appears in Jurnal. Give either this or account_id, not both. ' +
      'account_id is safer — a name that does not match is rejected by Jurnal.'
    ),
    debit: nonNegativeNumber.optional().describe('Debit amount. A line carries a debit or a credit, never both.'),
    credit: nonNegativeNumber.optional().describe('Credit amount. A line carries a debit or a credit, never both.'),
    description: z.string().optional().describe('Line-level description (optional)'),
  })).min(2).describe(
    'The lines of the entry, at least two. Each line names one account and carries either a ' +
    'debit or a credit. Total debit must equal total credit — Jurnal rejects an unbalanced entry.'
  ),
});

interface JournalAccount {
  id?: number | string;
  name?: string;
  number?: string;
  [key: string]: unknown;
}

interface JournalLine {
  id?: number | string;
  account?: JournalAccount;
  description?: string | null;
  debit?: number | string;
  credit?: number | string;
  [key: string]: unknown;
}

interface JournalEntry {
  id: number | string;
  transaction_no?: string;
  transaction_date?: string;
  memo?: string;
  custom_id?: string | null;
  transaction_status?: { id?: number; name?: string; name_bahasa?: string };
  transaction_account_lines?: JournalLine[];
  total_debit?: number | string;
  total_credit?: number | string;
  tags_string?: string;
  locked?: boolean;
  reconciled?: boolean;
  [key: string]: unknown;
}

interface JournalEntriesResponse {
  journal_entries?: JournalEntry[];
  journal_entry?: JournalEntry;
  [key: string]: unknown;
}

/**
 * Jurnal returns journal lines under `transaction_account_lines` — the read counterpart of
 * the `transaction_account_lines_attributes` key writes use. This tool used to read
 * `journal_lines`, a key the API never sends, so every entry reported an empty line list
 * and an entry with lines was indistinguishable from one without.
 */
function mapLines(entry: JournalEntry) {
  return (entry.transaction_account_lines ?? []).map((l: JournalLine) => ({
    id: l.id,
    account_id: l.account?.id,
    account_name: l.account?.name,
    account_number: l.account?.number,
    debit: l.debit,
    credit: l.credit,
    description: l.description ?? undefined,
  }));
}

function summarize(entry: JournalEntry) {
  return {
    id: entry.id,
    number: entry.transaction_no,
    date: entry.transaction_date,
    memo: entry.memo,
    custom_id: entry.custom_id ?? undefined,
    status: entry.transaction_status?.name,
    total_debit: entry.total_debit,
    total_credit: entry.total_credit,
    tags: entry.tags_string,
    locked: entry.locked,
    reconciled: entry.reconciled,
    lines: mapLines(entry),
  };
}

export async function listJournalEntries(params: z.infer<typeof listJournalEntriesSchema>) {
  const queryParams: Record<string, string | number | boolean> = {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  };
  if (params.start_date) queryParams['start_date'] = params.start_date;
  if (params.end_date) queryParams['end_date'] = params.end_date;

  const data = await jurnalRequest<JournalEntriesResponse>('GET', '/api/v1/journal_entries', queryParams);

  const entries = extractList<JournalEntry>(data, 'GET /api/v1/journal_entries', ['journal_entries', 'data']);
  return entries.map((e: JournalEntry) => ({
    id: e.id,
    number: e.transaction_no,
    date: e.transaction_date,
    memo: e.memo,
    total_debit: e.total_debit,
    total_credit: e.total_credit,
    lines: mapLines(e),
  }));
}

export async function getJournalEntry(params: z.infer<typeof getJournalEntrySchema>) {
  const data = await jurnalRequest<JournalEntriesResponse>('GET', `/api/v1/journal_entries/${params.id}`);
  const entry = data.journal_entry ?? (data as unknown as JournalEntry);
  return summarize(entry);
}

/** Jurnal accepts YYYY-MM-DD on the way in but answers with DD/MM/YYYY. */
function sameDate(sent: string, returned: unknown): boolean {
  if (typeof returned !== 'string') return false;
  const dmy = returned.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  return (dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : returned) === sent;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function createJournalEntry(params: z.infer<typeof createJournalEntrySchema>) {
  // Validate the entry here rather than letting Jurnal decide. An unbalanced or
  // half-specified entry comes back as an opaque API error, and — worse — a line whose
  // account Jurnal cannot resolve is dropped by strong params while the request still
  // answers 2xx, leaving a real but wrong entry in the books.
  const lines = params.lines.map((line, index) => {
    const n = index + 1;
    const hasId = line.account_id !== undefined;
    const hasName = line.account_name !== undefined && line.account_name.trim() !== '';
    if (hasId === hasName) {
      throw new Error(
        `Line ${n}: give exactly one of account_id or account_name ` +
        `(got ${hasId ? 'both' : 'neither'}). Use get_accounts to resolve an account_id.`
      );
    }

    const debit = line.debit ?? 0;
    const credit = line.credit ?? 0;
    if ((debit > 0) === (credit > 0)) {
      throw new Error(
        `Line ${n}: give exactly one of debit or credit, greater than zero ` +
        `(got debit ${debit}, credit ${credit}). A journal line is one side of the entry.`
      );
    }

    return {
      ...(hasId ? { account_id: line.account_id } : { account_name: line.account_name }),
      ...(debit > 0 ? { debit } : { credit }),
      ...(line.description ? { description: line.description } : {}),
    };
  });

  const totalDebit = round2(params.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0));
  const totalCredit = round2(params.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0));
  if (totalDebit !== totalCredit) {
    throw new Error(
      `Journal entry is out of balance: total debit ${totalDebit} vs total credit ${totalCredit} ` +
      `(difference ${round2(Math.abs(totalDebit - totalCredit))}). Jurnal requires debit to equal ` +
      `credit; nothing was sent.`
    );
  }

  const body = {
    journal_entry: {
      transaction_date: params.transaction_date,
      ...(params.transaction_no ? { transaction_no: params.transaction_no } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      ...(params.custom_id ? { custom_id: params.custom_id } : {}),
      ...(params.tags && params.tags.length > 0 ? { tags: params.tags } : {}),
      transaction_account_lines_attributes: lines,
    },
  };

  const created = await jurnalRequest<JournalEntriesResponse>('POST', '/api/v1/journal_entries', undefined, body);
  const entry = created.journal_entry ?? (created as unknown as JournalEntry);
  if (entry?.id === undefined) {
    throw new Error(
      `Jurnal accepted the journal entry but returned no id. Response keys: ` +
      `[${Object.keys(created ?? {}).join(', ')}].`
    );
  }

  // Read it back: a 2xx from Jurnal is not evidence the payload landed.
  const after = await jurnalRequest<JournalEntriesResponse>('GET', `/api/v1/journal_entries/${entry.id}`);
  const saved = after.journal_entry ?? (after as unknown as JournalEntry);
  const savedLines = saved.transaction_account_lines ?? [];

  if (savedLines.length === 0) {
    throw new Error(
      `Journal entry ${entry.id} (${saved.transaction_no ?? 'no number'}) was created but saved with ` +
      `no lines — Jurnal dropped all ${lines.length} of them. The entry exists and is wrong: delete it ` +
      `in Jurnal. Check that every account_id/account_name in the request resolves to a real account.`
    );
  }

  const ignored: { field: string; requested: unknown; actual: unknown }[] = [];
  const check = (field: string, requested: unknown, actual: unknown, matches: boolean) => {
    if (!matches) ignored.push({ field, requested, actual });
  };

  check('transaction_date', params.transaction_date, saved.transaction_date,
    sameDate(params.transaction_date, saved.transaction_date));
  if (params.transaction_no !== undefined) {
    check('transaction_no', params.transaction_no, saved.transaction_no,
      String(saved.transaction_no) === params.transaction_no);
  }
  if (params.memo !== undefined) {
    check('memo', params.memo, saved.memo, String(saved.memo ?? '') === params.memo);
  }
  check('lines', lines.length, savedLines.length, savedLines.length === lines.length);
  check('total_debit', totalDebit, saved.total_debit, round2(Number(saved.total_debit ?? 0)) === totalDebit);
  check('total_credit', totalCredit, saved.total_credit, round2(Number(saved.total_credit ?? 0)) === totalCredit);

  return {
    ...summarize(saved),
    verified: ignored.length === 0,
    ignored,
  };
}
