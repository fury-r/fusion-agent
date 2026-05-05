import OpenAI from 'openai';
import { BaseProvider, CompletionOptions, CompletionResult } from './base';

export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:8080/v1';
export const DEFAULT_LOCAL_MODEL = 'local-model';

/**
 * LocalProvider connects to any OpenAI-compatible local LLM server.
 *
 * Compatible servers include (but are not limited to):
 *   - LM Studio    — http://localhost:1234/v1
 *   - llama.cpp    — http://localhost:8080/v1
 *   - LiteLLM      — http://localhost:4000/v1
 *   - Jan          — http://localhost:1337/v1
 *   - text-gen-webui — http://localhost:5000/v1
 *
 * Configure via environment variables:
 *   LOCAL_LLM_BASE_URL=http://localhost:1234/v1
 *   LOCAL_LLM_API_KEY=optional-key   (some servers require one; defaults to "local")
 *   LOCAL_LLM_MODEL=mistral
 */
export class LocalProvider extends BaseProvider {
  private client: OpenAI;

  constructor(
    model = DEFAULT_LOCAL_MODEL,
    baseUrl = DEFAULT_LOCAL_BASE_URL,
    apiKey = 'local',
  ) {
    super('local', model);
    this.client = new OpenAI({
      apiKey: apiKey || 'local',
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
