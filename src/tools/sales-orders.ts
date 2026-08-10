import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, numericId, positiveNumber, nonNegativeNumber } from '../schema-utils.js';
import { extractList } from '../response-utils.js';

export const listSalesOrdersSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open').describe('Filter by order status'),
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getSalesOrderSchema = z.object({
  id: stringId.describe('Sales order ID'),
});

export const closeSalesOrderSchema = z.object({
  id: stringId.describe('Sales order ID to close'),
});

export const createSalesOrderSchema = z.object({
  customer_id: stringId.describe('Customer ID'),
  transaction_date: z.string().describe('Transaction date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: stringId.describe('Product ID'),
    quantity: positiveNumber.describe('Quantity'),
    unit_price: nonNegativeNumber.describe('Unit price'),
  })).describe('Line items for the order'),
  memo: z.string().optional().describe('Optional memo/note'),
  message: z.string().optional().describe(
    'Terms/notes text shown on the printed sales order, separate from memo.'
  ),
});

export const updateSalesOrderSchema = z.object({
  id: stringId.describe('Sales order ID to update'),
  customer_id: stringId.optional().describe('Change the customer'),
  transaction_date: z.string().optional().describe('Transaction date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe(
    'Due date in YYYY-MM-DD format. Jurnal requires this on every update, so when omitted ' +
    'the order\'s existing due date is resent unchanged.'
  ),
  memo: z.string().optional().describe('Memo/note. Pass an empty string to clear it.'),
  message: z.string().optional().describe(
    'Terms/notes text shown on the printed sales order, separate from memo. Pass an empty ' +
    'string to clear it.'
  ),
  line_items: z.array(z.object({
    id: numericId.optional().describe(
      'Existing line ID, from get_sales_order. REQUIRED to change or remove a line — ' +
      'a line sent without an id is added as a new one.'
    ),
    product_id: stringId.optional().describe('Product ID'),
    quantity: positiveNumber.optional().describe('Quantity'),
    unit_price: nonNegativeNumber.optional().describe('Unit price'),
    _destroy: z.boolean().optional().describe('Set true (with id) to delete this line'),
  })).optional().describe(
    'Lines to add, change or remove. This is a partial update, NOT a replacement: lines ' +
    'you omit are left untouched. Call get_sales_order first to read the existing line IDs.'
  ),
});

export const deleteSalesOrderSchema = z.object({
  id: stringId.describe('Sales order ID to delete'),
});

interface SalesOrderItem {
  id: number | string;
  transaction_no?: string;
  person?: { id?: number | string; name?: string };
  transaction_date?: string;
  due_date?: string;
  message?: string;
  amount?: number;
  status?: string;
  editable?: boolean;
  deletable?: boolean;
  deleted_at?: string | null;
  [key: string]: unknown;
}

interface SalesOrdersResponse {
  sales_orders?: SalesOrderItem[];
  sales_order?: SalesOrderItem;
  [key: string]: unknown;
}

export async function listSalesOrders(params: z.infer<typeof listSalesOrdersSchema>) {
  const data = await jurnalRequest<SalesOrdersResponse>('GET', '/api/v1/sales_orders', {
    // Jurnal has no "all" status — passing it matches nothing and returns an empty
    // list, which reads as "you have no sales orders". Omit the filter instead.
    ...(params.status === 'all' ? {} : { status: params.status }),
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  const orders = extractList<SalesOrderItem>(data, 'GET /api/v1/sales_orders', ['sales_orders', 'data']);
  return orders.map((order: SalesOrderItem) => ({
    id: order.id,
    number: order.transaction_no,
    customer_name: order.person?.name,
    date: order.transaction_date,
    total: order.amount,
    status: order.status,
  }));
}

export async function getSalesOrder(params: z.infer<typeof getSalesOrderSchema>) {
  const data = await jurnalRequest<SalesOrdersResponse>('GET', `/api/v1/sales_orders/${params.id}`);
  return data.sales_order ?? data;
}

export async function closeSalesOrder(params: z.infer<typeof closeSalesOrderSchema>) {
  const data = await jurnalRequest<SalesOrdersResponse>('PATCH', `/api/v1/sales_orders/${params.id}/close`);
  return data.sales_order ?? data;
}

export async function createSalesOrder(params: z.infer<typeof createSalesOrderSchema>) {
  const body = {
    sales_order: {
      person_id: params.customer_id,
      transaction_date: params.transaction_date,
      ...(params.due_date ? { due_date: params.due_date } : {}),
      memo: params.memo,
      ...(params.message !== undefined ? { message: params.message } : {}),
      transaction_lines_attributes: params.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        rate: item.unit_price,
      })),
    },
  };

  const data = await jurnalRequest<SalesOrdersResponse>('POST', '/api/v1/sales_orders', undefined, body);
  const order = data.sales_order as SalesOrderItem | undefined ?? data as unknown as SalesOrderItem;
  return {
    id: order.id,
    number: order.transaction_no,
  };
}

/** Jurnal accepts dates as YYYY-MM-DD but returns them as DD/MM/YYYY. */
function toInputDate(returned: string): string {
  const dmy = returned.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : returned;
}

function sameDate(sent: string, returned: unknown): boolean {
  if (typeof returned !== 'string') return false;
  return toInputDate(returned) === sent;
}

