import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, numericId, positiveNumber, nonNegativeNumber } from '../schema-utils.js';
import { extractList, copyTransactionLines, type SourceLine } from '../response-utils.js';

export const listSalesInvoicesSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const createInvoiceSchema = z.object({
  customer_id: stringId.describe('Customer ID'),
  transaction_date: z.string().describe('Invoice date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: stringId.describe('Product ID'),
    quantity: positiveNumber.describe('Quantity'),
    unit_price: nonNegativeNumber.describe('Unit price per item'),
    description: z.string().optional().describe('Line item description'),
    discount: nonNegativeNumber.optional().describe('Discount percent on this line (per-line discount)'),
    tax_id: numericId.optional().describe('Tax ID to apply to this line'),
  })).describe('Line items for the invoice'),
  discount_type: z.enum(['percent', 'value']).optional().describe(
    'Whether discount_value is a percentage or a flat amount. Defaults to percent when a discount is given.'
  ),
  discount_value: nonNegativeNumber.optional().describe('Invoice-level discount, as a percent or a flat amount per discount_type'),
  withholding_type: z.enum(['percent', 'value']).optional().describe(
    'Whether withholding_value is a percentage or a flat amount (PPh). Defaults to value.'
  ),
  withholding_value: nonNegativeNumber.optional().describe('Withholding tax (PPh) amount or percent per withholding_type'),
  withholding_account_id: numericId.optional().describe(
    'Account the withholding is booked to. Required when withholding_value is set — use get_accounts to find it.'
  ),
  tax_after_discount: z.boolean().optional().describe('Whether tax is calculated after the discount is applied (Jurnal default: true)'),
  memo: z.string().optional().describe('Optional memo/note'),
}).refine(
  v => !(v.withholding_value !== undefined && v.withholding_value > 0) || v.withholding_account_id !== undefined,
  { message: 'withholding_account_id is required when withholding_value is set — Jurnal needs an account to book the PPh to.' }
);

