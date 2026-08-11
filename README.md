# DocFlow

Invoices read, checked and approved before anything is booked.

A PDF arrives. Its fields are extracted along with the exact words on the page
each value came from, checked against rules that are ordinary code, and held
for a person whenever anything is uncertain. What reaches the accounting system
is the version somebody approved — and delivering it twice creates one bill.

**[Open the live demo →](https://docflow-web-woad.vercel.app)**

- Console — https://docflow-web-woad.vercel.app
- API docs (Swagger) — https://docflow-api-flame.vercel.app/api/docs
- Health check — https://docflow-api-flame.vercel.app/api/health

No sign-up: the workspace is private, disposable and deleted within a day or two of that.

## What you can do in the demo

Press **Open a demo workspace** and you get a private inbox and six synthetic
invoices, each written to fail in a particular way.

| Do this | Watch |
| --- | --- |
| Open **Northwind Paper — clean invoice** | The page is read, the JSON streams in field by field, every rule passes |
| Hover any field | The words it was read from are outlined on the PDF itself |
| Open **Atlas Fabrication** | `TOTAL_MISMATCH` blocks approval; the message carries both numbers |
| Try to approve it | Refused by the API, not just by a disabled button |
| Override the finding | A reason is required, and it is stored next to the approval |
| Add **the same invoice again** | `POSSIBLE_DUPLICATE_RECORD` — different file, same vendor and number |
| Open **Meridian Design** | Priced in JPY: the destination has no account in it, so it cannot be delivered |
| Open **Quill Supplies** | The PDF instructs the model to approve itself. It is extracted as text and ignored as an instruction |
| Approve, then edit a number | The approval is withdrawn; delivery refuses until it is approved again |
| Deliver with **Succeed remotely, lose the response** | Attempt 1 loses the response, attempt 2 finds the bill already there. One bill exists |

## Measured, not estimated

From a full run over the six sample invoices, against DeepSeek from a Vercel
US-East function:

| | |
| --- | --- |
| Cost per invoice | **$0.00074** (~$0.74 per 1,000) |
| Time to read one | 3.4–3.9 s including PDF parsing |
| Fields with located evidence | **9 of 9** on a clean invoice |
| Bills created by a delivery that succeeded and lost its response | **1** |

Cost is recorded per call in integer millionths of a dollar and summed. Failed
and repaired attempts are included, because a cost panel without them is
describing a bill nobody receives.

## Architecture

```
Browser ──▶ Next.js (Vercel) ──▶ NestJS (Vercel Functions) ──┬─▶ Postgres (Neon)
   pdf.js render      SSE          extraction · rules · sync  ├─▶ Vercel Blob (private)
   evidence overlay                                           └─▶ any OpenAI-compatible model API
```

```
web/      Next.js 15 — document queue, PDF viewer with evidence, review and approval
server/   NestJS 11 — intake, extraction, validation, approval, idempotent delivery
```

[ARCHITECTURE.md](ARCHITECTURE.md) covers the whole system, including the parts
this release deliberately leaves out.

## Design decisions worth calling out

**What the model proposed and what a person approved are different tables.**
`field_proposals` holds the extraction — value, confidence, evidence — and is
never edited. `record_versions` holds what the business will act on, and every
correction writes a new immutable version. An approval names the exact version
it approved, which is what makes "approved" survive somebody changing a number
afterwards.

**Evidence coordinates come from the document, not from the model.** A model
will happily invent plausible bounding boxes. So it returns only the text it
claims to have read, and the server finds that text in the page's real word
geometry. A fabricated quote is located nowhere, produces no highlight, and the
field is marked `no source` — which is exactly the signal a reviewer needs, and
the one a confidence score hides. One of the sample invoices reliably produces
a field with 100% confidence and no locatable source.

**Reading order is rebuilt from position.** A PDF's text items arrive in
drawing order, not reading order: a table is often written as every description
followed by every amount. Handing that sequence to a model produces confident
nonsense about which number belongs to which row, so words are grouped into
lines by vertical position first.

**Validation is ordinary code, not a second opinion from the model.** A model
asked to check its own answer is confident in the same places it was wrong, and
its verdict cannot be unit tested, counted over time, or explained to a client
asking why an invoice was held. Arithmetic is arithmetic. Every rule has a
stable code, a severity and fixtures.

**Rules are tuned so they can be trusted.** A line is only wrong when it is off
by more than a cent, because a unit price of a third of a cent has to round
somewhere. An invoice date two days ahead is clock skew, not a typo. An absent
optional field is absent rather than "low confidence". A rule that fires on
noise teaches reviewers to click past findings, which is worse than not having
it.

**The idempotency key contains no timestamp and no randomness.** It is derived
from organization, record, approved version and destination, so every attempt
for one approval carries the same key and the destination answers the second
one with the bill the first created. The hard failure is not an error — it is a
request that succeeds remotely and fails on the way back, and a key containing
`Date.now()` would look correct in every test that does not model it.

**Approving and enqueuing the delivery are one transaction.** If the process
dies immediately afterwards, the system still knows both that this was approved
and that it owes a delivery.

**Money never touches a float.** Amounts are integer minor units end to end;
`19.99 + 0.01` in binary floating point is not `20.00`, and an arithmetic rule
that fires on that artefact is worse than no rule.

**Documents are private and read through short-lived signed URLs.** The blob
store is private, keys are prefixed per tenant, and a read URL is minted per
request after the caller's tenancy has been checked.

**The demo's fixtures are generated, not collected.** A portfolio demo must not
contain anybody's real supplier or price, and the interesting failures do not
arrive on demand. Generating them is what lets the gallery promise a specific
outcome and then produce it.

## What it deliberately does not do

**Nothing is paid.** The destination is a mock accounting system that persists
realistic remote state and can be made to rate-limit, time out, fail, and
succeed-while-appearing-to-fail. A real QuickBooks Sandbox adapter is designed
in ARCHITECTURE.md and is not in this release.

**Scans are not read.** This reads digital PDFs, which is what invoices from
any modern accounting package are. A scan has no text layer and needs a real
OCR provider; the demo says so rather than pretending, and the adapter
interface is where one would be added.

**The extraction is not evaluated.** There is no labelled set and no accuracy
number. Six synthetic invoices are a demonstration, not a measurement, and
calling them one would be dishonest.

**One template.** The invoice template is the whole of this release. The
architecture is written so a second document type is data plus fixtures rather
than a fork, but the tender template is not built yet.

**One user per workspace.** No invitations, roles or permissions.

## Running it locally

```bash
cd server
cp .env.example .env       # DATABASE_URL, DIRECT_URL, JWT_SECRET, BLOB_READ_WRITE_TOKEN, LLM_API_KEY
pnpm install
pnpm prisma migrate deploy
pnpm fixtures              # generates the sample invoices
pnpm dev                   # http://localhost:8080/api  (docs at /api/docs)

cd ../web
cp .env.example .env.local
pnpm install
pnpm dev                   # http://localhost:3000
```

Any OpenAI-compatible endpoint works — point `LLM_BASE_URL`, `LLM_MODEL` and
the two price variables at whichever provider you have a key for.

## Tests

```bash
cd server && pnpm test     # 72 unit tests
cd web    && pnpm test     # 17 unit tests
```

They concentrate on the parts that fail quietly: reading order rebuilt from
geometry, a quote that is nowhere in the document, a schema failure re-asked
with the complaint attached, per-line rounding tolerance, duplicate detection
across different files, an idempotency key that must not vary, a delivery that
succeeds remotely and loses its response, and an SSE event split across chunk
boundaries — including one split through a multi-byte character.

## API

`GET /api/docs` serves Swagger UI.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/demo/session` | Mint a private workspace and sign into it |
| `GET` | `/api/samples` | The synthetic invoices the demo ships with |
| `POST` | `/api/documents/from-sample` · `/api/documents/uploads` | Put a document into the workspace |
| `GET` | `/api/documents` · `/api/documents/:id` | The queue and one document |
| `GET` | `/api/documents/:id/file` | A short-lived signed URL for the original |
| `POST` | `/api/documents/:id/process` | Read, extract and validate — **server-sent events** |
| `GET` | `/api/records/:id` | Fields, evidence, findings, approvals and deliveries |
| `PATCH` | `/api/records/:id/fields` | Correct fields, producing a new version |
| `POST` | `/api/records/:id/findings/:id/resolve` | Acknowledge a warning or override a blocker |
| `POST` | `/api/records/:id/approve` · `/reject` | Decide, against an exact version |
| `POST` | `/api/records/:id/sync` | Deliver the approved version, idempotently |
| `GET` | `/api/records/:id/timeline` | Every recorded action, from the audit log |
| `GET` | `/api/usage` · `/api/destination/bills` | Spend, and what the destination believes it holds |

Everything outside `/demo`, `/auth` and `/health` requires
`Authorization: Bearer <token>`.
