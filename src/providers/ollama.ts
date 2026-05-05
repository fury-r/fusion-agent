import OpenAI from 'openai';
import { BaseProvider, CompletionOptions, CompletionResult } from './base';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_OLLAMA_MODEL = 'llama3';

/**
 * OllamaProvider connects to a locally running Ollama instance.
 *
 * Ollama exposes an OpenAI-compatible REST API at http://localhost:11434/v1,
 * so we re-use the OpenAI SDK with a custom baseURL.  No API key is required
 * (the SDK requires a non-empty string, so we pass a placeholder).
 *
 * Start Ollama and pull a model before using this provider:
 *   ollama serve
 *   ollama pull llama3
 */
export class OllamaProvider extends BaseProvider {
  private client: OpenAI;

  constructor(model = DEFAULT_OLLAMA_MODEL, baseUrl = DEFAULT_OLLAMA_BASE_URL) {
    // apiKey is unused by Ollama but required by the parent constructor
    super('ollama', model);
    this.client = new OpenAI({
      apiKey: 'ollama', // placeholder — Ollama does not validate the key
      baseURL: baseUrl,
    });
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 4096;
    const temperature = options.temperature ?? 0.7;

    if (options.stream && options.onChunk) {
      const stream = await this.client.chat.completions.create({
        model,
        messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
        max_tokens: maxTokens,
        temperature,
        stream: true,
      });

      let fullContent = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          fullContent += delta;
          options.onChunk(delta);
        }
      }
      return { content: fullContent, model };
    }

    const response = await this.client.chat.completions.create({
      model,
      messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
      max_tokens: maxTokens,
      temperature,
    });

    const content = response.choices[0]?.message?.content || '';
    return {
      content,
      model: response.model,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }
}
