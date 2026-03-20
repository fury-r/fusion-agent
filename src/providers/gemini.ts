import { GoogleGenerativeAI, GenerativeModel, Content } from '@google/generative-ai';
import { BaseProvider, CompletionOptions, CompletionResult, Message } from './base';

export const GEMINI_MODELS = ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'] as const;
export const DEFAULT_GEMINI_MODEL = 'gemini-1.5-pro';

export class GeminiProvider extends BaseProvider {
  private client: GoogleGenerativeAI;
  private generativeModel: GenerativeModel;

  constructor(apiKey: string, model = DEFAULT_GEMINI_MODEL) {
    super(apiKey, model);
    this.client = new GoogleGenerativeAI(apiKey);
    this.generativeModel = this.client.getGenerativeModel({ model });
  }

  private convertMessages(messages: Message[]): { system: string; history: Content[]; lastUserMsg: string } {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const system = systemMessages.map((m) => m.content).join('\n\n');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    if (conversationMessages.length === 0) {
      return { system, history: [], lastUserMsg: '' };
    }

    const lastMsg = conversationMessages[conversationMessages.length - 1];
    const historyMessages = conversationMessages.slice(0, -1);

    const history: Content[] = historyMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    return { system, history, lastUserMsg: lastMsg.content };
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const modelName = options.model || this.model;
    const maxTokens = options.maxTokens || 4096;
    const temperature = options.temperature ?? 0.7;

    // Re-create model in case model override is different
    const genModel = modelName !== this.model
      ? this.client.getGenerativeModel({ model: modelName })
      : this.generativeModel;

    const { system, history, lastUserMsg } = this.convertMessages(options.messages);

    const fullPrompt = system ? `${system}\n\n${lastUserMsg}` : lastUserMsg;

    const chat = genModel.startChat({
      history,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
      },
    });

    if (options.stream && options.onChunk) {
      const result = await chat.sendMessageStream(fullPrompt);
      let fullContent = '';
      for await (const chunk of result.stream) {
        const text = chunk.text();
        fullContent += text;
        options.onChunk(text);
      }
      return { content: fullContent, model: modelName };
    }

    const result = await chat.sendMessage(fullPrompt);
    const content = result.response.text();
    const usage = result.response.usageMetadata;
    return {
      content,
      model: modelName,
      usage: usage
        ? {
            promptTokens: usage.promptTokenCount || 0,
            completionTokens: usage.candidatesTokenCount || 0,
            totalTokens: usage.totalTokenCount || 0,
          }
        : undefined,
    };
  }
}
