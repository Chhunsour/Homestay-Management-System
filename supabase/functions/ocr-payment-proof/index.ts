// Phase 6A — payment screenshot OCR.
//
// Reads a payment proof (an existing stored screenshot, or bytes the caller
// is about to upload) and returns extracted fields for a human to review.
// It never writes to `payments`, `payment_proofs`, or any other table — see
// docs/PHASE_6A_OCR.md. The Anthropic API key lives only in this process's
// environment; it is never sent to, or reachable from, the mobile or web app.
//
// ponytail: one function, three small files, no shared _shared/ folder — this
// is the only edge function in the project. Split cors/auth helpers out once
// a second function needs them, not before.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';
import {
  buildProviderFailureResult,
  parseReceiptText,
  resolveProofAccess,
  summarizeOcrDuplicates,
  validateOcrFileSize,
  validateOcrMimeType,
} from '../../../packages/shared/src/ocr.ts';
import type { OcrErrorKey, OcrProofRow } from '../../../packages/shared/src/ocr.ts';
import { createClaudeOcrProvider } from './providerClaude.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ERROR_STATUS: Record<OcrErrorKey, number> = {
  auth_required: 401,
  forbidden: 403,
  invalid_request: 400,
  invalid_mime_type: 400,
  invalid_file_size: 400,
  proof_not_found: 404,
  rate_limited: 429,
  provider_error: 502,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fail(errorKey: OcrErrorKey): Response {
  return json({ error: errorKey }, ERROR_STATUS[errorKey]);
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail('invalid_request');

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail('auth_required');

  if (!ANTHROPIC_API_KEY) {
    console.error('ocr-payment-proof: ANTHROPIC_API_KEY is not configured');
    return fail('provider_error');
  }

  // Scoped to the caller's own session, exactly like the web and mobile
  // apps — every select and RPC below runs through the caller's RLS, so a
  // business_id in the request body is never trusted, only checked.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return fail('auth_required');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request');
  }
  if (typeof body !== 'object' || body === null) return fail('invalid_request');
  const input = body as Record<string, unknown>;

  let businessId: string;
  let mimeType: string;
  let base64: string;

  if (typeof input.proofId === 'string') {
    const { data: proofRow } = await supabase
      .from('payment_proofs')
      .select('id, business_id, payment_id, storage_path, mime_type')
      .eq('id', input.proofId)
      .maybeSingle<OcrProofRow>();

    const access = resolveProofAccess(proofRow ?? null);
    if (!access.ok) return fail(access.errorKey);

    businessId = access.row.business_id;
    mimeType = access.row.mime_type;

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('payment-proofs')
      .download(access.row.storage_path);
    if (downloadError || !fileBlob) return fail('proof_not_found');

    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    const sizeError = validateOcrFileSize(bytes.byteLength);
    if (sizeError) return fail(sizeError);
    base64 = encodeBase64(bytes);
  } else if (
    typeof input.businessId === 'string' &&
    typeof input.imageBase64 === 'string' &&
    typeof input.mimeType === 'string'
  ) {
    // A screenshot the caller is about to attach, not yet stored: no
    // payment row exists for it yet, so there is nothing in
    // `payment_proofs` to select and RLS-scope against. Permission is
    // checked directly against the business instead.
    businessId = input.businessId;
    mimeType = input.mimeType;
    base64 = input.imageBase64.includes(',')
      ? input.imageBase64.split(',').pop()!
      : input.imageBase64;

    const { data: allowed } = await supabase.rpc('has_business_permission', {
      p_business_id: businessId,
      p_permission: 'payments.manage',
    });
    if (!allowed) return fail('forbidden');

    const mimeError = validateOcrMimeType(mimeType);
    if (mimeError) return fail(mimeError);

    // Exact byte count needs decoding; base64 overhead (~4/3) is close
    // enough to reject an oversized upload before spending time on it.
    const approxBytes = Math.floor((base64.length * 3) / 4);
    const sizeError = validateOcrFileSize(approxBytes);
    if (sizeError) return fail(sizeError);
  } else {
    return fail('invalid_request');
  }

  const { data: throttleAllowed, error: throttleError } = await supabase.rpc(
    'check_ocr_rate_limit',
    {
      p_business_id: businessId,
    },
  );
  if (throttleError) return fail('forbidden');
  if (!throttleAllowed) return fail('rate_limited');

  const provider = createClaudeOcrProvider(ANTHROPIC_API_KEY);

  let extraction;
  try {
    const rawText = await provider.extractText({ base64, mimeType });
    extraction = parseReceiptText(rawText);
  } catch (err) {
    // Never log the screenshot itself or the transcribed text — only that
    // reading it failed. The caller gets an honest "we couldn't read this",
    // not a fabricated set of fields.
    console.error(
      'ocr-payment-proof: provider failure:',
      err instanceof Error ? err.message : 'unknown',
    );
    return json({
      extraction: buildProviderFailureResult(),
      duplicates: [],
      possibleDuplicate: false,
      provider: provider.name,
    });
  }

  // Duplicate assistance only, never a block: this is a read-only check
  // against the same payment_duplicates() the manual "record payment" form
  // already warns with.
  let duplicates: unknown[] = [];
  if (
    extraction.reference.value ||
    (extraction.amount.value !== null && extraction.paymentDate.value)
  ) {
    const paidAt = extraction.paymentDate.value
      ? `${extraction.paymentDate.value}T${extraction.paymentTime.value ?? '00:00'}:00`
      : null;
    const { data } = await supabase.rpc('payment_duplicates', {
      p_business_id: businessId,
      p_reference: extraction.reference.value,
      p_amount: extraction.amount.value,
      p_paid_at: paidAt,
    });
    duplicates = data ?? [];
  }

  return json({
    extraction,
    duplicates,
    possibleDuplicate: summarizeOcrDuplicates(
      duplicates as Parameters<typeof summarizeOcrDuplicates>[0],
    ).possibleDuplicate,
    provider: provider.name,
  });
});
