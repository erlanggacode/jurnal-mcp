import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, positiveNumber, nonNegativeNumber } from '../schema-utils.js';
import { copyTransactionLines, type SourceLine } from '../response-utils.js';

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
  })).describe('Line items for the invoice'),
  memo: z.string().optional().describe('Optional memo/note'),
});

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

  return data.sales_invoices ?? [];
}

export async function createInvoice(params: z.infer<typeof createInvoiceSchema>) {
  const body = {
    sales_invoice: {
      person_id: params.customer_id,
      transaction_date: params.transaction_date,
      due_date: params.due_date,
      memo: params.memo,
      transaction_lines_attributes: params.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        rate: item.unit_price,
        description: item.description,
      })),
    },
  };

  const data = await jurnalRequest<InvoicesResponse>('POST', '/api/v1/sales_invoices', undefined, body);
  const invoice = data.sales_invoice ?? data as unknown as InvoiceItem;
  return {
    id: invoice.id,
    number: invoice.transaction_no,
    customer_name: (invoice.person as { name?: string } | undefined)?.name,
    date: invoice.transaction_date,
    due_date: invoice.due_date,
    total: invoice.amount,
    status: invoice.status,
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
