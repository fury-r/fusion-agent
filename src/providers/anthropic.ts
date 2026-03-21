import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider, CompletionOptions, CompletionResult, Message } from './base';

export const ANTHROPIC_MODELS = ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'] as const;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';

export class AnthropicProvider extends BaseProvider {
  private client: Anthropic;

  constructor(apiKey: string, model = DEFAULT_ANTHROPIC_MODEL) {
    super(apiKey, model);
    this.client = new Anthropic({ apiKey });
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 4096;
    const temperature = options.temperature ?? 0.7;

    // Anthropic separates system prompt from conversation messages
    const systemMessages = options.messages.filter((m: Message) => m.role === 'system');
    const conversationMessages = options.messages.filter((m: Message) => m.role !== 'system');
    const systemPrompt = systemMessages.map((m: Message) => m.content).join('\n\n');

    if (options.stream && options.onChunk) {
      const stream = await this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt || undefined,
        messages: conversationMessages as Anthropic.MessageParam[],
      });

      let fullContent = '';
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          fullContent += chunk.delta.text;
          options.onChunk(chunk.delta.text);
        }
      }
      const finalMsg = await stream.finalMessage();
      return {
        content: fullContent,
        model: finalMsg.model,
        usage: {
          promptTokens: finalMsg.usage.input_tokens,
          completionTokens: finalMsg.usage.output_tokens,
          totalTokens: finalMsg.usage.input_tokens + finalMsg.usage.output_tokens,
        },
      };
    }

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt || undefined,
      messages: conversationMessages as Anthropic.MessageParam[],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const content = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    return {
      content,
      model: response.model,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }
}
