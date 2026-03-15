'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * useSpeechRecognition — Hook cho chế độ "Dịch Thuật" (Standard Mode)
 *
 * Logic đơn giản & đáng tin cậy:
 * 1. User bấm "Nói" → bắt đầu nhận diện giọng nói (continuous=false)
 * 2. Hiển thị interimResults real-time khi user nói
 * 3. Khi user ngừng nói → Web Speech API tự động dừng → trả về isFinal
 * 4. Gọi onResult(text) → dịch → TTS
 * 5. Mic tự tắt, user bấm "Nói" để nói câu tiếp
 *
 * KHÔNG dùng continuous=true → Tránh triệt để mọi lỗi lặp/echo
 */
export default function useSpeechRecognition({ lang = 'zh-CN', onResult, onInterim, onError }) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recognitionRef = useRef(null);
  const startTime = useRef(0);
  const timerRef = useRef(null);
  const isActiveRef = useRef(false);

  // Callback refs để tránh stale closures trong recognition callbacks
  const onResultRef = useRef(onResult);
  const onInterimRef = useRef(onInterim);
  const onErrorRef = useRef(onError);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const cleanup = useCallback(() => {
    clearInterval(timerRef.current);
    isActiveRef.current = false;
    setIsRecording(false);
  }, []);

  const start = useCallback(() => {
    if (typeof window === 'undefined') return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    // Dừng phiên cũ nếu có
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch (_) {}
    }

    const rec = new SR();
    rec.continuous = false;      // [KEY] Tự dừng khi user ngừng nói
    rec.interimResults = true;   // Hiển thị real-time
    rec.lang = lang;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setIsRecording(true);
    };

    rec.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) {
          finalText += transcript + ' ';
        } else {
          interimText += transcript + ' ';
        }
      }

      if (finalText.trim()) {
        // Có kết quả cuối cùng → gọi onResult
        if (onInterimRef.current) onInterimRef.current(''); // Xóa interim
        if (onResultRef.current) onResultRef.current(finalText.trim());
      } else if (interimText.trim()) {
        // Chỉ có interim → hiển thị tạm
        if (onInterimRef.current) onInterimRef.current(interimText.trim());
      }
    };

    rec.onerror = (event) => {
      if (onErrorRef.current) onErrorRef.current(event.error);
      // Không cleanup ở đây — onend sẽ lo
    };

    rec.onend = () => {
      // Recognition tự dừng (continuous=false) hoặc bị lỗi
      cleanup();
    };

    recognitionRef.current = rec;
    isActiveRef.current = true;
    startTime.current = Date.now();
    setElapsed(0);

    // Timer đếm giây
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);

    try {
      rec.start();
    } catch (e) {
      cleanup();
      if (onErrorRef.current) onErrorRef.current('start-failed');
    }
  }, [lang, cleanup]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (_) {}
    }
    cleanup();
  }, [cleanup]);

  const abort = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch (_) {}
    }
    cleanup();
    if (onInterimRef.current) onInterimRef.current('');
  }, [cleanup]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch (_) {}
      }
      clearInterval(timerRef.current);
    };
  }, []);

  const supported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  return { isRecording, elapsed, start, stop, abort, supported };
}
