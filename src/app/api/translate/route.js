import { requireAuth } from '@/lib/auth';
import { enforceRateLimit, rateLimitHeaders } from '@/lib/rateLimit';

export const maxDuration = 60;

function timedJson(body, {
  status = 200,
  startedAt,
  timings = {},
  headers = {},
  requestId = null,
}) {
  const totalMs = Date.now() - startedAt;
  const responseTimings = { ...timings, totalMs };
  const serverTiming = [
    ...Object.entries(timings).map(([name, duration]) => (
      `${name.replace(/Ms$/, '')};dur=${Math.max(0, Math.round(duration))}`
    )),
    `total;dur=${Math.max(0, Math.round(totalMs))}`,
  ].join(', ');

  return Response.json(
    { ok: status < 400, ...body, requestId, timings: responseTimings },
    {
      status,
      headers: {
        'Server-Timing': serverTiming,
        ...(requestId ? { 'X-Request-ID': requestId } : {}),
        ...headers,
      },
    }
  );
}

function allowClientApiKeys() {
  return process.env.ALLOW_CLIENT_API_KEYS === 'true' || process.env.NODE_ENV !== 'production';
}

const OPENAI_TRANSLATION_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
]);

function getProviderConfig(engine, clientApiKey = '') {
  const canUseClientKey = allowClientApiKeys();

  if (engine === 'deepseek') {
    return {
      provider: 'deepseek',
      url: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      apiKey: process.env.DEEPSEEK_API_KEY || (canUseClientKey ? clientApiKey : ''),
    };
  }

  const model = OPENAI_TRANSLATION_MODELS.has(engine) ? engine : 'gpt-5.4-mini';

  return {
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    model,
    apiKey: process.env.OPENAI_API_KEY || (canUseClientKey ? clientApiKey : ''),
  };
}

function createChatCompletionPayload(cfg, messages, { stream = false } = {}) {
  const payload = {
    model: cfg.model,
    messages,
    stream,
  };

  if (cfg.provider === 'openai') {
    payload.max_completion_tokens = 1000;
    return payload;
  }

  payload.max_tokens = 1000;
  payload.temperature = 0.2;
  return payload;
}

const CJK_CHARS = /[\u3400-\u9fff]/;
const KANA_CHARS = /[\u3040-\u30ff]/;
const HANGUL_CHARS = /[\uac00-\ud7af]/;
const LATIN_CHARS = /[a-zA-Z]/;
const VIET_D = /[đĐ]/;

function isLikelyLanguage(text, lang) {
  const value = (text || '').trim();
  if (!value) return false;

  const hasCjk = CJK_CHARS.test(value);
  const hasKana = KANA_CHARS.test(value);
  const hasHangul = HANGUL_CHARS.test(value);
  const hasLatin = LATIN_CHARS.test(value);
  const decomposed = value.normalize('NFD');
  const hasVietnamese = /[\u0300-\u036f]/.test(decomposed) || VIET_D.test(value);

  if (lang === 'zh') return hasCjk;
  if (lang === 'ja') return hasKana || hasCjk;
  if (lang === 'ko') return hasHangul;
  if (lang === 'vi') return !hasCjk && !hasKana && !hasHangul && (hasLatin || hasVietnamese);
  if (lang === 'en') return hasLatin && !hasCjk && !hasKana && !hasHangul && !hasVietnamese;
  return true;
}

