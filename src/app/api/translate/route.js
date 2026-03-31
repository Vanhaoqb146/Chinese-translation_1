export async function POST(request) {
  try {
    const body = await request.json();
    // BỔ SUNG: Nhận thêm mảng history từ frontend
    const { text, sourceLang, targetLang, engine, history = [] } = body;
    const apiKey = body.apiKey || process.env.OPENAI_API_KEY || '';

    if (!text || !sourceLang || !targetLang) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const langNames = {
      vi: 'Vietnamese', en: 'English', zh: 'Chinese',
      ja: 'Japanese', ko: 'Korean',
    };

    const sourceName = langNames[sourceLang] || sourceLang;
    const targetName = langNames[targetLang] || targetLang;

    // Try LLM first (OpenAI or DeepSeek)
    if (apiKey) {
      const configs = {
        openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
        deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
      };
      const cfg = configs[engine] || configs.openai;

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

      // Đưa khoảng 4 câu lịch sử gần nhất, wrap trong khung dịch thuật rõ ràng
      // để GPT không nhầm history là cuộc hội thoại cần tiếp tục
      if (history && history.length > 0) {
        const recentHistory = history.slice(-4);
        recentHistory.forEach(msg => {
          const role = msg.role || 'user';
          const prefix = role === 'user'
            ? `[Previous ${sourceName} input]:`
            : `[Previous ${targetName} translation]:`;
          messages.push({ role, content: `${prefix} ${msg.content}` });
        });
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
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: cfg.model,
              messages,
              max_tokens: 1000,
              temperature: 0.2,
              stream: true,
            }),
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
            },
          });
        }

        // ====== NON-STREAMING MODE (Standard — giữ nguyên) ======
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: messages,
            max_tokens: 1000,
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(25000),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error?.message || `API error ${res.status}`);
        }

        const data = await res.json();
        return Response.json({
          translation: data.choices[0].message.content.trim(),
          engine: engine || 'openai',
        });
      } catch (llmErr) {
        console.warn('LLM failed, falling back to MyMemory:', llmErr.message);
        // Fall through to MyMemory
      }
    }

    // Fallback: MyMemory (free)
    const translation = await translateWithMyMemory(text, sourceLang, targetLang);
    return Response.json({ translation, engine: 'mymemory' });

  } catch (err) {
    console.error('Translation error:', err);
    return Response.json({ error: err.message }, { status: 500 });
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
