import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listSalesInvoicesSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const createInvoiceSchema = z.object({
  customer_id: z.string().describe('Customer ID'),
  transaction_date: z.string().describe('Invoice date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: z.string().describe('Product ID'),
    quantity: z.number().positive().describe('Quantity'),
    unit_price: z.number().nonnegative().describe('Unit price per item'),
    description: z.string().optional().describe('Line item description'),
  })).describe('Line items for the invoice'),
  memo: z.string().optional().describe('Optional memo/note'),
});

export const createInvoiceBySalesOrderSchema = z.object({
  sales_order_id: z.string().describe('Sales order ID to create invoice from'),
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

export async function createInvoiceBySalesOrder(params: z.infer<typeof createInvoiceBySalesOrderSchema>) {
  const body = {
    sales_invoice: {
      sales_order_id: params.sales_order_id,
      transaction_date: params.transaction_date,
      due_date: params.due_date,
      memo: params.memo,
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
