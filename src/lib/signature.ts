import type { EmailType } from "../schemas";

const MCPFACTORY_APP_ID = "mcpfactory";

/** Full GrowthAgency signature — only used for mcpfactory app */
export function buildMcpFactorySignature(type: EmailType, brandUrl?: string): string {
  const brandDisplay = brandUrl || "BRAND_URL";
  const brandHref = brandUrl || "BRAND_URL";

  const unsubscribeBlock = type === "transactional"
    ? `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Inter,system-ui,-apple-system,sans-serif"><tr><td style="font-size:11px;color:#cbd5e1;padding-top:4px"><a href="{{{pm:unsubscribe}}}" style="color:#cbd5e1;text-decoration:underline">Unsubscribe</a> to stop receiving sales cold emails from us</td></tr></table>`
    : "";

  // All table-based layout — no <p> tags to avoid email client default margins
  return [
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse"><tr><td style="padding:24px 0 0">`,
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;width:100%"><tr><td style="padding:16px 0 0">`,
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Inter,system-ui,-apple-system,sans-serif">`,
    `<tr>`,
    `<td style="padding-right:14px;vertical-align:top">`,
    `<img src="https://media.licdn.com/dms/image/v2/D4E03AQExHRKHGkfXdA/profile-displayphoto-shrink_200_200/profile-displayphoto-shrink_200_200/0/1696248223118?e=2147483647&v=beta&t=B8ASFxYpZNDdcCSZ3NS_-OhnBgDYQPb4Z5HuIjsBrrE" alt="" width="52" height="52" style="border-radius:50%;display:block" />`,
    `</td>`,
    `<td style="vertical-align:top;font-size:13px;line-height:1.3">`,
    `<span style="font-weight:600;color:#0f172a;display:block">Kevin Lourd</span>`,
    `<span style="color:#64748b;display:block;padding-top:1px">Growth<span style="color:#10b981;font-weight:600">Agency</span>.dev</span>`,
    `<a href="https://growthagency.dev" style="color:#10b981;text-decoration:none;font-size:12px;display:block;padding-top:2px">growthagency.dev</a>`,
    `</td>`,
    `</tr>`,
    `</table>`,
    `</td></tr></table>`,
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Inter,system-ui,-apple-system,sans-serif;padding-top:10px"><tr><td style="font-size:11px;color:#94a3b8;padding-top:10px;font-style:italic">`,
    `Email generated with AI on behalf of our client: <a href="${brandHref}" style="color:#94a3b8;text-decoration:underline">${brandDisplay}</a>`,
    `</td></tr></table>`,
    unsubscribeBlock,
    `</td></tr></table>`,
  ].join("");
}

/** Minimal default footer — just a discrete unsubscribe for transactional, nothing for broadcast */
export function buildDefaultFooter(type: EmailType): string {
  if (type !== "transactional") return "";

  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse"><tr><td style="padding:24px 0 0;text-align:center"><span style="font-size:11px;color:#9ca3af;font-family:sans-serif"><a href="{{{pm:unsubscribe}}}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></span></td></tr></table>`;
}

export function buildSignature(type: EmailType, appId: string, brandUrl?: string): string {
  // Broadcast emails go through Instantly which manages its own per-account signatures
  if (type === "broadcast") return "";

  if (appId === MCPFACTORY_APP_ID) {
    return buildMcpFactorySignature(type, brandUrl);
  }
  return buildDefaultFooter(type);
}

export function appendSignature(htmlBody: string | undefined, type: EmailType, appId: string, brandUrl?: string): string | undefined {
  if (!htmlBody) return undefined;
  const footer = buildSignature(type, appId, brandUrl);
  if (!footer) return htmlBody;
  return htmlBody + footer;
}
