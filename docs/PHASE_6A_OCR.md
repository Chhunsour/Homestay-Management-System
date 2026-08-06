# Phase 6A — payment screenshot OCR

Phase 5 stores a payment screenshot and shows it back; nothing reads the
amount, the reference or the date out of it. Phase 6A adds that reading step
as its own service — a Supabase Edge Function that takes an image, returns
what it could make out, and stops. It never records a payment, never resolves
a duplicate, and never touches a row Phase 5 already owns. Everything it
returns is for a human to check before typing anything into the record-payment
form; the workflow that consumes it is Phase 6B.

---

## 1. Why an edge function, not a server action

`apps/web`'s Server Actions are Next.js-only — mobile has no equivalent
surface and talks to Supabase directly, exactly like the web app's own reads
do. OCR needs to be reachable from both without either app ever holding the
provider's API key, so it lives where both clients already have a client:
Supabase. `supabase/functions/ocr-payment-proof` is the first edge function in
this project; the key sits in the function's own process environment
(`ANTHROPIC_API_KEY`) and is never sent to, or reachable from, either app.

## 2. Provider interface and the parser split

```
image bytes ──▶ OcrProvider.extractText() ──▶ raw text ──▶ parseReceiptText() ──▶ OcrExtraction
              (supabase/functions/ocr-payment-proof/provider*.ts)   (packages/shared/src/ocr.ts)
```

The provider does exactly one thing — turn an image into the text it
contains — declared by the `OcrProvider` interface
(`supabase/functions/ocr-payment-proof/provider.ts`):

```ts
export interface OcrProvider {
  readonly name: string;
  extractText(input: { base64: string; mimeType: string }): Promise<string>;
}
```

`providerClaude.ts` is the one implementation shipped: Claude Opus 5, chosen
for accurate mixed Khmer/Latin-script image understanding over ABA, KHQR and
bank-transfer layouts. It sends the image (or, for a PDF bank receipt, a
`document` content block) with a plain "transcribe everything, don't
interpret it" prompt at `effort: "low"` — a single-page transcription is a
bounded task, and low effort keeps latency and cost down without losing
accuracy. Swapping providers means writing a new file that implements
`OcrProvider`; nothing in `index.ts` or the parser changes.

**All the domain knowledge — currency formats, Cambodian date conventions,
what a transaction id looks like — lives in `parseReceiptText()`
(`packages/shared/src/ocr.ts`), not in the provider or the prompt.** That
split is deliberate:

- It is pure and offline, so it is tested with plain fixture strings
  (`packages/shared/src/ocr.test.ts`) — no screenshot, no network call, no API
  key needed to run the suite.
- It never guesses. A field the regexes can't support with reasonable
  confidence comes back `null` with a warning, not a best-effort value — see
  §5.
- It is shared with both apps through `@homestay/shared`, the same way
  `summarizeBookingPayments()` is: one definition, used everywhere that reads
  its shape.

## 3. Extraction schema

`OcrField<T>` pairs a value with how sure the parser is:

```ts
interface OcrField<T> {
  value: T | null;
  confidence: number; // 0 (no evidence) – 1 (certain); 0 whenever value is null
}
```

`OcrExtraction` (`packages/shared/src/ocr.ts`):

| Field              | Type                    | Notes                                                        |
| ------------------ | ----------------------- | -------------------------------------------------------------|
| `payerName`         | `OcrField<string>`      | Usually the guest — "From" / "Sender" / "Payer" on the receipt |
| `receiverName`      | `OcrField<string>`      | The business/host account, when the screenshot shows it       |
| `amount`            | `OcrField<number>`      | Positive, rounded to 2 decimals                                |
| `currency`          | `OcrField<Currency>`    | `USD` or `KHR`, from the symbol or the currency word           |
| `reference`         | `OcrField<string>`      | Bank/ABA/KHQR transaction id                                    |
| `paymentDate`       | `OcrField<string>`      | `YYYY-MM-DD`                                                    |
| `paymentTime`       | `OcrField<string>`      | `HH:MM`, 24-hour                                                |
| `method`            | `OcrField<PaymentMethod>` | `aba` \| `khqr` \| `bank_transfer` \| `cash`, when recognized |
| `methodLabel`       | `OcrField<string>`      | The raw bank/app name as printed (e.g. "ACLEDA"), independent of `method` |
| `rawText`           | `string`                | Everything the provider transcribed, verbatim                  |
| `overallConfidence` | `number`                | Mean confidence of the fields found, capped at 0.25 whenever the amount is missing |
| `warnings`          | `OcrWarning[]`          | See §5                                                          |
| `missingFields`     | `string[]`              | Field names the parser could not fill in                       |

