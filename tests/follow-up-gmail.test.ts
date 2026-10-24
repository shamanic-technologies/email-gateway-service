import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index";
import * as idempotencyStore from "../src/lib/idempotency-store";

// RIGHT-MOMENT-OR-LATER-1014: a followUp send lands in the thread the person
// wrote in last, from the address they wrote to, whichever transport holds it.

vi.mock("../src/lib/register-providers", () => ({
  registerProviderRequirements: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config", () => ({
  config: {
    port: 3009,
    apiKey: "test-api-key",
    postmark: { url: "http://postmark", apiKey: "pm-key" },
    instantly: { url: "http://instantly", apiKey: "inst-key" },
    brand: { url: "http://brand", apiKey: "brand-key" },
    google: { url: "http://google", apiKey: "google-key" },
    key: { url: "", apiKey: "" },
    runs: { url: "", apiKey: "" },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const PERSON = "client@clientco.test";
const THREAD = {
  threadId: "T1",
  googleAccountId: "acc-1",
  mailbox: "owner@gmail.test",
  fromAddress: "kevin@ourbrand.test",
  lastMessageAt: "2026-10-14T14:24:35.000Z",
  lastMessageDirection: "outbound",
  subject: "Re: Enquiry",
  sendPermission: true,
};

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

const statusRow = (brand: Record<string, unknown> | null, byCampaign: Record<string, unknown> = {}) => ({
  results: [
    {
      email: PERSON,
      byCampaign,
      brand,
      campaign: null,
      global: { email: { bounced: false, unsubscribed: false } },
    },
  ],
});

type Route = (url: string, init: { method?: string; body?: string }) => ReturnType<typeof json> | undefined;

function serve(...routes: Route[]) {
  mockFetch.mockImplementation(async (url: string, init: { method?: string; body?: string } = {}) => {
    for (const r of routes) {
      const out = r(url, init);
      if (out) return out;
    }
    throw new Error(`unexpected fetch ${init.method ?? "GET"} ${url}`);
  });
}

const latestThread = (status: number, body: unknown): Route => (url) =>
  url.startsWith("http://google/orgs/google/threads/latest") ? json(status, body) : undefined;
const instantlyStatus = (body: unknown): Route => (url) =>
  url === "http://instantly/orgs/status" ? json(200, body) : undefined;
const instantlySend: Route = (url) =>
  url === "http://instantly/orgs/send" ? json(200, { success: true, campaignId: "c1", leadId: "l1", added: 1 }) : undefined;
const gmailReply = (status: number, body: unknown): Route => (url) =>
  url === "http://google/orgs/google/thread-replies" ? json(status, body) : undefined;

const followUp = (over: Record<string, unknown> = {}) => ({
  type: "broadcast",
  to: PERSON,
  subject: "Checking in",
  sequence: [{ step: 1, bodyHtml: "<p>Hi again</p>", bodyText: "Hi again", daysSinceLastStep: 0 }],
  followUp: true,
  idempotencyKey: "prospect-follow-up:event:e1",
  ...over,
});

const post = (body: unknown, brand = "brand_1") =>
  request(app)
    .post("/orgs/send")
    .set("X-API-Key", "test-api-key")
    .set("x-org-id", "org_1")
    .set("x-user-id", "user_1")
    .set("x-run-id", "run_1")
    .set("x-brand-id", brand)
    .send(body);

const calledUrls = () => mockFetch.mock.calls.map((c) => c[0] as string);

beforeEach(async () => {
  mockFetch.mockReset();
  await idempotencyStore.clear();
});

describe("followUp: the person's latest thread is an Instantly thread (unchanged)", () => {
  it("sends through instantly-service when the Instantly exchange is newer", async () => {
    serve(
      latestThread(200, { thread: THREAD }),
      instantlyStatus(statusRow({ lastDeliveredAt: "2026-10-14T15:00:00.000Z", queued: false })),
      instantlySend,
    );
    const res = await post(followUp());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, provider: "broadcast", messageId: "l1", campaignId: "c1" });
    expect(calledUrls()).not.toContain("http://google/orgs/google/thread-replies");
    const sendBody = JSON.parse(mockFetch.mock.calls.find((c) => c[0] === "http://instantly/orgs/send")![1].body);
    expect(sendBody.followUp).toBe(true);
  });

  it("counts a reply received in Instantly (per campaign) as the latest exchange", async () => {
    serve(
      latestThread(200, { thread: THREAD }),
      instantlyStatus(
        statusRow(
          { lastDeliveredAt: "2026-10-01T00:00:00.000Z", firstRepliedAt: "2026-10-02T00:00:00.000Z" },
          { c9: { lastDeliveredAt: "2026-10-01T00:00:00.000Z", firstRepliedAt: "2026-10-14T16:00:00.000Z" } },
        ),
      ),
      instantlySend,
    );
    const res = await post(followUp());
    expect(res.status).toBe(200);
    expect(calledUrls()).toContain("http://instantly/orgs/send");
  });

  it("stays on Instantly when no Gmail thread exists, without reading Instantly status", async () => {
    serve(latestThread(404, { error: "x", reason: "no_messages" }), instantlySend);
    const res = await post(followUp());
    expect(res.status).toBe(200);
    expect(calledUrls()).not.toContain("http://instantly/orgs/status");
  });

  it("lets instantly-service decide while a step of the brand's sequence is queued", async () => {
    serve(
      latestThread(200, { thread: THREAD }),
      instantlyStatus(statusRow({ lastDeliveredAt: null, queued: true })),
      instantlySend,
    );
    const res = await post(followUp());
    expect(res.status).toBe(200);
    expect(calledUrls()).toContain("http://instantly/orgs/send");
  });

  it("never reads Google for a send that is not a follow-up", async () => {
    serve(instantlySend);
    const res = await post(followUp({ followUp: undefined }));
    expect(res.status).toBe(200);
    expect(calledUrls()).toEqual(["http://instantly/orgs/send"]);
  });
});

describe("followUp: the person's latest thread is in a connected Google mailbox", () => {
  it("replies in that Gmail thread from the address they wrote to", async () => {
    serve(
      latestThread(200, { thread: THREAD }),
      instantlyStatus(statusRow({ lastDeliveredAt: "2026-09-01T00:00:00.000Z", queued: false })),
      gmailReply(200, {
        sent: true,
        gmailMessageId: "g-sent-1",
        threadId: "T1",
        mailbox: THREAD.mailbox,
        from: THREAD.fromAddress,
        to: PERSON,
        subject: "Re: Enquiry",
      }),
    );
    const res = await post(followUp());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      provider: "broadcast",
      transport: "gmail",
      messageId: "g-sent-1",
      threadId: "T1",
      from: THREAD.fromAddress,
    });
    expect(calledUrls()).not.toContain("http://instantly/orgs/send");
    const reply = mockFetch.mock.calls.find((c) => c[0] === "http://google/orgs/google/thread-replies")!;
    expect(JSON.parse(reply[1].body)).toEqual({ to: PERSON, threadId: "T1", bodyHtml: "<p>Hi again</p>", bodyText: "Hi again" });
    expect(reply[1].headers["x-org-id"]).toBe("org_1");
    expect(reply[1].headers["x-run-id"]).toBe("run_1");

    // Same key again: deduplicated, nothing re-sent.
    mockFetch.mockClear();
    const again = await post(followUp());
    expect(again.body.deduplicated).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("names the send's lead to google-service so the reply is declared in the ledger", async () => {
    serve(
      latestThread(200, { thread: THREAD }),
      instantlyStatus(statusRow(null)),
      gmailReply(200, { sent: true, gmailMessageId: "g3", threadId: "T1", mailbox: "m", from: THREAD.fromAddress, to: PERSON, subject: "Re: Enquiry" }),
    );
    const res = await post(followUp({ leadId: "lead-42" }));
    expect(res.status).toBe(200);
    const reply = mockFetch.mock.calls.find((c) => c[0] === "http://google/orgs/google/thread-replies")!;
    expect(JSON.parse(reply[1].body)).toEqual({
      to: PERSON,
      threadId: "T1",
      bodyHtml: "<p>Hi again</p>",
      bodyText: "Hi again",
      leadId: "lead-42",
    });
  });

  it("replies in Gmail when the person was never emailed through Instantly", async () => {
    serve(
      latestThread(200, { thread: THREAD }),
      instantlyStatus(statusRow(null)),
      gmailReply(200, { sent: true, gmailMessageId: "g2", threadId: "T1", mailbox: "m", from: THREAD.fromAddress, to: PERSON, subject: "Re: Enquiry" }),
    );
    const res = await post(followUp());
    expect(res.status).toBe(200);
    expect(res.body.transport).toBe("gmail");
  });

  it("round-trips the named refusal when the Google account lacks send permission (no fallback)", async () => {
    const refusal = {
      error: "The Google account owner@gmail.test was connected without permission to send email. The org owner must reconnect Google (dashboard, CRM, Google) and grant send access. Nothing was sent.",
      code: "google_send_permission_missing",
      mailbox: "owner@gmail.test",
    };
    serve(
      latestThread(200, { thread: { ...THREAD, sendPermission: false } }),
      instantlyStatus(statusRow({ lastDeliveredAt: null })),
      gmailReply(403, refusal),
    );
    const res = await post(followUp());
    expect(res.status).toBe(403);
    expect(res.body).toEqual(refusal);
    expect(calledUrls()).not.toContain("http://instantly/orgs/send");

    // A refusal is not remembered: a retry after the reconnect asks again.
    expect(await idempotencyStore.get("prospect-follow-up:event:e1")).toBeUndefined();
  });

  it("refuses a standing opt-out before writing in Gmail", async () => {
    serve(
      latestThread(200, { thread: THREAD }),
      instantlyStatus(statusRow({ lastDeliveredAt: null, sendRefusal: { code: "lead_opted_out", until: null } })),
    );
    const res = await post(followUp());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("lead_opted_out");
    expect(calledUrls()).not.toContain("http://google/orgs/google/thread-replies");
  });

  it("refuses a multi-step sequence: a Gmail reply is one email", async () => {
    serve(latestThread(200, { thread: THREAD }), instantlyStatus(statusRow(null)));
    const res = await post(
      followUp({
        sequence: [
          { step: 1, bodyHtml: "<p>a</p>", daysSinceLastStep: 0 },
          { step: 2, bodyHtml: "<p>b</p>", daysSinceLastStep: 3 },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("follow_up_gmail_single_email");
  });

  it("fails 502 when google-service cannot be read, never guessing a transport", async () => {
    serve(latestThread(500, { error: "boom" }), instantlySend);
    const res = await post(followUp());
    expect(res.status).toBe(502);
    expect(calledUrls()).not.toContain("http://instantly/orgs/send");
  });
});
