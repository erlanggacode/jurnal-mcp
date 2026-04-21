import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const createDeliveryOrderSchema = z.object({
  sales_order_id: z.string().describe('Sales order ID to create delivery for'),
  transaction_date: z.string().describe('Delivery date in YYYY-MM-DD format'),
  memo: z.string().optional().describe('Optional memo/note'),
});

interface DeliveryOrderItem {
  id: number | string;
  transaction_no?: string;
  [key: string]: unknown;
}

interface DeliveryOrderResponse {
  delivery_order?: DeliveryOrderItem;
  [key: string]: unknown;
}

export async function createDeliveryOrder(params: z.infer<typeof createDeliveryOrderSchema>) {
  const body = {
    delivery_order: {
      sales_order_id: params.sales_order_id,
      transaction_date: params.transaction_date,
      memo: params.memo,
    },
  };

  const data = await jurnalRequest<DeliveryOrderResponse>('POST', '/api/v1/delivery_orders', undefined, body);
  return data.delivery_order ?? data;
}
