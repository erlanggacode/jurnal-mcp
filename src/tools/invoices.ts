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

interface InvoiceItem {
  id: number | string;
  transaction_no?: string;
  person?: { name?: string };
  transaction_date?: string;
  amount?: number;
  status?: string;
  due_date?: string;
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
