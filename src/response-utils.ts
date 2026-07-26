/**
 * Pull a collection out of a Jurnal API response.
 *
 * List tools used to do `data.contacts ?? []`, which turns an unrecognised response
 * — a changed envelope, a wrong path, an error body that still came back 200 — into
 * "no results". That is indistinguishable from a genuinely empty account, so the
 * caller has no way to tell "you have no contacts" from "this tool is broken", and
 * the failure hides until someone checks by hand.
 *
 * A present-but-empty array is a real answer and returned as such. An envelope with
 * none of the expected keys raises, naming the keys that were actually present so
 * the real shape can be read off the error.
 */
export interface SourceLine {
  quantity?: number | string;
  remaining_quantity?: number | string;
  rate?: number | string;
  description?: string;
  product?: { id?: number | string; name?: string };
  unit?: { id?: number | string };
  tax?: { id?: number | string } | null;
  line_tax?: { id?: number | string } | null;
  [key: string]: unknown;
}

/**
 * Copy the lines of a source document (purchase order, sales order) into the shape a
 * create call wants.
 *
 * Jurnal does not populate a new transaction from a reference to the document it came
 * from — passing purchase_order_id or sales_order_id alone is answered with "Person tidak
 * boleh kosong, Transaction lines tidak boleh kosong". The reference links the records;
 * the new transaction still has to carry its own vendor/customer and lines.
 *
 * Line IDs are deliberately not copied: they belong to the source document's own rows, and
 * reusing them would point the new record at rows owned by something else. Quantities come
 * from `remaining_quantity` where the API provides it, so a partly billed or partly invoiced
 * document bills what is outstanding rather than charging for the same goods twice.
 */
export function copyTransactionLines(sourceLines: SourceLine[]): Record<string, unknown>[] {
  return sourceLines
    .map(line => {
      const taxId = line.tax?.id ?? line.line_tax?.id;
      return {
        product_id: line.product?.id,
        quantity: Number(line.remaining_quantity ?? line.quantity ?? 0),
        rate: Number(line.rate ?? 0),
        ...(line.description ? { description: line.description } : {}),
        ...(line.unit?.id !== undefined ? { unit_id: line.unit.id } : {}),
        ...(taxId !== undefined && taxId !== null ? { tax_id: taxId } : {}),
      };
    })
    .filter(line => line.quantity > 0 && line.product_id !== undefined);
}

export function extractList<T>(
  data: unknown,
  endpoint: string,
  keys: string[]
): T[] {
  if (Array.isArray(data)) return data as T[];

  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;

    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        if (key !== keys[0]) {
          console.error(`[jurnal-mcp] ${endpoint}: collection found under "${key}", expected "${keys[0]}"`);
        }
        return value as T[];
      }
    }

    // An empty object is a plausible way to say "nothing here"; treat it as empty
    // rather than failing a legitimately empty account.
    const present = Object.keys(record);
    if (present.length === 0) return [];

    throw new Error(
      `Jurnal API response for ${endpoint} contained no array under ${keys.map(k => `"${k}"`).join(' or ')}. ` +
      `Top-level keys present: [${present.join(', ')}]. ` +
      `The endpoint path or response envelope is probably wrong — this is a bug in the MCP server, ` +
      `not an empty result.`
    );
  }

  throw new Error(
    `Jurnal API response for ${endpoint} was ${data === null ? 'null' : typeof data}, expected an object or array.`
  );
}
