import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listExpensesSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
  start_date: z.string().optional().describe('Filter from date (YYYY-MM-DD)'),
  end_date: z.string().optional().describe('Filter to date (YYYY-MM-DD)'),
});

export const getExpenseSchema = z.object({
  id: z.number().int().positive().describe('Expense ID'),
});

export const createExpenseSchema = z.object({
  transaction_date: z.string().describe('Expense date (YYYY-MM-DD)'),
  payment_account_id: z.number().int().positive().describe('ID of the bank/cash account used to pay. Use get_accounts to find the correct ID.'),
  payment_method_id: z.number().int().positive().describe('Payment method ID (e.g. Transfer Bank). Use get_payment_methods to find the correct ID.'),
  payment_method_name: z.string().optional().describe('Payment method name (e.g. "Transfer Bank"). Use get_payment_methods to find the correct name.'),
  transaction_no: z.string().optional().describe('Expense reference number (optional)'),
  memo: z.string().optional().describe('Expense note/description (optional)'),
  tags_string: z.string().optional().describe('Comma-separated list of tags to attach (e.g. "marketing,travel,office")'),
  expense_lines_attributes: z.array(z.object({
    account_id: z.number().int().positive().describe('Expense account ID'),
    amount: z.number().positive().describe('Amount for this line'),
    memo: z.string().optional().describe('Line item description'),
  })).describe('Expense line items. Each item needs account_id (expense account from get_accounts), amount, and optional memo.'),
});

export const updateExpenseSchema = z.object({
  id: z.number().int().positive().describe('Expense ID to update'),
  transaction_date: z.string().optional().describe('Expense date (YYYY-MM-DD)'),
  payment_account_id: z.number().int().positive().optional().describe('ID of the bank/cash account used to pay'),
  payment_method_id: z.number().int().positive().optional().describe('Payment method ID. Use get_payment_methods to find the correct ID.'),
  payment_method_name: z.string().optional().describe('Payment method name (e.g. "Transfer Bank")'),
  transaction_no: z.string().optional().describe('Expense reference number'),
  memo: z.string().optional().describe('Expense note/description'),
  tags_string: z.string().optional().describe('Comma-separated list of tags (e.g. "marketing,travel"). Replaces all existing tags. Pass empty string to remove all tags.'),
  expense_lines_attributes: z.array(z.object({
    id: z.number().int().optional().describe('Existing line item ID (required when updating an existing line)'),
    account_id: z.number().int().positive().describe('Expense account ID'),
    amount: z.number().positive().describe('Amount for this line'),
    memo: z.string().optional().describe('Line item description'),
    _destroy: z.boolean().optional().describe('Set to true to delete this line item'),
  })).optional().describe('Expense line items to update'),
});

export const deleteExpenseSchema = z.object({
  id: z.number().int().positive().describe('Expense ID to delete'),
});

interface ExpenseLine {
  id?: number | string;
  account_id?: number | string;
  account_name?: string;
  amount?: number;
  memo?: string;
  [key: string]: unknown;
}

interface Tag {
  id?: number | string;
  name?: string;
  [key: string]: unknown;
}

interface Expense {
  id: number | string;
  transaction_no?: string;
  transaction_date?: string;
  payment_account_name?: string;
  payment_account_id?: number | string;
  memo?: string;
  amount?: number;
  status?: string;
  tags?: Tag[];
  tags_string?: string;
  expense_lines?: ExpenseLine[];
  [key: string]: unknown;
}

interface ExpensesResponse {
  expenses?: Expense[];
  expense?: Expense;
  [key: string]: unknown;
}

export async function listExpenses(params: z.infer<typeof listExpensesSchema>) {
  const queryParams: Record<string, string | number | boolean> = {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  };
  if (params.start_date) queryParams['start_date'] = params.start_date;
  if (params.end_date) queryParams['end_date'] = params.end_date;

  const data = await jurnalRequest<ExpensesResponse>('GET', '/api/v1/expenses', queryParams);

  const expenses = data.expenses ?? [];
  return {
    expenses: expenses.map((e: Expense) => ({
      id: e.id,
      number: e.transaction_no,
      date: e.transaction_date,
      payment_account: e.payment_account_name,
      amount: e.amount,
      memo: e.memo,
      status: e.status,
      tags: (e.tags ?? []).map((t: Tag) => t.name),
    })),
    _raw_keys: data.expenses ? undefined : Object.keys(data),
  };
}

