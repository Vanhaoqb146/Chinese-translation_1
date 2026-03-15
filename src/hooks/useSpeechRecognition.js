'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

const KEEPALIVE_TIMEOUT = 8000;
const KEEPALIVE_CHECK = 3000;
const AUTO_FLUSH_DELAY = 2000; // Tự động dịch sau 2 giây im lặng

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

  // Đếm số lượng isFinal results đã được commit (đã gửi qua onResult)
  // Khi recognition restart, event.results bắt đầu lại từ 0,
  // nhưng committedCount reset để tránh trùng lặp
  const committedCountRef = useRef(0);
  // Buffer tạm: thành phần isFinal chưa commit trong phiên recognition hiện tại
  const pendingFinalRef = useRef('');
  // Timer tự động flush sau khi ngừng nói
  const autoFlushTimerRef = useRef(null);

  // Callback refs để tránh stale closures
  const onResultRef = useRef(onResult);
  const onInterimRef = useRef(onInterim);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);

  // Flush pending finals: gửi text chưa commit qua onResult, reset counter
  const flushPending = useCallback(() => {
    clearTimeout(autoFlushTimerRef.current);
    const text = pendingFinalRef.current.trim();
    if (text && onResultRef.current) {
      onResultRef.current(text);
    }
    pendingFinalRef.current = '';
    committedCountRef.current = 0;

    // Sau khi flush, restart recognition để reset event.results
    // (tránh event.results cũ chứa text đã commit → hiển thị lại)
    if (wantRecording.current && recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch (_) {}
      // onend sẽ tự restart vì wantRecording=true
    }
  }, []);

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
      // Reset tracking cho phiên recognition mới
      committedCountRef.current = 0;
      pendingFinalRef.current = '';
      setIsRecording(true);
    };

    rec.onresult = (event) => {
      lastResultTime.current = Date.now();

      // Đếm số isFinal results trong event.results hiện tại
      let newFinal = '';
      let currentInterim = '';
      let finalCount = 0;

      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) {
          finalCount++;
          // Chỉ lấy các isFinal MỚI (chưa commit)
          if (finalCount > committedCountRef.current) {
            newFinal += transcript + ' ';
          }
        } else {
          currentInterim += transcript + ' ';
        }
      }

      // Cập nhật pending buffer với text mới
      if (newFinal) {
        pendingFinalRef.current += newFinal;
      }

      // Hiển thị UI: pending (chưa commit) + interim
      const displayText = (pendingFinalRef.current + currentInterim).trim();
      if (onInterimRef.current) onInterimRef.current(displayText || '');

      // [AUTO-FLUSH] Reset timer mỗi khi có kết quả mới
      // Nếu có isFinal mới, sau AUTO_FLUSH_DELAY giây im lặng sẽ tự động flush
      if (newFinal) {
        clearTimeout(autoFlushTimerRef.current);
        autoFlushTimerRef.current = setTimeout(() => {
          if (pendingFinalRef.current.trim()) {
            flushPending();
            // Xóa interim text sau khi đã commit
            if (onInterimRef.current) onInterimRef.current('');
          }
        }, AUTO_FLUSH_DELAY);
      }
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
        // event.results sẽ reset khi tạo instance mới
        // committedCountRef cũng đã reset trong onstart
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
  }, [lang, onError, flushPending]);

  const start = useCallback(() => {
    wantRecording.current = true;
    restartCount.current = 0;
    startTime.current = Date.now();
    lastResultTime.current = Date.now();
    committedCountRef.current = 0;
    pendingFinalRef.current = '';
    clearTimeout(autoFlushTimerRef.current);
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
    clearTimeout(autoFlushTimerRef.current);
    try { if (recognitionRef.current) recognitionRef.current.stop(); } catch (_) {}
    setIsRecording(false);

    // Flush toàn bộ pending text khi dừng mic thủ công
    const finalText = pendingFinalRef.current.trim();
    pendingFinalRef.current = '';
    committedCountRef.current = 0;
    if (finalText && onResultRef.current) {
      onResultRef.current(finalText);
    }
  }, []);

  const abort = useCallback(() => {
    wantRecording.current = false;
    clearInterval(timerRef.current);
    clearInterval(keepAliveRef.current);
    clearTimeout(autoFlushTimerRef.current);
    try { if (recognitionRef.current) recognitionRef.current.abort(); } catch (_) {}
    setIsRecording(false);
    pendingFinalRef.current = '';
    committedCountRef.current = 0;
  }, []);

  useEffect(() => {
    return () => {
      wantRecording.current = false;
      clearInterval(timerRef.current);
      clearInterval(keepAliveRef.current);
      clearTimeout(autoFlushTimerRef.current);
      try { if (recognitionRef.current) recognitionRef.current.stop(); } catch (_) {}
    };
  }, []);

  const supported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  return { isRecording, elapsed, start, stop, abort, supported };
}
