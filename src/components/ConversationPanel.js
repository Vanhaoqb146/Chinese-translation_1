'use client';
import { useState, useRef, useCallback } from 'react';
import useRealtimeConversation from '@/hooks/useRealtimeConversation';

/**
 * ConversationPanel — 2 Mic Buttons (Tiếng Việt / 中文)
 *
 * Mỗi nút bấm → start(lang) → Deepgram nhận diện ngôn ngữ đó
 * 4s im → REST translate → TTS → resume
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
  const [interimText, setInterimText] = useState('');
  const [silenceSeconds, setSilenceSeconds] = useState(4);
  const logBodyRef = useRef(null);

  const handleInterimText = useCallback((text) => setInterimText(text), []);

  const handleFinalResult = useCallback(({ originalText, translatedText, fromLang, toLang, id }) => {
    setHistory(prev => [{
      source: originalText,
      target: translatedText,
      fromLang, toLang,
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      id,
    }, ...prev].slice(0, 100));
    setInterimText('');
    setTimeout(() => {
      if (logBodyRef.current) logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }, 50);
  }, [setHistory]);

  const handleStatusChange = useCallback((status) => setConvStatus(status), []);
  const handleError = useCallback((msg) => {
    setConvStatus('idle');
    console.warn('Conversation Error:', msg);
  }, []);

  const conv = useRealtimeConversation({
    srcLangCode: srcLang.translateCode,
    tgtLangCode: tgtLang.translateCode,
    engine,
    silenceMs: silenceSeconds * 1000,
    onInterimText: handleInterimText,
    onFinalResult: handleFinalResult,
    onStatusChange: handleStatusChange,
    onError: handleError,
  });

  // Bấm nút ngôn ngữ → start(lang)
  const handleStartLang = useCallback((lang) => {
    if (conv.isListening) {
      conv.stop();
    } else {
      conv.start(lang);
    }
  }, [conv]);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    setInterimText('');
  }, [setHistory]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const getFlagForLang = (langCode) => {
    const lang = LANGUAGES.find(l => l.translateCode === langCode);
    return lang ? lang.flag : '🌐';
  };

  const isBusy = convStatus === 'translating' || convStatus === 'speaking';

  return (
    <div className="conv-auto" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ===== LỊCH SỬ HỘI THOẠI (ĐẦU TIÊN) ===== */}
      <div className="conv-log" style={{ flex: 1, minHeight: 0 }}>
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
                Chọn {srcLang.flag} {srcLang.name} hoặc {tgtLang.flag} {tgtLang.name}
              </div>
            </div>
          )}
          {history.slice().reverse().map((h, index) => {
            const isSourceSpeaker = h.fromLang === srcLang.translateCode;
            const alignment = isSourceSpeaker ? 'flex-start' : 'flex-end';
            const bubbleBg = isSourceSpeaker ? 'white' : 'linear-gradient(135deg, #0ea5e9, #06b6d4)';
            const textColor = isSourceSpeaker ? '#1f2937' : 'white';
            const borderColor = isSourceSpeaker ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)';

            return (
              <div key={`msg-${h.id}-${index}`} style={{ display: 'flex', flexDirection: 'column', alignItems: alignment, marginBottom: '20px', width: '100%' }}>
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${borderColor}`, paddingBottom: '8px' }}>
                    <span style={{ fontSize: '15px', fontWeight: '500', lineHeight: '1.4' }}>
                      <span style={{ fontSize: '12px', opacity: 0.8, marginRight: '8px' }}>{getFlagForLang(h.fromLang)}</span>
                      {h.source}
                    </span>
                    <button
                      onClick={() => speak(h.source, findSttCode(h.fromLang))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', opacity: 0.8, marginLeft: '12px', color: textColor }}
                      title="Nghe lại câu gốc"
                    >🔊</button>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '15px', lineHeight: '1.4' }}>
                      <span style={{ fontSize: '12px', opacity: 0.8, marginRight: '8px' }}>{getFlagForLang(h.toLang)}</span>
                      {h.target}
                    </span>
                    <button
                      onClick={() => speak(h.target, findSttCode(h.toLang))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', opacity: 0.8, marginLeft: '12px', color: textColor }}
                      title="Nghe lại bản dịch"
                    >🔊</button>
                  </div>
                </div>
                <span style={{ fontSize: '11px', opacity: 0.5, marginTop: '4px', padding: '0 8px' }}>{h.time}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== STT PREVIEW ===== */}
      {interimText && (
        <div style={{
          margin: '0 16px 8px',
          padding: '12px 16px',
          background: 'rgba(14, 165, 233, 0.05)',
          borderRadius: '12px',
          border: '1px dashed rgba(14, 165, 233, 0.3)',
        }}>
          <div style={{ fontSize: '14px', color: '#4b5563', lineHeight: 1.5 }}>
            <span style={{ fontSize: '11px', opacity: 0.6, marginRight: 6 }}>
              {conv.activeLang ? getFlagForLang(conv.activeLang) : '🎤'}
            </span>
            {interimText}
            <span style={{ display: 'inline-block', width: 2, height: 16, background: '#0ea5e9', marginLeft: 2, animation: 'blink 1s infinite' }} />
          </div>
        </div>
      )}

      {/* ===== PHẦN ĐIỀU KHIỂN (DƯỚI CÙNG) ===== */}
      <div className="conv-bottom-controls">
        {/* Cảnh báo */}
        <div style={{ fontSize: '0.72rem', color: '#ff4d4f', textAlign: 'center', lineHeight: 1.6, fontWeight: 600, background: 'rgba(255,77,79,0.08)', borderRadius: 8, padding: '6px 12px', border: '1px solid rgba(255,77,79,0.2)', margin: '0 16px 8px' }}>
          ⚠️ Không nên thu âm quá 3 phút để dịch chính xác nhất!
        </div>

        {/* 2 NÚT MIC */}
        <div className="ptt-controls">
          {/* Nút Tiếng Việt */}
          <div className="ptt-group">
            <button
              className={`ptt-btn ${conv.activeLang === srcLang.translateCode ? 'recording' : ''}`}
              disabled={isBusy || (conv.isListening && conv.activeLang !== srcLang.translateCode)}
              onClick={() => handleStartLang(srcLang.translateCode)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <span className="ptt-btn-icon">
                {conv.activeLang === srcLang.translateCode && convStatus === 'speaking' ? '🔊' :
                 conv.activeLang === srcLang.translateCode && convStatus === 'translating' ? '⏳' :
                 conv.activeLang === srcLang.translateCode ? '⏹' : '🎤'}
              </span>
              {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
              {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
            </button>
            <div className="ptt-label">{srcLang.flag} {srcLang.name}</div>
          </div>

          {/* Trạng thái ở giữa */}
          <div className="ptt-hint">
            {convStatus === 'idle' && '👆 Chọn ngôn ngữ'}
            {convStatus === 'listening' && '🟢 Đang nghe...'}
            {convStatus === 'translating' && '⏳ Đang dịch...'}
            {convStatus === 'speaking' && '🔊 Đang phát...'}
          </div>

          {/* Nút 中文 */}
          <div className="ptt-group">
            <button
              className={`ptt-btn ${conv.activeLang === tgtLang.translateCode ? 'recording' : ''}`}
              disabled={isBusy || (conv.isListening && conv.activeLang !== tgtLang.translateCode)}
              onClick={() => handleStartLang(tgtLang.translateCode)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <span className="ptt-btn-icon">
                {conv.activeLang === tgtLang.translateCode && convStatus === 'speaking' ? '🔊' :
                 conv.activeLang === tgtLang.translateCode && convStatus === 'translating' ? '⏳' :
                 conv.activeLang === tgtLang.translateCode ? '⏹' : '🎤'}
              </span>
              {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
              {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
            </button>
            <div className="ptt-label">{tgtLang.flag} {tgtLang.name}</div>
          </div>
        </div>

        {/* Timer + Info */}
        {conv.isListening && (
          <div style={{ textAlign: 'center', marginTop: '-4px', marginBottom: '4px' }}>
            <div className="ptt-timer">{formatTime(conv.elapsed)}</div>
          </div>
        )}

        {/* CÀI ĐẶT THỜI GIAN IM LẶNG */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          margin: '0 16px 8px', padding: '8px 14px',
          background: 'rgba(14, 165, 233, 0.05)',
          borderRadius: 10, border: '1px solid rgba(14, 165, 233, 0.15)',
        }}>
          <span style={{ fontSize: '13px', whiteSpace: 'nowrap', color: '#4b5563', fontWeight: 500 }}>
            🌐 Dịch sau
          </span>
          <input
            type="range"
            min={2} max={10} step={1}
            value={silenceSeconds}
            onChange={(e) => setSilenceSeconds(Number(e.target.value))}
            disabled={conv.isListening}
            style={{ flex: 1, accentColor: '#0ea5e9', cursor: conv.isListening ? 'not-allowed' : 'pointer' }}
          />
          <span style={{
            fontSize: '13px', fontWeight: 700, color: '#0ea5e9',
            minWidth: 40, textAlign: 'center',
          }}>
            {silenceSeconds}s
          </span>
        </div>
      </div>
    </div>
  );
}
