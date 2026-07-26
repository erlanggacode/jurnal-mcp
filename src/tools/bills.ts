import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, numericId, positiveNumber, nonNegativeNumber } from '../schema-utils.js';
import { extractList, copyTransactionLines, type SourceLine } from '../response-utils.js';

export const listBillsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getBillSchema = z.object({
  id: stringId.describe('Bill (purchase invoice) ID'),
});

export const createBillSchema = z.object({
  vendor_id: stringId.describe('Vendor/Supplier ID (use list_customers with type vendor to find)'),
  transaction_date: z.string().describe('Bill date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: stringId.describe('Product ID. Use search_products to resolve one by name.'),
    quantity: positiveNumber.describe('Quantity'),
    // Named unit_price, not rate: it is mapped to the API's `rate` field on the way out.
    unit_price: nonNegativeNumber.describe('Unit price per item (sent to the API as "rate")'),
    description: z.string().optional().describe('Line item description'),
    unit_id: numericId.optional().describe('Unit of measure ID (optional; defaults to the product\'s unit)'),
    tax_id: numericId.optional().describe('Tax ID to apply to this line (optional)'),
  })).describe(
    'Line items for the bill. Each item requires product_id, quantity and unit_price; ' +
    'description, unit_id and tax_id are optional.'
  ),
  memo: z.string().optional().describe('Optional memo/note'),
});

