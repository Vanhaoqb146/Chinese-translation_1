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
        openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
        deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
      };
      const cfg = configs[engine] || configs.openai;

      // 1. TỐI ƯU HÓA SYSTEM PROMPT
      const systemPrompt = `Bạn là một chuyên gia phiên dịch cabin (interpreter) cấp cao.
Nhiệm vụ: Dịch văn bản từ ${sourceName} sang ${targetName}.
Yêu cầu bắt buộc:
1. CHỈ TRẢ VỀ nội dung đã dịch, TUYỆT ĐỐI KHÔNG thêm lời giải thích, không thêm ngoặc kép, không dùng markdown.
2. Dịch sát nghĩa, tự nhiên, trôi chảy và phù hợp với văn phong bản địa của ngôn ngữ đích.
3. TỰ ĐỘNG LƯỢC BỎ các từ ngữ ngập ngừng (à, ừm, ờ, vấp váp). TUYỆT ĐỐI GIỮ NGUYÊN TÊN RIÊNG (ví dụ: Nguyễn Văn A, Trần Văn B), không được nhầm lẫn chữ cái cuối câu chỉ tên người với thán từ/từ đệm.
4. Chú ý đọc hiểu lịch sử hội thoại (nếu có) để xác định đúng đại từ nhân xưng và ngữ cảnh.`;

      // 2. XÂY DỰNG MẢNG TIN NHẮN CÓ NGỮ CẢNH
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // Đưa khoảng 4 câu lịch sử gần nhất vào để làm ngữ cảnh (tránh gửi quá dài tốn token)
      if (history && history.length > 0) {
        const recentHistory = history.slice(-4);
        recentHistory.forEach(msg => {
          // Format mảng history mong đợi từ FE: { role: 'user'/'assistant', content: '...' }
          messages.push({ role: msg.role || 'user', content: msg.content });
        });
      }

      // Thêm câu nói hiện tại cần dịch vào cuối
      messages.push({ role: 'user', content: text });

      try {
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: messages, // Sử dụng mảng messages mới
            max_tokens: 1000,   // Giảm token xuống vì dịch câu ngắn không cần tới 4000
            temperature: 0.2,   // Giảm nhiệt độ để câu dịch chuẩn xác và ít bay bổng sai lệch hơn
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
