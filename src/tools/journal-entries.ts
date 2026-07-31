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

export const updateJournalEntrySchema = z.object({
  id: numericId.describe('Journal entry ID to update'),
  transaction_date: z.string().optional().describe('Entry date in YYYY-MM-DD format'),
  transaction_no: z.string().optional().describe('Entry number'),
  memo: z.string().optional().describe('Memo describing the whole entry. Pass an empty string to clear it.'),
  custom_id: z.string().optional().describe('Your own external reference for this entry'),
  tags: z.array(z.string()).optional().describe('Tags to attach to the entry — replaces the existing tag list'),
  lines: z.array(z.object({
    id: numericId.optional().describe(
      'Existing line ID, from get_journal_entry. REQUIRED to change or remove a line — ' +
      'a line sent without an id is added as a new one.'
    ),
    account_id: numericId.optional().describe(
      'Account ID, from get_accounts. Give either this or account_name, not both.'
    ),
    account_name: z.string().optional().describe(
      'Account name exactly as it appears in Jurnal. Give either this or account_id, not both.'
    ),
    debit: nonNegativeNumber.optional().describe('Debit amount. A line carries a debit or a credit, never both.'),
    credit: nonNegativeNumber.optional().describe('Credit amount. A line carries a debit or a credit, never both.'),
    description: z.string().optional().describe('Line-level description'),
    _destroy: z.boolean().optional().describe('Set true (with id) to delete this line'),
  })).optional().describe(
    'Lines to add, change or remove. This is a partial update, NOT a replacement — but the ' +
    'resulting set of lines (existing lines left alone, plus your adds/changes/removes) must ' +
    'still balance debit = credit; this is checked locally before anything is sent. Call ' +
    'get_journal_entry first to read the existing line IDs.'
  ),
});