export const createBillByPurchaseOrderSchema = z.object({
  purchase_order_id: stringId.describe('Purchase order ID to create the bill from'),
  transaction_date: z.string().describe('Bill date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  memo: z.string().optional().describe('Optional memo/note'),
});

export const updateBillSchema = z.object({
  id: stringId.describe('Bill (purchase invoice) ID to update'),
  vendor_id: stringId.optional().describe('Change the vendor/supplier'),
  transaction_date: z.string().optional().describe('Bill date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  memo: z.string().optional().describe('Memo/note. Pass an empty string to clear it.'),
  line_items: z.array(z.object({
    id: numericId.optional().describe(
      'Existing line ID, from get_bill. REQUIRED to change or remove a line — ' +
      'a line sent without an id is added as a new one.'
    ),
    product_id: stringId.optional().describe('Product ID. Use search_products to resolve one by name.'),
    quantity: positiveNumber.optional().describe('Quantity'),
    unit_price: nonNegativeNumber.optional().describe('Unit price per item (sent to the API as "rate")'),
    description: z.string().optional().describe('Line item description'),
    unit_id: numericId.optional().describe('Unit of measure ID'),
    tax_id: numericId.optional().describe('Tax ID to apply to this line'),
    _destroy: z.boolean().optional().describe('Set true (with id) to delete this line'),
  })).optional().describe(
    'Lines to add, change or remove. This is a partial update, NOT a replacement: lines ' +
    'you omit are left untouched. Call get_bill first to read the existing line IDs.'
  ),
});

export const deleteBillSchema = z.object({
  id: stringId.describe('Bill (purchase invoice) ID to delete'),
});

interface BillItem {
  id: number | string;
  transaction_no?: string;
  person?: { id?: number | string; name?: string; display_name?: string };
  transaction_date?: string;
  due_date?: string;
  amount?: number;
  status?: string;
  editable?: boolean;
  deletable?: boolean;
  deleted_at?: string | null;
  [key: string]: unknown;
}

interface BillsResponse {
  purchase_invoices?: BillItem[];
  purchase_invoice?: BillItem;
  [key: string]: unknown;
}

export async function listBills(params: z.infer<typeof listBillsSchema>) {
  const data = await jurnalRequest<BillsResponse>('GET', '/api/v1/purchase_invoices', {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  const bills = extractList<BillItem>(data, 'GET /api/v1/purchase_invoices', ['purchase_invoices', 'data']);
  return bills.map((bill: BillItem) => ({
    id: bill.id,
    number: bill.transaction_no,
    vendor_name: bill.person?.name,
    date: bill.transaction_date,
    due_date: bill.due_date,
    total: bill.amount,
    status: bill.status,
  }));
}

export async function getBill(params: z.infer<typeof getBillSchema>) {
  const data = await jurnalRequest<BillsResponse>('GET', `/api/v1/purchase_invoices/${params.id}`);
  return data.purchase_invoice ?? data;
}

export async function createBill(params: z.infer<typeof createBillSchema>) {
  const body = {
    purchase_invoice: {
      person_id: params.vendor_id,
      transaction_date: params.transaction_date,
      ...(params.due_date ? { due_date: params.due_date } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      transaction_lines_attributes: params.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        rate: item.unit_price,
        ...(item.description ? { description: item.description } : {}),
        ...(item.unit_id !== undefined ? { unit_id: item.unit_id } : {}),
        ...(item.tax_id !== undefined ? { tax_id: item.tax_id } : {}),
      })),
    },
  };

  const data = await jurnalRequest<BillsResponse>('POST', '/api/v1/purchase_invoices', undefined, body);
  const bill = data.purchase_invoice as BillItem | undefined ?? data as unknown as BillItem;
  return {
    id: bill.id,
    number: bill.transaction_no,
    vendor_name: bill.person?.name,
    date: bill.transaction_date,
    due_date: bill.due_date,
    total: bill.amount,
    status: bill.status,
  };
}

/**
 * Jurnal accepts dates as YYYY-MM-DD but returns them as DD/MM/YYYY, so a read-back
 * check that compares the two forms directly reports every date as ignored.
 */
function sameDate(sent: string, returned: unknown): boolean {
  if (typeof returned !== 'string') return false;
  const dmy = returned.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return (dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : returned) === sent;
}

export async function updateBill(params: z.infer<typeof updateBillSchema>) {
  const { id, line_items, ...fields } = params;

  // `editable` is Jurnal's own per-record verdict: a bill that is paid, reconciled or
  // locked by a closed book refuses edits. Reading it first turns an opaque API error
  // into a statement of why this particular bill cannot be changed.
  const before = await jurnalRequest<BillsResponse>('GET', `/api/v1/purchase_invoices/${id}`);
  const current = (before.purchase_invoice ?? before) as unknown as BillItem;
  if (current.editable === false) {
    throw new Error(
      `Jurnal reports bill ${id} (${current.transaction_no ?? 'no number'}) as not editable ` +
      `(status "${current.status}", has_payments ${current.has_payments}, is_reconciled ${current.is_reconciled}). ` +
      `Remove the payment or reopen the period in the Jurnal UI first.`
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
      ...(line.description !== undefined ? { description: line.description } : {}),
      ...(line.unit_id !== undefined ? { unit_id: line.unit_id } : {}),
      ...(line.tax_id !== undefined ? { tax_id: line.tax_id } : {}),
      ...(line._destroy ? { _destroy: true } : {}),
    }));
  }

  if (Object.keys(changes).length === 0) {
    throw new Error(`No fields given to update on bill ${id}.`);
  }

  const body = { purchase_invoice: changes };
  try {
    await jurnalRequest('PATCH', `/api/v1/purchase_invoices/${id}`, undefined, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/40[45]|method not allowed/i.test(message)) throw error;
    await jurnalRequest('PUT', `/api/v1/purchase_invoices/${id}`, undefined, body);
  }

  // Jurnal answers 200 after silently dropping attributes it does not permit — the
  // same behaviour that let create_purchase_order report success for an order with no
  // lines. Read the bill back and report what actually changed.
  const after = await jurnalRequest<BillsResponse>('GET', `/api/v1/purchase_invoices/${id}`);
  const updated = (after.purchase_invoice ?? after) as unknown as BillItem;

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
  };
}

