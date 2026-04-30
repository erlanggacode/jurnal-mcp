import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';

export const getPaymentMethodsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(50).describe('Number of results per page'),
});

interface PaymentMethod {
  id: number | string;
  name?: string;
  [key: string]: unknown;
}

interface PaymentMethodsResponse {
  payment_methods?: PaymentMethod[];
  [key: string]: unknown;
}

export async function getPaymentMethods(params: z.infer<typeof getPaymentMethodsSchema>) {
  const data = await jurnalRequest<PaymentMethodsResponse>('GET', '/api/v1/payment_methods', {
    page: params.page,
    page_size: params.page_size,
  });

  const methods = data.payment_methods ?? [];
  return {
    payment_methods: methods.map((m: PaymentMethod) => ({
      id: m.id,
      name: m.name,
    })),
    _raw_keys: data.payment_methods ? undefined : Object.keys(data),
  };
}
