/**
 * REP-REPLY-1127: turn a transactional send's Reply-To list and thread ids
 * into what postmark-service sets on the delivered message.
 *
 * - `replyTo` (Postmark `ReplyTo`) accepts a comma-separated RFC 5322 address
 *   list; a mail client puts every address in To when the reader hits Reply.
 * - postmark-service has no `inReplyTo`/`references` body field: it sets every
 *   `headers` entry as a real message header, so threading travels there.
 */

export type ReplyToInput = string | { email: string; name?: string }[] | undefined;

/**
 * An ASCII display name is a quoted-string (the schema refuses `"`, `\` and
 * line breaks, so nothing needs escaping: postmark-service's SES list splitter
 * is quote-aware but not escape-aware). A non-ASCII name is an RFC 2047
 * encoded-word, which SES requires for a non-ASCII display name.
 */
function displayName(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name}"`;
  return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
}

/** A single string is forwarded verbatim (unchanged behaviour); a list is rendered. */
export function renderReplyTo(replyTo: ReplyToInput): string | undefined {
  if (replyTo === undefined || typeof replyTo === "string") return replyTo;
  return replyTo.map((a) => (a.name ? `${displayName(a.name)} <${a.email}>` : a.email)).join(", ");
}

/** `{ headers }` only when the caller stated a thread; else nothing on the wire. */
export function threadingHeaders(
  inReplyTo: string | undefined,
  references: string | undefined,
): { headers?: { name: string; value: string }[] } {
  const headers: { name: string; value: string }[] = [];
  if (inReplyTo) headers.push({ name: "In-Reply-To", value: inReplyTo });
  if (references) headers.push({ name: "References", value: references.trim().split(/\s+/).join(" ") });
  return headers.length > 0 ? { headers } : {};
}
