import { z } from 'zod';
import { jurnalRequest } from '../jurnal-client.js';
import { stringId, numericId, positiveNumber } from '../schema-utils.js';

export const listReceivePaymentsSchema = z.object({
  page: z.number().int().positive().default(1).describe('Page number'),
  page_size: z.number().int().positive().default(10).describe('Number of results per page'),
  sort_by: z.string().default('created_at').describe('Field to sort by'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
});

export const getReceivePaymentsByInvoiceSchema = z.object({
  invoice_id: stringId.describe('Invoice ID to fetch payments for'),
});

export const createReceivePaymentSchema = z.object({
  transaction_id: numericId.describe('The invoice transaction ID to apply payment to (numeric ID from the invoice)'),
  transaction_date: z.string().describe('Payment date in YYYY-MM-DD format'),
  amount: positiveNumber.describe('Payment amount'),
  deposit_to_name: z.string().describe('Name of the bank/cash account to deposit to (e.g. "BCA 4748"). Use get_accounts to find the account name.'),
  payment_method_id: numericId.describe('Payment method ID (e.g. Transfer Bank). Use get_payment_methods to find the correct ID.'),
  payment_method_name: z.string().optional().describe('Payment method name (optional, e.g. "Transfer Bank")'),
  custom_id: z.string().optional().describe('Custom payment reference ID (optional)'),
  memo: z.string().optional().describe('Payment memo/note (optional)'),
  is_draft: z.boolean().default(false).describe('Whether to save as draft (default: false)'),
});

export const createBillPaymentSchema = z.object({
  bill_id: numericId.describe('The bill (purchase invoice) ID to pay. Use list_bills or get_bill to find it.'),
  transaction_date: z.string().describe('Payment date in YYYY-MM-DD format'),
  amount: positiveNumber.describe('Payment amount. May be less than the bill total for a partial payment.'),
  withdraw_from_id: numericId.optional().describe(
    'ID of the bank/cash account the money leaves (e.g. 83540261 for "BCA 4748"). Use get_accounts ' +
    'to find it. Preferred over withdraw_from_name — the payable side of the API wants an ID.'
  ),
  withdraw_from_name: z.string().optional().describe(
    'Name or account number of the bank/cash account the money leaves (e.g. "BCA 4748" or "111-001"). ' +
    'Resolved to an ID via get_accounts. Ignored when withdraw_from_id is given.'
  ),
  payment_method_id: numericId.describe('Payment method ID (e.g. Transfer Bank). Use get_payment_methods to find the correct ID.'),
  payment_method_name: z.string().optional().describe('Payment method name (optional, e.g. "Transfer Bank")'),
  custom_id: z.string().optional().describe('Custom payment reference ID (optional)'),
  memo: z.string().optional().describe('Payment memo/note (optional)'),
  is_draft: z.boolean().default(false).describe('Whether to save as draft (default: false)'),
}).refine(
  v => v.withdraw_from_id !== undefined || v.withdraw_from_name !== undefined,
  { message: 'Give withdraw_from_id (preferred) or withdraw_from_name — the account the money leaves.' }
);

interface PaymentItem {
  id: number | string;
  custom_id?: string;
  amount?: number;
  transaction_date?: string;
  [key: string]: unknown;
}

interface PaymentsResponse {
  receive_payments?: PaymentItem[];
  receive_payment?: PaymentItem;
  [key: string]: unknown;
}

export async function listReceivePayments(params: z.infer<typeof listReceivePaymentsSchema>) {
  const data = await jurnalRequest<PaymentsResponse>('GET', '/api/v1/receive_payments', {
    page: params.page,
    page_size: params.page_size,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
  });

  return data.receive_payments ?? [];
}

export async function getReceivePaymentsByInvoice(params: z.infer<typeof getReceivePaymentsByInvoiceSchema>) {
  const data = await jurnalRequest<PaymentsResponse>('GET', '/api/v1/receive_payments', {
    invoice_id: params.invoice_id,
  });

  const payments = data.receive_payments ?? [];
  const totalPaid = payments.reduce((sum: number, p: PaymentItem) => sum + (Number(p.amount) || 0), 0);

  return {
    payments,
    total_paid: totalPaid,
  };
}

export async function createReceivePayment(params: z.infer<typeof createReceivePaymentSchema>) {
  const body: Record<string, unknown> = {
    receive_payment: {
      transaction_date: params.transaction_date,
      deposit_to_name: params.deposit_to_name,
      payment_method_id: params.payment_method_id,
      is_draft: params.is_draft,
      ...(params.payment_method_name ? { payment_method_name: params.payment_method_name } : {}),
      ...(params.custom_id ? { custom_id: params.custom_id } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      records_attributes: [
        {
          transaction_id: params.transaction_id,
          amount: params.amount,
        },
      ],
    },
  };

  const data = await jurnalRequest<PaymentsResponse>('POST', '/api/v1/receive_payments', undefined, body);
  return data.receive_payment ?? data;
}

/**
 * Paying a bill is the payable-side mirror of receive_payments, but the resource is not
 * documented and the name is not derivable from anything already in this codebase.
 * Rather than guess once and POST — which risks writing a real payment through the wrong
 * shape — probe with GETs first: the resource that answers is the resource that exists.
 */
const BILL_PAYMENT_RESOURCES = ['purchase_payments', 'bill_payments', 'pay_bills'];

/**
 * The payable side does not mirror receive_payments here. create_receive_payment passes
 * `deposit_to_name` and lets Jurnal resolve the name server-side; the payable side rejected
 * every name field with 422 `refund_from tidak bisa kosong / tidak valid` and wants an
 * account ID instead — the same `refund_from_id` create_expense already sends for "which
 * account did the money leave". Rails humanises `refund_from_id` to "Refund from", which is
 * why the error names the association rather than the attribute; `refund_from` is kept as a
 * fallback in case this one is literal.
 */
const REFUND_FIELDS = ['refund_from_id', 'refund_from'];

const isMissing = (error: unknown): boolean =>
  /\b40[045]\b|not found|method not allowed/i.test(error instanceof Error ? error.message : String(error));

async function discoverBillPaymentResource(): Promise<{ resource: string }> {
  const tried: string[] = [];
  for (const resource of BILL_PAYMENT_RESOURCES) {
    try {
      await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/${resource}`, { page_size: 1 });
      if (resource !== BILL_PAYMENT_RESOURCES[0]) {
        console.error(`[jurnal-mcp] bill payments live at "/api/v1/${resource}"`);
      }
      return { resource };
    } catch (error) {
      if (!isMissing(error)) throw error; // a real error means the endpoint exists
      tried.push(`/api/v1/${resource}`);
    }
  }

  throw new Error(
    `No bill payment endpoint found. Tried ${tried.join(', ')}, all of which returned 404/405. ` +
    `Jurnal may not expose payable-side payments over the API, or may name the resource ` +
    `something else — add the correct name to BILL_PAYMENT_RESOURCES in payments.ts. ` +
    `Until then, bills have to be paid in the Jurnal UI.`
  );
}

interface AccountRecord {
  id: number | string;
  name?: string;
  number?: string;
  code?: string;
  [key: string]: unknown;
}

/**
 * Resolve a bank/cash account name or number to its ID. get_bank_accounts has been seen
 * returning 401 for API keys that can still read /accounts, so go through /accounts and say
 * plainly that withdraw_from_id sidesteps this if that endpoint is blocked too.
 */
async function resolveAccountId(nameOrNumber: string): Promise<number | string> {
  const wanted = nameOrNumber.trim().toLowerCase();
  let accounts: AccountRecord[];
  try {
    const data = await jurnalRequest<{ accounts?: AccountRecord[] }>('GET', '/api/v1/accounts', { page_size: 200 });
    accounts = data.accounts ?? [];
  } catch (error) {
    throw new Error(
      `Could not read /api/v1/accounts to resolve "${nameOrNumber}" (${error instanceof Error ? error.message : String(error)}). ` +
      `Pass withdraw_from_id directly instead — find the account ID in the Jurnal UI under ` +
      `Accounts, or in the URL of the account's page.`
    );
  }

  const matches = accounts.filter(a =>
    [a.name, a.number, a.code].some(v => typeof v === 'string' && v.trim().toLowerCase() === wanted)
  );
  if (matches.length === 1) return matches[0].id;

  if (matches.length === 0) {
    const cashBank = accounts
      .filter(a => typeof a.name === 'string' && /bank|cash|kas|bca|mandiri|bni|bri/i.test(a.name))
      .slice(0, 15)
      .map(a => `${a.name} (id ${a.id}, no. ${a.number ?? a.code ?? '?'})`);
    throw new Error(
      `No account matches "${nameOrNumber}". Likely bank/cash accounts: ${cashBank.join('; ') || 'none found'}. ` +
      `Pass withdraw_from_id to be unambiguous.`
    );
  }

  throw new Error(
    `"${nameOrNumber}" matches ${matches.length} accounts: ` +
    `${matches.map(a => `id ${a.id} (no. ${a.number ?? a.code ?? '?'})`).join(', ')}. Pass withdraw_from_id instead.`
  );
}

export async function createBillPayment(params: z.infer<typeof createBillPaymentSchema>) {
  const { resource } = await discoverBillPaymentResource();
  const envelope = resource.replace(/s$/, '');

  const refundFromId = params.withdraw_from_id ?? await resolveAccountId(params.withdraw_from_name!);

  const billBefore = await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/purchase_invoices/${params.bill_id}`);
  const bill = (billBefore.purchase_invoice ?? billBefore) as Record<string, unknown>;
  const remainingBefore = Number(bill.remaining ?? bill.original_amount ?? 0);

  const buildBody = (refundField: string) => ({
    [envelope]: {
      transaction_date: params.transaction_date,
      [refundField]: refundFromId,
      payment_method_id: params.payment_method_id,
      is_draft: params.is_draft,
      ...(params.payment_method_name ? { payment_method_name: params.payment_method_name } : {}),
      ...(params.custom_id ? { custom_id: params.custom_id } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      records_attributes: [
        {
          transaction_id: params.bill_id,
          amount: params.amount,
        },
      ],
    },
  });

  // A 422 means Jurnal rejected the payload and wrote nothing, so retrying the other
  // spelling is safe — no risk of a double payment. Anything else is not a naming problem
  // and is re-thrown with the endpoint that answered, so the next debug round starts there.
  let data: Record<string, unknown> | undefined;
  let refundFieldUsed = REFUND_FIELDS[0];
  for (const [index, refundField] of REFUND_FIELDS.entries()) {
    try {
      data = await jurnalRequest<Record<string, unknown>>('POST', `/api/v1/${resource}`, undefined, buildBody(refundField));
      refundFieldUsed = refundField;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isLastCandidate = index === REFUND_FIELDS.length - 1;
      if (isLastCandidate || !/\b422\b/.test(message) || !/refund_from/i.test(message)) {
        throw new Error(
          `POST /api/v1/${resource} failed with "${refundField}": ${message} ` +
          `(sent account id ${refundFromId} for bill ${params.bill_id}).`
        );
      }
    }
  }

  const payment = (data![envelope] ?? data!) as PaymentItem;

  // The bill is the source of truth for whether the payment applied. A payment that was
  // created but not linked to the bill leaves `remaining` untouched, and that looks
  // identical to success from the POST response alone.
  const billAfter = await jurnalRequest<Record<string, unknown>>('GET', `/api/v1/purchase_invoices/${params.bill_id}`);
  const updated = (billAfter.purchase_invoice ?? billAfter) as Record<string, unknown>;
  const remainingAfter = Number(updated.remaining ?? 0);
  const applied = remainingBefore - remainingAfter;

  return {
    payment_id: payment?.id,
    endpoint: `/api/v1/${resource}`,
    account_field_used: refundFieldUsed,
    withdraw_from_id: refundFromId,
    bill_id: params.bill_id,
    bill_number: updated.transaction_no,
    amount_sent: params.amount,
    amount_applied_to_bill: applied,
    remaining_before: remainingBefore,
    remaining_after: remainingAfter,
    verified: applied === params.amount,
    ...(applied === params.amount ? {} : {
      warning:
        `Jurnal accepted the payment but the bill's outstanding balance moved by ${applied}, ` +
        `not the ${params.amount} sent. The payment exists but may not be linked to the bill. ` +
        `Check payment ${payment?.id} in the Jurnal UI before treating this bill as paid.`,
    }),
  };
}
