import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const getBankAccountsSchema = z.object({
  account_number: z.string().optional()
    .describe('Filter by bank account number (partial match). Omit to return all bank accounts.'),
});

interface BankAccount {
  id: number | string;
  name?: string;
  number?: string;
  account_no?: string;
  account_number?: string;
  balance?: number;
  currency_code?: string;
  [key: string]: unknown;
}

interface BankSummaryResponse {
  bank_accounts?: BankAccount[];
  accounts?: BankAccount[];
  bank_summary?: BankAccount[];
  [key: string]: unknown;
}

export async function getBankAccounts(params: z.infer<typeof getBankAccountsSchema>) {
  const data = await jurnalRequest<BankSummaryResponse>('GET', '/api/v1/bank_summary');

  // Return the full raw response so field names can be verified against the live API.
  // bank_accounts is the expected key but the actual key may differ.
  const accounts: BankAccount[] = (
    data.bank_accounts ??
    (data as Record<string, unknown>)['accounts'] as BankAccount[] ??
    (data as Record<string, unknown>)['bank_summary'] as BankAccount[] ??
    []
  );

  const filtered = params.account_number
    ? accounts.filter(a => {
        const num = String(a.number ?? a.account_no ?? a.account_number ?? '');
        return num.includes(params.account_number!);
      })
    : accounts;

  return {
    accounts: filtered.map(a => ({
      id: a.id,
      name: a.name,
      account_number: a.number ?? a.account_no ?? (a as Record<string, unknown>)['account_number'],
      balance: a.balance,
      currency: a.currency_code,
    })),
    _raw: data,
  };
}
