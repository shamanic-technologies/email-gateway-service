import type { EmailType } from "../schemas";

/** Minimal default footer — just a discrete unsubscribe for transactional, nothing for broadcast */
export function buildDefaultFooter(type: EmailType): string {
  if (type !== "transactional") return "";

  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse"><tr><td style="padding:24px 0 0;text-align:center"><span style="font-size:11px;color:#9ca3af;font-family:sans-serif"><a href="{{{pm:unsubscribe}}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></span></td></tr></table>`;
}

export function buildSignature(type: EmailType): string {
  // Broadcast emails go through Instantly which manages its own per-account signatures
  if (type === "broadcast") return "";

  return buildDefaultFooter(type);
}

export function appendSignature(htmlBody: string | undefined, type: EmailType): string | undefined {
  if (!htmlBody) return undefined;
  const footer = buildSignature(type);
  if (!footer) return htmlBody;
  return htmlBody + footer;
}
