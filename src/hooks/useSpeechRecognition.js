'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

const KEEPALIVE_TIMEOUT = 8000;
const KEEPALIVE_CHECK = 3000;

export default function useSpeechRecognition({ lang = 'zh-CN', onResult, onInterim, onError }) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const wantRecording = useRef(false);
  const recognitionRef = useRef(null);
  const lastResultTime = useRef(0);
  const startTime = useRef(0);
  const timerRef = useRef(null);
  const keepAliveRef = useRef(null);
  const restartCount = useRef(0);

  // Session buffer: chứa toàn bộ text đã committed (isFinal) trong phiên hiện tại.
  // Chỉ flush qua onResult khi user nhấn "Dừng".
  const sessionBufferRef = useRef('');

  const createRecognition = useCallback(() => {
    if (typeof window === 'undefined') return null;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      lastResultTime.current = Date.now();
      setIsRecording(true);
    };

    rec.onresult = (event) => {
      lastResultTime.current = Date.now();

      // [FIX] Rebuild final + interim từ TOÀN BỘ event.results (index 0 → length)
      // Web Speech API giữ lại mọi results cũ trong mảng khi continuous=true.
      // KHÔNG dùng event.resultIndex để append — sẽ gây lặp trùng.
      let allFinal = '';
      let currentInterim = '';

      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) {
          allFinal += transcript + ' ';
        } else {
          currentInterim += transcript + ' ';
        }
      }

      // Cập nhật session buffer = tất cả text đã isFinal (rebuild mỗi lần, không append)
      sessionBufferRef.current = allFinal;

      // Hiển thị UI: toàn bộ final đã tích lũy + đoạn interim đang gõ
      const displayText = (allFinal + currentInterim).trim();
      if (onInterim) onInterim(displayText || '');
    };

    rec.onerror = (event) => {
      if (onError) onError(event.error);
      if (event.error === 'not-allowed' || event.error === 'audio-capture') {
        wantRecording.current = false;
        setIsRecording(false);
      }
    };

    rec.onend = () => {
      setIsRecording(false);
      if (wantRecording.current) {
        restartCount.current++;
        try {
          recognitionRef.current = createRecognition();
          if (recognitionRef.current) recognitionRef.current.start();
        } catch (e) {
          setTimeout(() => {
            if (wantRecording.current) {
              try {
                recognitionRef.current = createRecognition();
                if (recognitionRef.current) recognitionRef.current.start();
              } catch (_) {}
            }
          }, 200);
        }
      }
    };

    return rec;
  }, [lang, onInterim, onError]);

  const start = useCallback(() => {
    wantRecording.current = true;
    restartCount.current = 0;
    startTime.current = Date.now();
    lastResultTime.current = Date.now();
    sessionBufferRef.current = '';
    setElapsed(0);

    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);

    keepAliveRef.current = setInterval(() => {
      if (!wantRecording.current) return;
      if (Date.now() - lastResultTime.current > KEEPALIVE_TIMEOUT && recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch (_) {}
      }
    }, KEEPALIVE_CHECK);

    recognitionRef.current = createRecognition();
    if (recognitionRef.current) {
      recognitionRef.current.start();
    }
  }, [createRecognition]);

  const stop = useCallback(() => {
    wantRecording.current = false;
    clearInterval(timerRef.current);
    clearInterval(keepAliveRef.current);
    try { if (recognitionRef.current) recognitionRef.current.stop(); } catch (_) {}
    setIsRecording(false);

    // Flush toàn bộ session buffer qua onResult khi dừng mic
    const finalText = sessionBufferRef.current.trim();
    sessionBufferRef.current = '';
    if (finalText && onResult) {
      onResult(finalText);
    }
  }, [onResult]);

  const abort = useCallback(() => {
    wantRecording.current = false;
    clearInterval(timerRef.current);
    clearInterval(keepAliveRef.current);
    try { if (recognitionRef.current) recognitionRef.current.abort(); } catch (_) {}
    setIsRecording(false);
    sessionBufferRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      wantRecording.current = false;
      clearInterval(timerRef.current);
      clearInterval(keepAliveRef.current);
      try { if (recognitionRef.current) recognitionRef.current.stop(); } catch (_) {}
    };
  }, []);

  const supported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  return { isRecording, elapsed, start, stop, abort, supported };
}