export async function updateSalesOrder(params: z.infer<typeof updateSalesOrderSchema>) {
  const { id, line_items, ...fields } = params;

  // `editable` is Jurnal's own per-record verdict: an order that has been invoiced/delivered
  // or is locked by a closed book refuses edits. Reading it first turns an opaque API error
  // into a statement of why this particular order cannot be changed.
  const before = await jurnalRequest<SalesOrdersResponse>('GET', `/api/v1/sales_orders/${id}`);
  const current = (before.sales_order ?? before) as unknown as SalesOrderItem;
  if (current.editable === false) {
    throw new Error(
      `Jurnal reports sales order ${id} (${current.transaction_no ?? 'no number'}) as not editable ` +
      `(status "${current.status}"). Check whether it has already been invoiced or delivered.`
    );
  }

  const changes: Record<string, unknown> = {};
  if (fields.customer_id !== undefined) changes['person_id'] = fields.customer_id;
  if (fields.transaction_date !== undefined) changes['transaction_date'] = fields.transaction_date;
  if (fields.due_date !== undefined) changes['due_date'] = fields.due_date;
  if (fields.memo !== undefined) changes['memo'] = fields.memo;
  if (fields.message !== undefined) changes['message'] = fields.message;
  if (line_items !== undefined) {
    changes['transaction_lines_attributes'] = line_items.map(line => ({
      ...(line.id !== undefined ? { id: line.id } : {}),
      ...(line.product_id !== undefined ? { product_id: line.product_id } : {}),
      ...(line.quantity !== undefined ? { quantity: line.quantity } : {}),
      ...(line.unit_price !== undefined ? { rate: line.unit_price } : {}),
      ...(line._destroy ? { _destroy: true } : {}),
    }));
  }

  if (Object.keys(changes).length === 0) {
    throw new Error(`No fields given to update on sales order ${id}.`);
  }

  // Jurnal rejects a sales order PATCH with "due_date tidak boleh kosong" if due_date is
  // absent from the payload at all, even when nothing about the date is changing. Resend
  // the existing value so a real change to another field doesn't get blocked by this.
  if (changes['due_date'] === undefined && current.due_date !== undefined) {
    changes['due_date'] = toInputDate(current.due_date);
  }

  const body = { sales_order: changes };
  try {
    await jurnalRequest('PATCH', `/api/v1/sales_orders/${id}`, undefined, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/40[45]|method not allowed/i.test(message)) throw error;
    await jurnalRequest('PUT', `/api/v1/sales_orders/${id}`, undefined, body);
  }

  // Jurnal answers 200 after silently dropping attributes it does not permit. Read the
  // order back and report what actually changed.
  const after = await jurnalRequest<SalesOrdersResponse>('GET', `/api/v1/sales_orders/${id}`);
  const updated = (after.sales_order ?? after) as unknown as SalesOrderItem;

  const applied: string[] = [];
  const ignored: { field: string; requested: unknown; actual: unknown }[] = [];
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'transaction_lines_attributes') continue;
    const actual = updated[field] ?? (field === 'person_id' ? updated.person?.id : undefined);
    const matches = field.endsWith('_date')
      ? sameDate(value as string, actual)
      : String(actual) === String(value);
    if (matches) applied.push(field);
    else ignored.push({ field, requested: value, actual });
  }

  const linesBefore = (current.transaction_lines_attributes as unknown[] | undefined) ?? [];
  const linesAfter = (updated.transaction_lines_attributes as unknown[] | undefined) ?? [];

  return {
    id,
    number: updated.transaction_no,
    applied,
    ignored,
    verified: ignored.length === 0,
    ...(line_items === undefined ? {} : {
      lines_before: linesBefore.length,
      lines_after: linesAfter.length,
    }),
    total: updated.original_amount ?? updated.amount,
    date: updated.transaction_date,
    due_date: updated.due_date,
    memo: updated.memo,
    message: updated.message,
    status: updated.status,
  };
}

export async function deleteSalesOrder(params: z.infer<typeof deleteSalesOrderSchema>) {
  // Capture what is about to be destroyed, both to check Jurnal's own `deletable`
  // verdict and so the caller gets a record of it back — there is no undo here.
  const before = await jurnalRequest<SalesOrdersResponse>('GET', `/api/v1/sales_orders/${params.id}`);
  const order = (before.sales_order ?? before) as unknown as SalesOrderItem;
  if (order.deletable === false) {
    throw new Error(
      `Jurnal reports sales order ${params.id} (${order.transaction_no ?? 'no number'}) as not deletable ` +
      `(status "${order.status}"). It has likely already been invoiced or delivered — unlink those ` +
      `documents in the Jurnal UI first.`
    );
  }

  const deleted = {
    id: order.id,
    number: order.transaction_no,
    customer_name: order.person?.name,
    date: order.transaction_date,
    total: order.original_amount ?? order.amount,
  };

  await jurnalRequest<unknown>('DELETE', `/api/v1/sales_orders/${params.id}`);

  // Confirm it is actually gone: a 200 on DELETE is not proof, and Jurnal soft-deletes
  // some records (`deleted_at`) rather than removing them.
  let gone = false;
  let stillPresent: SalesOrderItem | undefined;
  try {
    const check = await jurnalRequest<SalesOrdersResponse>('GET', `/api/v1/sales_orders/${params.id}`);
    const found = (check.sales_order ?? check) as unknown as SalesOrderItem;
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
        `Jurnal accepted the delete but sales order ${params.id} is still readable and not marked ` +
        `deleted (status "${stillPresent?.status}"). Check it in the Jurnal UI.`,
    }),
  };
}
