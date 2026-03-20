export interface Speckit {
  name: string;
  description: string;
  systemPrompt: string;
  defaultModel?: string;
  defaultProvider?: string;
  examples?: string[];
}
