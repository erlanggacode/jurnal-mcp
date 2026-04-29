import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const getAccountsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(50).describe('Number of results per page'),
  account_type: z.string().optional().describe('Filter by account type (e.g. bank, cash, receivable)'),
});

interface Account {
  id: number | string;
  name?: string;
  number?: string;
  code?: string;
  account_type?: string;
  category?: string;
  balance?: number;
  is_cash_bank?: boolean;
  [key: string]: unknown;
}

interface AccountsResponse {
  accounts?: Account[];
  [key: string]: unknown;
}

export async function getAccounts(params: z.infer<typeof getAccountsSchema>) {
  const queryParams: Record<string, string | number | boolean> = {
    page: params.page,
    page_size: params.page_size,
  };
  if (params.account_type) queryParams['account_type'] = params.account_type;

  const data = await jurnalRequest<AccountsResponse>('GET', '/api/v1/accounts', queryParams);

  const accounts = data.accounts ?? [];
  return {
    accounts: accounts.map((a: Account) => ({
      id: a.id,
      name: a.name,
      number: a.number ?? a.code,
      account_type: a.account_type ?? a.category,
      balance: a.balance,
      is_cash_bank: a.is_cash_bank,
    })),
    _raw_keys: data.accounts ? undefined : Object.keys(data),
  };
}
