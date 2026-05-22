import { AI_PROVIDER_URLS } from "./constants";

export type AiProviderId = keyof typeof AI_PROVIDER_URLS;

export interface AiProvider {
  id: AiProviderId;
  name: string;
  url: string;
  supportsFileUpload: boolean;
  maxContextTokens?: number;
}

export const AI_PROVIDERS: AiProvider[] = [
  { id: "chatgpt", name: "ChatGPT", url: AI_PROVIDER_URLS.chatgpt, supportsFileUpload: true },
  { id: "claude", name: "Claude", url: AI_PROVIDER_URLS.claude, supportsFileUpload: true },
  { id: "gemini", name: "Gemini", url: AI_PROVIDER_URLS.gemini, supportsFileUpload: true },
  { id: "grok", name: "Grok", url: AI_PROVIDER_URLS.grok, supportsFileUpload: true },
];

export function getAiProvider(id?: string): AiProvider {
  return AI_PROVIDERS.find(provider => provider.id === id) ?? AI_PROVIDERS[0];
}
