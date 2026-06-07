import { jsonOk, noStoreHeaders } from '@/lib/apiResponse';

export async function GET() {
  return jsonOk(
    {
      service: 'voice-translate-api',
      status: 'ok',
      time: new Date().toISOString(),
      providers: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
        azureSpeech: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
        elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
        deepgram: false,
      },
    },
    { headers: noStoreHeaders() }
  );
}
