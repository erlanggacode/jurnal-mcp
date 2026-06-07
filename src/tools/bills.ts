import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listBillsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getBillSchema = z.object({
  id: z.string().describe('Bill (purchase invoice) ID'),
});

export const createBillSchema = z.object({
  vendor_id: z.string().describe('Vendor/Supplier ID (use list_customers with type vendor to find)'),
  transaction_date: z.string().describe('Bill date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: z.string().describe('Product ID'),
    quantity: z.number().positive().describe('Quantity'),
    unit_price: z.number().nonnegative().describe('Unit price per item'),
    description: z.string().optional().describe('Line item description'),
  })).describe('Line items for the bill'),
  memo: z.string().optional().describe('Optional memo/note'),
});

export const createBillByPurchaseOrderSchema = z.object({
  purchase_order_id: z.string().describe('Purchase order ID to create the bill from'),
  transaction_date: z.string().describe('Bill date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  memo: z.string().optional().describe('Optional memo/note'),
});

interface BillItem {
  id: number | string;
  transaction_no?: string;
  person?: { name?: string };
  transaction_date?: string;
  due_date?: string;
  amount?: number;
  status?: string;
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

  const bills = data.purchase_invoices ?? [];
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

export async function createBillByPurchaseOrder(params: z.infer<typeof createBillByPurchaseOrderSchema>) {
  const body = {
    purchase_invoice: {
      purchase_order_id: params.purchase_order_id,
      transaction_date: params.transaction_date,
      ...(params.due_date ? { due_date: params.due_date } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
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
