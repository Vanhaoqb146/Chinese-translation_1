'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

// Bản đồ mã ngôn ngữ Whisper → mã dùng trong app
const WHISPER_LANG_MAP = {
  chinese: 'zh', mandarin: 'zh', vietnamese: 'vi',
  english: 'en', japanese: 'ja', korean: 'ko',
};

// Thời lượng tối thiểu (ms) để gửi Whisper — tránh gửi tiếng click chuột
const MIN_RECORD_DURATION = 600;

/**
 * useManualConversation — Hook Push-to-Talk (Bộ đàm)
 *
 * Sử dụng MediaRecorder API, kích hoạt hoàn toàn bằng UI events.
 * Không có VAD, không ScriptProcessorNode, không cold-start.
 *
 * @param {Object} config
 * @param {string} config.apiKey        — OpenAI API key
 * @param {string} config.engine        — 'openai' | 'deepseek'
 * @param {Function} config.onTranscribed — ({ originalText, detectedLang, fromLang, toLang, id }) => void
 * @param {Function} config.onResult      — ({ originalText, translatedText, detectedLang, fromLang, toLang, id }) => Promise
 * @param {Function} config.onError       — (message: string) => void
 */
export default function useManualConversation({
  apiKey,
  engine,
  onTranscribed,
  onResult,
  onError,
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Refs nội bộ
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startTimeRef = useRef(0);
  const elapsedTimerRef = useRef(null);
  const conversationHistoryRef = useRef([]);

  // Lưu lại ngôn ngữ đích để xử lý trong callbacks
  const activeLangRef = useRef({ fromLang: null, toLang: null });

  /**
   * Gửi audio blob → Whisper → Translate → gọi callbacks
   */
  const processAudio = useCallback(async (audioBlob) => {
    setIsProcessing(true);

    try {
      // ===== BƯỚC 1: Whisper STT =====
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');
      formData.append('apiKey', apiKey);

      const whisperRes = await fetch('/api/whisper', { method: 'POST', body: formData });
      const whisperData = await whisperRes.json();

      if (!whisperRes.ok) {
        throw new Error(whisperData.error || whisperData.detail || 'Whisper API failed');
      }

      if (!whisperData.text || whisperData.text.trim().length === 0) {
        // Whisper trả về rỗng (không nhận diện được gì) → bỏ qua yên lặng
        return;
      }

      const text = whisperData.text.trim();
      const detectedLang = whisperData.language ? whisperData.language.toLowerCase() : null;
      const langCode = detectedLang ? (WHISPER_LANG_MAP[detectedLang] || detectedLang) : null;

      // Xác định chiều dịch dựa trên ngôn ngữ được phát hiện
      const { fromLang: hintFrom, toLang: hintTo } = activeLangRef.current;
      let fromLang = hintFrom;
      let toLang = hintTo;

      // Nếu Whisper phát hiện ngôn ngữ khác với hint → dùng kết quả Whisper
      if (langCode && langCode !== hintFrom) {
        fromLang = langCode;
        // toLang giữ nguyên
      }

      const recordId = Date.now();
      if (onTranscribed) {
        onTranscribed({ originalText: text, detectedLang: langCode, fromLang, toLang, id: recordId });
      }

      // ===== BƯỚC 2: GPT Translation =====
      const translateRes = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          sourceLang: fromLang,
          targetLang: toLang,
          apiKey,
          engine: engine || 'openai',
          history: conversationHistoryRef.current,
        }),
      });

      const translateData = await translateRes.json();
      const translated = translateData.translation || text;

      // Cập nhật lịch sử hội thoại để GPT có ngữ cảnh
      conversationHistoryRef.current.push({ role: 'user', content: text });
      conversationHistoryRef.current.push({ role: 'assistant', content: translated });
      if (conversationHistoryRef.current.length > 6) {
        conversationHistoryRef.current = conversationHistoryRef.current.slice(-6);
      }

      if (onResult) {
        await onResult({
          originalText: text,
          translatedText: translated,
          detectedLang: langCode,
          fromLang,
          toLang,
          id: recordId,
        });
      }
    } catch (err) {
      if (onError) onError('Lỗi: ' + err.message);
    } finally {
      setIsProcessing(false);
    }
  }, [apiKey, engine, onTranscribed, onResult, onError]);

  /**
   * BẮT ĐẦU GHI ÂM — Gọi từ onMouseDown / onTouchStart
   *
   * @param {string} fromLang — mã ngôn ngữ nguồn (ví dụ: 'zh')
   * @param {string} toLang   — mã ngôn ngữ đích (ví dụ: 'vi')
   */
  const startRecording = useCallback(async (fromLang, toLang) => {
    // Lưu chiều dịch
    activeLangRef.current = { fromLang, toLang };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Chọn MIME type phù hợp với trình duyệt
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        // Kiểm tra thời lượng tối thiểu
        const duration = Date.now() - startTimeRef.current;
        if (duration < MIN_RECORD_DURATION) {
          if (onError) onError('⚡ Thu âm quá ngắn — hãy giữ nút lâu hơn!');
          cleanupStream();
          return;
        }

        // Đóng gói audio blob
        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          processAudio(blob);
        }

        cleanupStream();
      };

      // Bắt đầu thu — timeslice 250ms để có chunks liên tục
      recorder.start(250);
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setElapsed(0);

      // Đồng hồ đếm giây
      elapsedTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

    } catch (err) {
      if (onError) onError('Không thể truy cập microphone: ' + err.message);
    }
  }, [processAudio, onError]);

  /**
   * DỪNG GHI ÂM — Gọi từ onMouseUp / onTouchEnd / onMouseLeave / onTouchCancel
   */
  const stopRecording = useCallback(() => {
    clearInterval(elapsedTimerRef.current);
    setIsRecording(false);

    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop(); // → Sẽ gọi recorder.onstop → processAudio
    } else {
      cleanupStream();
    }
  }, []);

  /**
   * Xóa lịch sử hội thoại (khi bắt đầu phiên mới)
   */
  const clearHistory = useCallback(() => {
    conversationHistoryRef.current = [];
  }, []);

  /**
   * Giải phóng MediaStream tracks
   */
  const cleanupStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  // Cleanup khi unmount
  useEffect(() => {
    return () => {
      clearInterval(elapsedTimerRef.current);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      cleanupStream();
    };
  }, []);

  return {
    isRecording,
    isProcessing,
    elapsed,
    startRecording,
    stopRecording,
    clearHistory,
  };
}
