import type { OrgContext } from "../middleware/requireOrgId";
import * as instantlyClient from "./instantly-client";
import { getLatestGmailThread, type LatestGmailThread } from "./google-client";

// WHERE a follow-up lands (RIGHT-MOMENT-OR-LATER-1014, owner 2026-10-14): a
// `followUp: true` send is a reply IN the thread the person wrote in last, FROM
// the address they wrote to / were answered from, whichever transport holds it.
//
// Two transports can hold the person's latest exchange with the brand:
// - an Instantly thread (instantly-service continues it itself on followUp), or
// - a Gmail thread of a mailbox the org connected (google-service replies in it).
// The Gmail thread wins only when its newest message is STRICTLY newer than the
// brand's latest Instantly exchange (last email delivered, a reply received).
// Otherwise the send goes to instantly-service exactly as before.
//
// Read failures are not "no thread": an unreadable answer fails the send (502)
// rather than guessing a transport and mailing a stranger's email.

export type FollowUpRoute =
  | { transport: "instantly"; reason: string }
  | { transport: "gmail"; thread: LatestGmailThread }
  | { transport: "refused"; status: number; body: Record<string, unknown> };

// The send gate's never-lapsing refusals (instantly-service owns them and
// states them on the status read): honoured on the Gmail transport too.
const STANDING_REFUSALS = new Set(["lead_opted_out", "lead_not_a_prospect"]);

const later = (a: string | null, b: string | null | undefined): string | null => {
  if (!b) return a;
  if (!a) return b;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
};

interface BrandExchange {
  latestAt: string | null;
  queued: boolean;
  refusalCode: string | null;
}

/** The brand's latest Instantly exchange with the person, across the brands of the send. */
async function readInstantlyExchange(to: string, brandIds: string[], ctx: OrgContext): Promise<BrandExchange> {
  const answers = await Promise.all(
    brandIds.map((brandId) => instantlyClient.getStatus({ brandId, items: [{ email: to }] }, ctx)),
  );
  const out: BrandExchange = { latestAt: null, queued: false, refusalCode: null };
  for (const answer of answers) {
    const result = answer.results?.[0];
    if (!result) throw new Error(`instantly-service /orgs/status answered no row for ${to}`);
    const scopes = [result.brand, ...Object.values(result.byCampaign ?? {})];
    for (const scope of scopes) {
      if (!scope) continue;
      out.latestAt = later(out.latestAt, scope.lastDeliveredAt);
      out.latestAt = later(out.latestAt, scope.firstRepliedAt ?? null);
    }
    const brand = result.brand as (instantlyClient.ScopedStatus & {
      queued?: boolean;
      sendRefusal?: { code?: string } | null;
    }) | null;
    if (brand?.queued === true) out.queued = true;
    const code = brand?.sendRefusal?.code;
    if (!out.refusalCode && typeof code === "string" && STANDING_REFUSALS.has(code)) out.refusalCode = code;
  }
  return out;
}

export async function resolveFollowUpRoute(to: string, ctx: OrgContext): Promise<FollowUpRoute> {
  const brandIds = (ctx.brandId ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  // "The brand's latest exchange" needs a brand; instantly-service keys its
  // own follow-up thread on the brand the same way.
  if (brandIds.length === 0) return { transport: "instantly", reason: "no_brand" };

  const gmail = await getLatestGmailThread(to, ctx);
  if (!gmail.found) return { transport: "instantly", reason: `gmail_${gmail.reason}` };
  if (!gmail.thread.lastMessageAt) return { transport: "instantly", reason: "gmail_thread_undated" };

  const instantly = await readInstantlyExchange(to, brandIds, ctx);
  // A step of the brand's sequence still waiting to leave: instantly-service
  // decides (it refuses a racing follow-up with `brand_sequence_queued`).
  if (instantly.queued) return { transport: "instantly", reason: "brand_sequence_queued" };
  if (instantly.latestAt && new Date(instantly.latestAt).getTime() >= new Date(gmail.thread.lastMessageAt).getTime()) {
    return { transport: "instantly", reason: "instantly_thread_is_latest" };
  }

  if (instantly.refusalCode) {
    return {
      transport: "refused",
      status: 409,
      body: {
        error: instantly.refusalCode === "lead_opted_out" ? "Lead has opted out" : "Lead is not a prospect",
        code: instantly.refusalCode,
        details: `${to} carries a standing ${instantly.refusalCode} refusal. No email was sent.`,
      },
    };
  }
  return { transport: "gmail", thread: gmail.thread };
}
