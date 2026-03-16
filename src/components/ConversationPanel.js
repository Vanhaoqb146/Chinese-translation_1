'use client';
import { useState, useRef, useCallback } from 'react';
import useAutoConversation from '@/hooks/useAutoConversation';

/**
 * ConversationPanel — Giao diện chế độ "Giao tiếp" (Toggle Mic)
 *
 * Click mic để BẮT ĐẦU phiên hội thoại → Nói → Tự động nhận diện khi ngừng nói
 * → Dịch → Phát âm (TTS) → Tắt mic tạm thời khi TTS → Bật lại mic
 * Click mic LẦN NỮA để KẾT THÚC phiên.
 */
export default function ConversationPanel({
  apiKey,
  engine,
  srcLang,
  tgtLang,
  speak,
  findSttCode,
  LANGUAGES,
  history,
  setHistory,
}) {
  const [convStatus, setConvStatus] = useState('idle');
  // idle | listening | processing | speaking
  const [isSpeaking, setIsSpeaking] = useState(false);
  const logBodyRef = useRef(null);
  const autoConvRef = useRef(null);

  // ====== Callbacks cho hook useAutoConversation ======
  const handleTranscribed = useCallback(({ originalText, detectedLang, fromLang, toLang, id }) => {
    setConvStatus('processing');
    setHistory(prev => [{
      source: originalText,
      target: '⏳ Đang dịch...',
      fromLang,
      toLang,
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      id,
    }, ...prev].slice(0, 100));

    setTimeout(() => {
      if (logBodyRef.current) logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }, 50);
  }, []);

  const handleResult = useCallback(async ({ translatedText, toLang, id }) => {
    setHistory(prev => prev.map(item =>
      item.id === id ? { ...item, target: translatedText } : item
    ));

    // Tạm dừng mic → phát TTS → bật lại mic
    const toSttCode = findSttCode(toLang);
    setIsSpeaking(true);
    setConvStatus('speaking');

    // Pause mic trước khi phát TTS để tránh thu tiếng vọng
    if (autoConvRef.current) autoConvRef.current.pause();

    try {
      await speak(translatedText, toSttCode);
    } finally {
      setIsSpeaking(false);
      // Resume mic sau khi TTS xong (nếu phiên vẫn đang active)
      if (autoConvRef.current) autoConvRef.current.resume();
      setConvStatus('listening');
    }
  }, [speak, findSttCode]);

  const handleTranslating = useCallback((isTranslating) => {
    if (isTranslating) {
      setConvStatus('processing');
    } else {
      // [FIX] Khi xử lý xong (kể cả Whisper trả rỗng), phải reset UI về 'listening'
      // Nếu không có else này, UI sẽ bị treo vĩnh viễn ở "Đang xử lý..."
      setConvStatus(prev => prev === 'processing' ? 'listening' : prev);
    }
  }, []);

  const handleError = useCallback((msg) => {
    setConvStatus('idle');
    setIsSpeaking(false);
    console.warn('Conversation Error:', msg);
  }, []);

  // ====== Hook Auto Conversation (VAD-based) ======
  const autoConv = useAutoConversation({
    apiKey,
    engine,
    srcLangCode: srcLang.translateCode,
    tgtLangCode: tgtLang.translateCode,
    onTranscribed: handleTranscribed,
    onResult: handleResult,
    onTranslating: handleTranslating,
    onError: handleError,
  });

  // Lưu ref để pause/resume bên callbacks
  autoConvRef.current = autoConv;

  // ====== Toggle mic: Click 1 lần bật, click lần nữa tắt ======
  const handleToggleMic = useCallback(() => {
    if (isSpeaking) return; // Không cho thao tác khi đang phát TTS

    if (autoConv.isListening) {
      // DỪNG phiên hội thoại
      autoConv.stop();
      setConvStatus('idle');
    } else {
      // BẮT ĐẦU phiên hội thoại
      autoConv.start();
      setConvStatus('listening');
    }
  }, [autoConv, isSpeaking]);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  // ====== Helpers ======
  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const getFlagForLang = (langCode) => {
    const lang = LANGUAGES.find(l => l.translateCode === langCode);
    return lang ? lang.flag : '🌐';
  };

  return (
    <div className="conv-auto">
      {/* ===== NÚT MIC TRUNG TÂM (TOGGLE) ===== */}
      <div className="ptt-controls">
        <div className="ptt-group">
          <button
            className={`ptt-btn ${autoConv.isListening ? 'recording' : ''} ${convStatus === 'processing' ? 'processing' : ''}`}
            disabled={isSpeaking}
            onClick={handleToggleMic}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="ptt-btn-icon">
              {isSpeaking ? '🔊' : convStatus === 'processing' ? '⏳' : autoConv.isListening ? '⏹' : '🎤'}
            </span>
            {autoConv.isListening && !isSpeaking && convStatus !== 'processing' && <span className="pulse-ring" />}
            {autoConv.isListening && !isSpeaking && convStatus !== 'processing' && <span className="pulse-ring p2" />}
          </button>

          {/* Trạng thái */}
          <div className="ptt-hint" style={{ paddingTop: 0 }}>
            {convStatus === 'idle' && '👆 Nhấn để bắt đầu hội thoại'}
            {convStatus === 'listening' && '🟢 Đang lắng nghe...'}
            {convStatus === 'processing' && '⏳ Đang xử lý...'}
            {convStatus === 'speaking' && '🔊 Đang phát âm...'}
          </div>

          {/* Timer */}
          {autoConv.isListening && (
            <div className="ptt-timer">{formatTime(autoConv.elapsed)}</div>
          )}

          <div className="ptt-auto-detect-label">
            Tự động nhận diện {srcLang.flag} {srcLang.name} hoặc {tgtLang.flag} {tgtLang.name}
          </div>
        </div>
      </div>

      {/* ===== LỊCH SỬ HỘI THOẠI ===== */}
      <div className="conv-log">
        <div className="conv-log-header">
          <span>💬 Cuộc hội thoại</span>
          <div className="panel-actions">
            <button onClick={handleClearHistory} title="Xóa">🗑️</button>
          </div>
        </div>
        <div className="conv-log-body" ref={logBodyRef}>
          {history.length === 0 && (
            <div className="conv-empty">
              <div className="conv-empty-icon">💬</div>
              <div>Nhấn nút micro để bắt đầu</div>
              <div className="conv-empty-sub">
                Nói {srcLang.flag} {srcLang.name} hoặc {tgtLang.flag} {tgtLang.name} — Tự động nhận diện!
              </div>
            </div>
          )}
          {history.slice().reverse().map((h) => {
            const isSourceSpeaker = h.fromLang === srcLang.translateCode;
            const alignment = isSourceSpeaker ? 'flex-start' : 'flex-end';
            const bubbleBg = isSourceSpeaker ? 'white' : 'linear-gradient(135deg, #8b5cf6, #d946ef)';
            const textColor = isSourceSpeaker ? '#1f2937' : 'white';
            const borderColor = isSourceSpeaker ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)';

            return (
              <div key={h.id} style={{ display: 'flex', flexDirection: 'column', alignItems: alignment, marginBottom: '20px', width: '100%' }}>
                <div style={{
                  background: bubbleBg,
                  color: textColor,
                  padding: '12px 16px',
                  borderRadius: '16px',
                  maxWidth: '85%',
                  boxShadow: '0 4px 15px rgba(0,0,0,0.05)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px'
                }}>
                  {/* CÂU GỐC */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${borderColor}`, paddingBottom: '8px' }}>
                    <span style={{ fontSize: '15px', fontWeight: '500', lineHeight: '1.4' }}>
                      <span style={{ fontSize: '12px', opacity: 0.8, marginRight: '8px' }}>
                        {getFlagForLang(h.fromLang)}
                      </span>
                      {h.source}
                    </span>
                    <button
                      onClick={() => speak(h.source, findSttCode(h.fromLang))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', opacity: 0.8, marginLeft: '12px', color: textColor }}
                      title="Nghe lại câu gốc"
                    >🔊</button>
                  </div>

                  {/* CÂU DỊCH */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '15px', lineHeight: '1.4' }}>
                      <span style={{ fontSize: '12px', opacity: 0.8, marginRight: '8px' }}>
                        {getFlagForLang(h.toLang)}
                      </span>
                      {h.target}
                    </span>
                    <button
                      onClick={() => speak(h.target, findSttCode(h.toLang))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', opacity: 0.8, marginLeft: '12px', color: textColor }}
                      title="Nghe lại bản dịch"
                    >🔊</button>
                  </div>
                </div>

                {/* THỜI GIAN */}
                <span style={{ fontSize: '11px', opacity: 0.5, marginTop: '4px', padding: '0 8px' }}>
                  {h.time}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
