import { ModelError } from "./model";
import type { ModelClient } from "./model";

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Real DeepSeek client (OpenAI-compatible chat completions API).
 * Reads no environment itself; pass the API key explicitly.
 */
export class DeepSeekClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.deepseek.com";
    this.model = options.model ?? "deepseek-chat";
  }

  async complete(prompt: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
      });
    } catch (err) {
      throw new ModelError(err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) {
      throw new ModelError(`DeepSeek API error ${response.status}`, response.status);
    }

    const data = (await response.json()) as DeepSeekResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new ModelError("DeepSeek API returned no content");
    }
    return content;
  }
}
