import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, numericId, positiveNumber, nonNegativeNumber } from '../schema-utils.js';
import { extractList } from '../response-utils.js';

export const listPurchaseOrdersSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open').describe('Filter by order status'),
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getPurchaseOrderSchema = z.object({
  id: stringId.describe('Purchase order ID'),
});

export const closePurchaseOrderSchema = z.object({
  id: stringId.describe('Purchase order ID to close'),
});

export const createPurchaseOrderSchema = z.object({
  vendor_id: stringId.describe('Vendor/Supplier ID (use list_customers with type vendor to find)'),
  transaction_date: z.string().describe('Transaction date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: stringId.describe('Product ID'),
    quantity: positiveNumber.describe('Quantity'),
    unit_price: nonNegativeNumber.describe('Unit price'),
  })).describe('Line items for the purchase order'),
  memo: z.string().optional().describe('Optional memo/note'),
});

export const updatePurchaseOrderSchema = z.object({
  id: stringId.describe('Purchase order ID to update'),
  vendor_id: stringId.optional().describe('Change the vendor/supplier'),
  transaction_date: z.string().optional().describe('Transaction date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  memo: z.string().optional().describe('Memo/note. Pass an empty string to clear it.'),
  line_items: z.array(z.object({
    id: numericId.optional().describe(
      'Existing line ID, from get_purchase_order. REQUIRED to change or remove a line — ' +
      'a line sent without an id is added as a new one.'
    ),
    product_id: stringId.optional().describe('Product ID'),
    quantity: positiveNumber.optional().describe('Quantity'),
    unit_price: nonNegativeNumber.optional().describe('Unit price'),
    _destroy: z.boolean().optional().describe('Set true (with id) to delete this line'),
  })).optional().describe(
    'Lines to add, change or remove. This is a partial update, NOT a replacement: lines ' +
    'you omit are left untouched. Call get_purchase_order first to read the existing line IDs.'
  ),
});

export const deletePurchaseOrderSchema = z.object({
  id: stringId.describe('Purchase order ID to delete'),
});

interface PurchaseOrderItem {
  id: number | string;
  transaction_no?: string;
  person?: { id?: number | string; name?: string };
  transaction_date?: string;
  due_date?: string;
  amount?: number;
  status?: string;
  editable?: boolean;
  deletable?: boolean;
  deleted_at?: string | null;
  [key: string]: unknown;
}

interface PurchaseOrdersResponse {
  purchase_orders?: PurchaseOrderItem[];
  purchase_order?: PurchaseOrderItem;
  [key: string]: unknown;
}

export async function listPurchaseOrders(params: z.infer<typeof listPurchaseOrdersSchema>) {
  const data = await jurnalRequest<PurchaseOrdersResponse>('GET', '/api/v1/purchase_orders', {
    // Jurnal has no "all" status — passing it matches nothing and returns an empty
    // list, which reads as "you have no purchase orders". Omit the filter instead.
    ...(params.status === 'all' ? {} : { status: params.status }),
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  const orders = extractList<PurchaseOrderItem>(data, 'GET /api/v1/purchase_orders', ['purchase_orders', 'data']);
  return orders.map((order: PurchaseOrderItem) => ({
    id: order.id,
    number: order.transaction_no,
    vendor_name: order.person?.name,
    date: order.transaction_date,
    due_date: order.due_date,
    total: order.amount,
    status: order.status,
  }));
}

export async function getPurchaseOrder(params: z.infer<typeof getPurchaseOrderSchema>) {
  const data = await jurnalRequest<PurchaseOrdersResponse>('GET', `/api/v1/purchase_orders/${params.id}`);
  return data.purchase_order ?? data;
}

export async function closePurchaseOrder(params: z.infer<typeof closePurchaseOrderSchema>) {
  const data = await jurnalRequest<PurchaseOrdersResponse>('PATCH', `/api/v1/purchase_orders/${params.id}/close`);
  return data.purchase_order ?? data;
}

export async function createPurchaseOrder(params: z.infer<typeof createPurchaseOrderSchema>) {
  const body = {
    purchase_order: {
      person_id: params.vendor_id,
      transaction_date: params.transaction_date,
      ...(params.due_date ? { due_date: params.due_date } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      // Jurnal names this `transaction_lines_attributes` on every transaction type,
      // purchase orders included — confirmed against GET /purchase_orders/:id. A
      // model-specific key like `purchase_order_lines_attributes` is not permitted,
      // so Rails strips it and the order is created with no lines and a zero total.
      transaction_lines_attributes: params.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        rate: item.unit_price,
      })),
    },
  };

  const data = await jurnalRequest<PurchaseOrdersResponse>('POST', '/api/v1/purchase_orders', undefined, body);
  const order = data.purchase_order as PurchaseOrderItem | undefined ?? data as unknown as PurchaseOrderItem;

  // Jurnal accepts the POST and returns 200 even when it has dropped every line it
  // did not recognise, so a bare "created" tells the caller nothing. Read the order
  // back and say what actually landed.
  const lines = (order.transaction_lines_attributes as unknown[] | undefined) ?? [];
  return {
    id: order.id,
    number: order.transaction_no,
    total: order.original_amount ?? order.amount,
    line_items_sent: params.line_items.length,
    line_items_saved: lines.length,
    ...(lines.length === params.line_items.length
      ? {}
      : {
          warning:
            `Jurnal saved ${lines.length} of ${params.line_items.length} line items. ` +
            `The purchase order exists but is incomplete — check it in Jurnal before using it.`,
        }),
  };
}

/** Jurnal accepts dates as YYYY-MM-DD but returns them as DD/MM/YYYY. */
function sameDate(sent: string, returned: unknown): boolean {
  if (typeof returned !== 'string') return false;
  const dmy = returned.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return (dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : returned) === sent;
}

export async function updatePurchaseOrder(params: z.infer<typeof updatePurchaseOrderSchema>) {
  const { id, line_items, ...fields } = params;

  // `editable` is Jurnal's own per-record verdict: an order that has already been billed or
  // is locked by a closed book refuses edits. Reading it first turns an opaque API error into
  // a statement of why this particular order cannot be changed.
  const before = await jurnalRequest<PurchaseOrdersResponse>('GET', `/api/v1/purchase_orders/${id}`);
  const current = (before.purchase_order ?? before) as unknown as PurchaseOrderItem;
  if (current.editable === false) {
    throw new Error(
      `Jurnal reports purchase order ${id} (${current.transaction_no ?? 'no number'}) as not editable ` +
      `(status "${current.status}"). Check whether it has already been billed.`
    );
  }

  const changes: Record<string, unknown> = {};
  if (fields.vendor_id !== undefined) changes['person_id'] = fields.vendor_id;
  if (fields.transaction_date !== undefined) changes['transaction_date'] = fields.transaction_date;
  if (fields.due_date !== undefined) changes['due_date'] = fields.due_date;
  if (fields.memo !== undefined) changes['memo'] = fields.memo;
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
    throw new Error(`No fields given to update on purchase order ${id}.`);
  }

  const body = { purchase_order: changes };
  try {
    await jurnalRequest('PATCH', `/api/v1/purchase_orders/${id}`, undefined, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/40[45]|method not allowed/i.test(message)) throw error;
    await jurnalRequest('PUT', `/api/v1/purchase_orders/${id}`, undefined, body);
  }

  // Jurnal answers 200 after silently dropping attributes it does not permit. Read the
  // order back and report what actually changed.
  const after = await jurnalRequest<PurchaseOrdersResponse>('GET', `/api/v1/purchase_orders/${id}`);
  const updated = (after.purchase_order ?? after) as unknown as PurchaseOrderItem;

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
    status: updated.status,
  };
}

