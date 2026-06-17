'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

// Bản đồ phát hiện ngôn ngữ tự động (fallback)
const CJK_CHARS = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const VIET_DIACRITICS = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/;

function detectLangFromText(text, srcLang = 'zh', tgtLang = 'vi') {
  if (!text) return null;
  const hasViet = VIET_DIACRITICS.test(text);
  const hasCJK = CJK_CHARS.test(text);

  if (hasViet) return 'vi';
  if (hasCJK) return 'zh';

  // Context-aware Latin detection:
  if (/[a-zA-Z]/.test(text)) {
    if (srcLang === 'vi' || tgtLang === 'vi') return 'vi';
    return 'en';
  }
  return null;
}

// Tránh lặp từ do cơ chế thu âm liên tục hoặc restart của trình duyệt di động
function mergeOverlap(a, b) {
  a = a.trim();
  b = b.trim();
  if (!a) return b;
  if (!b) return a;

  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);

  const clean = (w) => w.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");
  const aClean = aWords.map(clean);
  const bClean = bWords.map(clean);

  let bestOverlap = {
    aStart: -1,
    bStart: -1,
    length: 0,
    totalLen: 0
  };

  // Quét qua các vị trí trong chuỗi a để tìm vùng khớp tốt nhất với chuỗi b
  for (let i = 0; i < aWords.length; i++) {
    let matchCount = 0;
    let len = 0;
    
    while (i + len < aWords.length && len < bWords.length) {
      if (aClean[i + len] === bClean[len]) {
        matchCount++;
      }
      len++;
    }
    
    // Tỷ lệ khớp từ 70% trở lên và khớp tối thiểu 2 từ để tránh trùng hợp ngẫu nhiên
    const matchRate = len > 0 ? matchCount / len : 0;
    if (matchRate > 0.7 && matchCount >= 2) {
      if (matchCount > bestOverlap.length) {
        bestOverlap = {
          aStart: i,
          bStart: 0,
          length: matchCount,
          totalLen: len
        };
      }
    }
  }

  if (bestOverlap.length >= 2) {
    const aPrefix = aWords.slice(0, bestOverlap.aStart).join(' ');
    const aSuffix = aWords.slice(bestOverlap.aStart + bestOverlap.totalLen).join(' ');
    
    let result = '';
    if (aPrefix) result += aPrefix + ' ';
    result += b;
    if (aSuffix) result += ' ' + aSuffix;
    return result;
  }

  // Phương án dự phòng: nếu không tìm thấy khớp đáng kể, ghép nối tiếp thông thường
  return a + ' ' + b;
}

/**
 * useQuickConversation — Hook Giao Tiếp Nhanh sử dụng Web Speech API native
 *
 * Tối ưu hóa cực hạn về tốc độ và loại bỏ hoàn toàn Cold-Start latency (<50ms).
 */
