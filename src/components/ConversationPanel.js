'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import useRealtimeConversation from '@/hooks/useRealtimeConversation';

// Voice options per language — Azure AI Speech (sorted best quality first)
const VOICE_OPTIONS_AZURE = {
  vi: [
    { id: 'vi-VN-HoaiMyNeural', label: '⭐ Nữ miền Bắc (HoaiMy)' },
    { id: 'vi-VN-NamMinhNeural', label: '⭐ Nam miền Bắc (NamMinh)' },
    { id: 'vi-VN-ThuDuongNeural', label: 'Nữ miền Nam (ThuDuong)' },
    { id: 'vi-VN-QuangNeural', label: 'Nam miền Nam (Quang)' },
  ],
  zh: [
    { id: 'zh-CN-XiaoxiaoMultilingualNeural', label: '⭐ Nữ Đa ngữ (Xiaoxiao)' },
    { id: 'zh-CN-YunyiMultilingualNeural', label: '⭐ Nam Đa ngữ (Yunyi)' },
    { id: 'zh-CN-XiaoxiaoNeural', label: 'Nữ Phổ thông (Xiaoxiao)' },
    { id: 'zh-CN-YunjianNeural', label: 'Nam Phổ thông (Yunjian)' },
    { id: 'zh-CN-XiaochenNeural', label: 'Nữ Tự nhiên (Xiaochen)' },
    { id: 'zh-CN-YunxiNeural', label: 'Nam Thanh niên (Yunxi)' },
    { id: 'zh-CN-XiaoyiNeural', label: 'Nữ Thanh niên (Xiaoyi)' },
    { id: 'zh-CN-YunyangNeural', label: 'Nam MC tin tức (Yunyang)' },
    { id: 'zh-CN-XiaochenMultilingualNeural', label: 'Nữ Đa ngữ (Xiaochen)' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', label: 'Nữ Đông Bắc' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', label: 'Nữ Thiểm Tây' },
    { id: 'zh-HK-HiuGaaiNeural', label: 'Nữ Quảng Đông' },
    { id: 'zh-HK-WanLungNeural', label: 'Nam Quảng Đông' },
    { id: 'zh-TW-HsiaoChenNeural', label: 'Nữ Đài Loan' },
    { id: 'zh-TW-YunJheNeural', label: 'Nam Đài Loan' },
  ],
  en: [
    { id: 'en-US-JennyMultilingualNeural', label: '⭐ Nữ Đa ngữ (Jenny)' },
    { id: 'en-US-RyanMultilingualNeural', label: '⭐ Nam Đa ngữ (Ryan)' },
    { id: 'en-US-AriaNeural', label: 'Nữ Aria' },
    { id: 'en-US-GuyNeural', label: 'Nam Guy' },
    { id: 'en-US-BrianNeural', label: 'Nam Brian' },
  ],
  ja: [
    { id: 'ja-JP-NanamiNeural', label: 'Nữ Nhật (Nanami)' },
    { id: 'ja-JP-KeitaNeural', label: 'Nam Nhật (Keita)' },
  ],
  ko: [
    { id: 'ko-KR-SunHiNeural', label: 'Nữ Hàn (SunHi)' },
    { id: 'ko-KR-InJoonNeural', label: 'Nam Hàn (InJoon)' },
  ],
};

