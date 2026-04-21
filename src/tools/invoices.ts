import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listSalesInvoicesSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
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
