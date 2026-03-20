import { BaseProvider } from './base';
import { OpenAIProvider, DEFAULT_OPENAI_MODEL } from './openai';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic';
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini';

export type ProviderName = 'openai' | 'anthropic' | 'gemini';

export interface ProviderOptions {
  provider: ProviderName;
  apiKey?: string;
  model?: string;
}

export function createProvider(options: ProviderOptions): BaseProvider {
  const { provider, apiKey, model } = options;

  switch (provider) {
    case 'openai': {
      const key = apiKey || process.env.OPENAI_API_KEY || '';
      if (!key) throw new Error('OpenAI API key is required. Set OPENAI_API_KEY env variable.');
      return new OpenAIProvider(key, model || DEFAULT_OPENAI_MODEL);
    }
    case 'anthropic': {
      const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
      if (!key) throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY env variable.');
      return new AnthropicProvider(key, model || DEFAULT_ANTHROPIC_MODEL);
    }
    case 'gemini': {
      const key = apiKey || process.env.GEMINI_API_KEY || '';
      if (!key) throw new Error('Gemini API key is required. Set GEMINI_API_KEY env variable.');
      return new GeminiProvider(key, model || DEFAULT_GEMINI_MODEL);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export { BaseProvider, OpenAIProvider, AnthropicProvider, GeminiProvider };
export type { CompletionOptions, CompletionResult, Message } from './base';
