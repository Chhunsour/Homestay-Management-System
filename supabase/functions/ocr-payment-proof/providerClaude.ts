import Anthropic from 'npm:@anthropic-ai/sdk';
import type { OcrImageInput, OcrProvider } from './provider.ts';

const TRANSCRIBE_PROMPT =
  'Transcribe every piece of visible text from this Cambodian payment ' +
  'confirmation screenshot or receipt, exactly as printed, one line per ' +
  'line of the image. Keep labels and their values together on one line ' +
  'when the image shows them together (for example "From: SOK DARA", ' +
  '"Amount: $150.00", "Transaction ID: FT23219876543"). Preserve numbers, ' +
  'currency symbols and punctuation exactly. Do not translate, summarize, ' +
  'correct, or explain anything — output only the transcribed text.';

/** Anthropic's image blocks accept these four; PDF proofs go through a document block instead. */
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Claude Opus 5, chosen for accurate mixed Khmer/Latin-script image
 * understanding. Swappable: anything implementing `OcrProvider` — a
 * different model, Google Vision, Tesseract — drops in without touching
 * `index.ts` or the parser.
 */
export function createClaudeOcrProvider(apiKey: string): OcrProvider {
  const client = new Anthropic({ apiKey });

  return {
    name: 'claude-opus-5',
    async extractText({ base64, mimeType }: OcrImageInput): Promise<string> {
      const contentBlock =
        mimeType === 'application/pdf'
          ? ({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            } as const)
          : ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: IMAGE_MEDIA_TYPES.has(mimeType)
                  ? (mimeType as 'image/jpeg')
                  : 'image/jpeg',
                data: base64,
              },
            } as const);

      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 2048,
        // A single-page transcription is a bounded, well-specified task —
        // low effort keeps latency and cost down without losing accuracy.
        output_config: { effort: 'low' },
        messages: [
          {
            role: 'user',
            content: [contentBlock, { type: 'text', text: TRANSCRIBE_PROMPT }],
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        throw new Error('provider_refused');
      }

      const textBlock = response.content.find((block) => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text' || !textBlock.text.trim()) {
        throw new Error('empty_response');
      }
      return textBlock.text;
    },
  };
}