`OcrWarning` is one of `amount_missing`, `currency_ambiguous`,
`reference_missing`, `date_missing`, `time_missing`, `payer_name_missing`,
`low_overall_confidence`, `provider_error`.

## 4. API usage

`POST {SUPABASE_URL}/functions/v1/ocr-payment-proof`, `Authorization: Bearer
<the caller's own access token>` — the same session both apps already hold,
never a service key.

**Request** — one of two shapes:

```jsonc
// Re-read an already-uploaded proof.
{ "proofId": "uuid" }

// A screenshot the caller is about to attach; no payment row exists for it
// yet, so there is nothing in payment_proofs to reference.
{ "businessId": "uuid", "imageBase64": "…", "mimeType": "image/jpeg", "fileName": "optional.jpg" }
```

**Response** (`200`):

```jsonc
{
  "extraction": { /* OcrExtraction, §3 */ },
  "duplicates": [ /* PaymentDuplicate[], from the existing payment_duplicates() RPC */ ],
  "possibleDuplicate": false,
  "provider": "claude-opus-5"
}
```

A provider failure (unreadable image, timeout, safety refusal) is **not** an
HTTP error — it is a normal `200` carrying
`buildProviderFailureResult()`: every field `null`, `warnings: ["provider_error"]`.
The caller always gets a shape it can render; there is nothing to special-case
in the UI for "OCR failed" versus "OCR found nothing."

**Error responses** (`{ "error": "<key>" }`):

| Key                 | HTTP | Meaning                                                        |
| -------------------- | ---- | --------------------------------------------------------------|
| `auth_required`      | 401  | No session, or the bearer token doesn't resolve to a user       |
| `forbidden`           | 403  | Caller lacks `payments.manage` on the business                  |
| `invalid_request`     | 400  | Wrong method, unparsable body, or neither request shape matched |
| `invalid_mime_type`   | 400  | Outside `PROOF_MIME_TYPES` (jpeg, png, webp, pdf)                |
| `invalid_file_size`   | 400  | Zero bytes or over `PROOF_MAX_BYTES` (10 MB)                    |
| `proof_not_found`     | 404  | `proofId` missing, or belongs to another business (see §5)      |
| `rate_limited`        | 429  | Over the per-business or per-caller cap (§5)                    |
| `provider_error`      | 502  | `ANTHROPIC_API_KEY` isn't configured on the function             |

## 5. Security

- **Membership, not the client, decides.** The `proofId` path selects from
  `payment_proofs` through the caller's own RLS-scoped Supabase client —
  the same `has_business_permission(business_id, 'payments.manage')` policy
  Phase 5 already enforces. A proof belonging to another business simply
  doesn't come back, the same way `payment_not_found` already covers both
  "missing" and "not visible" everywhere else in this schema
  (`resolveProofAccess()` in `packages/shared/src/ocr.ts`). The inline-upload
  path has no row to scope against yet, so it checks
  `has_business_permission` directly via RPC before doing anything else.
- **Owner, manager and staff** may request OCR — it's gated on
  `payments.manage`, the same permission that lets them record a payment in
  the first place. No new permission was added.
- **Storage stays private.** The `proofId` path downloads through the
  caller's own session, so the same `payment-proofs` bucket policies Phase 5
  wrote apply unchanged; the function never uses a service-role key and never
  produces a public URL.
- **MIME type and size are validated** on both paths — the allow-list is the
  same `PROOF_MIME_TYPES` / `PROOF_MAX_BYTES` Phase 5 already enforces at the
  bucket, so a proof that could never have been stored can't be OCR'd either.
- **Throttling is database-enforced**, not in-process — an edge function has
  no memory between invocations and may run as several concurrent instances,
  so an in-memory counter would not work. `check_ocr_rate_limit(business_id)`
  (`supabase/migrations/20260806000100_ocr_rate_limit.sql`) records the
  attempt and checks the last minute in one locked transaction: 20 requests
  per business, 8 per caller, per minute.
- **Nothing sensitive is logged.** A provider failure logs that reading
  failed, never the image bytes or the transcribed text — see `index.ts`.
- **Nothing is stored.** The extraction lives for one request. The only
  thing that outlives it is the timestamp row `check_ocr_rate_limit` writes
  for throttling — no business_id-to-content mapping beyond that.
- **Duplicate assistance is read-only.** When the extraction has a reference
  (or an amount and a date), the function calls the existing
  `payment_duplicates()` RPC — the same one the manual "record payment" form
  already warns with — and returns what it finds. It never creates, voids or
  edits a payment; `possibleDuplicate` is a flag for a human, exactly like
  every other duplicate signal in this schema.

