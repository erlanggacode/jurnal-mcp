import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { numericId, positiveNumber } from '../schema-utils.js';

export const listBankWithdrawalsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
  start_date: z.string().optional().describe('Filter from date (YYYY-MM-DD)'),
  end_date: z.string().optional().describe('Filter to date (YYYY-MM-DD)'),
});

export const getBankWithdrawalSchema = z.object({
  id: numericId.describe('Bank withdrawal ID'),
});

const withdrawalLineFields = {
  account_name: z.string().describe('Expense/equity account name this withdrawal is posted to (e.g. "Prive", "Biaya Lain-lain"). Use get_accounts to find the correct name.'),
  amount: positiveNumber.describe('Amount (debit) for this line'),
  description: z.string().optional().describe('Line item description'),
  line_tax_id: numericId.optional().describe('Tax ID to apply to this line (optional)'),
  line_tax_name: z.string().optional().describe('Tax name to apply to this line (optional, alternative to line_tax_id)'),
};

export const createBankWithdrawalSchema = z.object({
  transaction_date: z.string().describe('Withdrawal date (YYYY-MM-DD)'),
  refund_from_name: z.string().describe('Name of the bank/cash account the money leaves (e.g. "Kas", "BCA 4748"). Use get_accounts or get_bank_accounts to find the correct name.'),
  person_name: z.string().optional().describe('Contact/person name this withdrawal is associated with (optional)'),
  transaction_no: z.string().optional().describe('Withdrawal reference number (optional)'),
  custom_id: z.string().optional().describe('Custom reference ID (optional)'),
  memo: z.string().optional().describe('Withdrawal note/description (optional)'),
  withdrawal_lines_attributes: z.array(z.object(withdrawalLineFields)).describe(
    'Withdrawal line items. Each item needs account_name, amount, and optional description/line_tax.'
  ),
});

export const updateBankWithdrawalSchema = z.object({
  id: numericId.describe('Bank withdrawal ID to update'),
  transaction_date: z.string().optional().describe('Withdrawal date (YYYY-MM-DD)'),
  refund_from_name: z.string().optional().describe('Name of the bank/cash account the money leaves'),
  person_name: z.string().optional().describe('Contact/person name this withdrawal is associated with'),
  transaction_no: z.string().optional().describe('Withdrawal reference number'),
  memo: z.string().optional().describe('Withdrawal note/description'),
  withdrawal_lines_attributes: z.array(z.object({
    id: numericId.optional().describe('Existing line item ID (required when updating an existing line)'),
    ...withdrawalLineFields,
    _destroy: z.boolean().optional().describe('Set to true to delete this line item'),
  })).optional().describe('Withdrawal line items to add or update. Existing lines omitted here are left untouched.'),
});

export const deleteBankWithdrawalSchema = z.object({
  id: numericId.describe('Bank withdrawal ID to delete'),
});

interface WithdrawalLine {
  id?: number | string;
  account_id?: number | string;
  account_name?: string;
  account?: { id?: number | string; name?: string };
  debit?: number;
  amount?: number;
  memo?: string;
  description?: string;
  [key: string]: unknown;
}

interface BankWithdrawal {
  id: number | string;
  transaction_no?: string;
  transaction_date?: string;
  refund_from?: { id?: number | string; name?: string; number?: string };
  person?: { id?: number | string; name?: string };
  memo?: string;
  custom_id?: string | null;
  original_amount?: number;
  transaction_status?: { id?: number | string; name?: string } | string;
  deletable?: boolean;
  editable?: boolean;
  transaction_account_lines?: WithdrawalLine[];
  transaction_account_lines_attributes?: WithdrawalLine[];
  [key: string]: unknown;
}

interface BankWithdrawalsResponse {
  bank_withdrawals?: BankWithdrawal[];
  bank_withdrawal?: BankWithdrawal;
  [key: string]: unknown;
}

/** Jurnal returns lines under `transaction_account_lines` on read, but writes use the
 * Rails-standard `transaction_account_lines_attributes` — the same asymmetry as expenses. */
function mapWithdrawalLines(withdrawal: BankWithdrawal) {
  const lines = withdrawal.transaction_account_lines ?? withdrawal.transaction_account_lines_attributes ?? [];
  return lines.map((l: WithdrawalLine) => ({
    id: l.id,
    account_id: l.account_id ?? l.account?.id,
    account_name: l.account_name ?? l.account?.name,
    amount: l.debit ?? l.amount,
    description: l.description ?? l.memo,
  }));
}

function statusName(status: BankWithdrawal['transaction_status']): string | undefined {
  if (status && typeof status === 'object') return status.name;
  return status;
}

