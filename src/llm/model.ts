/** A model/network failure that should be treated as transient, not fatal. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionResult {
  text: string;
  /** Token usage when the provider reports it; null otherwise. */
  usage: TokenUsage | null;
}

/**
 * Minimal abstraction over a language model. Real providers (e.g. DeepSeek)
 * and deterministic test fakes both implement this. `complete` must reject
 * with a `ModelError` (or any error) when the model cannot answer.
 */
export interface ModelClient {
  complete(prompt: string): Promise<CompletionResult>;
}
