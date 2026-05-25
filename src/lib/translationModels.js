export const DEFAULT_TRANSLATION_MODEL = 'gpt-5.4-mini';

export const TRANSLATION_MODELS = [
  { id: 'gpt-5.4-mini', label: 'OpenAI GPT-5.4 Mini' },
  { id: 'gpt-5.4', label: 'OpenAI GPT-5.4' },
  { id: 'gpt-5.4-nano', label: 'OpenAI GPT-5.4 Nano' },
];

const MODEL_IDS = new Set(TRANSLATION_MODELS.map((model) => model.id));

export function normalizeTranslationModel(model) {
  if (MODEL_IDS.has(model)) return model;
  return DEFAULT_TRANSLATION_MODEL;
}