export async function deletePurchaseOrder(params: z.infer<typeof deletePurchaseOrderSchema>) {
  // Capture what is about to be destroyed, both to check Jurnal's own `deletable`
  // verdict and so the caller gets a record of it back — there is no undo here.
  const before = await jurnalRequest<PurchaseOrdersResponse>('GET', `/api/v1/purchase_orders/${params.id}`);
  const order = (before.purchase_order ?? before) as unknown as PurchaseOrderItem;
  if (order.deletable === false) {
    throw new Error(
      `Jurnal reports purchase order ${params.id} (${order.transaction_no ?? 'no number'}) as not deletable ` +
      `(status "${order.status}"). It has likely already been billed — unlink the bill in the Jurnal UI first.`
    );
  }

  const deleted = {
    id: order.id,
    number: order.transaction_no,
    vendor_name: order.person?.name,
    date: order.transaction_date,
    total: order.original_amount ?? order.amount,
  };

  await jurnalRequest<unknown>('DELETE', `/api/v1/purchase_orders/${params.id}`);

  // Confirm it is actually gone: a 200 on DELETE is not proof, and Jurnal soft-deletes
  // some records (`deleted_at`) rather than removing them.
  let gone = false;
  let stillPresent: PurchaseOrderItem | undefined;
  try {
    const check = await jurnalRequest<PurchaseOrdersResponse>('GET', `/api/v1/purchase_orders/${params.id}`);
    const found = (check.purchase_order ?? check) as unknown as PurchaseOrderItem;
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
        `Jurnal accepted the delete but purchase order ${params.id} is still readable and not marked ` +
        `deleted (status "${stillPresent?.status}"). Check it in the Jurnal UI.`,
    }),
  };
}