export async function getExpense(params: z.infer<typeof getExpenseSchema>) {
  const data = await jurnalRequest<ExpensesResponse>('GET', `/api/v1/expenses/${params.id}`);
  const expense = data.expense ?? data as unknown as Expense;
  return {
    id: expense.id,
    number: expense.transaction_no,
    date: expense.transaction_date,
    payment_account: expense.payment_account_name,
    payment_account_id: expense.payment_account_id,
    amount: expense.amount,
    memo: expense.memo,
    status: expense.status,
    tags: (expense.tags ?? []).map((t: Tag) => t.name),
    tags_string: expense.tags_string,
    lines: (expense.expense_lines ?? []).map((l: ExpenseLine) => ({
      id: l.id,
      account_id: l.account_id,
      account_name: l.account_name,
      amount: l.amount,
      memo: l.memo,
    })),
  };
}

export async function createExpense(params: z.infer<typeof createExpenseSchema>) {
  const body = {
    expense: {
      transaction_date: params.transaction_date,
      payment_account_id: params.payment_account_id,
      payment_method_id: params.payment_method_id,
      ...(params.payment_method_name ? { payment_method_name: params.payment_method_name } : {}),
      ...(params.transaction_no ? { transaction_no: params.transaction_no } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      ...(params.tags_string !== undefined ? { tags_string: params.tags_string } : {}),
      transaction_account_lines_attributes: params.expense_lines_attributes.map(line => ({
        account_id: line.account_id,
        amount: line.amount,
        ...(line.memo ? { memo: line.memo } : {}),
      })),
    },
  };

  const data = await jurnalRequest<ExpensesResponse>('POST', '/api/v1/expenses', undefined, body);
  const expense = data.expense ?? data as unknown as Expense;
  return {
    id: expense.id,
    number: expense.transaction_no,
    date: expense.transaction_date,
    amount: expense.amount,
  };
}

export async function updateExpense(params: z.infer<typeof updateExpenseSchema>) {
  const { id, ...fields } = params;
  const expenseBody: Record<string, unknown> = {};

  if (fields.transaction_date) expenseBody['transaction_date'] = fields.transaction_date;
  if (fields.payment_account_id) expenseBody['payment_account_id'] = fields.payment_account_id;
  if (fields.payment_method_id) expenseBody['payment_method_id'] = fields.payment_method_id;
  if (fields.payment_method_name) expenseBody['payment_method_name'] = fields.payment_method_name;
  if (fields.transaction_no) expenseBody['transaction_no'] = fields.transaction_no;
  if (fields.memo !== undefined) expenseBody['memo'] = fields.memo;
  if (fields.tags_string !== undefined) expenseBody['tags_string'] = fields.tags_string;
  if (fields.expense_lines_attributes) {
    expenseBody['transaction_account_lines_attributes'] = fields.expense_lines_attributes.map(line => ({
      ...(line.id ? { id: line.id } : {}),
      account_id: line.account_id,
      amount: line.amount,
      ...(line.memo ? { memo: line.memo } : {}),
      ...(line._destroy ? { _destroy: true } : {}),
    }));
  }

  const data = await jurnalRequest<ExpensesResponse>('PUT', `/api/v1/expenses/${id}`, undefined, { expense: expenseBody });
  const expense = data.expense ?? data as unknown as Expense;
  return {
    id: expense.id,
    number: expense.transaction_no,
    date: expense.transaction_date,
    amount: expense.amount,
  };
}

export async function deleteExpense(params: z.infer<typeof deleteExpenseSchema>) {
  await jurnalRequest<unknown>('DELETE', `/api/v1/expenses/${params.id}`);
  return { success: true, deleted_id: params.id };
}
