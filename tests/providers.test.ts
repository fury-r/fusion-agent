import { OllamaProvider, DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from '../src/providers/ollama';
import { LocalProvider, DEFAULT_LOCAL_BASE_URL, DEFAULT_LOCAL_MODEL } from '../src/providers/local';
import { createProvider } from '../src/providers';

// ── OllamaProvider ────────────────────────────────────────────────────────────

describe('OllamaProvider', () => {
  it('uses default model and base URL', () => {
    const provider = new OllamaProvider();
    expect(provider.getModel()).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it('accepts a custom model', () => {
    const provider = new OllamaProvider('mistral');
    expect(provider.getModel()).toBe('mistral');
  });

  it('completes a message against a mock Ollama endpoint', async () => {
    const provider = new OllamaProvider('llama3', DEFAULT_OLLAMA_BASE_URL);

    // Monkey-patch the internal OpenAI client to avoid a real network call
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'Hello from Ollama!' } }],
      model: 'llama3',
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = { chat: { completions: { create: mockCreate } } };

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.content).toBe('Hello from Ollama!');
    expect(result.model).toBe('llama3');
    expect(result.usage?.totalTokens).toBe(9);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'llama3' }),
    );
  });

  it('streams chunks when stream + onChunk are provided', async () => {
    const provider = new OllamaProvider('llama3', DEFAULT_OLLAMA_BASE_URL);

    const fakeChunks = [
      { choices: [{ delta: { content: 'chunk1' } }] },
      { choices: [{ delta: { content: 'chunk2' } }] },
    ];

    const mockCreate = jest.fn().mockResolvedValue(
      (async function* () {
        for (const c of fakeChunks) yield c;
      })(),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = { chat: { completions: { create: mockCreate } } };

    const received: string[] = [];
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'stream test' }],
      stream: true,
      onChunk: (c) => received.push(c),
    });

    expect(received).toEqual(['chunk1', 'chunk2']);
    expect(result.content).toBe('chunk1chunk2');
  });
});

// ── LocalProvider ─────────────────────────────────────────────────────────────

describe('LocalProvider', () => {
  it('uses default model and base URL', () => {
    const provider = new LocalProvider();
    expect(provider.getModel()).toBe(DEFAULT_LOCAL_MODEL);
  });

  it('accepts custom model, base URL, and api key', () => {
    const provider = new LocalProvider('mistral', 'http://localhost:1234/v1', 'my-key');
    expect(provider.getModel()).toBe('mistral');
  });

  it('completes a message against a mock local server', async () => {
    const provider = new LocalProvider('mistral', DEFAULT_LOCAL_BASE_URL, 'test-key');

    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'Hello from local LLM!' } }],
      model: 'mistral',
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = { chat: { completions: { create: mockCreate } } };

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.content).toBe('Hello from local LLM!');
    expect(result.usage?.promptTokens).toBe(3);
  });

  it('streams chunks when stream + onChunk are provided', async () => {
    const provider = new LocalProvider('phi3', DEFAULT_LOCAL_BASE_URL);

    const fakeChunks = [
      { choices: [{ delta: { content: 'a' } }] },
      { choices: [{ delta: { content: 'b' } }] },
      { choices: [{ delta: { content: 'c' } }] },
    ];

    const mockCreate = jest.fn().mockResolvedValue(
      (async function* () {
        for (const c of fakeChunks) yield c;
      })(),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).client = { chat: { completions: { create: mockCreate } } };

    const received: string[] = [];
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'stream' }],
      stream: true,
      onChunk: (c) => received.push(c),
    });

    expect(received).toEqual(['a', 'b', 'c']);
    expect(result.content).toBe('abc');
  });
});

// ── createProvider factory ────────────────────────────────────────────────────

describe('createProvider — local providers', () => {
  it('creates an OllamaProvider for provider="ollama"', () => {
    const p = createProvider({ provider: 'ollama', model: 'llama3' });
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.getModel()).toBe('llama3');
  });

  it('creates an OllamaProvider with a custom baseUrl', () => {
    const p = createProvider({ provider: 'ollama', baseUrl: 'http://remote-host:11434/v1' });
    expect(p).toBeInstanceOf(OllamaProvider);
  });

  it('creates a LocalProvider for provider="local"', () => {
    const p = createProvider({ provider: 'local', model: 'mistral' });
    expect(p).toBeInstanceOf(LocalProvider);
    expect(p.getModel()).toBe('mistral');
  });

  it('creates a LocalProvider with a custom baseUrl and apiKey', () => {
    const p = createProvider({ provider: 'local', baseUrl: 'http://localhost:1234/v1', apiKey: 'sk-test' });
    expect(p).toBeInstanceOf(LocalProvider);
  });

  it('uses OLLAMA_BASE_URL env var when no baseUrl is provided', () => {
    const original = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://ollama-server:11434/v1';
    const p = createProvider({ provider: 'ollama' });
    expect(p).toBeInstanceOf(OllamaProvider);
    if (original !== undefined) process.env.OLLAMA_BASE_URL = original;
    else delete process.env.OLLAMA_BASE_URL;
  });

  it('uses LOCAL_LLM_BASE_URL env var when no baseUrl is provided', () => {
    const original = process.env.LOCAL_LLM_BASE_URL;
    process.env.LOCAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const p = createProvider({ provider: 'local' });
    expect(p).toBeInstanceOf(LocalProvider);
    if (original !== undefined) process.env.LOCAL_LLM_BASE_URL = original;
    else delete process.env.LOCAL_LLM_BASE_URL;
  });
});
