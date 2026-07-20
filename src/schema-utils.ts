import { z } from 'zod';

/**
 * Jurnal's GET responses return IDs as numbers (`product.id: 103901430`) and
 * money/quantity as strings (`rate: "6500000.0"`). Any flow that reads a record
 * and feeds it back into a create call — duplicating a sales order, say — hits a
 * type mismatch before the request is ever sent. These helpers accept whichever
 * form the API produced and normalise it to what the write endpoints expect.
 */

const toNumber = (v: string | number, ctx: z.RefinementCtx): number => {
  const n = typeof v === 'number' ? v : Number(v.trim());
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected a number, received "${v}"` });
    return z.NEVER;
  }
  return n;
};

/** ID sent to the API as a string. Accepts the numbers GETs return. */
export const stringId = z
  .union([z.string(), z.number()])
  .transform(v => String(v))
  .pipe(z.string().min(1, 'ID must not be empty'));

/** ID sent to the API as a number. Accepts the strings a caller may pass. */
export const numericId = z
  .union([z.string(), z.number()])
  .transform(toNumber)
  .pipe(z.number().int().positive());

/** Quantity/amount that must be > 0. Accepts the strings GETs return. */
export const positiveNumber = z
  .union([z.string(), z.number()])
  .transform(toNumber)
  .pipe(z.number().positive());

/** Price that may be 0. Accepts the strings GETs return. */
export const nonNegativeNumber = z
  .union([z.string(), z.number()])
  .transform(toNumber)
  .pipe(z.number().nonnegative());
