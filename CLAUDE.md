# Project: email-gateway

Email gateway - routes emails to Postmark (transactional) or Instantly (broadcast) based on type.

## Commands

- `npm test` — run tests (vitest)
- `npm run test:watch` — watch mode
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/routes/` — Express route handlers
- `src/middleware/` — Express middleware
- `src/lib/` — Shared utilities
- `src/config.ts` — Environment configuration
- `src/zod-setup.ts` — Side-effect module that extends Zod with `.openapi()`. Import it BEFORE any module that creates `z.object(...).openapi("Name")` schemas.
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually

## A visible copy is a different instrument from a blind one — `cc` is transactional-only and every address is validated

`cc` (transactional sends) is a comma-separated email list forwarded verbatim to
postmark-service's own `cc`, which sets Postmark's `Cc` header: the address lands
on a header every recipient of the message can see, and a reply-all reaches it.
That reader-facing difference is the whole point and it is why `bcc` was not
enough for the case that drove it — forwarding a prospect's reply thread to the
agency inbox while copying the client's own sales rep. A rep on `Bcc` receives a
mail addressed to somebody else (reads as mis-sent, gets ignored) and their
reply-all reaches nobody on our side, so the thread goes silently private.

Two things differ from `bcc` deliberately, and neither is an oversight:

**Every address is validated.** `bcc` is a bare `z.string()` with no email check
(unchanged — a caller relying on that keeps today's behaviour byte for byte).
`cc` refines each comma-separated entry through `z.string().email()`, so one
malformed entry refuses the WHOLE send with a 400 naming the field rather than
dropping the address quietly. An empty string is refused for the same reason:
a caller that names nobody omits the field, and then no `cc` key reaches
postmark-service at all.

**Broadcast refuses it rather than dropping it.** Instantly drives a per-lead
cold-email sequence and has no visible-copy recipient, so `cc` on a broadcast
body is a 400, not a silent strip. A discriminated union strips unknown keys by
default, which would have made a broadcast caller believe a visible copy was
going out; the field is therefore declared on `BroadcastSendSchema` with a
refinement that always fails. (It is typed `z.string()` rather than `z.never()`
only because `@asteasolutions/zod-to-openapi` throws `UnknownZodTypeError` on
`never` — the refusal is what matters, the type is the generator's constraint.)
This is the mirror of the broadcast-only strip below: there postmark has no such
dimension so stripping is correct; here the dimension is transactional-only so
naming it on the other channel is an error.

## A read that fans out to BOTH providers fails WHOLE — never a 200 with one provider missing

`POST /orgs/status` and the no-`type` paths of `/stats` (flat, grouped,
dynasty-grouped) call instantly-service AND postmark-service. Both are required:
if either rejects (5xx, `fetch failed`, timeout), the whole read is a 502. For
`/orgs/status` each provider must also answer for EVERY requested address (both
map `items` 1:1 and echo `item.email` verbatim; "no data" is a row with null
scopes, never an absent row), so a truncated answer is a 502 too.

Why: a consumer reads an absent `broadcast` block as "never contacted", so a
200 with one provider dropped is a partial answer that LOOKS complete. The old
code used `Promise.allSettled` + `console.warn` and served whatever arrived. On
2026-09-24 (06:45–07:10 UTC) instantly-service redeployed, ten of lead-service's
100-address batches came back 200 with no broadcast evidence, and a customer's
`contacted` count dropped by exactly 1,000 for one features-service refresh.
The prod log showed 232 such swallowed failures on `/orgs/status` in 72h (148×
`500 Failed to get delivery status`, 70× `fetch failed`, 14× timeout) and ~87
on grouped `/public/stats` — every one a silent partial.

Do NOT reintroduce `allSettled` / `.catch(e => e)` / an `{ error }` block on a
two-provider read. A caller that wants one channel passes `type=`. The only
provider-side tolerance kept is postmark answering a grouped read non-grouped
(it lacks some dimensions); instantly doing so is a 502.

The one network retry in each client (500ms) rides out a sub-second blip; a
longer restart surfaces as 502 and the caller keeps its last good figure.
`tests/status.test.ts` simulates a 10-batch bulk read across an instantly
restart and asserts every response is a 502 or complete.

## A campaign FAMILY is read with `campaignIds` — the gateway fans out per row and SUMS, it does not ask a provider for the set

A campaign as the customer knows it is many stored rows (campaign-service mints one per workflow switch; f7b1b610's family is 47). `/stats` (org, public, internal) takes `campaignIds=<comma list>` (≤200, exclusive with `campaignId`) and answers the sum of exactly what `campaignId=<row>` answers for each row — per group key when `groupBy` is set; `perCampaign=true` adds `byCampaign` with each row's own body. Fan-out is bounded at 16 rows in flight; the dynasty map is fetched once per request.

**Why per-row and summed, not a provider-side list filter:** recipient counts are `COUNT DISTINCT lead` WITHIN a query, so one provider query over the set would count a lead under two rows once, while the per-row reads every consumer has summed until now count it once per row. Same numbers as before is the contract; a set query would silently change every family figure. The fan-out is cheap: measured on prod 2026-09-24, 47 rows at 16 in flight answered in ~70-190ms warm (1.4s only on the first, cold pool at concurrency 6).

`sumDeep` adds field by field over the UNION of keys (so `notSending`/`cancelled` and any reply kind a provider adds survive) and adds `stepStats` per `step`. Do NOT swap it for the typed `addChannelStats`, which drops those fields. One row failing fails the whole read (502) — same guarantee as the two-provider rule below.

## Stats passthrough — broadcast-only filters/groupBys must be STRIPPED for postmark, never forwarded

The `/stats` route is a passthrough, but "passthrough" does NOT mean "forward every filter to both providers." A filter/groupBy dimension that one provider genuinely has NO concept of must be stripped before that provider, or the response is incoherent. Postmark (transactional) has no `timezone`/day-calendar grouping, no per-`audienceId` attribution — so those are **broadcast-only** and handled by `withoutBroadcastOnlyFilters` (strips `timezone` + `audienceId` before postmark) and `isBroadcastOnlyGroupBy` (`day`/`audienceId` → `handleBroadcastOnlyGrouped`, transactional returns empty groups). This is NOT "working around missing backend data" — postmark truly has no such dimension, so returning nothing for its side is correct; forwarding the filter instead makes postmark drop the unknown param and return UNFILTERED transactional stats presented alongside audience/day-scoped broadcast stats (a self-contradictory secondary surface = a bug). **When adding a new stats dimension, first ask "does postmark have this dimension?" If no, add it to the broadcast-only strip/route set — do NOT pure-forward it.** Cost 2026-07-06 (audienceId, #170→#171): shipped a pure-passthrough forwarding `audienceId` to both providers to main/prod; incoherent transactional output; #171 reverted onto the broadcast-only pattern (twin's #168, already on staging). When postmark-service#160 ships per-audience transactional stats, remove `audienceId` from the broadcast-only strip.

## An "unknown value" request field is `.nullish()`, never `.optional()` — absent and null must both be accepted

A request field whose absence MEANS "we don't know this value" (a lead-sourced attribute: timezone, company, location) gets `.nullish()`. `.optional()` accepts an absent key but rejects an explicit `null`, so a caller that faithfully forwards its own null column gets a 400 on a request that is perfectly well-formed — and the field's own description usually already promises a downstream fallback, making the refusal self-contradictory. Absent and null are the same statement; only one of them working is a bug, not strictness. Then normalize at the downstream boundary (`body.x ?? undefined`) so the provider receives an OMITTED key and applies its own default — do NOT forward `null` (the provider may reject it) and do NOT substitute a gateway-side default (choosing where a prospect is, is not the gateway's call). A real value still forwards unchanged; a malformed value (number, object) is still refused.

Cost 2026-08-18 (`timezone`, #182→#183/v0.25.2): `BroadcastSendSchema.timezone` was `.optional()` while lead-service sent explicit `null` for leads with no location — 10 of 13 job failures in a 30-minute prod window, all on the send step, i.e. after the lead had already been found, enriched and had an email generated. 55,468 fleet leads have no city and no country, so no timezone exists for them at any price and every one of them was permanently unsendable.

**Sibling fields not yet widened:** `recipientFirstName` / `recipientLastName` / `recipientCompany` are also lead-sourced and still `.optional()`. They have not been observed failing in prod (the 13 failures were all timezone), so they were left alone — but a caller that starts forwarding their nulls will hit the identical 400.

## Reading ONE logical send operation back — `runIds` cannot do it, and the failure is silent

`GET /stats?runIds=<run>` filters on the run the PROVIDER recorded against each
message, which is a CHILD run minted per send. It is not the run of the service
that asked for the sends. So a caller that performed thousands of sends as one
operation, and asks with its own run, matches nothing and gets a clean
well-formed response saying nothing was sent — byte-identical to a real all-zero
result. Measured in prod 2026-09-18: release run `79982eb6…` → `sent: 0`; its
child run `e095307e…` → `sent: 1`.

`GET /orgs/stats/by-operation` + `GET /public/stats/by-operation` take an
`operationRunId` instead — the `x-run-id` the caller performed the operation
under — and pass it to postmark-service's own per-operation read
(`GET /internal/operations/{operationRunId}/stats`, v0.33.0+), which persists
that value as each message's `parent_run_id`. One indexed aggregate whatever the
operation's size.

**The handle used to be the send's `tag`, and that premise was false.** A tag is
the `eventType` transactional-email-service reads out of its own templates table,
so it is per-TEMPLATE: 11 mailing-list releases over 8 days carried the same
`mailing-list-newsletter-test` tag, and one release's question returned all 11.
postmark-service withdrew `/stats/by-tag` before it reached prod (its #188) while
this gateway's v0.26.0 had promoted three minutes earlier, so every call here was
a 502 on a route that no longer existed. Shipped as a break, not an alias: a
caller still sending `operationId` gets a 400, never a number computed on the
wrong basis. A second handle for one question is two answers for one question.

**A bare 404 from the provider is NOT an empty operation.** The empty case is
only the one the provider NAMES (`404` + `code: OPERATION_NOT_FOUND`); everything
else — a withdrawn route, a typo'd path, a 500 — is a 502 here. Flattening an
unnamed 404 into `matched: false` would turn "this read no longer exists" into
"this operation has nothing", which is the same silent-zero failure in a new
costume.

**The half that matters is `matched`, not the figures.** An operation nothing
belongs to comes back `matched: false` with NO `transactional` block at all.
Never "improve" this into a zeroed `ChannelStats`: a consumer polling an
operation in flight must be able to tell "my question found nothing" from "the
outcomes are zero", and the only way to give it that is to refuse to emit
numbers with no messages behind them. Same reason the handler 502s when the
provider claims a match and serves no figures.

**Transactional only, on purpose.** Broadcast sequences are already named by
their campaign and audience, and the broadcast provider has no equivalent
per-send handle — so this read does not answer for broadcast rather than
answering with a silent zero. This is NOT the broadcast-only strip pattern
below; it is its mirror, and it is a separate read rather than a filter on
`/stats` precisely because `/stats`'s response shape cannot express
"I matched nothing".

Consumer: transactional-email-service's mailing-list release self-halt, which
stops a release when Postmark's bounce or unsubscribe outcomes go bad. It has
been inert for its whole life — first reading `/stats?runIds=` (a silent zero),
then this read while it was 502ing on the withdrawn provider route. It must send
`operationRunId` to get a verdict.

## The prod container is `distribute-email-gateway-service-1`, not `distribute-email-gateway-1`

The service key in `docker-compose.yml` carries the repo's full name, so the
container Docker names is `distribute-email-gateway-service-1`. A probe or a
deploy poll written against the shorter form fails with `No such container`,
which — when the poll swallows stderr — is an EMPTY reading indistinguishable
from "the deploy has not landed", and it runs to exhaustion against a service
that has been serving the change for minutes. Read the name rather than typing
it: `docker ps --format '{{.Names}} {{.Status}}' | grep email`.

## Shared contract

Cross-provider canonical shapes (`StatusScope`, `RecipientStats`, `EmailStats`, `StepStats`, `RepliesDetail`, `ChannelStats`, `ProviderStatus`, `GlobalStatus`, `ReplyClassification`) live in [`@shamanic-technologies/email-domain-contract`](https://github.com/shamanic-technologies/email-domain-contract). Do NOT redeclare these schemas locally — re-export from the package via `src/schemas.ts`. As of 2026-06-05 (DIS-229), instantly-service (v0.40.0) and postmark-service both migrated onto this package too — all three services now source the shared shapes from `^1.1.0`, so a contract change propagates to every provider on a version bump.

Two provider-specific fields are **optional in v1** of the contract: `cancelled` and `notSending`. They live on instantly responses today and are expected on postmark after a follow-up that pads them with neutral defaults (`false` / `0`). Contract v2 will tighten them to required after that padding ships.

`StatusScope` carries 8 **per-event first-occurrence timestamps** (contract `^1.1.0`, DIS-229): `firstContactedAt`, `firstSentAt`, `firstDeliveredAt`, `firstOpenedAt`, `firstClickedAt`, `firstRepliedAt`, `firstBouncedAt`, `firstUnsubscribedAt` — each optional + nullable ISO-8601, `MIN` (first occurrence) of that event type in scope; brand-scope = MIN across the brand's campaigns. They mirror `lastDeliveredAt` (MAX): **a MIN-twin of an existing `lastX` field takes a `firstX` prefix** for symmetry (convention: `firstX`=MIN, `lastX`=MAX). `firstRepliedAt` is always null for postmark (no reply tracking). email-gateway forwards them through the `/orgs/status` passthrough — no route logic; the providers populate them from their event stores.

`StatusScope` also carries **`sentCount`** (contract `^1.2.0`): the per-scope COUNT of emails actually sent to the recipient (a send-event count, NOT a boolean — `sent` only says "≥1 sent"). A consumer derives the outreach sequence position from it: `1` = initial email, `2` = first follow-up, `3` = second follow-up, … (lead-service forwards it onto each `/orgs/leads` row; the dashboard renders the sequence label). Optional `int` ≥ 0, **absent-safe** — a provider that predates the field simply omits it and the consumer reads `?? 0` (do NOT fabricate/default it in the passthrough). Scope aggregation: per-campaign (`byCampaign[id]`, `campaign`) = count of that (recipient, campaign)'s sends; **brand-scope = SUM across the brand's campaigns** (total emails sent to the recipient across the brand — contrast the booleans' BOOL_OR and the timestamps' MIN/MAX). Populated per-provider from each event store (broadcast via instantly-service, transactional via postmark-service); email-gateway forwards it through the `/orgs/status` passthrough untouched, keeping the broadcast/transactional blocks separate — a recipient reached by one provider reads that provider's `sentCount`.

## A provider-additive field on a contract shape is an `.extend()` here, not a contract fork

`StatusScope` lives in the shared contract, but a provider may serve fields the contract has not absorbed yet (`replyKind` / `disqualified`, instantly-service v0.75.0). Those are declared in `src/schemas.ts` as `RawStatusScope.extend({...})` (`ScopedStatusSchema`, wrapped by `GatewayProviderStatusSchema`) — the contract stays the single source of truth for the shared fields, and widening it is a separate cross-repo change. instantly-service made the same call on its own side.

Two constraints on such an extension. It is **optional** on both fields: the transactional provider (postmark) has no reply tracking and simply omits them, and a provider that predates the field must not start failing. And the value is typed `z.string()`, never a copy of the owner's enum — the same call the manual-qualification `status` field made in v0.25.3, after a stale local copy refused three kinds instantly-service accepted; `replyKind` is instantly-service's list and a stale copy here would refuse a kind the owner accepts. `disqualified` is derived by the provider from `replyKind`; this hop forwards the pair and decides nothing about who is disqualified. `replyClassification` keeps its exact meaning — a consumer reading only the coarse value sees no change.

The extended schemas carry no `.openapi("Name")` for the reason in the next section; the generator inlines them.

## Zod 4 caveat — contract schemas + `.openapi()`

`@asteasolutions/zod-to-openapi` attaches `.openapi()` to Zod schema instances at the time `extendZodWithOpenApi(z)` runs in the consumer. The contract package's schemas were instantiated before that point in the consumer's module graph, so they do NOT gain `.openapi()` retroactively. Re-export them without `.openapi(name)` and let the generator inline them (no `$ref` name). Local schemas defined in `src/schemas.ts` (after `import "./zod-setup"`) keep their `.openapi(name)` tagging.

## A vocabulary another service OWNS must not be re-declared here — validate loosely, let the owner refuse

`/orgs/manual-qualifications` forwards a human's reply statement to instantly-service, which owns that vocabulary. This service used to carry its own `z.enum([...])` copy of the list. instantly-service widened it (v0.74.0: `lead_referral`, `lead_info_requested`, `lead_meeting_requested`) and the copy went stale, so three kinds the owner accepts were refused here with a local 400 — the customer clicked and nothing happened, and no deploy of instantly-service could fix it. A second copy of an owner's list is a second place for the two to drift, and it drifts in the direction that breaks the customer.

So on a passthrough route: validate only what THIS service can be authoritative about (required fields present, `campaign_id` non-empty, `email` is an email address) and type an owner-owned value as `z.string().min(1)` with a description pointing at the owner's openapi as the authority. A value the owner rejects still comes back as a refusal — round-tripped from the owner, which is where the refusal belongs. Do NOT add a mapping/translation layer to reconcile the two lists; that is the same drift wearing a different hat. api-service made the identical call on the same field. Note this is the OPPOSITE of the broadcast-only stats rule above: there, postmark genuinely has no such dimension, so stripping is correct — here, the owner has the dimension and simply knows more values than we do. (Shipped 2026-08-27, v0.25.3.)
