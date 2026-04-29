import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listJournalEntriesSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
  start_date: z.string().optional().describe('Filter from date (YYYY-MM-DD)'),
  end_date: z.string().optional().describe('Filter to date (YYYY-MM-DD)'),
});

interface JournalLine {
  id?: number | string;
  account_name?: string;
  account_code?: string;
  debit?: number;
  credit?: number;
  memo?: string;
  [key: string]: unknown;
}

interface JournalEntry {
  id: number | string;
  transaction_no?: string;
  transaction_date?: string;
  memo?: string;
  journal_lines?: JournalLine[];
  [key: string]: unknown;
}

interface JournalEntriesResponse {
  journal_entries?: JournalEntry[];
  [key: string]: unknown;
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

  const entries = data.journal_entries ?? [];
  return entries.map((e: JournalEntry) => ({
    id: e.id,
    number: e.transaction_no,
    date: e.transaction_date,
    memo: e.memo,
    lines: (e.journal_lines ?? []).map((l: JournalLine) => ({
      account_name: l.account_name,
      account_code: l.account_code,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
  }));
}