## 6. Environment variables

| Variable             | Where                          | Notes                                                  |
| --------------------- | ------------------------------- | ------------------------------------------------------|
| `ANTHROPIC_API_KEY`   | The edge function's own env only | Local: `supabase/functions/.env` (git-ignored by `.env`). Hosted: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref <ref>`. Never in `apps/web/.env.local` or `apps/mobile/.env`. |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are provided automatically to every
edge function by the platform — nothing to configure.

## 7. Running it locally

```sh
supabase start
supabase db reset                 # applies 20260806000100_ocr_rate_limit.sql
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > supabase/functions/.env
supabase functions serve ocr-payment-proof --env-file supabase/functions/.env
```

Then call it with a real session's access token (sign in through the web or
mobile app, or `POST /auth/v1/token?grant_type=password` with the seeded demo
account from `npm run db:smoke` / `scripts/seed-demo.mjs`) and either request
shape from §4. A placeholder `ANTHROPIC_API_KEY` is enough to exercise every
code path except a real transcription — the provider call fails, and the
function returns `buildProviderFailureResult()` with a `200`, which is what
the "unreadable image / provider failure" test in `ocr.test.ts` pins in
isolation.

## 8. Testing with sanitized fixtures

**Never commit a real customer payment screenshot.** Every fixture in
`packages/shared/src/ocr.test.ts` is a synthetic string written for the test
— an ABA-style transcript, a KHQR-style transcript, bare amount lines — never
a transcription of an actual screenshot. Because the parser is pure text in,
structured data out, that's sufficient: it exercises the exact same code path
a real transcription would, without a real image ever existing on disk or in
git history.

The nine required scenarios and where they live:

| Scenario                        | Test                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------|
| ABA-style receipt text           | `parses an ABA-style receipt end to end`                                       |
| KHQR-style receipt text          | `parses a KHQR-style receipt, including a missing payer name`                  |
| USD and KHR amounts              | `recognizes USD and KHR amounts in every documented format`                    |
| Missing transaction id           | `handles a receipt with no transaction id instead of guessing one`             |
| Unreadable image / provider failure | `provider failure returns an all-null result, never a guess`               |
| Invalid file type                | `rejects a file type outside the payment-proof allow-list`                     |
| Cross-business access denial     | `a proof RLS hides (another business, or missing) resolves the same way`       |
| Duplicate-reference warning      | `flags a possible duplicate without deciding anything`                         |
| Low-confidence extraction        | `a low-confidence extraction is flagged rather than trusted`                   |

Run with `npm run test -w @homestay/shared` (or `npm test` from the repo
root, which runs it alongside every other workspace). The edge function
itself (`index.ts`) is thin orchestration over these pure functions plus
Supabase reads that are already RLS-tested in `supabase/tests/rls_payments.sql`
— it was additionally exercised end to end against a local Supabase stack
while building this phase (auth, both request shapes, mime/size rejection,
cross-business denial, and the rate limit tripping at the 8th per-minute
request), the same way `db:smoke` exercises the rest of the schema.

## 9. Known limitations

- **No review UI.** This phase returns extracted fields; nothing renders
  them, and nothing writes them anywhere. That is Phase 6B.
- **English and Khmer-script names only.** `extractName()` matches Latin and
  Khmer Unicode characters; a name transcribed in another script comes back
  `null` rather than mangled.
- **Line-anchored field matching.** The parser expects each field on its own
  line (`"From: SOK DARA"`), which matches how ABA and KHQR actually lay out
  a confirmation screen. A provider whose transcription runs fields together
  on one line will under-extract; this is a parser limitation to revisit if a
  second provider's transcription style differs enough to matter.
- **One currency pair.** Only `USD` and `KHR` are recognized, matching
  `CURRENCIES` in `packages/shared/src/constants.ts` — the same set Phase 5
  supports everywhere else.
- **`ocr_requests` has no purge job.** Rows accumulate for rate-limiting
  purposes only and are never deleted. Same shape of limitation as Phase 4's
  undeleted pending-hold rows: fine at this scale, and a `pg_cron` job
  deleting rows older than a day is the straightforward fix if the table's
  size ever becomes worth solving.
- **No client-side image compression.** A 10 MB proof is sent to the
  provider exactly as uploaded; Claude Opus 5 handles that natively, but a
  future phase could resize before sending if provider cost becomes a
  concern.
- **One provider, not configurable per business.** `providerClaude.ts` is
  wired directly into `index.ts`. Multi-provider selection (cost, regional
  data residency, an on-prem OCR engine) is a real `OcrProvider` away, not
  built.
