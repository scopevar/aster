/** Conservative text estimate, not a provider tokenizer or billing measurement. */
export function estimateContextTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 3);
}

export type ContextUsage = { usedTokens: number; contextWindow: number | null };
