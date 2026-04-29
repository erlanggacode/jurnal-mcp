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

async function fetchBankAccounts(): Promise<{ data: BankSummaryResponse; path: string }> {
  const paths = ['/api/v1/bank_accounts', '/api/v1/bank_summary'];
  let lastError: Error | undefined;
  for (const path of paths) {
    try {
      const data = await jurnalRequest<BankSummaryResponse>('GET', path);
      return { data, path };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}

export async function getBankAccounts(params: z.infer<typeof getBankAccountsSchema>) {
  const { data, path } = await fetchBankAccounts();

  const accounts: BankAccount[] = (
    data.bank_accounts ??
    data.accounts ??
    data.bank_summary ??
    []
  );

  const filtered = params.account_number
    ? accounts.filter(a => {
        const num = String(a.number ?? a.account_no ?? a.account_number ?? '');
        return num.includes(params.account_number!);
      })
    : accounts;

  return {
    endpoint_used: path,
    accounts: filtered.map(a => ({
      id: a.id,
      name: a.name,
      account_number: a.number ?? a.account_no ?? a.account_number,
      balance: a.balance,
      currency: a.currency_code,
    })),
    _raw: data,
  };
}