export default function useQuickConversation({
  srcLangCode, // 'zh'
  tgtLangCode, // 'vi'
  engine = 'openai',
  silenceMs = 1200, // Im lặng 1.2s là dịch ngay
  micMode = 'hold', // 'hold' | 'click'
  autoTTS = true,
  provider = 'azure', // 'azure' | 'elevenlabs'
  speed = 1.0,        // Tốc độ phát giọng nói
  onInterimText,
  onFinalResult,
  onStatusChange,
  onError,
  getVoiceForLang,
}) {
  const [isListening, setIsListening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeLang, setActiveLang] = useState(null);

  const recognitionRef = useRef(null);
  const startTimeRef = useRef(0);
  const elapsedTimerRef = useRef(null);

  const isSpeakingRef = useRef(false);
  const wantListeningRef = useRef(false);
  const inputLangRef = useRef(null);
  const currentAudioRef = useRef(null);
  const currentAudioUrlRef = useRef(null);

  const accumulatedTextRef = useRef('');
  const currentInterimRef = useRef('');
  const prevSessionsTextRef = useRef('');
  const silenceTimeoutRef = useRef(null);
  const isFinalFiredRef = useRef(false); // Đánh dấu đã nhận được kết quả isFinal cuối cùng
  const pendingResolveRef = useRef(null); // Resolve promise khi nhận được isFinal
  const isMicRunningRef = useRef(false);

  const conversationHistoryRef = useRef([]);
  const msgIdRef = useRef(Date.now());

  // Stable refs để tránh re-render đóng/mở mic
  const srcLangCodeRef = useRef(srcLangCode);
  const tgtLangCodeRef = useRef(tgtLangCode);
  const onFinalResultRef = useRef(onFinalResult);
  const onStatusChangeRef = useRef(onStatusChange);
  const onErrorRef = useRef(onError);
  const onInterimTextRef = useRef(onInterimText);
  const engineRef = useRef(engine);
  const silenceMsRef = useRef(silenceMs);
  const getVoiceForLangRef = useRef(getVoiceForLang);
  const micModeRef = useRef(micMode);
  const autoTTSRef = useRef(autoTTS);
  const providerRef = useRef(provider);
  const speedRef = useRef(speed);

  // Update refs synchronously during render to completely bypass React scheduling lags
  srcLangCodeRef.current = srcLangCode;
  tgtLangCodeRef.current = tgtLangCode;
  onFinalResultRef.current = onFinalResult;
  onStatusChangeRef.current = onStatusChange;
  onErrorRef.current = onError;
  onInterimTextRef.current = onInterimText;
  engineRef.current = engine;
  silenceMsRef.current = silenceMs;
  getVoiceForLangRef.current = getVoiceForLang;
  micModeRef.current = micMode;
  autoTTSRef.current = autoTTS;
  providerRef.current = provider;
  speedRef.current = speed;

  // Khởi tạo Audio Element dùng chung để tránh block autoplay trên di động
  const getOrCreateTtsAudio = useCallback(() => {
    if (typeof window === 'undefined') return null;
    if (!currentAudioRef.current) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playsInline = true;
      try {
        audio.setAttribute('playsinline', 'true');
        audio.setAttribute('webkit-playsinline', 'true');
      } catch (e) { /* ignore */ }
      currentAudioRef.current = audio;
    }
    return currentAudioRef.current;
  }, []);

  const releaseCurrentAudioUrl = useCallback(() => {
    if (!currentAudioUrlRef.current) return;
    try { URL.revokeObjectURL(currentAudioUrlRef.current); } catch (e) { /* ignore */ }
    currentAudioUrlRef.current = null;
  }, []);

  // ====== PIPELINE: Dịch thuật & Phát loa siêu tốc ======
  const triggerTranslation = useCallback(async (forcedText = '') => {
    let text = forcedText || accumulatedTextRef.current.trim();
    const interim = currentInterimRef.current.trim();
    if (!forcedText && interim) {
      text = mergeOverlap(text, interim);
    }
    if (!text) return;

    // Chuẩn hóa văn bản, lọc từ thừa
    text = text.replace(/(?<=^|\s|[.,!?])(ừm|ờ|à|ơi|ơ)(?=\s|[.,!?]|$)/gi, '');
    text = text.replace(/\b(uh|um|er|erm)\b/gi, '');
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Bộ lọc tiếng ồn giả định
    const noiseWords = ['phẩy.', 'chấm.', 'phẩy', 'chấm', 'hỏi.', 'hỏi', 'comma', 'period'];
    const cleanLower = text.replace(/[.,!?;:]+$/g, '').trim().toLowerCase();
    if (noiseWords.includes(cleanLower) || /^[.,!?;:\s]+$/.test(text)) {
      console.log(`🚫 [Noise Filter] Bỏ qua âm thanh nhiễu: "${text}"`);
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      return;
    }

    // Xác định ngôn ngữ nguồn và đích
    const textLang = detectLangFromText(text, srcLangCodeRef.current, tgtLangCodeRef.current) || inputLangRef.current;
    const fromLang = textLang;
    const toLang = fromLang === srcLangCodeRef.current
      ? tgtLangCodeRef.current
      : srcLangCodeRef.current;

    console.log(`🔄 [Fast Translate] Dịch: "${text}" (${fromLang} → ${toLang})`);

    // Khóa mic tạm thời để tránh Echo Loop
    isSpeakingRef.current = true;
    if (onStatusChangeRef.current) onStatusChangeRef.current('translating');

    // Tắt nhanh Web Speech API để rảnh mic cho TTS
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onstart = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.abort();
      } catch (e) { /* ignore */ }
      recognitionRef.current = null;
    }

    const translateController = new AbortController();
    const translateTimeout = setTimeout(() => {
      console.warn('⚠️ [Translate Timeout] Aborting fetch/stream after 15 seconds.');
      translateController.abort();
    }, 15000);

    try {
      // 1. Gọi API Translate (Streaming SSE để nhận chữ siêu tốc)
      const translateRes = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          sourceLang: fromLang,
          targetLang: toLang,
          engine: engineRef.current,
          history: conversationHistoryRef.current,
          stream: true,
        }),
        signal: translateController.signal,
      });

      if (!translateRes.ok) throw new Error(`Lỗi dịch thuật: ${translateRes.status}`);

      const reader = translateRes.body.getReader();
      const decoder = new TextDecoder();
      let translatedText = '';
      let buffer = '';
      let streamDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') { streamDone = true; break; }
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) translatedText += parsed.text;
          } catch (e) { /* ignore */ }
        }
        if (streamDone) break;
      }
      clearTimeout(translateTimeout);

      translatedText = translatedText.trim();
      if (!translatedText) throw new Error('Bản dịch rỗng');

      console.log(`✅ [Translate Done] Bản dịch: "${translatedText}"`);

      const id = ++msgIdRef.current;
      if (onFinalResultRef.current) {
        onFinalResultRef.current({ id, originalText: text, translatedText, fromLang, toLang });
      }

      // Lưu trữ hội thoại làm ngữ cảnh
      conversationHistoryRef.current.push(
        { role: 'user', content: text },
        { role: 'assistant', content: translatedText }
      );
      if (conversationHistoryRef.current.length > 8) {
        conversationHistoryRef.current = conversationHistoryRef.current.slice(-8);
      }

      // 2. Phát âm thanh TTS (Nếu autoTTS bật)
      if (autoTTSRef.current) {
        const voiceId = getVoiceForLangRef.current ? getVoiceForLangRef.current(toLang) : null;

        if (voiceId === '__MUTED__') {
          console.log(`🔇 [TTS] Bỏ qua phát âm vì loa ${toLang} đang tắt.`);
        } else {
          if (onStatusChangeRef.current) onStatusChangeRef.current('speaking');

          const ttsRes = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: translatedText,
              lang: toLang,
              voice: voiceId,
              provider: providerRef.current,
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (ttsRes.ok) {
            const blob = await ttsRes.blob();
            if (blob.size > 0) {
              const url = URL.createObjectURL(blob);
              const audio = getOrCreateTtsAudio();
              if (audio) {
                releaseCurrentAudioUrl();
                currentAudioUrlRef.current = url;
                audio.src = url;
                audio.currentTime = 0;
                audio.load();

                await new Promise(resolve => {
                  let resolved = false;
                  const done = () => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(safetyTimeout);
                    audio.onended = null;
                    audio.onerror = null;
                    audio.onloadedmetadata = null;
                    if (currentAudioUrlRef.current === url) {
                      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
                      currentAudioUrlRef.current = null;
                    }
                    resolve();
                  };

                  audio.onended = done;
                  audio.onerror = done;
                  // Tính toán thời gian timeout an toàn động dựa trên độ dài của văn bản dịch (tối thiểu 15s, tối đa 120s)
                  const timeoutMs = Math.min(120000, Math.max(15000, translatedText.length * 150));
                  const safetyTimeout = setTimeout(() => {
                    console.warn(`⚠️ [TTS Timeout] Force resolve phát âm sau ${timeoutMs}ms.`);
                    try { audio.pause(); } catch (e) { /* ignore */ }
                    done();
                  }, timeoutMs);

                  // Áp dụng tốc độ phát giọng nói (Speech Rate)
                  try {
                    audio.defaultPlaybackRate = speedRef.current;
                    audio.playbackRate = speedRef.current;
                  } catch (e) {
                    console.warn('⚠️ Gán playbackRate lỗi:', e);
                  }

                  audio.play().catch(() => done());
                });
              }
            }
          }
        }
      }
    } catch (err) {
      clearTimeout(translateTimeout);
      console.error('❌ [Pipeline Lỗi]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
    }

    // Giải phóng & Chuẩn bị cho câu tiếp theo
    accumulatedTextRef.current = '';
    currentInterimRef.current = '';
    isSpeakingRef.current = false;
    if (onInterimTextRef.current) onInterimTextRef.current('');

    // Nếu ở chế độ Hold (Nhấn giữ), mic sẽ tắt hẳn sau khi phát loa.
    // Nếu ở chế độ Click, mic cũng sẽ tắt sau mỗi câu để người dùng bấm nói câu kế tiếp.
    wantListeningRef.current = false;
    clearInterval(elapsedTimerRef.current);
    setIsListening(false);
    setActiveLang(null);
    if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
  }, [getOrCreateTtsAudio, releaseCurrentAudioUrl]);

  // ====== Quản lý hẹn giờ Im lặng (Click Mode) ======
  const resetSilenceTimer = useCallback(() => {
    clearTimeout(silenceTimeoutRef.current);
    if (isSpeakingRef.current) return;
    if (micModeRef.current === 'hold') return; // Chế độ nhấn giữ không dùng silence timer

    const timeout = silenceMsRef.current || 1200;
    silenceTimeoutRef.current = setTimeout(() => {
      console.log(`⏰ [Fast Silence] Phát hiện im lặng sau ${timeout}ms → Dừng & Dịch!`);
      stop();
    }, timeout);
  }, []);

  // ====== Setup Web Speech API ======
  const setupSpeechRecognition = useCallback((inputLang) => {
    if (typeof window === 'undefined') return null;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('Trình duyệt của bạn không hỗ trợ Web Speech API. Hãy dùng Google Chrome.');
    }

    prevSessionsTextRef.current = accumulatedTextRef.current;

    const rec = new SpeechRecognition();
    rec.continuous = true; // Thu âm liên tục để có interim chạy mượt mà
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Map mã ngôn ngữ
    const langMap = { zh: 'zh-CN', vi: 'vi-VN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };
    rec.lang = langMap[inputLang] || inputLang;

    rec.onstart = () => {
      console.log('🟢 [Web Speech native] Đã mở Micro.');
      isMicRunningRef.current = true;
      if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
    };

    rec.onresult = (e) => {
      if (isSpeakingRef.current) return;
      isFinalFiredRef.current = false;

      let sessionFinalText = '';
      let sessionInterimText = '';
      let hasNewFinal = false;

      for (let i = 0; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) {
          if (i >= e.resultIndex) {
            hasNewFinal = true;
          }
          if (!sessionFinalText) {
            sessionFinalText = transcript;
          } else {
            const cleanAcc = sessionFinalText.trim().toLowerCase();
            const cleanTrans = transcript.toLowerCase();
            if (cleanTrans.startsWith(cleanAcc)) {
              sessionFinalText = transcript;
            } else {
              sessionFinalText += ' ' + transcript;
            }
          }
        } else {
          if (!sessionInterimText) {
            sessionInterimText = transcript;
          } else {
            const cleanInt = sessionInterimText.trim().toLowerCase();
            const cleanTrans = transcript.toLowerCase();
            if (cleanTrans.startsWith(cleanInt)) {
              sessionInterimText = transcript;
            } else {
              sessionInterimText += ' ' + transcript;
            }
          }
        }
      }

      // Ghép văn bản của phiên hiện tại vào văn bản tích lũy của các phiên trước
      const prev = prevSessionsTextRef.current || '';
      accumulatedTextRef.current = mergeOverlap(prev, sessionFinalText);
      currentInterimRef.current = sessionInterimText;

      if (hasNewFinal) {
        isFinalFiredRef.current = true;
        
        // Giải quyết hàng đợi chờ isFinal
        if (pendingResolveRef.current) {
          pendingResolveRef.current();
          pendingResolveRef.current = null;
        }
      }

      const display = mergeOverlap(accumulatedTextRef.current, sessionInterimText).trim();
      if (onInterimTextRef.current) onInterimTextRef.current(display);

      resetSilenceTimer();
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.error(`❌ [Web Speech Lỗi]`, e.error);
      if (onErrorRef.current) onErrorRef.current(`Micro: ${e.error}`);
    };

    rec.onend = () => {
      console.log('🔴 [Web Speech native] Đã đóng Micro.');
      isMicRunningRef.current = false;
      if (wantListeningRef.current && !isSpeakingRef.current) {
        setTimeout(() => {
          if (wantListeningRef.current && !isSpeakingRef.current && !isMicRunningRef.current) {
            try {
              setupSpeechRecognition(inputLangRef.current);
              console.log('🔄 [Web Speech native] Restarted safely after 150ms delay');
            } catch (_) { /* ignore */ }
          }
        }, 150);
      }
    };

    recognitionRef.current = rec;
    rec.start();
    return rec;
  }, []);

  // ====== BẮT ĐẦU NÓI (start) ======
  const start = useCallback(async (inputLang) => {
    try {
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      prevSessionsTextRef.current = '';
      isSpeakingRef.current = false;
      isFinalFiredRef.current = false;
      pendingResolveRef.current = null;
      inputLangRef.current = inputLang;
      conversationHistoryRef.current = [];
      msgIdRef.current = Date.now();

      getOrCreateTtsAudio();

      wantListeningRef.current = true;
      setIsListening(true);
      setActiveLang(inputLang);
      setElapsed(0);
      startTimeRef.current = Date.now();
      
      elapsedTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      if (onStatusChangeRef.current) onStatusChangeRef.current('connecting');

      setupSpeechRecognition(inputLang);

    } catch (err) {
      console.error('❌ [Start Lỗi]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
      wantListeningRef.current = false;
      setIsListening(false);
    }
  }, [setupSpeechRecognition, getOrCreateTtsAudio]);

  // ====== DỪNG NÓI (stop) ======
  const stop = useCallback(async () => {
    console.log('🛑 [Quick Speech] Dừng thu âm...');
    wantListeningRef.current = false;
    clearTimeout(silenceTimeoutRef.current);
    clearInterval(elapsedTimerRef.current);

    // Đặt trạng thái nghe là false ngay lập tức để UI phản hồi nhạy bén (không trễ)
    setIsListening(false);

    // Nếu ở chế độ nhấn giữ (Hold-to-Talk), trì hoãn đóng mic 600ms để thu trọn vẹn từ cuối cùng
    if (micModeRef.current === 'hold') {
      await new Promise(resolve => setTimeout(resolve, 600));
    }

    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch (_) { }
    }

    // Đợi 150ms siêu ngắn để Web Speech trả nốt kết quả isFinal cuối cùng
    // Điều này đảm bảo từ cuối cùng người dùng nói trước khi nhả tay/hoặc ngắt luôn được bắt trọn 100%
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 150);
      
      if (!currentInterimRef.current.trim()) {
        clearTimeout(timeout);
        resolve();
      } else {
        pendingResolveRef.current = () => {
          clearTimeout(timeout);
          resolve();
        };
      }
    });

    const hasText = accumulatedTextRef.current.trim() || currentInterimRef.current.trim();
    if (hasText && !isSpeakingRef.current) {
      triggerTranslation();
    } else {
      setActiveLang(null);
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    }
  }, [triggerTranslation]);

  // ====== TẮT LOA PHÁT (stopSpeaking) ======
  const stopSpeaking = useCallback(() => {
    console.log('🔇 [Quick Speech] Dừng phát loa');
    if (currentAudioRef.current) {
      const audio = currentAudioRef.current;
      try { audio.pause(); audio.currentTime = 0; } catch (e) { /* ignore */ }
    }
    wantListeningRef.current = false;
    clearInterval(elapsedTimerRef.current);
    setIsListening(false);
    setActiveLang(null);
    if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
  }, []);

  // Cleanup khi unmount
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearTimeout(silenceTimeoutRef.current);
      clearInterval(elapsedTimerRef.current);
      if (currentAudioRef.current) {
        try {
          currentAudioRef.current.pause();
          currentAudioRef.current.removeAttribute('src');
          currentAudioRef.current.load();
        } catch (e) { /* ignore */ }
        currentAudioRef.current = null;
      }
      if (currentAudioUrlRef.current) {
        try { URL.revokeObjectURL(currentAudioUrlRef.current); } catch (e) { /* ignore */ }
        currentAudioUrlRef.current = null;
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onstart = null;
          recognitionRef.current.onresult = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.onend = null;
          recognitionRef.current.abort();
        } catch (e) { /* ignore */ }
        recognitionRef.current = null;
      }
    };
  }, []);

  const supported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  return {
    isListening,
    elapsed,
    activeLang,
    start,
    stop,
    stopSpeaking,
    isSpeaking: isSpeakingRef,
    supported,
  };
}