export const createInvoiceBySalesOrderSchema = z.object({
  sales_order_id: stringId.describe('Sales order ID to create invoice from'),
  transaction_date: z.string().describe('Invoice date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  memo: z.string().optional().describe('Optional memo/note'),
});

export const getInvoiceSchema = z.object({
  id: stringId.describe('Sales invoice ID'),
});

export const updateInvoiceSchema = z.object({
  id: stringId.describe('Sales invoice ID to update'),
  customer_id: stringId.optional().describe('Change the customer'),
  transaction_date: z.string().optional().describe('Invoice date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  memo: z.string().optional().describe('Memo/note. Pass an empty string to clear it.'),
  discount_type: z.enum(['percent', 'value']).optional().describe(
    'Whether discount_value is a percentage or a flat amount. Defaults to percent when a discount is given.'
  ),
  discount_value: nonNegativeNumber.optional().describe('Invoice-level discount, as a percent or a flat amount per discount_type'),
  withholding_type: z.enum(['percent', 'value']).optional().describe(
    'Whether withholding_value is a percentage or a flat amount (PPh). Defaults to value.'
  ),
  withholding_value: nonNegativeNumber.optional().describe('Withholding tax (PPh) amount or percent per withholding_type'),
  withholding_account_id: numericId.optional().describe(
    'Account the withholding is booked to. Required when withholding_value is set — use get_accounts to find it.'
  ),
  tax_after_discount: z.boolean().optional().describe('Whether tax is calculated after the discount is applied'),
  line_items: z.array(z.object({
    id: numericId.optional().describe(
      'Existing line ID, from get_invoice. REQUIRED to change or remove a line — ' +
      'a line sent without an id is added as a new one.'
    ),
    product_id: stringId.optional().describe('Product ID'),
    quantity: positiveNumber.optional().describe('Quantity'),
    unit_price: nonNegativeNumber.optional().describe('Unit price per item'),
    description: z.string().optional().describe('Line item description'),
    discount: nonNegativeNumber.optional().describe('Discount percent on this line (per-line discount)'),
    tax_id: numericId.optional().describe('Tax ID to apply to this line'),
    _destroy: z.boolean().optional().describe('Set true (with id) to delete this line'),
  })).optional().describe(
    'Lines to add, change or remove. This is a partial update, NOT a replacement: lines ' +
    'you omit are left untouched. Call get_invoice first to read the existing line IDs.'
  ),
}).refine(
  v => !(v.withholding_value !== undefined && v.withholding_value > 0) || v.withholding_account_id !== undefined,
  { message: 'withholding_account_id is required when withholding_value is set — Jurnal needs an account to book the PPh to.' }
);

export const deleteInvoiceSchema = z.object({
  id: stringId.describe('Sales invoice ID to delete'),
});

interface InvoiceItem {
  id: number | string;
  transaction_no?: string;
  person?: { id?: number | string; name?: string; display_name?: string };
  transaction_date?: string;
  amount?: number;
  status?: string;
  due_date?: string;
  editable?: boolean;
  deletable?: boolean;
  deleted_at?: string | null;
  has_payments?: boolean;
  is_reconciled?: boolean;
  [key: string]: unknown;
}

interface InvoicesResponse {
  sales_invoices?: InvoiceItem[];
  sales_invoice?: InvoiceItem;
  [key: string]: unknown;
}

export async function listSalesInvoices(params: z.infer<typeof listSalesInvoicesSchema>) {
  const data = await jurnalRequest<InvoicesResponse>('GET', '/api/v1/sales_invoices', {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  return extractList<InvoiceItem>(data, 'GET /api/v1/sales_invoices', ['sales_invoices', 'data']);
}

export async function getInvoice(params: z.infer<typeof getInvoiceSchema>) {
  const data = await jurnalRequest<InvoicesResponse>('GET', `/api/v1/sales_invoices/${params.id}`);
  return data.sales_invoice ?? data;
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

/**
 * Jurnal spells it "witholding", with one h, on the wire. The correct spelling is an
 * unpermitted key, which Rails drops silently behind a 200 — an invoice would come back
 * looking fine with no PPh on it. The tool's own parameters use the correct spelling and
 * are translated here.
 *
 * Field names are taken from a live transaction record (GET /purchase_invoices/:id), which
 * carries discount_unit, discount_price, discount_type, witholding_value, witholding_type,
 * witholding_amount, witholding_account and tax_after_discount. Sales invoices and bills are
 * the same underlying transaction in Jurnal — the bill record even carries sell_acc_id and
 * amount_receive — so the sales side takes the same attributes.
 */
const DISCOUNT_TYPE_IDS: Record<string, number> = {
  // 1 = Percent is confirmed from a live record ("discount_type": {"id": 1, "name": "Percent"}).
  // Value is the only other option Jurnal offers; its id is inferred, and the read-back below
  // reports it rather than letting a wrong id pass as success.
  percent: 1,
  value: 2,
};

export async function createInvoice(params: z.infer<typeof createInvoiceSchema>) {
  const wantsDiscount = params.discount_value !== undefined && params.discount_value > 0;
  const wantsWithholding = params.withholding_value !== undefined && params.withholding_value > 0;
  const discountType = params.discount_type ?? 'percent';
  const withholdingType = params.withholding_type ?? 'value';

  const body = {
    sales_invoice: {
      person_id: params.customer_id,
      transaction_date: params.transaction_date,
      ...(params.due_date ? { due_date: params.due_date } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      ...(params.tax_after_discount !== undefined ? { tax_after_discount: params.tax_after_discount } : {}),
      ...(wantsDiscount ? {
        discount_unit: params.discount_value,
        discount_type_id: DISCOUNT_TYPE_IDS[discountType],
      } : {}),
      ...(wantsWithholding ? {
        witholding_value: params.withholding_value,
        witholding_type: withholdingType,
        witholding_account_id: params.withholding_account_id,
      } : {}),
      transaction_lines_attributes: params.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        rate: item.unit_price,
        ...(item.description ? { description: item.description } : {}),
        ...(item.discount !== undefined ? { discount: item.discount } : {}),
        ...(item.tax_id !== undefined ? { tax_id: item.tax_id } : {}),
      })),
    },
  };

  const data = await jurnalRequest<InvoicesResponse>('POST', '/api/v1/sales_invoices', undefined, body);
  let invoice = data.sales_invoice ?? data as unknown as InvoiceItem;

  // The create response is not guaranteed to echo the computed totals, so read the invoice
  // back when a discount or withholding was asked for: those are exactly the attributes
  // Jurnal would drop silently, and the difference is money.
  if ((wantsDiscount || wantsWithholding) && invoice.id !== undefined) {
    try {
      const fresh = await jurnalRequest<InvoicesResponse>('GET', `/api/v1/sales_invoices/${invoice.id}`);
      invoice = fresh.sales_invoice ?? invoice;
    } catch {
      // Fall back to whatever the create returned rather than failing a written invoice.
    }
  }

  const discountApplied = Number(invoice.discount_price ?? 0);
  const withholdingApplied = Number(invoice.witholding_amount ?? 0);
  const unapplied: string[] = [];
  if (wantsDiscount && discountApplied === 0) unapplied.push(`discount (sent ${params.discount_value} as ${discountType})`);
  if (wantsWithholding && withholdingApplied === 0) unapplied.push(`withholding (sent ${params.withholding_value} as ${withholdingType})`);

  return {
    id: invoice.id,
    number: invoice.transaction_no,
    customer_name: (invoice.person as { display_name?: string; name?: string } | undefined)?.display_name
      ?? (invoice.person as { name?: string } | undefined)?.name,
    date: invoice.transaction_date,
    due_date: invoice.due_date,
    subtotal: invoice.subtotal,
    total: invoice.original_amount ?? invoice.amount,
    status: invoice.status,
    ...(wantsDiscount ? { discount_applied: discountApplied } : {}),
    ...(wantsWithholding ? { withholding_applied: withholdingApplied } : {}),
    ...(unapplied.length === 0 ? {} : {
      warning:
        `The invoice was created but Jurnal did not apply: ${unapplied.join('; ')}. ` +
        `The amount charged is wrong — check invoice ${invoice.id} in Jurnal. ` +
        `A rejected discount_type_id is the likely cause; see DISCOUNT_TYPE_IDS in invoices.ts.`,
    }),
  };
}

/** Reads the order and copies its customer and lines onto the invoice — see copyTransactionLines. */
export async function createInvoiceBySalesOrder(params: z.infer<typeof createInvoiceBySalesOrderSchema>) {
  const soData = await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/sales_orders/${params.sales_order_id}`);
  const so = (soData.sales_order ?? soData) as Record<string, unknown>;

  const personId = (so.person as { id?: number | string } | undefined)?.id;
  const soLines = (so.transaction_lines_attributes as SourceLine[] | undefined) ?? [];

  if (!personId) {
    throw new Error(
      `Sales order ${params.sales_order_id} has no customer to copy onto the invoice. ` +
      `Check the order in Jurnal — an invoice cannot be created without one.`
    );
  }
  if (soLines.length === 0) {
    throw new Error(
      `Sales order ${params.sales_order_id} has no line items to copy onto the invoice. ` +
      `If this order was created before the transaction_lines_attributes fix, it is empty in ` +
      `Jurnal and needs its lines added before it can be invoiced.`
    );
  }

  const lines = copyTransactionLines(soLines);
  if (lines.length === 0) {
    throw new Error(
      `Nothing left to invoice on sales order ${params.sales_order_id}: every line has a ` +
      `remaining quantity of 0, so it has already been invoiced in full.`
    );
  }

  const body = {
    sales_invoice: {
      person_id: personId,
      sales_order_id: params.sales_order_id,
      transaction_date: params.transaction_date,
      ...(params.due_date ? { due_date: params.due_date } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      transaction_lines_attributes: lines,
    },
  };

  const data = await jurnalRequest<InvoicesResponse>('POST', '/api/v1/sales_invoices', undefined, body);
  const invoice = data.sales_invoice ?? data as unknown as InvoiceItem;

  const savedLines = (invoice.transaction_lines_attributes as unknown[] | undefined) ?? [];
  const skipped = soLines.length - lines.length;

  return {
    id: invoice.id,
    number: invoice.transaction_no,
    customer_name: (invoice.person as { display_name?: string; name?: string } | undefined)?.display_name
      ?? (invoice.person as { name?: string } | undefined)?.name,
    date: invoice.transaction_date,
    due_date: invoice.due_date,
    total: invoice.original_amount ?? invoice.amount,
    status: invoice.status,
    from_sales_order: params.sales_order_id,
    lines_copied: lines.length,
    lines_saved: savedLines.length,
    ...(skipped > 0 ? { lines_skipped_already_invoiced: skipped } : {}),
    ...(savedLines.length === lines.length ? {} : {
      warning:
        `Jurnal saved ${savedLines.length} of the ${lines.length} lines copied from the order. ` +
        `The invoice exists but is incomplete — check it in Jurnal.`,
    }),
  };
}

export async function updateInvoice(params: z.infer<typeof updateInvoiceSchema>) {
  const {
    id, line_items,
    discount_type, discount_value,
    withholding_type, withholding_value, withholding_account_id,
    ...fields
  } = params;

  // `editable` is Jurnal's own per-record verdict: an invoice that has payments applied,
  // is reconciled, or is locked by a closed book refuses edits. Reading it first turns an
  // opaque API error into a statement of why this particular invoice cannot be changed.
  const before = await jurnalRequest<InvoicesResponse>('GET', `/api/v1/sales_invoices/${id}`);
  const current = (before.sales_invoice ?? before) as unknown as InvoiceItem;
  if (current.editable === false) {
    throw new Error(
      `Jurnal reports invoice ${id} (${current.transaction_no ?? 'no number'}) as not editable ` +
      `(status "${current.status}", has_payments ${current.has_payments}, is_reconciled ${current.is_reconciled}). ` +
      `Unapply the payment or reopen the period in the Jurnal UI first.`
    );
  }

  const wantsDiscount = discount_value !== undefined && discount_value > 0;
  const wantsWithholding = withholding_value !== undefined && withholding_value > 0;
  const resolvedDiscountType = discount_type ?? 'percent';
  const resolvedWithholdingType = withholding_type ?? 'value';

  const changes: Record<string, unknown> = {};
  if (fields.customer_id !== undefined) changes['person_id'] = fields.customer_id;
  if (fields.transaction_date !== undefined) changes['transaction_date'] = fields.transaction_date;
  if (fields.due_date !== undefined) changes['due_date'] = fields.due_date;
  if (fields.memo !== undefined) changes['memo'] = fields.memo;
  if (fields.tax_after_discount !== undefined) changes['tax_after_discount'] = fields.tax_after_discount;
  if (wantsDiscount) {
    changes['discount_unit'] = discount_value;
    changes['discount_type_id'] = DISCOUNT_TYPE_IDS[resolvedDiscountType];
  }
  if (wantsWithholding) {
    changes['witholding_value'] = withholding_value;
    changes['witholding_type'] = resolvedWithholdingType;
    changes['witholding_account_id'] = withholding_account_id;
  }
  if (line_items !== undefined) {
    changes['transaction_lines_attributes'] = line_items.map(line => ({
      ...(line.id !== undefined ? { id: line.id } : {}),
      ...(line.product_id !== undefined ? { product_id: line.product_id } : {}),
      ...(line.quantity !== undefined ? { quantity: line.quantity } : {}),
      ...(line.unit_price !== undefined ? { rate: line.unit_price } : {}),
      ...(line.description !== undefined ? { description: line.description } : {}),
      ...(line.discount !== undefined ? { discount: line.discount } : {}),
      ...(line.tax_id !== undefined ? { tax_id: line.tax_id } : {}),
      ...(line._destroy ? { _destroy: true } : {}),
    }));
  }

  if (Object.keys(changes).length === 0) {
    throw new Error(`No fields given to update on invoice ${id}.`);
  }

  const body = { sales_invoice: changes };
  try {
    await jurnalRequest('PATCH', `/api/v1/sales_invoices/${id}`, undefined, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/40[45]|method not allowed/i.test(message)) throw error;
    await jurnalRequest('PUT', `/api/v1/sales_invoices/${id}`, undefined, body);
  }

  // Jurnal answers 200 after silently dropping attributes it does not permit. Read the
  // invoice back and report what actually changed — the same failure mode create_invoice
  // already guards against for discount/withholding.
  const after = await jurnalRequest<InvoicesResponse>('GET', `/api/v1/sales_invoices/${id}`);
  const updated = (after.sales_invoice ?? after) as unknown as InvoiceItem;

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

  const discountApplied = Number(updated.discount_price ?? 0);
  const withholdingApplied = Number(updated.witholding_amount ?? 0);

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
    ...(wantsDiscount ? { discount_applied: discountApplied } : {}),
    ...(wantsWithholding ? { withholding_applied: withholdingApplied } : {}),
    total: updated.original_amount ?? updated.amount,
    date: updated.transaction_date,
    due_date: updated.due_date,
    memo: updated.memo,
  };
}

export async function deleteInvoice(params: z.infer<typeof deleteInvoiceSchema>) {
  // Capture what is about to be destroyed, both to check Jurnal's own `deletable`
  // verdict and so the caller gets a record of it back — there is no undo here.
  const before = await jurnalRequest<InvoicesResponse>('GET', `/api/v1/sales_invoices/${params.id}`);
  const invoice = (before.sales_invoice ?? before) as unknown as InvoiceItem;
  if (invoice.deletable === false) {
    throw new Error(
      `Jurnal reports invoice ${params.id} (${invoice.transaction_no ?? 'no number'}) as not deletable ` +
      `(status "${invoice.status}", has_payments ${invoice.has_payments}, is_reconciled ${invoice.is_reconciled}). ` +
      `Unapply the payment or reopen the period in the Jurnal UI first.`
    );
  }

  const deleted = {
    id: invoice.id,
    number: invoice.transaction_no,
    customer_name: invoice.person?.display_name ?? invoice.person?.name,
    date: invoice.transaction_date,
    total: invoice.original_amount ?? invoice.amount,
  };

  await jurnalRequest<unknown>('DELETE', `/api/v1/sales_invoices/${params.id}`);

  // Confirm it is actually gone: a 200 on DELETE is not proof, and Jurnal soft-deletes
  // some records (`deleted_at`) rather than removing them.
  let gone = false;
  let stillPresent: InvoiceItem | undefined;
  try {
    const check = await jurnalRequest<InvoicesResponse>('GET', `/api/v1/sales_invoices/${params.id}`);
    const found = (check.sales_invoice ?? check) as unknown as InvoiceItem;
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
        `Jurnal accepted the delete but invoice ${params.id} is still readable and not marked ` +
        `deleted (status "${stillPresent?.status}"). Check it in the Jurnal UI.`,
    }),
  };
}
