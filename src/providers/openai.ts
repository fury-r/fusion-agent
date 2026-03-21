import OpenAI from 'openai';
import { BaseProvider, CompletionOptions, CompletionResult } from './base';

export const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] as const;
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

export class OpenAIProvider extends BaseProvider {
  private client: OpenAI;

  constructor(apiKey: string, model = DEFAULT_OPENAI_MODEL) {
    super(apiKey, model);
    this.client = new OpenAI({ apiKey });
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