// Voice options — ElevenLabs (eleven_multilingual_v2 — all voices speak all languages)
const VOICE_OPTIONS_ELEVENLABS = [
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: '⭐ Lily (Nữ, ấm áp)' },
  { id: '21m00Tcm4TlvDq8ikWAM', label: '⭐ Rachel (Nữ, chuyên nghiệp)' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah (Nữ, nhẹ nhàng)' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian (Nam, trầm)' },
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel (Nam, mạnh mẽ)' },
  { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica (Nữ, vui vẻ)' },
  { id: 'iP95p4xoKVk53GoZ742B', label: 'Chris (Nam, thân thiện)' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda (Nữ, từ tốn)' },
];

/**
 * ConversationPanel — Redesigned as full-screen chat app
 *
 * Layout:
 *   [Header Bar] — mute/unmute speakers + hamburger menu
 *   [Full-screen Chat Log] — Zalo-style bubbles, auto-scroll
 *   [FAB Mic Buttons] — floating at bottom
 *   [Drawer Menu] — settings slide-in from right
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
  sessionUser,
}) {
  const getSessionValue = (key, defaultValue) => {
    if (typeof window !== 'undefined') {
      try {
        const saved = sessionStorage.getItem(`vt_setting_${key}`);
        if (saved !== null) return JSON.parse(saved);
      } catch { /* ignore */ }
    }
    return defaultValue;
  };

  const [convStatus, setConvStatus] = useState('idle');
  const [interimText, setInterimText] = useState('');
  
  const [silenceSeconds, setSilenceSeconds] = useState(() => getSessionValue('silenceSeconds', 4));
  const [provider, setProvider] = useState(() => getSessionValue('provider', 'azure'));
  const [srcVoice, setSrcVoice] = useState(() => getSessionValue('srcVoice', VOICE_OPTIONS_AZURE[srcLang.translateCode]?.[0]?.id || ''));
  const [tgtVoice, setTgtVoice] = useState(() => getSessionValue('tgtVoice', VOICE_OPTIONS_AZURE[tgtLang.translateCode]?.[0]?.id || ''));
  const [autoDetect, setAutoDetect] = useState(() => getSessionValue('autoDetect', false));
  const [micMode, setMicMode] = useState(() => getSessionValue('micMode', 'click'));
  const [autoTTS, setAutoTTS] = useState(() => getSessionValue('autoTTS', true));

  // ===== NEW: Drawer menu state =====
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ===== NEW: Font size state =====
  const [fontSize, setFontSize] = useState(() => getSessionValue('fontSize', 17));

  // ===== NEW: Mute/Unmute per language =====
  const [muteSrc, setMuteSrc] = useState(() => getSessionValue('muteSrc', false));
  const [muteTgt, setMuteTgt] = useState(() => getSessionValue('muteTgt', false));

  // Sync settings to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem('vt_setting_provider', JSON.stringify(provider));
      sessionStorage.setItem('vt_setting_silenceSeconds', JSON.stringify(silenceSeconds));
      sessionStorage.setItem('vt_setting_srcVoice', JSON.stringify(srcVoice));
      sessionStorage.setItem('vt_setting_tgtVoice', JSON.stringify(tgtVoice));
      sessionStorage.setItem('vt_setting_autoDetect', JSON.stringify(autoDetect));
      sessionStorage.setItem('vt_setting_micMode', JSON.stringify(micMode));
      sessionStorage.setItem('vt_setting_autoTTS', JSON.stringify(autoTTS));
      sessionStorage.setItem('vt_setting_fontSize', JSON.stringify(fontSize));
      sessionStorage.setItem('vt_setting_muteSrc', JSON.stringify(muteSrc));
      sessionStorage.setItem('vt_setting_muteTgt', JSON.stringify(muteTgt));
    } catch { /* ignore */ }
  }, [provider, silenceSeconds, srcVoice, tgtVoice, autoDetect, micMode, autoTTS, fontSize, muteSrc, muteTgt]);

  // Auto reset voices when provider changes
  useEffect(() => {
    if (provider === 'elevenlabs') {
      setSrcVoice(VOICE_OPTIONS_ELEVENLABS[0]?.id || '');
      setTgtVoice(VOICE_OPTIONS_ELEVENLABS[0]?.id || '');
    } else {
      setSrcVoice(VOICE_OPTIONS_AZURE[srcLang.translateCode]?.[0]?.id || '');
      setTgtVoice(VOICE_OPTIONS_AZURE[tgtLang.translateCode]?.[0]?.id || '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);
  const muteSrcRef = useRef(false);
  const muteTgtRef = useRef(false);
  useEffect(() => { muteSrcRef.current = muteSrc; }, [muteSrc]);
  useEffect(() => { muteTgtRef.current = muteTgt; }, [muteTgt]);

  const logBodyRef = useRef(null);
  const replayAudioRef = useRef(null);
  const [replayingId, setReplayingId] = useState(null);

  // ===== Auto-scroll =====
  const autoScrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (logBodyRef.current) {
        logBodyRef.current.scrollTo({
          top: logBodyRef.current.scrollHeight,
          behavior: 'smooth',
        });
      }
    }, 60);
  }, []);

  const handleInterimText = useCallback((text) => {
    setInterimText(text);
    autoScrollToBottom();
  }, [autoScrollToBottom]);

  const handleFinalResult = useCallback(({ originalText, translatedText, fromLang, toLang, id }) => {
    setHistory(prev => [{
      source: originalText,
      target: translatedText,
      fromLang, toLang,
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      id,
    }, ...prev].slice(0, 100));
    setInterimText('');
    autoScrollToBottom();

    // Lưu vào DB
    if (sessionUser?.username) {
      fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: sessionUser.username,
          source: originalText,
          target: translatedText,
          fromLang, toLang,
        }),
      }).catch(err => console.warn('⚠️ Lưu lịch sử thất bại:', err));
    }
  }, [setHistory, sessionUser?.username, autoScrollToBottom]);

  const handleStatusChange = useCallback((status) => setConvStatus(status), []);
  const handleError = useCallback((msg) => {
    setConvStatus('idle');
    console.warn('Conversation Error:', msg);
  }, []);

  // Voice refs
  const srcVoiceRef = useRef(srcVoice);
  const tgtVoiceRef = useRef(tgtVoice);
  srcVoiceRef.current = srcVoice;
  tgtVoiceRef.current = tgtVoice;

  const getVoiceForLang = useCallback((toLang) => {
    // Kiểm tra mute: nếu mute ngôn ngữ đích → trả null (hook sẽ skip TTS cho ngôn ngữ đang mute)
    if (toLang === srcLang.translateCode && muteSrcRef.current) return '__MUTED__';
    if (toLang === tgtLang.translateCode && muteTgtRef.current) return '__MUTED__';
    if (toLang === srcLang.translateCode) return srcVoiceRef.current;
    if (toLang === tgtLang.translateCode) return tgtVoiceRef.current;
    return null;
  }, [srcLang.translateCode, tgtLang.translateCode]);

  const conv = useRealtimeConversation({
    srcLangCode: srcLang.translateCode,
    tgtLangCode: tgtLang.translateCode,
    engine,
    silenceMs: silenceSeconds * 1000,
    autoDetect,
    micMode,
    autoTTS,
    provider,
    onInterimText: handleInterimText,
    onFinalResult: handleFinalResult,
    onStatusChange: handleStatusChange,
    onError: handleError,
    getVoiceForLang,
  });

  // Dừng replay
  const stopReplay = useCallback(() => {
    if (replayAudioRef.current) {
      try { replayAudioRef.current.pause(); replayAudioRef.current.currentTime = 0; } catch (e) { /* ignore */ }
      replayAudioRef.current = null;
    }
    setReplayingId(null);
  }, []);

  // Phát lại (toggle)
  const handleReplay = useCallback(async (text, langCode, msgId) => {
    if (replayingId === msgId) { stopReplay(); return; }
    stopReplay();
    setReplayingId(msgId);
    try {
      const baseLang = langCode.split('-')[0].toLowerCase();
      const voice = srcVoice && langCode.includes(srcLang.translateCode)
        ? srcVoice
        : tgtVoice && langCode.includes(tgtLang.translateCode)
          ? tgtVoice : null;
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: baseLang, voice, provider }),
      });
      if (!res.ok) { setReplayingId(null); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      replayAudioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); replayAudioRef.current = null; setReplayingId(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); replayAudioRef.current = null; setReplayingId(null); };
      audio.play().catch(() => { setReplayingId(null); });
    } catch (err) {
      console.warn('Replay error:', err);
      setReplayingId(null);
    }
  }, [replayingId, stopReplay, srcVoice, tgtVoice, srcLang.translateCode, tgtLang.translateCode, provider]);

  // Bấm nút mic
  const handleStartLang = useCallback((lang) => {
    stopReplay();
    if (conv.isListening) {
      conv.stop();
    } else {
      conv.start(lang);
    }
  }, [conv, stopReplay]);

  // Hold mode
  const holdStartTimeRef = useRef(0);
  const handleHoldStart = useCallback((lang, e) => {
    const busy = convStatus === 'translating' || convStatus === 'speaking' || convStatus === 'connecting';
    if (busy || conv.isListening) return;
    if (replayAudioRef.current) {
      try { replayAudioRef.current.pause(); replayAudioRef.current.currentTime = 0; } catch (e) { /* ignore */ }
      replayAudioRef.current = null;
    }
    holdStartTimeRef.current = Date.now();
    if (e?.target?.setPointerCapture && e?.pointerId != null) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    conv.start(lang);
    setTimeout(() => setReplayingId(null), 0);
  }, [conv, convStatus]);

  const handleHoldEnd = useCallback(() => {
    if (Date.now() - holdStartTimeRef.current < 500) return;
    if (!conv.isListening) return;
    conv.stopHold();
  }, [conv]);

  const handleStopSpeaking = useCallback(() => { conv.stopSpeaking(); }, [conv]);

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

  const isBusy = convStatus === 'translating' || convStatus === 'speaking' || convStatus === 'connecting';
  const isHoldMode = micMode === 'hold';

  // Hold pointer event helpers
  const holdProps = (lang) => ({
    onPointerDown: (e) => { e.preventDefault(); handleHoldStart(lang, e); },
    onPointerUp: (e) => { e.preventDefault(); handleHoldEnd(); },
    onPointerLeave: (e) => { e.preventDefault(); handleHoldEnd(); },
    onContextMenu: (e) => e.preventDefault(),
    style: { touchAction: 'none' },
  });

  // =====================================================================
  //  RENDER
  // =====================================================================
  return (
    <div className="conv-auto">

      {/* ============ HEADER BAR — speakers + hamburger ============ */}
      <div className="conv-header-bar">
        {/* Left: Speaker mute buttons */}
        <div className="conv-header-left">
          <button
            className={`speaker-btn ${muteSrc ? 'muted' : ''}`}
            onClick={() => setMuteSrc(!muteSrc)}
            title={muteSrc ? `Bật loa ${srcLang.name}` : `Tắt loa ${srcLang.name}`}
          >
            <span className="speaker-flag">{srcLang.flag}</span>
            <span className="speaker-icon">{muteSrc ? '🔇' : '🔊'}</span>
          </button>
          <button
            className={`speaker-btn ${muteTgt ? 'muted' : ''}`}
            onClick={() => setMuteTgt(!muteTgt)}
            title={muteTgt ? `Bật loa ${tgtLang.name}` : `Tắt loa ${tgtLang.name}`}
          >
            <span className="speaker-flag">{tgtLang.flag}</span>
            <span className="speaker-icon">{muteTgt ? '🔇' : '🔊'}</span>
          </button>
        </div>

        {/* Center: title */}
        <div className="conv-header-center">
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text2)' }}>💬 Giao tiếp</span>
        </div>

        {/* Right: clear + hamburger */}
        <div className="conv-header-right">
          <button
            className="hamburger-btn"
            onClick={() => handleClearHistory()}
            title="Xóa hội thoại"
            style={{ fontSize: '14px' }}
          >🗑️</button>
          <button
            className="hamburger-btn"
            onClick={() => setDrawerOpen(true)}
            title="Cài đặt"
          >☰</button>
        </div>
      </div>

      {/* ============ FULL-SCREEN CHAT LOG ============ */}
      <div className="conv-log fullscreen-chat">
        <div className="conv-log-body" ref={logBodyRef}>
          {history.length === 0 && !interimText && (
            <div className="conv-empty">
              <div className="conv-empty-icon">💬</div>
              <div>Nhấn nút micro để bắt đầu</div>
              <div className="conv-empty-sub">
                Chọn {srcLang.flag} {srcLang.name} hoặc {tgtLang.flag} {tgtLang.name}
              </div>
            </div>
          )}

          {/* Chat bubbles — Zalo style */}
          {history.slice().reverse().map((h, index) => {
            const isSource = h.fromLang === srcLang.translateCode;
            const alignment = isSource ? 'align-right' : 'align-left';

            return (
              <div key={`msg-${h.id}-${index}`} className={`chat-bubble-group ${alignment}`}>
                {/* Original text bubble */}
                <div className="chat-bubble bubble-original" style={{ fontSize: `${fontSize}px` }}>
                  <span className="chat-bubble-flag">{getFlagForLang(h.fromLang)}</span>
                  <span className="chat-bubble-text">{h.source}</span>
                  <button
                    className="chat-bubble-speaker"
                    onClick={() => !isBusy && handleReplay(h.source, findSttCode(h.fromLang), `src-${h.id}`)}
                    disabled={isBusy}
                    title={replayingId === `src-${h.id}` ? 'Dừng' : 'Nghe câu gốc'}
                  >{replayingId === `src-${h.id}` ? '🔇' : '🔊'}</button>
                </div>

                {/* Translated text bubble */}
                <div className="chat-bubble bubble-translated" style={{ fontSize: `${fontSize}px` }}>
                  <span className="chat-bubble-flag">{getFlagForLang(h.toLang)}</span>
                  <span className="chat-bubble-text">{h.target}</span>
                  <button
                    className="chat-bubble-speaker"
                    onClick={() => !isBusy && handleReplay(h.target, findSttCode(h.toLang), `tgt-${h.id}`)}
                    disabled={isBusy}
                    title={replayingId === `tgt-${h.id}` ? 'Dừng' : 'Nghe bản dịch'}
                    style={{ color: 'rgba(255,255,255,0.8)' }}
                  >{replayingId === `tgt-${h.id}` ? '🔇' : '🔊'}</button>
                </div>

                <span className="chat-bubble-time">{h.time}</span>
              </div>
            );
          })}

          {/* Interim text preview */}
          {interimText && (
            <div className="chat-bubble-interim" style={{ fontSize: `${fontSize}px` }}>
              <div className="chat-bubble-interim-text">
                <span style={{ fontSize: '12px', opacity: 0.6, marginRight: 6 }}>
                  {conv.activeLang ? getFlagForLang(conv.activeLang) : '🎤'}
                </span>
                {interimText}
                <span className="chat-bubble-interim-cursor" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============ FAB MIC BUTTONS (Floating Bottom) ============ */}
      <div className="fab-mic-container">
        {autoDetect ? (
          /* === AUTO DETECT: 1 mic === */
          <>
            <div className="fab-mic-group">
              <button
                className={`fab-mic-btn ${conv.isListening ? (isHoldMode ? 'holding' : 'recording') : ''}`}
                disabled={isHoldMode ? false : isBusy}
                {...(isHoldMode ? holdProps(srcLang.translateCode) : {
                  onClick: () => handleStartLang(srcLang.translateCode),
                  onContextMenu: (e) => e.preventDefault(),
                })}
              >
                <span className="fab-mic-btn-icon">
                  {convStatus === 'speaking' ? '🔊' :
                    convStatus === 'translating' ? '⏳' :
                      convStatus === 'connecting' ? '⏳' :
                        conv.isListening ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
                </span>
                {conv.isListening && convStatus === 'listening' && <span className="pulse-ring" />}
                {conv.isListening && convStatus === 'listening' && <span className="pulse-ring p2" />}
              </button>
              <div className="fab-mic-label">
                {conv.activeLang ? getFlagForLang(conv.activeLang) : '🌐'} Auto
              </div>
            </div>

            <div className="fab-status">
              <span className="fab-status-text">
                {convStatus === 'idle' && (isHoldMode ? '👇 Nhấn giữ' : '👆 Bấm nói')}
                {convStatus === 'connecting' && '⏳ Kết nối...'}
                {convStatus === 'listening' && (isHoldMode ? '🎙 Nghe...' : '🟢 Nghe...')}
                {convStatus === 'translating' && '⏳ Dịch...'}
                {convStatus === 'speaking' && (
                  <button className="fab-stop-speaking-btn" onClick={handleStopSpeaking}>🔇 Tắt</button>
                )}
              </span>
              {conv.isListening && <span className="fab-timer">{formatTime(conv.elapsed)}</span>}
            </div>
          </>
        ) : (
          /* === MANUAL: 2 mics === */
          <>
            {/* Source mic */}
            <div className="fab-mic-group">
              <button
                className={`fab-mic-btn ${conv.activeLang === srcLang.translateCode ? (isHoldMode ? 'holding' : 'recording') : ''}`}
                disabled={isHoldMode ? false : (isBusy || (conv.isListening && conv.activeLang !== srcLang.translateCode))}
                {...(isHoldMode ? holdProps(srcLang.translateCode) : {
                  onClick: () => handleStartLang(srcLang.translateCode),
                  onContextMenu: (e) => e.preventDefault(),
                })}
              >
                <span className="fab-mic-btn-icon">
                  {conv.activeLang === srcLang.translateCode && convStatus === 'speaking' ? '🔊' :
                    conv.activeLang === srcLang.translateCode && convStatus === 'translating' ? '⏳' :
                      conv.activeLang === srcLang.translateCode ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
                </span>
                {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
                {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
              </button>
              <div className="fab-mic-label">{srcLang.flag} {srcLang.name}</div>
            </div>

            {/* Center status */}
            <div className="fab-status">
              <span className="fab-status-text">
                {convStatus === 'idle' && (isHoldMode ? '👇 Nhấn giữ' : '👆 Chọn ngữ')}
                {convStatus === 'connecting' && '⏳...'}
                {convStatus === 'listening' && (isHoldMode ? '🎙 Nghe...' : '🟢 Nghe...')}
                {convStatus === 'translating' && '⏳ Dịch...'}
                {convStatus === 'speaking' && (
                  <button className="fab-stop-speaking-btn" onClick={handleStopSpeaking}>🔇 Tắt</button>
                )}
              </span>
              {conv.isListening && <span className="fab-timer">{formatTime(conv.elapsed)}</span>}
            </div>

            {/* Target mic */}
            <div className="fab-mic-group">
              <button
                className={`fab-mic-btn ${conv.activeLang === tgtLang.translateCode ? (isHoldMode ? 'holding' : 'recording') : ''}`}
                disabled={isHoldMode ? false : (isBusy || (conv.isListening && conv.activeLang !== tgtLang.translateCode))}
                {...(isHoldMode ? holdProps(tgtLang.translateCode) : {
                  onClick: () => handleStartLang(tgtLang.translateCode),
                  onContextMenu: (e) => e.preventDefault(),
                })}
              >
                <span className="fab-mic-btn-icon">
                  {conv.activeLang === tgtLang.translateCode && convStatus === 'speaking' ? '🔊' :
                    conv.activeLang === tgtLang.translateCode && convStatus === 'translating' ? '⏳' :
                      conv.activeLang === tgtLang.translateCode ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
                </span>
                {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
                {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
              </button>
              <div className="fab-mic-label">{tgtLang.flag} {tgtLang.name}</div>
            </div>
          </>
        )}
      </div>

      {/* ============ DRAWER MENU (Settings) ============ */}
      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
          <div className="drawer-content">
            <div className="drawer-header">
              <h3>⚙️ Cài đặt</h3>
              <button className="drawer-close-btn" onClick={() => setDrawerOpen(false)}>✕</button>
            </div>
            <div className="drawer-body">

              {/* Font size slider */}
              <div className="drawer-section">
                <div className="drawer-section-title">🔠 Cỡ chữ</div>
                <div className="font-size-slider-row">
                  <span style={{ fontSize: '12px', color: 'var(--muted)' }}>A</span>
                  <input
                    type="range"
                    min={12}
                    max={28}
                    step={1}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                  <span style={{ fontSize: '20px', color: 'var(--muted)' }}>A</span>
                  <span className="font-size-value">{fontSize}px</span>
                </div>
              </div>

              {/* Provider selection */}
              <div className="drawer-section">
                <div className="drawer-section-title">🤖 Speech Provider</div>
                <div className="drawer-row" style={{ gap: 6 }}>
                  <label>API</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[
                      { key: 'azure', label: 'Azure', icon: '☁️' },
                      { key: 'elevenlabs', label: 'ElevenLabs', icon: '🎭' },
                    ].map(opt => (
                      <button
                        key={opt.key}
                        onClick={() => !conv.isListening && setProvider(opt.key)}
                        disabled={conv.isListening}
                        style={{
                          padding: '5px 14px', fontSize: '12px', fontWeight: 600,
                          borderRadius: 8, cursor: conv.isListening ? 'not-allowed' : 'pointer',
                          border: provider === opt.key ? '1.5px solid #8b5cf6' : '1px solid rgba(0,0,0,0.1)',
                          background: provider === opt.key ? 'rgba(139,92,246,0.12)' : 'rgba(0,0,0,0.02)',
                          color: provider === opt.key ? '#8b5cf6' : '#6b7280',
                          opacity: conv.isListening ? 0.5 : 1,
                          transition: 'all 0.15s',
                        }}
                      >{opt.icon} {opt.label}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Voice selection */}
              <div className="drawer-section">
                <div className="drawer-section-title">🔊 Giọng đọc {provider === 'elevenlabs' ? '(ElevenLabs)' : '(Azure)'}</div>
                {provider === 'elevenlabs' ? (
                  /* ElevenLabs: same shared voice list for both languages (multilingual model) */
                  <>
                    <div className="drawer-row">
                      <label>{srcLang.flag} Giọng {srcLang.name}</label>
                      <select value={srcVoice} onChange={(e) => setSrcVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {VOICE_OPTIONS_ELEVENLABS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                    <div className="drawer-row">
                      <label>{tgtLang.flag} Giọng {tgtLang.name}</label>
                      <select value={tgtVoice} onChange={(e) => setTgtVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {VOICE_OPTIONS_ELEVENLABS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                  </>
                ) : (
                  /* Azure: language-specific voice lists */
                  <>
                    <div className="drawer-row">
                      <label>{srcLang.flag} {srcLang.name}</label>
                      <select value={srcVoice} onChange={(e) => setSrcVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {(VOICE_OPTIONS_AZURE[srcLang.translateCode] || []).map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                    <div className="drawer-row">
                      <label>{tgtLang.flag} {tgtLang.name}</label>
                      <select value={tgtVoice} onChange={(e) => setTgtVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {(VOICE_OPTIONS_AZURE[tgtLang.translateCode] || []).map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* Mic mode + toggles */}
              <div className="drawer-section">
                <div className="drawer-section-title">🎤 Chế độ micro</div>

                {/* Auto detect toggle */}
                <div className="drawer-row">
                  <label>🌐 Tự nhận dạng ngôn ngữ</label>
                  <div
                    className={`toggle-switch ${autoDetect ? 'on' : 'off'} ${conv.isListening ? 'disabled' : ''}`}
                    onClick={() => !conv.isListening && setAutoDetect(!autoDetect)}
                  >
                    <div className="toggle-switch-knob" />
                  </div>
                </div>

                {/* Auto TTS toggle */}
                <div className="drawer-row">
                  <label>{autoTTS ? '🔊' : '🔇'} Tự phát giọng sau dịch</label>
                  <div
                    className={`toggle-switch ${autoTTS ? 'on' : 'off'} ${conv.isListening ? 'disabled' : ''}`}
                    onClick={() => !conv.isListening && setAutoTTS(!autoTTS)}
                  >
                    <div className="toggle-switch-knob" />
                  </div>
                </div>

                {/* Mic mode buttons */}
                <div className="drawer-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <label>🎤 Mode</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[
                      ...(!autoDetect ? [{ key: 'click', label: 'Bấm', icon: '👆' }] : []),
                      { key: 'continuous', label: 'Liên tục', icon: '🔄' },
                      { key: 'hold', label: 'Giữ', icon: '✋' },
                    ].map(opt => (
                      <button
                        key={opt.key}
                        onClick={() => !conv.isListening && setMicMode(opt.key)}
                        disabled={conv.isListening}
                        style={{
                          padding: '5px 12px', fontSize: '12px', fontWeight: 600,
                          borderRadius: 8, cursor: conv.isListening ? 'not-allowed' : 'pointer',
                          border: micMode === opt.key ? '1.5px solid #0ea5e9' : '1px solid rgba(0,0,0,0.1)',
                          background: micMode === opt.key ? 'rgba(14,165,233,0.12)' : 'rgba(0,0,0,0.02)',
                          color: micMode === opt.key ? '#0ea5e9' : '#6b7280',
                          opacity: conv.isListening ? 0.5 : 1,
                          transition: 'all 0.15s',
                        }}
                      >
                        {opt.icon} {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Silence slider */}
                {micMode !== 'hold' && (
                  <div className="drawer-row" style={{ gap: 8 }}>
                    <label>🕐 Im lặng</label>
                    <input
                      type="range"
                      min={2} max={10} step={1}
                      value={silenceSeconds}
                      onChange={(e) => setSilenceSeconds(Number(e.target.value))}
                      disabled={conv.isListening}
                      style={{ flex: 1, accentColor: '#0ea5e9', cursor: conv.isListening ? 'not-allowed' : 'pointer' }}
                    />
                    <span style={{ fontSize: '13px', fontWeight: 700, color: '#0ea5e9', minWidth: 30, textAlign: 'center' }}>
                      {silenceSeconds}s
                    </span>
                  </div>
                )}
              </div>

              {/* Warning */}
              <div style={{
                fontSize: '12px', color: '#ff4d4f', textAlign: 'center', lineHeight: 1.4,
                fontWeight: 600, background: 'rgba(255,77,79,0.06)', borderRadius: 8,
                padding: '8px 12px', border: '1px solid rgba(255,77,79,0.15)',
              }}>
                ⚠️ Không nên thu âm quá 3 phút để đảm bảo dịch tốt!
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
