import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, positiveNumber, nonNegativeNumber } from '../schema-utils.js';
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
