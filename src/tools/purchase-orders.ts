import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const listPurchaseOrdersSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open').describe('Filter by order status'),
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(20).describe('Number of results per page'),
  sort_by: z.string().default('transaction_date').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getPurchaseOrderSchema = z.object({
  id: z.string().describe('Purchase order ID'),
});

export const closePurchaseOrderSchema = z.object({
  id: z.string().describe('Purchase order ID to close'),
});

export const createPurchaseOrderSchema = z.object({
  vendor_id: z.string().describe('Vendor/Supplier ID (use list_customers with type vendor to find)'),
  transaction_date: z.string().describe('Transaction date in YYYY-MM-DD format'),
  due_date: z.string().optional().describe('Due date in YYYY-MM-DD format'),
  line_items: z.array(z.object({
    product_id: z.string().describe('Product ID'),
    quantity: z.number().positive().describe('Quantity'),
    unit_price: z.number().nonnegative().describe('Unit price'),
  })).describe('Line items for the purchase order'),
  memo: z.string().optional().describe('Optional memo/note'),
});

interface PurchaseOrderItem {
  id: number | string;
  transaction_no?: string;
  person?: { name?: string };
  transaction_date?: string;
  due_date?: string;
  amount?: number;
  status?: string;
  [key: string]: unknown;
}

interface PurchaseOrdersResponse {
  purchase_orders?: PurchaseOrderItem[];
  purchase_order?: PurchaseOrderItem;
  [key: string]: unknown;
}

export async function listPurchaseOrders(params: z.infer<typeof listPurchaseOrdersSchema>) {
  const data = await jurnalRequest<PurchaseOrdersResponse>('GET', '/api/v1/purchase_orders', {
    status: params.status,
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  const orders = data.purchase_orders ?? [];
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
      purchase_order_lines_attributes: params.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        rate: item.unit_price,
      })),
    },
  };

  const data = await jurnalRequest<PurchaseOrdersResponse>('POST', '/api/v1/purchase_orders', undefined, body);
  const order = data.purchase_order as PurchaseOrderItem | undefined ?? data as unknown as PurchaseOrderItem;
  return {
    id: order.id,
    number: order.transaction_no,
  };
}