export async function listBankWithdrawals(params: z.infer<typeof listBankWithdrawalsSchema>) {
  const queryParams: Record<string, string | number | boolean> = {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  };
  if (params.start_date) queryParams['start_date'] = params.start_date;
  if (params.end_date) queryParams['end_date'] = params.end_date;

  const data = await jurnalRequest<BankWithdrawalsResponse>('GET', '/api/v1/bank_withdrawals', queryParams);

  const withdrawals = data.bank_withdrawals ?? [];
  return withdrawals.map((w: BankWithdrawal) => ({
    id: w.id,
    number: w.transaction_no,
    date: w.transaction_date,
    from_account: w.refund_from?.name,
    person: w.person?.name,
    amount: w.original_amount,
    memo: w.memo,
    status: statusName(w.transaction_status),
  }));
}

export async function getBankWithdrawal(params: z.infer<typeof getBankWithdrawalSchema>) {
  const data = await jurnalRequest<BankWithdrawalsResponse>('GET', `/api/v1/bank_withdrawals/${params.id}`);
  const withdrawal = data.bank_withdrawal ?? data as unknown as BankWithdrawal;
  return {
    id: withdrawal.id,
    number: withdrawal.transaction_no,
    date: withdrawal.transaction_date,
    from_account: withdrawal.refund_from?.name,
    from_account_id: withdrawal.refund_from?.id,
    person: withdrawal.person?.name,
    amount: withdrawal.original_amount,
    memo: withdrawal.memo,
    custom_id: withdrawal.custom_id,
    status: statusName(withdrawal.transaction_status),
    editable: withdrawal.editable,
    deletable: withdrawal.deletable,
    lines: mapWithdrawalLines(withdrawal),
  };
}

export async function createBankWithdrawal(params: z.infer<typeof createBankWithdrawalSchema>) {
  const body = {
    bank_withdrawal: {
      transaction_date: params.transaction_date,
      refund_from_name: params.refund_from_name,
      ...(params.person_name ? { person_name: params.person_name } : {}),
      ...(params.transaction_no ? { transaction_no: params.transaction_no } : {}),
      ...(params.custom_id ? { custom_id: params.custom_id } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      transaction_account_lines_attributes: params.withdrawal_lines_attributes.map(line => ({
        account_name: line.account_name,
        debit: line.amount,
        ...(line.description ? { description: line.description } : {}),
        ...(line.line_tax_id !== undefined ? { line_tax_id: line.line_tax_id } : {}),
        ...(line.line_tax_name ? { line_tax_name: line.line_tax_name } : {}),
      })),
    },
  };

  const data = await jurnalRequest<BankWithdrawalsResponse>('POST', '/api/v1/bank_withdrawals', undefined, body);
  const withdrawal = data.bank_withdrawal ?? data as unknown as BankWithdrawal;
  return {
    id: withdrawal.id,
    number: withdrawal.transaction_no,
    date: withdrawal.transaction_date,
    amount: withdrawal.original_amount,
  };
}

export async function updateBankWithdrawal(params: z.infer<typeof updateBankWithdrawalSchema>) {
  const { id, ...fields } = params;
  const withdrawalBody: Record<string, unknown> = {};

  if (fields.transaction_date) withdrawalBody['transaction_date'] = fields.transaction_date;
  if (fields.refund_from_name) withdrawalBody['refund_from_name'] = fields.refund_from_name;
  if (fields.person_name) withdrawalBody['person_name'] = fields.person_name;
  if (fields.transaction_no) withdrawalBody['transaction_no'] = fields.transaction_no;
  if (fields.memo !== undefined) withdrawalBody['memo'] = fields.memo;
  if (fields.withdrawal_lines_attributes) {
    withdrawalBody['transaction_account_lines_attributes'] = fields.withdrawal_lines_attributes.map(line => ({
      ...(line.id ? { id: line.id } : {}),
      account_name: line.account_name,
      debit: line.amount,
      ...(line.description ? { description: line.description } : {}),
      ...(line.line_tax_id !== undefined ? { line_tax_id: line.line_tax_id } : {}),
      ...(line.line_tax_name ? { line_tax_name: line.line_tax_name } : {}),
      ...(line._destroy ? { _destroy: true } : {}),
    }));
  }

  // Method is not documented; PATCH first, fall back to PUT if it is rejected — same
  // resilience bills, invoices, orders, journal entries and expenses already have.
  const body = { bank_withdrawal: withdrawalBody };
  let data: BankWithdrawalsResponse;
  try {
    data = await jurnalRequest<BankWithdrawalsResponse>('PATCH', `/api/v1/bank_withdrawals/${id}`, undefined, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/40[45]|method not allowed/i.test(message)) throw error;
    data = await jurnalRequest<BankWithdrawalsResponse>('PUT', `/api/v1/bank_withdrawals/${id}`, undefined, body);
  }
  const withdrawal = data.bank_withdrawal ?? data as unknown as BankWithdrawal;
  return {
    id: withdrawal.id,
    number: withdrawal.transaction_no,
    date: withdrawal.transaction_date,
    amount: withdrawal.original_amount,
  };
}

export async function deleteBankWithdrawal(params: z.infer<typeof deleteBankWithdrawalSchema>) {
  await jurnalRequest<unknown>('DELETE', `/api/v1/bank_withdrawals/${params.id}`);
  return { success: true, deleted_id: params.id };
}
