/** Escape user input that will be embedded in a LIKE/ILIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Split a search string by whitespace, dropping empty parts. */
export function splitWords(value: string): string[] {
  return value.split(/\s+/).filter((s) => s.length > 0);
}
