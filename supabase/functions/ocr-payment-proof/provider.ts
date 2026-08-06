/**
 * An OCR provider does exactly one thing: turn an image into the text it
 * contains. Nothing about parsing, currency, or Cambodian bank formats
 * belongs here — that lives in `parseReceiptText()`
 * (`packages/shared/src/ocr.ts`), which never sees an image and doesn't
 * care which provider produced the text it's handed. Swapping providers
 * means writing a new file that implements this interface; nothing else
 * in the function changes.
 */
export interface OcrImageInput {
  /** Raw bytes, base64-encoded, no data: URL prefix. */
  base64: string;
  /** One of PROOF_MIME_TYPES from packages/shared/src/constants.ts. */
  mimeType: string;
}

export interface OcrProvider {
  readonly name: string;
  extractText(input: OcrImageInput): Promise<string>;
}