export async function deleteBill(params: z.infer<typeof deleteBillSchema>) {
  // Capture what is about to be destroyed, both to check Jurnal's own `deletable`
  // verdict and so the caller gets a record of it back — there is no undo here.
  const before = await jurnalRequest<BillsResponse>('GET', `/api/v1/purchase_invoices/${params.id}`);
  const bill = (before.purchase_invoice ?? before) as unknown as BillItem;
  if (bill.deletable === false) {
    throw new Error(
      `Jurnal reports bill ${params.id} (${bill.transaction_no ?? 'no number'}) as not deletable ` +
      `(status "${bill.status}", has_payments ${bill.has_payments}, is_reconciled ${bill.is_reconciled}). ` +
      `Unapply the payment or reopen the period in the Jurnal UI first.`
    );
  }

  const deleted = {
    id: bill.id,
    number: bill.transaction_no,
    vendor_name: bill.person?.display_name ?? bill.person?.name,
    date: bill.transaction_date,
    total: bill.original_amount ?? bill.amount,
  };

  await jurnalRequest<unknown>('DELETE', `/api/v1/purchase_invoices/${params.id}`);

  // Confirm it is actually gone: a 200 on DELETE is not proof, and Jurnal soft-deletes
  // some records (`deleted_at`) rather than removing them.
  let gone = false;
  let stillPresent: BillItem | undefined;
  try {
    const check = await jurnalRequest<BillsResponse>('GET', `/api/v1/purchase_invoices/${params.id}`);
    const found = (check.purchase_invoice ?? check) as unknown as BillItem;
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
        `Jurnal accepted the delete but bill ${params.id} is still readable and not marked ` +
        `deleted (status "${stillPresent?.status}"). Check it in the Jurnal UI.`,
    }),
  };
}

/** Reads the order and copies its vendor and lines onto the bill — see copyTransactionLines. */
export async function createBillByPurchaseOrder(params: z.infer<typeof createBillByPurchaseOrderSchema>) {
  const poData = await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/purchase_orders/${params.purchase_order_id}`);
  const po = (poData.purchase_order ?? poData) as Record<string, unknown>;

  const personId = (po.person as { id?: number | string } | undefined)?.id;
  const poLines = (po.transaction_lines_attributes as SourceLine[] | undefined) ?? [];

  if (!personId) {
    throw new Error(
      `Purchase order ${params.purchase_order_id} has no vendor to copy onto the bill. ` +
      `Check the order in Jurnal — a bill cannot be created without one.`
    );
  }
  if (poLines.length === 0) {
    throw new Error(
      `Purchase order ${params.purchase_order_id} has no line items to copy onto the bill. ` +
      `If this order was created before the transaction_lines_attributes fix, it is empty in ` +
      `Jurnal and needs its lines added before it can be billed.`
    );
  }

  const lines = copyTransactionLines(poLines);

  if (lines.length === 0) {
    throw new Error(
      `Nothing left to bill on purchase order ${params.purchase_order_id}: every line has a ` +
      `remaining quantity of 0, so it has already been billed in full.`
    );
  }

  const body = {
    purchase_invoice: {
      person_id: personId,
      // Jurnal exposes the link as `selected_po_id` on the bill it returns; send both that
      // and the conventional name, then check below which one actually took.
      purchase_order_id: params.purchase_order_id,
      selected_po_id: params.purchase_order_id,
      transaction_date: params.transaction_date,
      ...(params.due_date ? { due_date: params.due_date } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      transaction_lines_attributes: lines,
    },
  };

  const data = await jurnalRequest<BillsResponse>('POST', '/api/v1/purchase_invoices', undefined, body);
  const bill = data.purchase_invoice as BillItem | undefined ?? data as unknown as BillItem;

  const savedLines = (bill.transaction_lines_attributes as unknown[] | undefined) ?? [];
  const linkedPoId = bill.selected_po_id ?? (bill.purchase_order as { id?: unknown } | null)?.id;
  const skipped = poLines.length - lines.length;

  return {
    id: bill.id,
    number: bill.transaction_no,
    vendor_name: bill.person?.display_name ?? bill.person?.name,
    date: bill.transaction_date,
    due_date: bill.due_date,
    total: bill.original_amount ?? bill.amount,
    status: bill.status,
    from_purchase_order: params.purchase_order_id,
    lines_copied: lines.length,
    lines_saved: savedLines.length,
    ...(skipped > 0 ? { lines_skipped_already_billed: skipped } : {}),
    linked_to_purchase_order: linkedPoId != null,
    ...(savedLines.length === lines.length ? {} : {
      warning:
        `Jurnal saved ${savedLines.length} of the ${lines.length} lines copied from the order. ` +
        `The bill exists but is incomplete — check it in Jurnal.`,
    }),
    ...(linkedPoId != null ? {} : {
      note:
        `The bill was created with the right vendor and lines, but Jurnal did not record a link ` +
        `back to purchase order ${params.purchase_order_id}, so the order will not show as billed. ` +
        `Close it with close_purchase_order if that is the intent.`,
    }),
  };
}
