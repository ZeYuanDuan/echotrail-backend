export const resolvePort = (value = process.env.PORT): number => {
  if (value === undefined) return 8080;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  return port;
};

export type GeminiConfig = {
  apiKey: string;
  model: string;
};

export const resolveGeminiConfig = (
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL,
): GeminiConfig => {
  const resolvedApiKey = apiKey?.trim();
  const resolvedModel = model?.trim() || 'gemini-3.5-flash-lite';

  if (!resolvedApiKey) throw new Error('GEMINI_API_KEY is required');
  if (!/^[a-zA-Z0-9._-]+$/.test(resolvedModel)) throw new Error('GEMINI_MODEL is invalid');

  return { apiKey: resolvedApiKey, model: resolvedModel };
};
