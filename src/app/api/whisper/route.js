import { NextResponse } from 'next/server';

// =============================================
// [LƯỚI LỌC THÉP] — Aggressive Hallucination Filter
// =============================================

// CHỈ cho phép Tiếng Việt và Tiếng Trung đi qua
const ALLOWED_LANGS = ['vietnamese', 'chinese', 'mandarin', 'vi', 'zh'];

// Danh sách "từ ma" (hallucination) mà Whisper thường bịa ra khi thu im lặng/tiếng ồn
const BAD_PHRASES = [
  // English hallucinations (phổ biến nhất khi im lặng)
  'thanks for watching', 'thank you for watching', 'please subscribe',
  'like and subscribe', 'see you next time', 'bye bye', 'goodbye',
  'see you later', 'thank you', 'you', 'bye',
  'please like', 'don\'t forget to subscribe', 'hit the bell',
  'leave a comment', 'share this video', 'follow me',
  'welcome back', 'hello everyone', 'hey guys',
  // Vietnamese hallucinations
  'đăng ký', 'theo dõi', 'tạm biệt', 'hẹn gặp lại',
  'cảm ơn các bạn', 'chào mừng các bạn', 'video tiếp theo',
  'nhấn like', 'chia sẻ', 'bình luận',
  'chào mừng bạn', 'xin chào',
  // Chinese hallucinations
  '点赞', '订阅', '转发', '打赏', '明镜', '字幕',
  '谢谢观看', '谢谢大家', '再见', '感谢收看',
  '欢迎', '关注',
  // Hindi / other
  'amara', 'manuval', 'प्रस्तुत्र',
  // Technical noise
  'http', 'www', '.com', '.org', '.net',
  // Misc Vietnamese noise words
  'điểm điểm', 'minh kính', 'phẩy.', 'chấm.',
];

export async function POST(request) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');
    const apiKey = formData.get('apiKey') || process.env.OPENAI_API_KEY || '';

    if (!audioFile) return NextResponse.json({ error: 'No audio file' }, { status: 400 });
    if (!apiKey) return NextResponse.json({ error: 'No API key.' }, { status: 400 });

    const whisperForm = new FormData();
    const originalName = audioFile.name || 'audio.webm';
    const ext = originalName.split('.').pop() || 'webm';
    whisperForm.append('file', audioFile, `audio.${ext}`);
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('temperature', '0.0');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: whisperForm,
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: 'Whisper API failed', detail: err }, { status: res.status });
    }

    const data = await res.json();
    let text = (data.text || '').trim();
    const detectedLang = data.language ? data.language.toLowerCase() : '';

    // ========== BỘ LỌC 1: KHÓA NGÔN NGỮ ==========
    // Nếu Whisper phát hiện ngôn ngữ KHÔNG phải Tiếng Việt hoặc Tiếng Trung → chặn ngay
    if (detectedLang && !ALLOWED_LANGS.includes(detectedLang)) {
      console.log(`🚫 [Whisper Filter] Blocked language: "${detectedLang}" — text: "${text}"`);
      return NextResponse.json({ text: '', language: null });
    }

    // ========== BỘ LỌC 2: CHẶN TỪ MA (Hallucination) ==========
    const lowerText = text.toLowerCase();
    if (BAD_PHRASES.some(phrase => lowerText.includes(phrase))) {
      console.log(`🚫 [Whisper Filter] Blocked hallucination: "${text}"`);
      return NextResponse.json({ text: '', language: null });
    }

    // ========== BỘ LỌC 3: VĂN BẢN QUÁ NGẮN (≤ 2 ký tự) ==========
    // Các ký tự đơn lẻ hoặc tiếng "ừm", "ờ" thường là nhiễu
    if (text.length <= 2) {
      console.log(`🚫 [Whisper Filter] Blocked too-short text: "${text}"`);
      return NextResponse.json({ text: '', language: null });
    }

    // ========== BỘ LỌC 4: VĂN BẢN RỖNG ==========
    if (!text) {
      return NextResponse.json({ text: '', language: null });
    }

    return NextResponse.json({ text, language: data.language || null });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}