export const deleteJournalEntrySchema = z.object({
  id: numericId.describe('Journal entry ID to delete'),
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
  deleted_at?: string | null;
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

export async function updateJournalEntry(params: z.infer<typeof updateJournalEntrySchema>) {
  const { id, lines, ...fields } = params;

  const before = await jurnalRequest<JournalEntriesResponse>('GET', `/api/v1/journal_entries/${id}`);
  const current = (before.journal_entry ?? before) as unknown as JournalEntry;
  if (current.locked === true) {
    throw new Error(
      `Journal entry ${id} (${current.transaction_no ?? 'no number'}) is locked ` +
      `(status "${current.transaction_status?.name}") — Jurnal refuses edits to a locked entry. ` +
      `Reopen the period in the Jurnal UI first.`
    );
  }
  if (current.reconciled === true) {
    throw new Error(
      `Journal entry ${id} (${current.transaction_no ?? 'no number'}) is reconciled — editing it ` +
      `would break the reconciliation. Unreconcile it in the Jurnal UI first.`
    );
  }

  const currentLines = current.transaction_account_lines ?? [];
  let sentLines: Record<string, unknown>[] | undefined;

  if (lines !== undefined) {
    // Validate each incoming line the way create_journal_entry does, then simulate the
    // resulting set of lines — existing ones left alone, plus adds/changes/removes — and
    // check THAT balances. A partial update that looks fine in isolation can still leave
    // the whole entry unbalanced, and Jurnal would either reject it opaquely or, worse,
    // accept a half-written entry.
    const byId = new Map<string, JournalLine>(
      currentLines.filter(l => l.id !== undefined).map(l => [String(l.id), l])
    );
    const destroyedIds = new Set<string>();
    const changedById = new Map<string, Record<string, unknown>>();
    const added: Record<string, unknown>[] = [];
    sentLines = [];

    lines.forEach((line, index) => {
      const n = index + 1;

      if (line._destroy) {
        if (line.id === undefined) {
          throw new Error(`Line ${n}: _destroy requires an id — nothing to remove without one.`);
        }
        if (!byId.has(String(line.id))) {
          throw new Error(`Line ${n}: id ${line.id} is not an existing line on journal entry ${id}.`);
        }
        destroyedIds.add(String(line.id));
        sentLines!.push({ id: line.id, _destroy: true });
        return;
      }

      const isNewLine = line.id === undefined;
      if (!isNewLine && !byId.has(String(line.id))) {
        throw new Error(`Line ${n}: id ${line.id} is not an existing line on journal entry ${id}.`);
      }

      const hasId = line.account_id !== undefined;
      const hasName = line.account_name !== undefined && line.account_name.trim() !== '';
      // A new line must fully specify its account; a changed line may leave it as-is.
      if (isNewLine || hasId || hasName) {
        if (hasId === hasName) {
          throw new Error(
            `Line ${n}: give exactly one of account_id or account_name ` +
            `(got ${hasId ? 'both' : 'neither'}). Use get_accounts to resolve an account_id.`
          );
        }
      }

      const givesAmount = isNewLine || line.debit !== undefined || line.credit !== undefined;
      const debit = line.debit ?? 0;
      const credit = line.credit ?? 0;
      if (givesAmount && (debit > 0) === (credit > 0)) {
        throw new Error(
          `Line ${n}: give exactly one of debit or credit, greater than zero ` +
          `(got debit ${debit}, credit ${credit}). A journal line is one side of the entry.`
        );
      }

      const payload: Record<string, unknown> = {
        ...(line.id !== undefined ? { id: line.id } : {}),
        ...(hasId ? { account_id: line.account_id } : hasName ? { account_name: line.account_name } : {}),
        ...(debit > 0 ? { debit } : credit > 0 ? { credit } : {}),
        ...(line.description !== undefined ? { description: line.description } : {}),
      };
      sentLines!.push(payload);

      if (isNewLine) added.push(payload);
      else changedById.set(String(line.id), payload);
    });

    const resulting: { debit: number; credit: number }[] = [];
    for (const l of currentLines) {
      const key = String(l.id);
      if (destroyedIds.has(key)) continue;
      const change = changedById.get(key);
      const overridesAmount = change && (change.debit !== undefined || change.credit !== undefined);
      resulting.push({
        debit: overridesAmount ? Number(change!.debit ?? 0) : Number(l.debit ?? 0),
        credit: overridesAmount ? Number(change!.credit ?? 0) : Number(l.credit ?? 0),
      });
    }
    for (const a of added) {
      resulting.push({ debit: Number(a.debit ?? 0), credit: Number(a.credit ?? 0) });
    }

    if (resulting.length < 2) {
      throw new Error(
        `Journal entry ${id} would be left with ${resulting.length} line(s) after this update — ` +
        `an entry needs at least two. Nothing was sent.`
      );
    }

    const totalDebit = round2(resulting.reduce((sum, l) => sum + l.debit, 0));
    const totalCredit = round2(resulting.reduce((sum, l) => sum + l.credit, 0));
    if (totalDebit !== totalCredit) {
      throw new Error(
        `This update would leave journal entry ${id} out of balance: total debit ${totalDebit} vs ` +
        `total credit ${totalCredit} (difference ${round2(Math.abs(totalDebit - totalCredit))}). ` +
        `Nothing was sent.`
      );
    }
  }

  const changes: Record<string, unknown> = {};
  if (fields.transaction_date !== undefined) changes['transaction_date'] = fields.transaction_date;
  if (fields.transaction_no !== undefined) changes['transaction_no'] = fields.transaction_no;
  if (fields.memo !== undefined) changes['memo'] = fields.memo;
  if (fields.custom_id !== undefined) changes['custom_id'] = fields.custom_id;
  if (fields.tags !== undefined) changes['tags'] = fields.tags;
  if (sentLines !== undefined) changes['transaction_account_lines_attributes'] = sentLines;

  if (Object.keys(changes).length === 0) {
    throw new Error(`No fields given to update on journal entry ${id}.`);
  }

  const body = { journal_entry: changes };
  try {
    await jurnalRequest('PATCH', `/api/v1/journal_entries/${id}`, undefined, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/40[45]|method not allowed/i.test(message)) throw error;
    await jurnalRequest('PUT', `/api/v1/journal_entries/${id}`, undefined, body);
  }

  // Jurnal answers 200 after silently dropping attributes it does not permit — the same
  // failure mode create_journal_entry already guards against. Read the entry back and
  // report what actually changed.
  const after = await jurnalRequest<JournalEntriesResponse>('GET', `/api/v1/journal_entries/${id}`);
  const updated = (after.journal_entry ?? after) as unknown as JournalEntry;

  const applied: string[] = [];
  const ignored: { field: string; requested: unknown; actual: unknown }[] = [];
  const check = (field: string, requested: unknown, actual: unknown, matches: boolean) => {
    if (matches) applied.push(field);
    else ignored.push({ field, requested, actual });
  };
  if (fields.transaction_date !== undefined) {
    check('transaction_date', fields.transaction_date, updated.transaction_date,
      sameDate(fields.transaction_date, updated.transaction_date));
  }
  if (fields.transaction_no !== undefined) {
    check('transaction_no', fields.transaction_no, updated.transaction_no,
      String(updated.transaction_no) === fields.transaction_no);
  }
  if (fields.memo !== undefined) {
    check('memo', fields.memo, updated.memo, String(updated.memo ?? '') === fields.memo);
  }
  if (fields.custom_id !== undefined) {
    check('custom_id', fields.custom_id, updated.custom_id, String(updated.custom_id ?? '') === fields.custom_id);
  }

  const linesAfter = updated.transaction_account_lines ?? [];

  return {
    ...summarize(updated),
    applied,
    ignored,
    verified: ignored.length === 0,
    ...(lines === undefined ? {} : { lines_before: currentLines.length, lines_after: linesAfter.length }),
  };
}

export async function deleteJournalEntry(params: z.infer<typeof deleteJournalEntrySchema>) {
  // Capture what is about to be destroyed, both to check Jurnal's own lock/reconciliation
  // state and so the caller gets a record of it back — there is no undo here.
  const before = await jurnalRequest<JournalEntriesResponse>('GET', `/api/v1/journal_entries/${params.id}`);
  const entry = (before.journal_entry ?? before) as unknown as JournalEntry;
  if (entry.locked === true) {
    throw new Error(
      `Journal entry ${params.id} (${entry.transaction_no ?? 'no number'}) is locked ` +
      `(status "${entry.transaction_status?.name}") — Jurnal refuses to delete a locked entry. ` +
      `Reopen the period in the Jurnal UI first.`
    );
  }
  if (entry.reconciled === true) {
    throw new Error(
      `Journal entry ${params.id} (${entry.transaction_no ?? 'no number'}) is reconciled — deleting ` +
      `it would break the reconciliation. Unreconcile it in the Jurnal UI first.`
    );
  }

  const deleted = {
    id: entry.id,
    number: entry.transaction_no,
    date: entry.transaction_date,
    memo: entry.memo,
    total_debit: entry.total_debit,
    total_credit: entry.total_credit,
  };

  await jurnalRequest<unknown>('DELETE', `/api/v1/journal_entries/${params.id}`);

  // Confirm it is actually gone: a 200 on DELETE is not proof, and Jurnal soft-deletes
  // some records (`deleted_at`) rather than removing them.
  let gone = false;
  let stillPresent: JournalEntry | undefined;
  try {
    const check = await jurnalRequest<JournalEntriesResponse>('GET', `/api/v1/journal_entries/${params.id}`);
    const found = (check.journal_entry ?? check) as unknown as JournalEntry;
    if (found?.deleted_at) gone = true;
    else stillPresent = found;
  } catch {
    gone = true; // 404 is the expected outcome
  }

  return {
    deleted,
    verified: gone,
    ...(gone ? {} : {
      warning:
        `Jurnal accepted the delete but journal entry ${params.id} is still readable and not marked ` +
        `deleted (status "${stillPresent?.transaction_status?.name}"). Check it in the Jurnal UI.`,
    }),
  };
}
