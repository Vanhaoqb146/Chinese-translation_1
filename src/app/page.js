'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import useSpeechRecognition from '@/hooks/useSpeechRecognition';
import useTranslation from '@/hooks/useTranslation';
import ConversationPanel from '@/components/ConversationPanel';
import LoginForm from '@/components/LoginForm';

const LANGUAGES = [
  { flag: '🇨🇳', name: '中文', sttCode: 'zh-CN', translateCode: 'zh', ttsCode: 'zh-CN' },
  { flag: '🇻🇳', name: 'Tiếng Việt', sttCode: 'vi-VN', translateCode: 'vi', ttsCode: 'vi-VN' },
  { flag: '🇺🇸', name: 'English', sttCode: 'en-US', translateCode: 'en', ttsCode: 'en-US' },
  { flag: '🇯🇵', name: '日本語', sttCode: 'ja-JP', translateCode: 'ja', ttsCode: 'ja-JP' },
  { flag: '🇰🇷', name: '한국어', sttCode: 'ko-KR', translateCode: 'ko', ttsCode: 'ko-KR' },
];

const TTS_LANG_MAP = {
  'zh-CN': ['zh-CN', 'zh-TW', 'zh-HK'],
  'vi-VN': ['vi-VN'],
  'en-US': ['en-US', 'en-GB'],
  'ja-JP': ['ja-JP'],
  'ko-KR': ['ko-KR'],
  zh: ['zh-CN', 'zh-TW'],
  vi: ['vi-VN'],
  en: ['en-US', 'en-GB'],
  ja: ['ja-JP'],
  ko: ['ko-KR'],
};

