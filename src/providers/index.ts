import { BaseProvider } from './base';
import { OpenAIProvider, DEFAULT_OPENAI_MODEL } from './openai';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic';
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini';
import { OllamaProvider, DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_BASE_URL } from './ollama';
import { LocalProvider, DEFAULT_LOCAL_MODEL, DEFAULT_LOCAL_BASE_URL } from './local';

export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'local';

export interface ProviderOptions {
  provider: ProviderName;
  apiKey?: string;
  model?: string;
  /** Base URL for local providers (ollama, local). Defaults to the provider's default URL. */
  baseUrl?: string;
}

export function createProvider(options: ProviderOptions): BaseProvider {
  const { provider, apiKey, model, baseUrl } = options;

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
    case 'ollama': {
      const url = baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
      return new OllamaProvider(model || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL, url);
    }
    case 'local': {
      const url = baseUrl || process.env.LOCAL_LLM_BASE_URL || DEFAULT_LOCAL_BASE_URL;
      const key = apiKey || process.env.LOCAL_LLM_API_KEY || 'local';
      return new LocalProvider(model || process.env.LOCAL_LLM_MODEL || DEFAULT_LOCAL_MODEL, url, key);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export { BaseProvider, OpenAIProvider, AnthropicProvider, GeminiProvider, OllamaProvider, LocalProvider };
export type { CompletionOptions, CompletionResult, Message } from './base';
