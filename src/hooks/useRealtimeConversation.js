'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * useRealtimeConversation — 4 bước tối ưu (2 nút mic)
 *
 * start(inputLang) → mở WS với language=inputLang
 * BƯỚC 1: Deepgram STT (language cứng) → hiện text gốc
 * BƯỚC 2: 4s im lặng → trigger
 * BƯỚC 3: Khóa mic → REST translate → hiện dịch → TTS
 * BƯỚC 4: TTS xong → dọn dẹp → mở mic → chu trình mới
 */

export default function useRealtimeConversation({
  srcLangCode,
  tgtLangCode,
  engine = 'openai',
  silenceMs = 4000,
  onInterimText,
  onFinalResult,
  onStatusChange,
  onError,
}) {
  const [isListening, setIsListening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeLang, setActiveLang] = useState(null); // Ngôn ngữ đang nghe

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const startTimeRef = useRef(0);
  const elapsedTimerRef = useRef(null);

  const isSpeakingRef = useRef(false);
  const wantListeningRef = useRef(false);
  const inputLangRef = useRef(null);

  const accumulatedTextRef = useRef('');
  const currentInterimRef = useRef('');
  const silenceTimeoutRef = useRef(null);

  const conversationHistoryRef = useRef([]);
  const msgIdRef = useRef(Date.now());

  // Stable refs
  const srcLangCodeRef = useRef(srcLangCode);
  const tgtLangCodeRef = useRef(tgtLangCode);
  const onFinalResultRef = useRef(onFinalResult);
  const onStatusChangeRef = useRef(onStatusChange);
  const onErrorRef = useRef(onError);
  const onInterimTextRef = useRef(onInterimText);
  const engineRef = useRef(engine);
  const silenceMsRef = useRef(silenceMs);

  useEffect(() => {
    srcLangCodeRef.current = srcLangCode;
    tgtLangCodeRef.current = tgtLangCode;
    onFinalResultRef.current = onFinalResult;
    onStatusChangeRef.current = onStatusChange;
    onErrorRef.current = onError;
    onInterimTextRef.current = onInterimText;
    engineRef.current = engine;
    silenceMsRef.current = silenceMs;
  });

  // ====== BƯỚC 2: Silence Timer ======
  const resetSilenceTimer = useCallback(() => {
    clearTimeout(silenceTimeoutRef.current);
    if (isSpeakingRef.current) return;

    const timeout = silenceMsRef.current || 4000;
    silenceTimeoutRef.current = setTimeout(async () => {
      let text = accumulatedTextRef.current.trim();
      if (!text && currentInterimRef.current.trim()) {
        text = currentInterimRef.current.trim();
      }
      if (!text) return;
      console.log(`⏰ [Silence] ${timeout / 1000}s timer fired!`);

      // Xác định chiều dịch từ inputLang
      const fromLang = inputLangRef.current;
      const toLang = fromLang === srcLangCodeRef.current
        ? tgtLangCodeRef.current
        : srcLangCodeRef.current;

      console.log(`⏰ [Silence] "${text.slice(0, 80)}" (${fromLang}→${toLang})`);

      // ====== BƯỚC 3: Khóa mic → Dịch → TTS ======
      isSpeakingRef.current = true;
      if (onStatusChangeRef.current) onStatusChangeRef.current('translating');

      try {
        // 3b. REST translate
        const translateRes = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            sourceLang: fromLang,
            targetLang: toLang,
            engine: engineRef.current,
            history: conversationHistoryRef.current,
          }),
          signal: AbortSignal.timeout(25000),
        });

        if (!translateRes.ok) throw new Error(`Translate error ${translateRes.status}`);
        const { translation: translatedText } = await translateRes.json();
        if (!translatedText) throw new Error('Empty translation');

        console.log(`✅ [Translate] "${translatedText.slice(0, 60)}..."`);

        // 3c. UI + History
        const id = ++msgIdRef.current;
        if (onFinalResultRef.current) {
          onFinalResultRef.current({ id, originalText: text, translatedText, fromLang, toLang });
        }

        conversationHistoryRef.current.push(
          { role: 'user', content: text },
          { role: 'assistant', content: translatedText }
        );
        if (conversationHistoryRef.current.length > 8) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-8);
        }

        // 3d. TTS — Stream play
        if (onStatusChangeRef.current) onStatusChangeRef.current('speaking');

        // KeepAlive giữ WS sống trong lúc TTS
        const sendKeepAlive = () => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        };
        sendKeepAlive();
        const keepAlive = setInterval(sendKeepAlive, 5000);

        try {
          const t0 = performance.now();
          const ttsRes = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: translatedText, lang: toLang }),
            signal: AbortSignal.timeout(30000),
          });

          if (ttsRes.ok) {
            const reader = ttsRes.body.getReader();
            const chunks = [];
            let firstChunkTime = 0;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!firstChunkTime) {
                firstChunkTime = performance.now();
                console.log(`🔊 [TTS] First byte: ${Math.round(firstChunkTime - t0)}ms`);
              }
              chunks.push(value);
            }

            const blob = new Blob(chunks, { type: 'audio/ogg' });
            console.log(`🔊 [TTS] Full: ${blob.size} bytes in ${Math.round(performance.now() - t0)}ms`);

            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.preload = 'auto';

            await new Promise(resolve => {
              audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
              audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
              audio.play().catch(() => resolve());
            });
          }
        } finally {
          clearInterval(keepAlive);
        }
      } catch (err) {
        console.error('❌ [Pipeline]', err);
        if (onErrorRef.current) onErrorRef.current(err.message);
      }

      // ====== BƯỚC 4: Dọn dẹp & Mở mic ======
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      isSpeakingRef.current = false;
      if (onInterimTextRef.current) onInterimTextRef.current('');
      if (wantListeningRef.current && onStatusChangeRef.current) {
        onStatusChangeRef.current('listening');
      }
    }, timeout);
  }, []);

  // ====== BƯỚC 1: Start(inputLang) ======
  const start = useCallback(async (inputLang) => {
    try {
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      isSpeakingRef.current = false;
      inputLangRef.current = inputLang;
      conversationHistoryRef.current = [];
      msgIdRef.current = Date.now();

      console.log(`🔑 [Start] inputLang=${inputLang}`);
      const tokenRes = await fetch('/api/deepgram/token');
      const { key } = await tokenRes.json();
      if (!key) throw new Error('No Deepgram API key');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(audioContext.destination);

      const sampleRate = audioContext.sampleRate;
      console.log(`🎤 [Start] sampleRate=${sampleRate}`);

      // WebSocket với language CỨng — KHÔNG dùng detect_language
      const wsUrl = `wss://api.deepgram.com/v1/listen?` +
        `model=nova-2&language=${inputLang}&smart_format=true&` +
        `interim_results=true&utterance_end_ms=1500&` +
        `encoding=linear16&sample_rate=${sampleRate}&channels=1`;

      console.log(`🌐 [WS] language=${inputLang}`);
      const ws = new WebSocket(wsUrl, ['token', key]);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('🟢 [WS] OPEN');
        wantListeningRef.current = true;
        setIsListening(true);
        setActiveLang(inputLang);
        setElapsed(0);
        startTimeRef.current = Date.now();
        elapsedTimerRef.current = setInterval(() => {
          setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }, 1000);
        if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
      };

      ws.onmessage = (event) => {
        if (isSpeakingRef.current) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type !== 'Results') return;

          const transcript = data.channel?.alternatives?.[0]?.transcript || '';
          const confidence = data.channel?.alternatives?.[0]?.confidence || 0;
          if (!transcript) return;

          const isFinal = data.is_final;
          console.log(`📝 ${isFinal ? 'FINAL' : 'interim'}: "${transcript}" (${confidence.toFixed(2)})`);

          if (isFinal) {
            accumulatedTextRef.current += (accumulatedTextRef.current ? ' ' : '') + transcript;
            currentInterimRef.current = '';
            if (onInterimTextRef.current) onInterimTextRef.current(accumulatedTextRef.current);
          } else {
            currentInterimRef.current = transcript;
            const display = accumulatedTextRef.current +
              (accumulatedTextRef.current ? ' ' : '') + transcript;
            if (onInterimTextRef.current) onInterimTextRef.current(display);
          }

          resetSilenceTimer();
        } catch (err) {
          console.error('❌ [WS] Parse:', err);
        }
      };

      ws.onerror = () => {
        console.error('❌ [WS] Error');
        if (onErrorRef.current) onErrorRef.current('Lỗi kết nối Deepgram');
      };

      ws.onclose = (e) => {
        console.log(`🔴 [WS] Closed: ${e.code}`);
      };

      // Stream audio + Simple VAD
      let n = 0;
      processor.onaudioprocess = (e) => {
        if (!wantListeningRef.current || isSpeakingRef.current) return;
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);

        // Simple VAD: tính RMS energy
        let sumSq = 0;
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          sumSq += input[i] * input[i];
        }
        const rms = Math.sqrt(sumSq / input.length);

        // Nếu có âm thanh (rms > 0.01) VÀ đã có text → reset timer
        // Ngăn timer fire sớm khi Deepgram chưa trả result nhưng user vẫn đang nói
        if (rms > 0.01 && accumulatedTextRef.current.trim()) {
          resetSilenceTimer();
        }

        wsRef.current.send(pcm.buffer);
        if (++n % 100 === 0) console.log(`🎤 ${n} chunks (rms=${rms.toFixed(3)})`);
      };

    } catch (err) {
      console.error('❌ [Start]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
    }
  }, [resetSilenceTimer]);

  // ====== Stop ======
  const stop = useCallback(() => {
    console.log('🛑 Stop');
    wantListeningRef.current = false;
    clearTimeout(silenceTimeoutRef.current);
    clearInterval(elapsedTimerRef.current);

    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close(1000, 'stop');
    wsRef.current = null;
    if (processorRef.current) processorRef.current.disconnect();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioContextRef.current?.state !== 'closed') audioContextRef.current?.close();

    setIsListening(false);
    setActiveLang(null);
    if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
  }, []);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearTimeout(silenceTimeoutRef.current);
      clearInterval(elapsedTimerRef.current);
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
      if (processorRef.current) processorRef.current.disconnect();
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (audioContextRef.current?.state !== 'closed') audioContextRef.current?.close();
    };
  }, []);

  return { isListening, elapsed, activeLang, start, stop };
}
