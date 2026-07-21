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
