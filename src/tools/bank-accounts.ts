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
  balance?: number;
  currency_code?: string;
  [key: string]: unknown;
}

interface BankSummaryResponse {
  bank_accounts?: BankAccount[];
  [key: string]: unknown;
}

export async function getBankAccounts(params: z.infer<typeof getBankAccountsSchema>) {
  const data = await jurnalRequest<BankSummaryResponse>('GET', '/api/v1/bank_summary');
  const accounts = data.bank_accounts ?? [];

  const filtered = params.account_number
    ? accounts.filter(a =>
        String(a.number ?? a.account_no ?? '').includes(params.account_number!)
      )
    : accounts;

  return filtered.map(a => ({
    id: a.id,
    name: a.name,
    account_number: a.number ?? a.account_no,
    balance: a.balance,
    currency: a.currency_code,
  }));
}
