import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const getBankAccountsSchema = z.object({
  account_number: z.string().optional()
    .describe('Filter by bank account number (partial match). Omit to return all bank accounts.'),
});

interface BankAccount {
  id: number | string;
  name: string;
  number: string;
}

interface BankSummaryResponse {
  bank_accounts?: BankAccount[];
  accounts?: BankAccount[];
  bank_summary?: BankAccount[];
  [key: string]: unknown;
}

function loadFromEnv(): BankAccount[] | null {
  const raw = process.env.BANK_ACCOUNT_MAPPINGS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BankAccount[];
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchFromApi(): Promise<BankAccount[]> {
  const paths = ['/api/v1/bank_accounts', '/api/v1/bank_summary'];
  let lastError: Error | undefined;
  for (const path of paths) {
    try {
      const data = await jurnalRequest<BankSummaryResponse>('GET', path);
      const accounts = data.bank_accounts ?? data.accounts ?? data.bank_summary ?? [];
      return accounts as BankAccount[];
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}

export async function getBankAccounts(params: z.infer<typeof getBankAccountsSchema>) {
  const envAccounts = loadFromEnv();
  const source = envAccounts ? 'config' : 'api';
  const accounts = envAccounts ?? await fetchFromApi();

  const filtered = params.account_number
    ? accounts.filter(a => String(a.number ?? '').includes(params.account_number!))
    : accounts;

  return {
    source,
    accounts: filtered.map(a => ({
      id: a.id,
      name: a.name,
      account_number: a.number,
    })),
  };
}