export async function POST(request) {
  const startedAt = Date.now();
  const requestId = request.headers.get('x-request-id') || `translate-${startedAt.toString(36)}`;

  try {
    const auth = await requireAuth(request);
    if (auth.response) return auth.response;

    const limit = enforceRateLimit(request, {
      name: 'translate',
      user: auth.user,
      limit: 180,
      windowMs: 60_000,
    });
    if (limit.response) return limit.response;

    const body = await request.json();
    // BỔ SUNG: Nhận thêm mảng history từ frontend
    const { text, sourceLang, targetLang, engine, history = [] } = body;
    const cfg = getProviderConfig(engine, body.apiKey || '');
    console.log(`[Translate][${requestId}] started source=${sourceLang} target=${targetLang} model=${cfg.model} chars=${typeof text === 'string' ? text.length : 0}`);

    if (!text || !sourceLang || !targetLang) {
      return timedJson(
        { error: 'Missing required fields' },
        { status: 400, startedAt, headers: rateLimitHeaders(limit.result), requestId }
      );
    }

    if (typeof text !== 'string' || text.length > 6000) {
      return timedJson(
        { error: 'Text is too long' },
        { status: 400, startedAt, headers: rateLimitHeaders(limit.result), requestId }
      );
    }

    const langNames = {
      vi: 'Vietnamese', en: 'English', zh: 'Chinese',
      ja: 'Japanese', ko: 'Korean',
    };

    const sourceName = langNames[sourceLang] || sourceLang;
    const targetName = langNames[targetLang] || targetLang;

    // Try LLM first (OpenAI or DeepSeek)
    if (cfg.apiKey) {
      // [FIX BUG 2] STRICT TRANSLATION-ONLY SYSTEM PROMPT
      // Sử dụng tiếng Anh, cực kỳ rõ ràng, cấm GPT trả lời câu hỏi hoặc nói chuyện
      const systemPrompt = `You are a professional, direct translation engine. Your ONLY task is to translate text from ${sourceName} to ${targetName}.

ABSOLUTE RULES — NEVER BREAK THESE:
1. ONLY output the translated text. Nothing else.
2. NEVER answer questions. If the input is a question, TRANSLATE the question. Do NOT answer it.
3. NEVER continue a conversation. NEVER add greetings, farewells, or conversational filler.
4. NEVER add explanations, notes, quotation marks, or markdown formatting.
5. NEVER refuse to translate. Translate everything exactly as given.
6. Translate naturally and fluently in the target language's native style.
7. Automatically remove filler words (um, uh, er, à, ừm, ờ) from the input.
8. ALWAYS preserve proper nouns exactly as they appear (e.g., names of people, places).
9. Use conversation history ONLY for pronoun/context resolution, NEVER to generate responses.
10. Before translating, silently fix any obvious speech recognition errors in the input — such as misheard characters/words, garbled text, broken names, or repeated syllables.
11. CRITICAL PUNCTUATION RULE: Do NOT use comma splices. Break long spoken text into proper grammatical sentences using periods (.) and question marks (?). Ensure proper capitalization at the start of each sentence. For example: "Xin chào mọi người, hôm nay thế nào, rất vui" MUST become "Xin chào mọi người! Hôm nay thế nào? Rất vui được gặp các bạn."

REMEMBER: You are a TRANSLATION ENGINE, not a chatbot. Your output must ALWAYS be a translation, NEVER an answer or response.`;

      // 2. XÂY DỰNG MẢNG TIN NHẮN CÓ NGỮ CẢNH
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // Đưa khoảng 4 câu lịch sử gần nhất vào system context để GPT hiểu ngữ cảnh
      // nhưng không dùng role user/assistant chứa prefix để tránh model copy pattern prefix ở output.
      if (history && history.length > 0) {
        const recentHistory = history.slice(-4);
        let historyContextText = `\n\nTranslation history for context (use ONLY for pronoun resolution, style, and tone consistency; do NOT output any of these prefix labels or translate them):\n`;
        
        recentHistory.forEach(msg => {
          const role = msg.role || 'user';
          const label = role === 'user' ? sourceName : targetName;
          historyContextText += `[Previous ${label}]: ${msg.content}\n`;
        });
        
        messages[0].content += historyContextText;
      }

      // Thêm câu nói hiện tại cần dịch vào cuối, wrap rõ ràng
      messages.push({ role: 'user', content: `Translate the following from ${sourceName} to ${targetName}. Output ONLY the translation:\n${text}` });

      try {
        // ====== STREAMING MODE (Conversation) ======
        if (body.stream) {
          const res = await fetch(cfg.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(createChatCompletionPayload(cfg, messages, { stream: true })),
            signal: AbortSignal.timeout(30000),
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error?.message || `API error ${res.status}`);
          }

          // Pipe GPT SSE stream thẳng về browser
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();

          (async () => {
            let sseBuffer = '';
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed.startsWith('data: ')) continue;
                  const data = trimmed.slice(6).trim();
                  if (data === '[DONE]') {
                    await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
                    break;
                  }
                  try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                      await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ text: delta })}\n\n`));
                    }
                  } catch {}
                }
              }
              // Process remaining buffer
              if (sseBuffer.trim()) {
                const trimmed = sseBuffer.trim();
                if (trimmed.startsWith('data: ')) {
                  const data = trimmed.slice(6).trim();
                  if (data !== '[DONE]') {
                    try {
                      const parsed = JSON.parse(data);
                      const delta = parsed.choices?.[0]?.delta?.content;
                      if (delta) {
                        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ text: delta })}\n\n`));
                      }
                    } catch {}
                  }
                }
              }
              await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
            } finally {
              writer.close();
            }
          })();

          return new Response(readable, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Translate-Model': cfg.model,
              'X-Translate-Engine': engine || 'openai',
              ...rateLimitHeaders(limit.result),
            },
          });
        }

        // ====== NON-STREAMING MODE (Standard — giữ nguyên) ======
        const llmStartedAt = Date.now();
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(createChatCompletionPayload(cfg, messages)),
          signal: AbortSignal.timeout(25000),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error?.message || `API error ${res.status}`);
        }

        const data = await res.json();
        const llmMs = Date.now() - llmStartedAt;
        let translation = data.choices[0].message.content.trim();

        // Clean up any leaked prefixes from the translation
        const prefixesToRemove = [
          `[Previous ${sourceName} input]:`,
          `[Previous ${targetName} translation]:`,
          `[Previous ${targetName} input]:`,
          `[Previous ${sourceName} translation]:`,
          `Previous ${sourceName} input:`,
          `Previous ${targetName} translation:`,
          `Previous ${targetName} input:`,
          `Previous ${sourceName} translation:`,
          `[Previous translation]:`,
          `[Translation]:`,
          `Translation:`
        ];
        
        for (const p of prefixesToRemove) {
          if (translation.toLowerCase().startsWith(p.toLowerCase())) {
            translation = translation.slice(p.length).trim();
            // Remove outer quotes if the model wrapped the translation in quotes
            translation = translation.replace(/^["'“`](.*)["'”`]$/g, '$1').trim();
          }
        }

        if (!isLikelyLanguage(translation, targetLang)) {
          console.warn(
            `[Translate Guard] Output did not look like ${targetLang}; requesting a repair pass.`
          );

          const repairMessages = [
            {
              role: 'system',
              content: `You are a strict translation repair engine. Translate from ${sourceName} to ${targetName}. Output ONLY ${targetName} text, with no notes.`,
            },
            {
              role: 'user',
              content: `The previous output was invalid because it was not ${targetName}. Translate this text to ${targetName} only:\n${text}`,
            },
          ];

          const repairRes = await fetch(cfg.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(createChatCompletionPayload(cfg, repairMessages)),
            signal: AbortSignal.timeout(15000),
          });

          if (repairRes.ok) {
            const repairData = await repairRes.json();
            const repaired = repairData.choices?.[0]?.message?.content?.trim() || '';
            if (isLikelyLanguage(repaired, targetLang)) {
              translation = repaired;
            }
          }
        }

        console.log(`[Translate][${requestId}] timings=${JSON.stringify({
          llmMs,
          totalMs: Date.now() - startedAt,
        })}`);
        return timedJson(
          {
            translation,
            engine: engine || 'openai',
            model: cfg.model,
          },
          {
            startedAt,
            timings: { llmMs },
            requestId,
            headers: {
              'X-Translate-Model': cfg.model,
              'X-Translate-Engine': engine || 'openai',
              ...rateLimitHeaders(limit.result),
            },
          }
        );
      } catch (llmErr) {
        console.warn('LLM failed, falling back to MyMemory:', llmErr.message);
        // Fall through to MyMemory
      }
    }

    // Fallback: MyMemory (free)
    const fallbackStartedAt = Date.now();
    const translation = await translateWithMyMemory(text, sourceLang, targetLang);
    return timedJson(
      { translation, engine: 'mymemory' },
      {
        startedAt,
        timings: { fallbackMs: Date.now() - fallbackStartedAt },
        requestId,
        headers: {
          'X-Translate-Engine': 'mymemory',
          ...rateLimitHeaders(limit.result),
        },
      }
    );

  } catch (err) {
    console.error(`[Translate][${requestId}] error:`, err);
    return timedJson({ error: err.message }, { status: 500, startedAt, requestId });
  }
}

async function translateWithMyMemory(text, source, target) {
  const MAX = 490;
  if (text.length <= MAX) {
    return myMemoryRequest(text, source, target);
  }
  // Split long text
  const sentences = text.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) || [text];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > MAX && current) { chunks.push(current.trim()); current = s; }
    else current += s;
  }
  if (current.trim()) chunks.push(current.trim());

  const results = [];
  for (const chunk of chunks) {
    results.push(await myMemoryRequest(chunk, source, target));
  }
  return results.join(' ');
}

async function myMemoryRequest(text, source, target) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${target}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  if (data.responseStatus === 200) return data.responseData.translatedText;
  throw new Error(data.responseDetails || 'MyMemory failed');
}