export default function HomePage() {
  const [sessionUser, setSessionUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [viewMode, setViewMode] = useState('standard');
  const [srcIdx, setSrcIdx] = useState(0);
  const [tgtIdx, setTgtIdx] = useState(1);
  const [engine, setEngine] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [sourceBlocks, setSourceBlocks] = useState([]);
  const [targetBlocks, setTargetBlocks] = useState([]);
  const [interimText, setInterimText] = useState('');
  const [activeMic, setActiveMic] = useState(null);
  const activeMicRef = useRef(null);
  const [history, setHistory] = useState([]);

  useEffect(() => { activeMicRef.current = activeMic; }, [activeMic]);
  const [toast, setToast] = useState('');

  const [voicesReady, setVoicesReady] = useState(false);
  const voicesRef = useRef([]);
  const sourceRef = useRef(null);
  const targetRef = useRef(null);

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedUser = localStorage.getItem('vt_user');
    if (savedUser) setSessionUser(JSON.parse(savedUser));
    setAuthChecked(true);
  }, []);

  const handleLogin = (user) => {
    setSessionUser(user);
    localStorage.setItem('vt_user', JSON.stringify(user));
  };

  const handleLogout = () => {
    setSessionUser(null);
    localStorage.removeItem('vt_user');
  };

  // Load voices
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const loadVoices = () => {
      const v = window.speechSynthesis.getVoices();
      if (v.length > 0) { voicesRef.current = v; setVoicesReady(true); }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }, []);

  const srcLang = LANGUAGES[srcIdx];
  const tgtLang = LANGUAGES[tgtIdx];

  const findSttCode = (translateCode) => {
    const lang = LANGUAGES.find(l => l.translateCode === translateCode);
    return lang ? lang.ttsCode : translateCode;
  };

  // TTS
  const findVoice = (langCode) => {
    const voices = voicesRef.current.length > 0 ? voicesRef.current : (typeof window !== 'undefined' ? window.speechSynthesis.getVoices() : []);
    if (voices.length === 0) return null;
    const candidates = TTS_LANG_MAP[langCode] || [langCode];
    for (const c of candidates) { const f = voices.find(v => v.lang.replace('_', '-').toLowerCase() === c.toLowerCase() && v.name.includes('Google')); if (f) return f; }
    for (const c of candidates) { const f = voices.find(v => v.lang.replace('_', '-').toLowerCase() === c.toLowerCase() && (v.name.includes('Online') || v.name.includes('Natural'))); if (f) return f; }
    for (const c of candidates) { const f = voices.find(v => v.lang.replace('_', '-').toLowerCase() === c.toLowerCase()); if (f) return f; }
    const baseLang = langCode.split('-')[0].toLowerCase();
    return voices.find(v => v.lang.toLowerCase().startsWith(baseLang)) || null;
  };

  const speak = (text, langCode) => {
    return new Promise((resolve) => {
      if (!text || typeof window === 'undefined' || !window.speechSynthesis) return resolve();

      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      const chunks = text.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) || [text];
      const voice = findVoice(langCode);
      let i = 0;

      const next = () => {
        if (i >= chunks.length) {
          resolve();
          return;
        }

        const chunk = chunks[i].trim();
        if (!chunk) { i++; next(); return; }

        const u = new SpeechSynthesisUtterance(chunk);
        u.rate = 1.0; u.lang = langCode;
        if (voice) { u.voice = voice; u.lang = voice.lang; }

        const keepAlive = setInterval(() => { if (window.speechSynthesis.speaking) { window.speechSynthesis.pause(); window.speechSynthesis.resume(); } }, 5000);
        const timeout = setTimeout(() => { clearInterval(keepAlive); window.speechSynthesis.cancel(); resolve(); }, 30000);

        u.onend = () => { clearInterval(keepAlive); clearTimeout(timeout); window.ttsEndTime = Date.now(); i++; next(); };
        u.onerror = () => { clearInterval(keepAlive); clearTimeout(timeout); window.ttsEndTime = Date.now(); i++; next(); };

        window.speechSynthesis.speak(u);
      };
      next();
    });
  };

  // Translation hook (Standard mode)
  const { isTranslating, queueTranslation, flush } = useTranslation();

  const sttSourceRef = useRef(null);

  const handleFinalResult = useCallback((text, panel) => {
    const cleanText = text.trim();
    const lowerText = cleanText.toLowerCase();
    const noiseWords = ['phẩy.', 'chấm.', 'phẩy', 'chấm', ',', '.', '?', '!'];
    if (!cleanText || noiseWords.includes(lowerText)) return;

    // [KEY] Auto-stop mic khi có kết quả cuối cùng
    // (continuous=false nên recognition đã tự dừng, sync UI state)
    setActiveMic(null);
    setInterimText('');

    if (panel === 'source') {
      setSourceBlocks(prev => [...prev, { text: cleanText, type: 'final', id: Date.now() }]);
      queueTranslation(cleanText, LANGUAGES[srcIdx].translateCode, LANGUAGES[tgtIdx].translateCode, { apiKey, engine },
        async (origText, translated) => {
          setTargetBlocks(prev => [...prev, { text: translated, type: 'final', id: Date.now() }]);
          await speak(translated, LANGUAGES[tgtIdx].ttsCode);
        });
    } else {
      setTargetBlocks(prev => [...prev, { text: cleanText, type: 'final', id: Date.now() }]);
      queueTranslation(cleanText, LANGUAGES[tgtIdx].translateCode, LANGUAGES[srcIdx].translateCode, { apiKey, engine },
        async (origText, translated) => {
          setSourceBlocks(prev => [...prev, { text: translated, type: 'final', id: Date.now() }]);
          await speak(translated, LANGUAGES[srcIdx].ttsCode);
        });
    }
  }, [srcIdx, tgtIdx, apiKey, engine, queueTranslation]);

  const handleFinalResultSource = useCallback((t) => handleFinalResult(t, 'source'), [handleFinalResult]);

  const handleInterimResult = useCallback((text) => {
    setInterimText(text);
  }, []);

  const handleSttError = useCallback((err) => {
    if (err === 'not-allowed') showToast('❌ Vui lòng cấp quyền truy cập Mic');
    else if (err === 'audio-capture') showToast('❌ Không tìm thấy thiết bị Mic');
    else if (err !== 'no-speech' && err !== 'aborted') console.warn('Lỗi STT: ' + err);
  }, [showToast]);

  const sttSource = useSpeechRecognition({
    lang: LANGUAGES[srcIdx].sttCode,
    onResult: handleFinalResultSource,
    onInterim: handleInterimResult,
    onError: handleSttError
  });

  useEffect(() => { sttSourceRef.current = sttSource; }, [sttSource]);

  // (Auto Conversation đã được thay thế bởi ConversationPanel component)

  const formatTime = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const toggleMic = (panel) => {
    if (viewMode === 'conversation') return;
    if (activeMic === panel) {
      // User bấm dừng thủ công
      if (sttSourceRef.current) sttSourceRef.current.stop();
      setActiveMic(null);
      setInterimText('');
    } else {
      // Bắt đầu nghe - dừng phiên cũ nếu có
      if (activeMic && sttSourceRef.current) sttSourceRef.current.abort();
      if (sttSourceRef.current) sttSourceRef.current.start();
      setActiveMic(panel);
    }
  };



  const swapLangs = () => {
    setSrcIdx(tgtIdx);
    setTgtIdx(srcIdx);

    // Đảo ngược luôn nội dung của 2 khung
    setSourceBlocks(targetBlocks);
    setTargetBlocks(sourceBlocks);

    // Dừng đọc âm thanh hiện tại để tránh đọc lộn ngôn ngữ
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  };

  if (!mounted || !authChecked) return null;

  if (!sessionUser) {
    return (
      <div className="app">
        <div className="bg-orb bg-orb-1" />
        <div className="bg-orb bg-orb-2" />
        <div className="bg-orb bg-orb-3" />
        <LoginForm onLogin={handleLogin} />
      </div>
    );
  }

  // =============== CONVERSATION MODE ===============
  const conversationView = (
    <ConversationPanel
      apiKey={apiKey}
      engine={engine}
      srcLang={srcLang}
      tgtLang={tgtLang}
      speak={speak}
      findSttCode={findSttCode}
      LANGUAGES={LANGUAGES}
    />
  );

  return (
    <div className="app">
      <div className="bg-orb bg-orb-1" />
      <div className="bg-orb bg-orb-2" />
      <div className="bg-orb bg-orb-3" />
      <div className={`container ${viewMode === 'conversation' ? 'container-conv' : ''}`}>
        <header className="header">
          <div className="logo">
            <span className="logo-icon">🎙</span>
            <h1>VoiceTranslate <sup className="badge">AI</sup></h1>
          </div>
          <div className="mode-switcher">
            <button className={viewMode === 'standard' ? 'active' : ''} onClick={() => setViewMode('standard')}>📋 Dịch thuật</button>
            <button className={viewMode === 'conversation' ? 'active' : ''} onClick={() => setViewMode('conversation')}>💬 Giao tiếp</button>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {sessionUser && (
              <div
                title={`Đơn vị: ${sessionUser.unit}\nVai trò: ${sessionUser.role}`}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', padding: '5px 12px', borderRadius: '99px', fontSize: '13px', fontWeight: '500', border: '1px solid rgba(255,255,255,0.1)' }}>

                {/* HIỂN THỊ NÚT VÀO DASHBOARD NẾU LÀ ADMIN */}
                {sessionUser.role === 'admin' && (
                  <button onClick={() => window.location.href = '/admin'} style={{ background: '#d97706', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '20px', cursor: 'pointer', fontSize: '12px', marginRight: '5px', fontWeight: 'bold' }}>
                    🛡️ Quản trị
                  </button>
                )}

                <img src={sessionUser.avatar} alt="avatar" style={{ width: '26px', height: '26px', borderRadius: '50%' }} />
                <span>{sessionUser.name}</span>
                <button onClick={handleLogout} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', marginLeft: '2px', fontSize: '14px', display: 'flex', alignItems: 'center' }} title="Đăng xuất">🚪</button>
              </div>
            )}
            <button className="settings-btn" onClick={() => setShowSettings(!showSettings)}>⚙️</button>
          </div>
        </header>

        {showSettings && (
          <div className="settings-panel">
            <div className="setting-row">
              <label>🔑 API Key</label>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Để trống nếu dùng env var" />
            </div>
            <div className="setting-row">
              <label>🤖 Engine</label>
              <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="openai">OpenAI GPT-4o-mini</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </div>
            <div className="setting-row">
              <label>{srcLang.flag} Nguồn</label>
              <select value={srcIdx} onChange={(e) => setSrcIdx(Number(e.target.value))}>
                {LANGUAGES.map((l, i) => <option key={i} value={i}>{l.flag} {l.name}</option>)}
              </select>
            </div>
            <div className="setting-row">
              <label>{tgtLang.flag} Đích</label>
              <select value={tgtIdx} onChange={(e) => setTgtIdx(Number(e.target.value))}>
                {LANGUAGES.map((l, i) => <option key={i} value={i}>{l.flag} {l.name}</option>)}
              </select>
            </div>
          </div>
        )}

        {viewMode === 'conversation' ? conversationView : (
          <>
            <div className="lang-bar">
              <span className="lang-chip"><span className="flag">{srcLang.flag}</span>{srcLang.name}</span>
              <button className="swap-btn" onClick={swapLangs}>⇄</button>
              <span className="lang-chip"><span className="flag">{tgtLang.flag}</span>{tgtLang.name}</span>
            </div>

            <div className="panels">
              <div className="panel panel-source">
                <div className="panel-header">
                  <span>{srcLang.flag} {srcLang.name}</span>
                  <div className="panel-actions">
                    <button onClick={() => setSourceBlocks([])} title="Xóa">🗑️</button>
                  </div>
                </div>
                <div className="panel-body" ref={sourceRef}>
                  {sourceBlocks.length === 0 && !interimText && <div className="placeholder">Nhấn micro và nói...</div>}
                  {sourceBlocks.map((b) => (
                    <div key={b.id} className="sentence" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                      <span>{b.text}</span>
                      <button onClick={() => speak(b.text, srcLang.ttsCode)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', opacity: 0.7 }} title="Nghe lại">🔊</button>
                    </div>
                  ))}
                  {interimText && activeMic === 'source' && <div className="sentence interim">{interimText}</div>}
                </div>
                <div className="panel-footer">
                  <button className={`mic-btn ${activeMic === 'source' ? 'recording' : ''}`} onClick={() => toggleMic('source')}>
                    <span className="mic-icon">{activeMic === 'source' ? '⏹' : '🎤'}</span>
                    {activeMic === 'source' ? 'Dừng' : 'Nói'}
                  </button>
                  {activeMic === 'source' && <span className="timer">{formatTime(sttSource.elapsed)}</span>}
                  {isTranslating && <span className="translating-badge">⏳ Đang dịch...</span>}
                </div>
              </div>

              <div className="arrow-divider">→</div>

              <div className="panel panel-target">
                <div className="panel-header">
                  <span>{tgtLang.flag} {tgtLang.name}</span>
                  <div className="panel-actions">
                    <button onClick={() => setTargetBlocks([])} title="Xóa">🗑️</button>
                  </div>
                </div>
                <div className="panel-body" ref={targetRef}>
                  {targetBlocks.length === 0 && <div className="placeholder">Bản dịch sẽ hiện tại đây...</div>}
                  {targetBlocks.map((b) => (
                    <div key={b.id} className="sentence" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                      <span>{b.text}</span>
                      <button onClick={() => speak(b.text, tgtLang.ttsCode)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', opacity: 0.7 }} title="Nghe lại">🔊</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {history.length > 0 && (
              <div className="history">
                <div className="history-header">
                  <h2>📜 Lịch sử</h2>
                  <button onClick={() => setHistory([])}>Xóa</button>
                </div>
                <div className="history-list">
                  {history.slice(0, 10).map((h) => (
                    <div key={h.id} className="history-item">
                      <span className="hi-source">{h.source}</span>
                      <span className="hi-arrow">→</span>
                      <span className="hi-target">{h.target}</span>
                      <span className="hi-time">{h.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <footer className="footer">⚡ Powered by OpenAI Whisper + GPT</footer>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
