// mobile/src/components/ConversationPanel.js
import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  Switch,
  NativeModules,
  Platform,
} from 'react-native';
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import Voice from '../services/speechRecognition';
import {
  MIN_SPEECH_CAPTURE_MS,
  isSpeechMeteringActive,
  startSpeechAudioRecording,
  stopSpeechAudioRecording,
  stopPersistentSpeechAudioRecording,
  startBackgroundService,
  stopBackgroundService,
} from '../services/speechAudioRecorder';

const AndroidAecRecorder = NativeModules.AndroidAecRecorder || null;
import {
  detectMobileTextLanguage,
  getMobileAutoDetectLanguages,
  isTextLikelyLanguage,
  normalizeMobileAutoDetectLanguage,
} from '../lib/mobileAutoDetect';
import { COLORS, SIZES } from '../theme';
import MicrophonePulse from './MicrophonePulse';
import { VOICE_OPTIONS_AZURE, VOICE_OPTIONS_ELEVENLABS } from '../lib/voiceOptions';

const DEFAULT_SILENCE_SECONDS = 4;
const MIN_SILENCE_SECONDS = 2;
const MAX_SILENCE_SECONDS = 10;

const clampSilenceSeconds = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SILENCE_SECONDS;
  return Math.max(MIN_SILENCE_SECONDS, Math.min(MAX_SILENCE_SECONDS, Math.round(numeric)));
};

const getSpeechLocale = (translateCode) => (
  translateCode === 'zh' ? 'zh-CN' :
  translateCode === 'vi' ? 'vi-VN' :
  translateCode === 'en' ? 'en-US' :
  translateCode === 'ja' ? 'ja-JP' :
  translateCode === 'ko' ? 'ko-KR' : 'vi-VN'
);

const normalizeDetectedLanguage = (locale) => (
  typeof locale === 'string' ? locale.split('-')[0].toLowerCase() : null
);

const detectLangFromText = (text, srcLang, tgtLang) => {
  const normalized = (text || '').trim();
  if (!normalized) return null;

  const candidates = [srcLang, tgtLang].map((lang) => lang.translateCode);
  const scores = {
    zh: /[\u3400-\u9fff]/.test(normalized) ? 3 : 0,
    ja: /[\u3040-\u30ff]/.test(normalized) ? 4 : 0,
    ko: /[\uac00-\ud7af]/.test(normalized) ? 4 : 0,
    vi: /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(normalized) ? 4 : 0,
    en: /^[a-zA-Z0-9\s.,!?'"()\-:;]+$/.test(normalized) ? 1 : 0,
  };

  const best = candidates
    .map((code) => ({ code, score: scores[code] || 0 }))
    .sort((a, b) => b.score - a.score)[0];

  const detected = best?.score > 0 ? best.code : null;
  return normalizeMobileAutoDetectLanguage(detected);
};

const getDefaultVoiceForLang = (provider, langCode) => {
  if (provider === 'elevenlabs') {
    return VOICE_OPTIONS_ELEVENLABS[0]?.id || '';
  }

  return VOICE_OPTIONS_AZURE[langCode]?.[0]?.id || '';
};

const getSafeVoiceForLang = (provider, langCode, voiceId) => {
  const voices = provider === 'elevenlabs'
    ? VOICE_OPTIONS_ELEVENLABS
    : (VOICE_OPTIONS_AZURE[langCode] || []);

  return voices.some((voice) => voice.id === voiceId)
    ? voiceId
    : getDefaultVoiceForLang(provider, langCode);
};

const getAllowedAutoCodes = (srcLang, tgtLang) => (
  getMobileAutoDetectLanguages(srcLang.translateCode, tgtLang.translateCode)
);

const resolveAutoDetectedLanguage = (text, detectedLangOverride, srcLang, tgtLang) => {
  const allowedCodes = getAllowedAutoCodes(srcLang, tgtLang);
  const detectedLang = normalizeMobileAutoDetectLanguage(detectedLangOverride);
  const textLang = detectMobileTextLanguage(text, allowedCodes);

  if (detectedLang && allowedCodes.includes(detectedLang)) {
    if (textLang && textLang !== detectedLang && isTextLikelyLanguage(text, textLang)) {
      return textLang;
    }
    return detectedLang;
  }

  return textLang;
};

export default function ConversationPanel({
  srcIdx,
  tgtIdx,
  LANGUAGES,
  user,
  apiKey,
  selectedModel,
  api,
  playTts,
  isPlaying,
  stopAudio,
  themeColors,
  chatLog: persistedChatLog,
  setChatLog: setPersistedChatLog,
}) {
  // Mode-Specific Settings (Loaded from local SecureStore)
  const colors = themeColors || COLORS;
  const styles = getStyles(colors);
  const [fontSize, setFontSize] = useState(16);
  const [provider, setProvider] = useState('azure'); // 'azure' | 'elevenlabs'
  const [speed, setSpeed] = useState(1.0); // 0.8 to 2.0
  const [srcVoice, setSrcVoice] = useState('');
  const [tgtVoice, setTgtVoice] = useState('');
  const [autoTTS, setAutoTTS] = useState(true);
  const [micMode, setMicMode] = useState('click'); // 'click' | 'continuous' | 'hold'
  const [silenceSeconds, setSilenceSeconds] = useState(DEFAULT_SILENCE_SECONDS);
  const [muteSrc, setMuteSrc] = useState(false);
  const [muteTgt, setMuteTgt] = useState(false);
  const [autoDetect, setAutoDetect] = useState(false);

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [localChatLog, setLocalChatLog] = useState([]);
  const chatLog = persistedChatLog || localChatLog;
  const setChatLog = setPersistedChatLog || setLocalChatLog;
  const [isProcessing, setIsProcessing] = useState(false);
  const [isManualRecording, setIsManualRecording] = useState(false); // Used in 'click' or 'hold' mode
  const [activeManualLang, setActiveManualLang] = useState(null); // 'src' | 'tgt'
  const [isSpeechActive, setIsSpeechActive] = useState(false);

  // Live STT States
  const [liveText, setLiveText] = useState('');
  const liveTextRef = useRef('');
  const accumulatedTextRef = useRef('');
  const interimTextRef = useRef('');
  const silenceTimerRef = useRef(null);

  const clearSilenceTimer = () => {
    if (Platform.OS === 'android' && AndroidAecRecorder) {
      AndroidAecRecorder.cancelBackgroundTimer().catch(() => {});
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const startSilenceTimer = (langType, seconds) => {
    clearSilenceTimer();
    if (Platform.OS === 'android' && AndroidAecRecorder) {
      AndroidAecRecorder.startBackgroundTimer(seconds * 1000)
        .then((fired) => {
          if (fired) {
            stopRecognitionAndTranslate(langType);
          }
        })
        .catch((err) => {
          console.warn('[🎙 Conv] Native background timer failed, fallback:', err);
          silenceTimerRef.current = setTimeout(() => {
            stopRecognitionAndTranslate(langType);
          }, seconds * 1000);
        });
    } else {
      silenceTimerRef.current = setTimeout(() => {
        stopRecognitionAndTranslate(langType);
      }, seconds * 1000);
    }
  };

  const triggerContinuousMicRestart = (langType) => {
    if (Platform.OS === 'android' && AndroidAecRecorder) {
      AndroidAecRecorder.cancelBackgroundTimer()
        .then(() => AndroidAecRecorder.startBackgroundTimer(500))
        .then((fired) => {
          if (fired && micModeRef.current === 'continuous' && isManualRecording) {
            if (autoDetect) {
              if (!autoListeningWantedRef.current) return;
              startRecordingLoop('auto');
            } else {
              startRecordingLoop(langType || activeManualLangRef.current || 'src');
            }
          }
        })
        .catch((err) => {
          console.warn('[🎙 Conv] Restart timer failed, starting immediately:', err);
          if (micModeRef.current === 'continuous' && isManualRecording) {
            startRecordingLoop(langType || activeManualLangRef.current || 'src');
          }
        });
    } else {
      setTimeout(() => {
        if (micModeRef.current === 'continuous' && isManualRecording) {
          if (autoDetect) {
            if (!autoListeningWantedRef.current) return;
            startRecordingLoop('auto');
          } else {
            startRecordingLoop(langType || activeManualLangRef.current || 'src');
          }
        }
      }, 500);
    }
  };

  const resumeKeptVoiceSession = (langType, delayMs = 400) => {
    const resume = () => {
      voiceInputSuppressedRef.current = false;
      if (isRecordingRef.current) {
        setIsSpeechActive(true);
      } else {
        triggerContinuousMicRestart(langType);
      }
    };

    if (Platform.OS === 'android' && AndroidAecRecorder) {
      AndroidAecRecorder.cancelBackgroundTimer()
        .then(() => AndroidAecRecorder.startBackgroundTimer(delayMs))
        .then((fired) => {
          if (fired) resume();
        })
        .catch(resume);
    } else {
      setTimeout(resume, delayMs);
    }
  };

  // Refs for tracking speech recognition and async state boundaries
  const micModeRef = useRef(micMode);
  const silenceSecondsRef = useRef(silenceSeconds);
  const isRecordingRef = useRef(false);
  const activeManualLangRef = useRef(activeManualLang);
  const holdStartTimeRef = useRef(0);
  const detectedAutoLangRef = useRef(null);
  const audioRecordingRef = useRef(null);
  const audioCaptureStartedAtRef = useRef(0);
  const audioLastSpeechAtRef = useRef(0);
  const audioHasSpeechRef = useRef(false);
  const autoCaptureGenerationRef = useRef(0);
  const autoListeningWantedRef = useRef(false);

  const scrollViewRef = useRef(null);

  const muteSrcRef = useRef(muteSrc);
  const muteTgtRef = useRef(muteTgt);
  const srcVoiceRef = useRef(srcVoice);
  const tgtVoiceRef = useRef(tgtVoice);
  const providerRef = useRef(provider);
  const speedRef = useRef(speed);
  const autoTTSRef = useRef(autoTTS);
  const autoDetectRef = useRef(autoDetect);
  const isManualRecordingRef = useRef(isManualRecording);
  const isProcessingRef = useRef(isProcessing);
  const isTtsPlayingRef = useRef(false);
  const voiceInputSuppressedRef = useRef(false);
  const chatLogRef = useRef(chatLog);

  // Sync state values to Refs to avoid stale closures in metering callbacks
  useEffect(() => {
    micModeRef.current = micMode;
    silenceSecondsRef.current = silenceSeconds;
    activeManualLangRef.current = activeManualLang;
    muteSrcRef.current = muteSrc;
    muteTgtRef.current = muteTgt;
    srcVoiceRef.current = srcVoice;
    tgtVoiceRef.current = tgtVoice;
    providerRef.current = provider;
    speedRef.current = speed;
    autoTTSRef.current = autoTTS;
    autoDetectRef.current = autoDetect;
    isManualRecordingRef.current = isManualRecording;
    isProcessingRef.current = isProcessing;
    chatLogRef.current = chatLog;
  }, [micMode, silenceSeconds, activeManualLang, muteSrc, muteTgt, srcVoice, tgtVoice, provider, speed, autoTTS, autoDetect, isManualRecording, isProcessing, chatLog]);

  // Auto loop in continuous mode when TTS stops playing (Removed in favor of Callback-based restarters)

  // Load saved settings on mount
  useEffect(() => {
    async function loadSettings() {
      const saved = await api.getModeSettings('conv');
      if (saved) {
        const savedProvider = saved.autoDetect ? 'azure' : (saved.provider || 'azure');

        if (saved.fontSize) setFontSize(saved.fontSize);
        if (saved.provider) setProvider(savedProvider);
        if (saved.speed) setSpeed(saved.speed);
        setSrcVoice(getSafeVoiceForLang(savedProvider, LANGUAGES[srcIdx].translateCode, saved.srcVoice));
        setTgtVoice(getSafeVoiceForLang(savedProvider, LANGUAGES[tgtIdx].translateCode, saved.tgtVoice));
        if (saved.autoTTS !== undefined) setAutoTTS(saved.autoTTS);
        if (saved.micMode) setMicMode(saved.micMode);
        if (saved.silenceSeconds) setSilenceSeconds(clampSilenceSeconds(saved.silenceSeconds));
        if (saved.muteSrc !== undefined) setMuteSrc(saved.muteSrc);
        if (saved.muteTgt !== undefined) setMuteTgt(saved.muteTgt);
        if (saved.autoDetect !== undefined) setAutoDetect(saved.autoDetect);
      } else {
        // Set default voices
        setSrcVoice(getDefaultVoiceForLang('azure', LANGUAGES[srcIdx].translateCode));
        setTgtVoice(getDefaultVoiceForLang('azure', LANGUAGES[tgtIdx].translateCode));
      }
    }
    loadSettings();
  }, [api, LANGUAGES, srcIdx, tgtIdx]);

  // Save settings when changed
  useEffect(() => {
    const currentSettings = {
      fontSize,
      provider,
      speed,
      srcVoice,
      tgtVoice,
      autoTTS,
      micMode,
      silenceSeconds,
      muteSrc,
      muteTgt,
      autoDetect,
    };
    api.saveModeSettings('conv', currentSettings);
  }, [api, fontSize, provider, speed, srcVoice, tgtVoice, autoTTS, micMode, silenceSeconds, muteSrc, muteTgt, autoDetect]);

  useEffect(() => {
    if (autoDetect && micMode === 'click') {
      setMicMode('continuous');
    }
    if (autoDetect && provider !== 'azure') {
      setProvider('azure');
    }
  }, [autoDetect, micMode, provider]);

  // Keep stored voices compatible with the current provider and language pair.
  useEffect(() => {
    setSrcVoice((currentVoice) => getSafeVoiceForLang(provider, LANGUAGES[srcIdx].translateCode, currentVoice));
    setTgtVoice((currentVoice) => getSafeVoiceForLang(provider, LANGUAGES[tgtIdx].translateCode, currentVoice));
  }, [provider, LANGUAGES, srcIdx, tgtIdx]);

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      autoListeningWantedRef.current = false;
      autoCaptureGenerationRef.current += 1;
      cleanupRecording();
      stopBackgroundService();
    };
  }, []);

  const cleanupRecording = async () => {
    try {
      clearSilenceTimer();
      setIsSpeechActive(false);
      if (audioRecordingRef.current) {
        const recording = audioRecordingRef.current;
        audioRecordingRef.current = null;
        await stopSpeechAudioRecording(recording);
      }
      await Voice.stop();
      await Voice.destroy();
    } catch (e) {}
    await stopPersistentSpeechAudioRecording();
  };

  const handlePressMic = async (langType) => {
    if (isProcessing) return;

    if (autoDetect && langType === 'auto') {
      if (isManualRecording || activeManualLangRef.current === langType) {
        await cancelAutoDetectionCapture();
        return;
      }
      autoListeningWantedRef.current = true;
    }

    if (isRecordingRef.current) {
      if (activeManualLangRef.current === langType) {
        await stopRecognitionAndTranslate(langType, { resumeContinuous: false });
      }
      return;
    }

    await stopAudio();
    startRecordingLoop(langType);
  };

  const handleHoldStart = async (langType) => {
    if (isProcessing || isRecordingRef.current) return;
    if (autoDetect && langType === 'auto') {
      autoListeningWantedRef.current = true;
    }
    holdStartTimeRef.current = Date.now();
    await stopAudio();
    startRecordingLoop(langType);
  };

  const handleHoldEnd = async () => {
    if (Date.now() - holdStartTimeRef.current < 500) return;
    if (!isRecordingRef.current) return;
    await stopRecognitionAndTranslate(activeManualLangRef.current, { resumeContinuous: false, stopDelayMs: 600 });
  };

  const cancelAutoDetectionCapture = async () => {
    autoListeningWantedRef.current = false;
    autoCaptureGenerationRef.current += 1;
    isRecordingRef.current = false;
    audioHasSpeechRef.current = false;
    setIsSpeechActive(false);
    isManualRecordingRef.current = false;
    setIsManualRecording(false);
    activeManualLangRef.current = null;
    setActiveManualLang(null);
    setLiveText('');
    liveTextRef.current = '';

    const recording = audioRecordingRef.current;
    audioRecordingRef.current = null;
    if (recording) {
      try {
        await stopSpeechAudioRecording(recording);
      } catch (error) {
        console.warn('[ConversationPanel] Failed to discard auto capture:', error);
      }
    }
    await stopPersistentSpeechAudioRecording();
    await stopBackgroundService();

    console.log('[🧭 Conv] Auto capture cancelled by user; pending audio discarded.');
  };

  const startAzureAutoRecording = async (langType, captureGeneration) => {
    audioHasSpeechRef.current = false;
    audioCaptureStartedAtRef.current = Date.now();
    audioLastSpeechAtRef.current = Date.now();

    const recording = await startSpeechAudioRecording((status) => {
      if (
        captureGeneration !== autoCaptureGenerationRef.current ||
        !isRecordingRef.current ||
        activeManualLangRef.current !== langType ||
        !status?.isRecording
      ) return;

      if (isSpeechMeteringActive(status)) {
        audioHasSpeechRef.current = true;
        audioLastSpeechAtRef.current = Date.now();
        setIsSpeechActive(true);
        return;
      }

      const elapsedMs = Date.now() - audioCaptureStartedAtRef.current;
      const silentForMs = Date.now() - audioLastSpeechAtRef.current;
      const silenceLimitMs = silenceSecondsRef.current * 1000;

      if (
        micModeRef.current !== 'hold' &&
        audioHasSpeechRef.current &&
        elapsedMs >= MIN_SPEECH_CAPTURE_MS &&
        silentForMs >= silenceLimitMs
      ) {
        stopRecognitionAndTranslate(langType, {
          trigger: 'silence',
          speechEndedAt: audioLastSpeechAtRef.current,
        });
      }
    }, {
      persistentAndroid: micModeRef.current === 'continuous',
    });

    if (
      captureGeneration !== autoCaptureGenerationRef.current ||
      !isRecordingRef.current ||
      activeManualLangRef.current !== langType
    ) {
      await stopSpeechAudioRecording(recording);
      return;
    }

    audioRecordingRef.current = recording;
  };

  const stopAzureAutoRecording = async () => {
    const recording = audioRecordingRef.current;
    audioRecordingRef.current = null;
    return stopSpeechAudioRecording(recording);
  };

  // Start Speech Capture (Universal for Click, Hold, and Continuous)
  const startRecordingLoop = async (langType) => {
    try {
      if (autoDetect && langType === 'auto' && !autoListeningWantedRef.current) {
        return;
      }

      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        setIsManualRecording(false);
        Alert.alert('Cập quyền', 'Vui lòng cấp quyền micro trong cài đặt để sử dụng.');
        return;
      }

      if (!isManualRecordingRef.current) {
        await startBackgroundService(
          'VoiceTranslate AI đang chạy ẩn',
          'Chế độ giao tiếp đang hoạt động ở chế độ nền.'
        );
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: true,
      });

      // Clear any running instance
      try {
        await Voice.stop();
        await Voice.destroy();
      } catch (e) {}

      setLiveText('');
      liveTextRef.current = '';
      accumulatedTextRef.current = '';
      interimTextRef.current = '';
      detectedAutoLangRef.current = null;
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }

      const srcLang = LANGUAGES[srcIdx];
      const tgtLang = LANGUAGES[tgtIdx];
      const allowedAutoCodes = getAllowedAutoCodes(srcLang, tgtLang);

      if (autoDetectRef.current && langType === 'auto') {
        if (!autoListeningWantedRef.current) return;
        const captureGeneration = ++autoCaptureGenerationRef.current;
        isRecordingRef.current = true;
        isManualRecordingRef.current = true;
        setIsManualRecording(true);
        activeManualLangRef.current = langType;
        setActiveManualLang(langType);
        setIsSpeechActive(true);
        await startAzureAutoRecording(langType, captureGeneration);
        return;
      }

      // Configure Voice listeners dynamically before starting
      Voice.onSpeechStart = () => {
        setLiveText('');
        liveTextRef.current = '';
        accumulatedTextRef.current = '';
        interimTextRef.current = '';
        setIsSpeechActive(true);
      };

      Voice.onSpeechResults = (e) => {
        if (
          voiceInputSuppressedRef.current ||
          isProcessingRef.current ||
          isTtsPlayingRef.current
        ) return;
        if (e.value && e.value[0]) {
          accumulatedTextRef.current = (accumulatedTextRef.current + ' ' + e.value[0]).trim();
          interimTextRef.current = '';
          liveTextRef.current = accumulatedTextRef.current;
          setLiveText(accumulatedTextRef.current);
          
          if (micModeRef.current !== 'hold') {
            startSilenceTimer(langType, silenceSecondsRef.current);
          }
        }
      };

      Voice.onSpeechPartialResults = (e) => {
        if (
          voiceInputSuppressedRef.current ||
          isProcessingRef.current ||
          isTtsPlayingRef.current
        ) return;
        if (e.value && e.value[0]) {
          interimTextRef.current = e.value[0];
          const fullText = (accumulatedTextRef.current + ' ' + interimTextRef.current).trim();
          liveTextRef.current = fullText;
          setLiveText(fullText);

          if (micModeRef.current !== 'hold') {
            startSilenceTimer(langType, silenceSecondsRef.current);
          }
        }
      };

      Voice.onSpeechError = (e) => {
        console.warn('Voice recognition error inside ConversationPanel:', e);
        setIsSpeechActive(false);
      };

      Voice.onSpeechLanguageDetection = (e) => {
        if (!autoDetectRef.current || langType !== 'auto') return;

        const detectedCode = normalizeDetectedLanguage(e?.detectedLanguage);
        if (detectedCode && allowedAutoCodes.includes(detectedCode) && e?.confidence !== 0) {
          detectedAutoLangRef.current = detectedCode;
        }
      };

      Voice.onRecognitionEnd = () => {
        setIsSpeechActive(false);
        isRecordingRef.current = false;

        if (
          micModeRef.current === 'continuous' &&
          isManualRecordingRef.current &&
          !isProcessingRef.current &&
          !isTtsPlayingRef.current &&
          !isRecordingRef.current
        ) {
          console.log('[🎙 Conv] Recognition ended unexpectedly in continuous mode, restarting...');
          triggerContinuousMicRestart(langType);
        }
      };

      let inputLang = srcLang;
      if (langType === 'tgt') {
        inputLang = tgtLang;
      }

      const speechLocale = getSpeechLocale(inputLang.translateCode);
      const recognitionOptions = {
        continuous: true, // Luôn thu âm liên tục để tránh tự động ngắt mic khi người dùng tạm nghỉ nói ở chế độ nhấn giữ (Hold)
      };

      isRecordingRef.current = true;
      isManualRecordingRef.current = true;
      setIsManualRecording(true);
      activeManualLangRef.current = langType;
      setActiveManualLang(langType);
      
      await Voice.start(speechLocale, recognitionOptions);
    } catch (err) {
      console.error('Failed to start recording loop:', err);
      await stopPersistentSpeechAudioRecording();
      await stopBackgroundService();
      setIsManualRecording(false);
      setActiveManualLang(null);
      isRecordingRef.current = false;
    }
  };

  const translateRecognizedText = async (textToTranslate, langType, options = {}) => {
    const {
      detectedLangOverride,
      shouldResumeContinuous,
      keepVoiceSession = false,
      requestId = null,
      speechEndedAt = null,
    } = options;

    setIsProcessing(true);
    isProcessingRef.current = true;
    try {
      const srcLang = LANGUAGES[srcIdx];
      const tgtLang = LANGUAGES[tgtIdx];

      let inputLang = srcLang;
      let outputLang = tgtLang;

      if (autoDetectRef.current && langType === 'auto') {
        const detectedLang = resolveAutoDetectedLanguage(
          textToTranslate,
          detectedLangOverride || detectedAutoLangRef.current,
          srcLang,
          tgtLang
        );
        console.log(`[🧭 Conv] Auto-detect: detectedLangOverride=${detectedLangOverride} detectedAutoLangRef=${detectedAutoLangRef.current} → resolved=${detectedLang}  srcLang=${srcLang.translateCode} tgtLang=${tgtLang.translateCode}`);
        if (detectedLang === tgtLang.translateCode) {
          inputLang = tgtLang;
          outputLang = srcLang;
        }
        console.log(`[🧭 Conv] Direction: ${inputLang.translateCode} → ${outputLang.translateCode}  text="${textToTranslate.slice(0, 50)}"`);
      } else if (langType === 'tgt') {
        inputLang = tgtLang;
        outputLang = srcLang;
      }

      const historyContext = chatLogRef.current.slice(-4).flatMap((msg) => ([
        { role: msg.isUser ? 'user' : 'assistant', content: msg.sourceText },
        { role: msg.isUser ? 'assistant' : 'user', content: msg.translatedText },
      ]));

      const translateStartedAt = Date.now();
      if (requestId) {
        console.log(`[PERF ${requestId}] translate_started ${JSON.stringify({
          speechEndToTranslateMs: speechEndedAt
            ? translateStartedAt - speechEndedAt
            : null,
          chars: textToTranslate.length,
        })}`);
      }
      const translation = await api.translateText({
        text: textToTranslate,
        sourceLang: inputLang.translateCode,
        targetLang: outputLang.translateCode,
        engine: selectedModel,
        apiKey,
        history: historyContext,
        requestId,
      });
      if (requestId) {
        const translateFinishedAt = Date.now();
        console.log(`[PERF ${requestId}] translate_finished ${JSON.stringify({
          translateMs: translateFinishedAt - translateStartedAt,
          speechEndToTranslationMs: speechEndedAt
            ? translateFinishedAt - speechEndedAt
            : null,
        })}`);
      }

      if (!isTextLikelyLanguage(translation, outputLang.translateCode)) {
        console.warn(
          `Conversation translation ignored: output did not look like ${outputLang.translateCode}.`,
          { sourceLang: inputLang.translateCode, targetLang: outputLang.translateCode, textToTranslate, translation }
        );
        return;
      }

      const newEntry = {
        id: Date.now(),
        sourceText: textToTranslate,
        translatedText: translation,
        isUser: inputLang.translateCode === srcLang.translateCode,
        fromLang: inputLang.translateCode,
        toLang: outputLang.translateCode,
        time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      };

      setChatLog(prev => {
        const next = [...prev, newEntry];
        chatLogRef.current = next;
        return next;
      });

      if (user?.username) {
        api.saveHistory({
          userId: user.username,
          source: textToTranslate,
          target: translation,
          fromLang: inputLang.translateCode,
          toLang: outputLang.translateCode,
        }).catch((historyError) => {
          console.warn('Conversation history save failed:', historyError);
        });
      }

      const currentVoice = getSafeVoiceForLang(
        providerRef.current,
        outputLang.translateCode,
        outputLang.translateCode === srcLang.translateCode ? srcVoiceRef.current : tgtVoiceRef.current
      );
      const currentTtsCode = outputLang.ttsCode;
      const isMuted = (outputLang.translateCode === srcLang.translateCode && muteSrcRef.current) ||
                      (outputLang.translateCode === tgtLang.translateCode && muteTgtRef.current);

      if (autoTTSRef.current && !isMuted) {
        isTtsPlayingRef.current = true;
        await playTts(translation, currentTtsCode, currentVoice, {
          provider: providerRef.current,
          speed: speedRef.current,
          onPlaybackFinished: () => {
            isTtsPlayingRef.current = false;
            if (keepVoiceSession) {
              resumeKeptVoiceSession(langType);
            } else if (shouldResumeContinuous) {
              triggerContinuousMicRestart(langType);
            }
          }
        });
      } else {
        isTtsPlayingRef.current = false;
        if (keepVoiceSession) {
          resumeKeptVoiceSession(langType, 150);
        } else if (shouldResumeContinuous) {
          triggerContinuousMicRestart(langType);
        }
      }
    } catch (e) {
      console.warn('Voice translation failed:', e);
      if (keepVoiceSession) {
        resumeKeptVoiceSession(langType, 150);
      }
    } finally {
      setIsProcessing(false);
      isProcessingRef.current = false;
      if (!shouldResumeContinuous) {
        activeManualLangRef.current = null;
        setActiveManualLang(null);
      }
    }
  };

  // Stop recognition and translate
  const stopRecognitionAndTranslate = async (langType, options = {}) => {
    const shouldResumeContinuous =
      micModeRef.current === 'continuous' &&
      options.resumeContinuous !== false &&
      (!autoDetect || langType !== 'auto' || autoListeningWantedRef.current);
    const keepVoiceSession =
      Platform.OS === 'android' &&
      shouldResumeContinuous &&
      !autoDetectRef.current &&
      langType !== 'auto';
    const stopDelayMs = options.stopDelayMs || 0;
    const speechEndedAt = options.speechEndedAt || audioLastSpeechAtRef.current || null;
    const requestId = autoDetect && langType === 'auto'
      ? `conv-auto-${Date.now().toString(36)}`
      : null;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (!isRecordingRef.current) return;
    const isAzureAutoCapture = autoDetectRef.current && langType === 'auto' && audioRecordingRef.current;
    if (!keepVoiceSession) {
      isRecordingRef.current = false;
    } else {
      voiceInputSuppressedRef.current = true;
    }
    setIsSpeechActive(false);
    
    // Continuous mode only resumes after silence-triggered translation, not after manual stop.
    if (!shouldResumeContinuous) {
      if (autoDetectRef.current && langType === 'auto') {
        autoListeningWantedRef.current = false;
      }
      activeManualLangRef.current = null;
      isManualRecordingRef.current = false;
      setIsManualRecording(false);
    }

    try {
      if (stopDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, stopDelayMs));
      }

      if (isAzureAutoCapture) {
        const captureStopStartedAt = Date.now();
        const audioUri = await stopAzureAutoRecording();
        if (!shouldResumeContinuous) {
          await stopPersistentSpeechAudioRecording();
          await stopBackgroundService();
        }
        const captureStoppedAt = Date.now();
        setLiveText('');
        liveTextRef.current = '';
        console.log(`[PERF ${requestId}] capture_stopped ${JSON.stringify({
          trigger: options.trigger || 'manual',
          configuredSilenceMs: silenceSecondsRef.current * 1000,
          measuredSilenceMs: speechEndedAt ? captureStopStartedAt - speechEndedAt : null,
          captureMs: captureStopStartedAt - audioCaptureStartedAtRef.current,
          fileFinalizeMs: captureStoppedAt - captureStopStartedAt,
        })}`);

        // Guard: bail out early if recording produced no usable file
        if (!audioUri) {
          console.warn('[ConversationPanel] Azure auto recording returned no audio file.');
          setIsProcessing(false);
          if (shouldResumeContinuous) {
            setTimeout(() => startRecordingLoop(langType), 350);
          } else {
            activeManualLangRef.current = null;
            setActiveManualLang(null);
            setIsManualRecording(false);
          }
          return;
        }

        if (audioHasSpeechRef.current) {
          setIsProcessing(true);
          const srcLang = LANGUAGES[srcIdx];
          const tgtLang = LANGUAGES[tgtIdx];
          try {
            const sttStartedAt = Date.now();
            const sttResult = await api.transcribeAudio({
              audioUri,
              srcLang: srcLang.translateCode,
              tgtLang: tgtLang.translateCode,
              mode: 'conversation',
              provider: 'azure',
              fallbackProvider: 'whisper',
              requestId,
              allowEarlyWhisper: true,
            });
            const sttFinishedAt = Date.now();
            console.log(`[PERF ${requestId}] stt_finished ${JSON.stringify({
              sttMs: sttFinishedAt - sttStartedAt,
              speechEndToSttMs: speechEndedAt ? sttFinishedAt - speechEndedAt : null,
              provider: sttResult.provider,
              language: sttResult.language,
              timings: sttResult.timings || null,
            })}`);
            console.log(`[🧭 Conv] STT result: text="${(sttResult.text || '').slice(0, 60)}"  lang=${sttResult.language}  provider=${sttResult.provider}`);
            const textToTranslate = (sttResult.text || '').trim();
            const detectedLangOverride = normalizeMobileAutoDetectLanguage(sttResult.language);

            if (textToTranslate) {
              await translateRecognizedText(textToTranslate, langType, {
                detectedLangOverride,
                shouldResumeContinuous,
                requestId,
                speechEndedAt,
              });
              return;
            }
          } catch (sttError) {
            console.warn('[ConversationPanel] STT failed:', sttError);
          }
        }

        setIsProcessing(false);
        if (!shouldResumeContinuous) {
          activeManualLangRef.current = null;
          setActiveManualLang(null);
          setIsManualRecording(false);
        } else {
          if (Platform.OS === 'android' && AndroidAecRecorder) {
            AndroidAecRecorder.cancelBackgroundTimer()
              .then(() => AndroidAecRecorder.startBackgroundTimer(350))
              .then((fired) => {
                if (fired) startRecordingLoop(langType);
              })
              .catch(() => startRecordingLoop(langType));
          } else {
            setTimeout(() => startRecordingLoop(langType), 350);
          }
        }
        return;
      }

      if (keepVoiceSession) {
        const textToTranslate = liveTextRef.current;
        setLiveText('');
        liveTextRef.current = '';

        if (textToTranslate && textToTranslate.trim()) {
          await translateRecognizedText(textToTranslate, langType, {
            shouldResumeContinuous,
            keepVoiceSession: true,
          });
        } else {
          voiceInputSuppressedRef.current = false;
          setIsSpeechActive(true);
        }
        return;
      }

      await Voice.stop();
      try {
        await Voice.destroy();
      } catch (e) {}
      if (!shouldResumeContinuous) {
        await stopBackgroundService();
      }

      // Wait briefly for Voice events to settle
      const runSettleAndTranslate = async () => {
        const textToTranslate = liveTextRef.current;
        setLiveText('');
        liveTextRef.current = '';

        if (textToTranslate && textToTranslate.trim()) {
          await translateRecognizedText(textToTranslate, langType, { shouldResumeContinuous });
        } else {
          if (!shouldResumeContinuous) {
            activeManualLangRef.current = null;
            setActiveManualLang(null);
            setIsManualRecording(false);
          } else {
            if (Platform.OS === 'android' && AndroidAecRecorder) {
              AndroidAecRecorder.cancelBackgroundTimer()
                .then(() => AndroidAecRecorder.startBackgroundTimer(350))
                .then((fired) => {
                  if (fired) startRecordingLoop(langType);
                })
                .catch(() => startRecordingLoop(langType));
            } else {
              setTimeout(() => startRecordingLoop(langType), 350);
            }
          }
        }
      };

      if (Platform.OS === 'android' && AndroidAecRecorder) {
        AndroidAecRecorder.cancelBackgroundTimer()
          .then(() => AndroidAecRecorder.startBackgroundTimer(300))
          .then((fired) => {
            if (fired) runSettleAndTranslate();
          })
          .catch(() => runSettleAndTranslate());
      } else {
        setTimeout(runSettleAndTranslate, 300);
      }
    } catch (err) {
      console.error('Failed to stop Voice recording', err);
      voiceInputSuppressedRef.current = false;
      if (!shouldResumeContinuous) {
        await stopPersistentSpeechAudioRecording();
        await stopBackgroundService();
      }
      setIsManualRecording(false);
      setActiveManualLang(null);
      isRecordingRef.current = false;
    }
  };

  // Replay a message
  const handleReplay = async (text, toLang, msgId) => {
    const isSrc = toLang === LANGUAGES[srcIdx].translateCode;
    const lang = isSrc ? LANGUAGES[srcIdx] : LANGUAGES[tgtIdx];
    const voice = getSafeVoiceForLang(provider, lang.translateCode, isSrc ? srcVoice : tgtVoice);
    const voiceCode = lang.ttsCode;
    await playTts(text, voiceCode, voice, { provider, speed });
  };

  // Get candidate voices lists
  const srcLangCode = LANGUAGES[srcIdx].translateCode;
  const tgtLangCode = LANGUAGES[tgtIdx].translateCode;
  const azureVoicesSrc = VOICE_OPTIONS_AZURE[srcLangCode] || [];
  const azureVoicesTgt = VOICE_OPTIONS_AZURE[tgtLangCode] || [];
  const voicesListSrc = provider === 'elevenlabs' ? VOICE_OPTIONS_ELEVENLABS : azureVoicesSrc;
  const voicesListTgt = provider === 'elevenlabs' ? VOICE_OPTIONS_ELEVENLABS : azureVoicesTgt;
  const controlsLocked = isManualRecording || isProcessing;
  const providerLocked = controlsLocked || autoDetect;
  const isHoldMode = micMode === 'hold';
  const isMicListening = (langType) => activeManualLang === langType && isManualRecording;
  const modeInstruction = autoDetect
    ? (isHoldMode
        ? 'Nhấn giữ mic Auto để nói, thả tay ra là dịch và phát.'
        : 'Bấm mic Auto để nghe liên tục, im lặng đủ thời gian sẽ dịch rồi nghe tiếp.')
    : micMode === 'continuous'
      ? 'Bấm mic nguồn hoặc đích để nghe liên tục. Dịch xong app sẽ tự mở mic lại cùng chiều.'
      : isHoldMode
        ? 'Nhấn giữ mic nguồn hoặc đích để nói, thả tay ra là dịch và phát.'
        : 'Bấm mic nguồn hoặc đích, nói xong im lặng đủ thời gian là dịch.';

  const handleAutoDetectToggle = (value) => {
    if (controlsLocked) return;
    if (value) setProvider('azure');
    setAutoDetect(value);
  };

  return (
    <View style={styles.container}>
      {/* HEADER WITH SETTINGS ICON */}
      <View style={styles.headerBar}>
        <View style={styles.speakerRow}>
          <TouchableOpacity
            style={[styles.speakerBtn, muteSrc && styles.speakerBtnMuted]}
            onPress={() => setMuteSrc(!muteSrc)}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 13 }}>{LANGUAGES[srcIdx].flag}</Text>
              <Feather name={muteSrc ? "volume-x" : "volume-2"} size={13} color={colors.text} />
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.speakerBtn, muteTgt && styles.speakerBtnMuted]}
            onPress={() => setMuteTgt(!muteTgt)}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 13 }}>{LANGUAGES[tgtIdx].flag}</Text>
              <Feather name={muteTgt ? "volume-x" : "volume-2"} size={13} color={colors.text} />
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.headerTitle}>Giao tiếp</Text>

        <TouchableOpacity style={styles.settingsBtn} onPress={() => setSettingsVisible(true)}>
          <Feather name="settings" size={16} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.chatStage}>
      {/* CHAT LOG VIEW */}
      <ScrollView
        ref={scrollViewRef}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
        style={styles.chatLog}
        contentContainerStyle={styles.chatListContent}
      >
        {chatLog.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIconWrap}>
              <Feather name="message-circle" size={26} color={colors.accent1} />
            </View>
            <Text style={styles.emptyTitle}>Sẵn sàng hội thoại</Text>
            <Text style={styles.emptyText}>{modeInstruction}</Text>
          </View>
        ) : (
          chatLog.map((chat) => (
            <View key={chat.id} style={[styles.bubbleContainer, chat.isUser ? styles.bubbleRight : styles.bubbleLeft]}>
              <View style={[styles.bubbleCard, chat.isUser ? styles.cardUser : styles.cardPartner]}>
                <Text style={[styles.bubbleSource, { fontSize: fontSize - 2 }]}>{chat.sourceText}</Text>
                <View style={styles.bubbleFooter}>
                  <Text style={[styles.bubbleTarget, { fontSize: fontSize }]}>{chat.translatedText}</Text>
                  <TouchableOpacity
                    onPress={() => handleReplay(chat.translatedText, chat.toLang, chat.id)}
                    style={[styles.replayBtn, chat.isUser ? styles.replayBtnUser : styles.replayBtnPartner]}
                  >
                    <Feather
                      name="volume-2"
                      size={14}
                      color={chat.isUser ? colors.accent1 : colors.success}
                    />
                  </TouchableOpacity>
                </View>
                <Text style={styles.bubbleTime}>{chat.time}</Text>
              </View>
            </View>
          ))
        )}
        {isManualRecording && liveText.trim() !== '' && (
          <View style={[styles.bubbleContainer, (activeManualLang === 'tgt') ? styles.bubbleLeft : styles.bubbleRight]}>
            <View style={[styles.bubbleCard, (activeManualLang === 'tgt') ? styles.cardPartner : styles.cardUser, styles.liveBubble]}>
              <Text style={[styles.bubbleSource, { fontSize: fontSize, fontStyle: 'italic' }]}>
                {liveText}...
              </Text>
            </View>
          </View>
        )}
        {isProcessing && (
          <View style={styles.loadingBubble}>
            <ActivityIndicator size="small" color={colors.accent1} />
            <Text style={styles.loadingText}>Đang nhận dạng dịch thuật...</Text>
          </View>
        )}
      </ScrollView>

      {/* MIC CONTROL ZONE */}
      <View style={styles.actionArea}>
        {autoDetect ? (
          <View style={styles.singleMicContainer}>
            <View style={styles.circleMicColumn}>
              <View style={styles.circleMicWrapper}>
                {isMicListening('auto') && (
                  <MicrophonePulse isRecording={true} color={colors.danger} size={70} />
                )}
                <TouchableOpacity
                  activeOpacity={0.8}
                  style={[
                    styles.circleMicBtn,
                    styles.circleMicBtnAuto,
                    isMicListening('auto') && styles.circleMicBtnActive,
                    isProcessing && styles.circleMicBtnDisabled
                  ]}
                  disabled={isProcessing}
                  onPress={isHoldMode ? undefined : () => handlePressMic('auto')}
                  onPressIn={isHoldMode ? () => handleHoldStart('auto') : undefined}
                  onPressOut={isHoldMode ? handleHoldEnd : undefined}
                >
                  <Feather
                    name={isMicListening('auto') ? (isHoldMode ? "mic" : "square") : "mic"}
                    size={24}
                    color="#fff"
                  />
                </TouchableOpacity>
              </View>
              <Text style={[styles.circleMicLabel, isMicListening('auto') && styles.circleMicLabelActive]}>
                🌐 Auto
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.bottomMicCard}>
            {/* Source Mic */}
            <View style={styles.circleMicColumn}>
              <View style={styles.circleMicWrapper}>
                {isMicListening('src') && (
                  <MicrophonePulse isRecording={true} color={colors.danger} size={70} />
                )}
                <TouchableOpacity
                  activeOpacity={0.8}
                  style={[
                    styles.circleMicBtn,
                    styles.circleMicBtnSource,
                    isMicListening('src') && styles.circleMicBtnActive,
                    (activeManualLang === 'tgt' || isProcessing) && styles.circleMicBtnDisabled
                  ]}
                  disabled={activeManualLang === 'tgt' || isProcessing}
                  onPress={isHoldMode ? undefined : () => handlePressMic('src')}
                  onPressIn={isHoldMode ? () => handleHoldStart('src') : undefined}
                  onPressOut={isHoldMode ? handleHoldEnd : undefined}
                >
                  <Feather
                    name={isMicListening('src') ? (isHoldMode ? "mic" : "square") : "mic"}
                    size={24}
                    color="#fff"
                  />
                </TouchableOpacity>
              </View>
              <Text style={[styles.circleMicLabel, isMicListening('src') && styles.circleMicLabelActive]}>
                {LANGUAGES[srcIdx].flag} {LANGUAGES[srcIdx].name}
              </Text>
            </View>

            {/* Middle Spacer */}
            <View style={styles.micCenterSeparator}>
              <Feather name="refresh-cw" size={13} color={colors.muted} />
              <Text style={styles.micCenterText}>Chọn ngữ</Text>
            </View>

            {/* Target Mic */}
            <View style={styles.circleMicColumn}>
              <View style={styles.circleMicWrapper}>
                {isMicListening('tgt') && (
                  <MicrophonePulse isRecording={true} color={colors.danger} size={70} />
                )}
                <TouchableOpacity
                  activeOpacity={0.8}
                  style={[
                    styles.circleMicBtn,
                    styles.circleMicBtnTarget,
                    isMicListening('tgt') && styles.circleMicBtnActive,
                    (activeManualLang === 'src' || isProcessing) && styles.circleMicBtnDisabled
                  ]}
                  disabled={activeManualLang === 'src' || isProcessing}
                  onPress={isHoldMode ? undefined : () => handlePressMic('tgt')}
                  onPressIn={isHoldMode ? () => handleHoldStart('tgt') : undefined}
                  onPressOut={isHoldMode ? handleHoldEnd : undefined}
                >
                  <Feather
                    name={isMicListening('tgt') ? (isHoldMode ? "mic" : "square") : "mic"}
                    size={24}
                    color="#fff"
                  />
                </TouchableOpacity>
              </View>
              <Text style={[styles.circleMicLabel, isMicListening('tgt') && styles.circleMicLabelActive]}>
                {LANGUAGES[tgtIdx].flag} {LANGUAGES[tgtIdx].name}
              </Text>
            </View>
          </View>
        )}
      </View>
      </View>

      {/* MODE SETTINGS MODAL */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={settingsVisible}
        onRequestClose={() => setSettingsVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>⚙️ Cài đặt Giao tiếp</Text>
              <TouchableOpacity onPress={() => setSettingsVisible(false)} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.modalBody}>
              {/* Font Size Settings */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Cỡ chữ: {fontSize}px</Text>
                <View style={styles.adjustRow}>
                  <TouchableOpacity onPress={() => setFontSize(Math.max(12, fontSize - 1))} style={styles.adjustBtn}>
                    <Text style={styles.adjustBtnText}>-</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setFontSize(Math.min(28, fontSize + 1))} style={styles.adjustBtn}>
                    <Text style={styles.adjustBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Speech Provider Button Group */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Nhận dạng giọng nói (STT)</Text>
                <View style={styles.btnGroup}>
                  <View style={[styles.btnGroupItem, styles.btnGroupItemActive]}>
                    <Text style={styles.btnGroupText}>{autoDetect ? 'Azure Auto' : 'Native Speech'}</Text>
                  </View>
                </View>
              </View>

              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Nhà cung cấp giọng nói (TTS)</Text>
                <View style={styles.btnGroup}>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, provider === 'azure' && styles.btnGroupItemActive, providerLocked && styles.btnGroupItemDisabled]}
                    onPress={() => !providerLocked && setProvider('azure')}
                    disabled={providerLocked}
                  >
                    <Text style={styles.btnGroupText}>Azure</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, provider === 'elevenlabs' && styles.btnGroupItemActive, providerLocked && styles.btnGroupItemDisabled]}
                    onPress={() => !providerLocked && setProvider('elevenlabs')}
                    disabled={providerLocked}
                  >
                    <Text style={styles.btnGroupText}>ElevenLabs</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Speed Settings */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Tốc độ phát âm: {speed.toFixed(1)}x</Text>
                <View style={styles.adjustRow}>
                  <TouchableOpacity
                    onPress={() => !controlsLocked && setSpeed(Math.max(0.8, speed - 0.1))}
                    style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.adjustBtnText}>-</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => !controlsLocked && setSpeed(Math.min(2.0, speed + 0.1))}
                    style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.adjustBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Mic Mode Picker */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Chế độ Micro</Text>
                <View style={styles.btnGroup}>
                  {!autoDetect && (
                    <TouchableOpacity
                      style={[styles.btnGroupItem, micMode === 'click' && styles.btnGroupItemActive, controlsLocked && styles.btnGroupItemDisabled]}
                      onPress={() => !controlsLocked && setMicMode('click')}
                      disabled={controlsLocked}
                    >
                      <Text style={styles.btnGroupText}>Bấm</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[styles.btnGroupItem, micMode === 'continuous' && styles.btnGroupItemActive, controlsLocked && styles.btnGroupItemDisabled]}
                    onPress={() => !controlsLocked && setMicMode('continuous')}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.btnGroupText}>Liên tục</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, micMode === 'hold' && styles.btnGroupItemActive, controlsLocked && styles.btnGroupItemDisabled]}
                    onPress={() => !controlsLocked && setMicMode('hold')}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.btnGroupText}>Giữ</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Silence Seconds Settings */}
              {micMode !== 'hold' && (
                <View style={styles.settingItem}>
                  <Text style={styles.settingLabel}>Thời gian im lặng tự dịch: {silenceSeconds}s</Text>
                  <View style={styles.adjustRow}>
                    <TouchableOpacity
                      onPress={() => !controlsLocked && setSilenceSeconds(clampSilenceSeconds(silenceSeconds - 1))}
                      style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                      disabled={controlsLocked}
                    >
                      <Text style={styles.adjustBtnText}>-</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => !controlsLocked && setSilenceSeconds(clampSilenceSeconds(silenceSeconds + 1))}
                      style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                      disabled={controlsLocked}
                    >
                      <Text style={styles.adjustBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Switch options */}
              <View style={styles.switchRow}>
                <Text style={styles.settingLabel}>Tự động phát giọng nói dịch</Text>
                <Switch
                  value={autoTTS}
                  onValueChange={setAutoTTS}
                  disabled={controlsLocked}
                  trackColor={{ true: colors.selectedSolid || colors.accent1 }}
                />
              </View>

              <View style={[styles.switchRow, { opacity: controlsLocked ? 0.5 : 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 8 }]}>
                <Text style={styles.settingLabel}>Tự động nhận dạng ngôn ngữ</Text>
                <Switch
                  value={autoDetect}
                  onValueChange={handleAutoDetectToggle}
                  disabled={controlsLocked}
                  trackColor={{ true: colors.selectedSolid || colors.accent1 }}
                />
              </View>

              {/* Voice Selector Source */}
              <View style={styles.voiceSection}>
                <Text style={styles.settingLabel}>{LANGUAGES[srcIdx].flag} Giọng {LANGUAGES[srcIdx].name}</Text>
                <ScrollView style={styles.voiceScroll} nestedScrollEnabled>
                  {voicesListSrc.map((v) => (
                    <TouchableOpacity
                      key={v.id}
                      style={[styles.voiceItem, srcVoice === v.id && styles.voiceItemActive, controlsLocked && styles.controlDisabled]}
                      onPress={() => !controlsLocked && setSrcVoice(v.id)}
                      disabled={controlsLocked}
                    >
                      <Text style={[styles.voiceItemText, srcVoice === v.id && styles.voiceItemTextActive]}>
                        {v.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

              {/* Voice Selector Target */}
              <View style={styles.voiceSection}>
                <Text style={styles.settingLabel}>{LANGUAGES[tgtIdx].flag} Giọng {LANGUAGES[tgtIdx].name}</Text>
                <ScrollView style={styles.voiceScroll} nestedScrollEnabled>
                  {voicesListTgt.map((v) => (
                    <TouchableOpacity
                      key={v.id}
                      style={[styles.voiceItem, tgtVoice === v.id && styles.voiceItemActive, controlsLocked && styles.controlDisabled]}
                      onPress={() => !controlsLocked && setTgtVoice(v.id)}
                      disabled={controlsLocked}
                    >
                      <Text style={[styles.voiceItemText, tgtVoice === v.id && styles.voiceItemTextActive]}>
                        {v.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </ScrollView>

            <TouchableOpacity style={styles.saveBtn} onPress={() => setSettingsVisible(false)}>
              <Text style={styles.saveBtnText}>Lưu & Đóng</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const getStyles = (colors) => StyleSheet.create({
  container: {
    flex: 1,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  speakerRow: {
    flexDirection: 'row',
    gap: 8,
  },
  speakerBtn: {
    backgroundColor: colors.glassBg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: SIZES.radiusRound,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  speakerBtnMuted: {
    borderColor: colors.danger,
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  speakerBtnText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: 'bold',
  },
  headerTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
    color: colors.text,
    letterSpacing: 0,
  },
  settingsBtn: {
    backgroundColor: colors.glassBg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: SIZES.radiusRound,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatStage: {
    flex: 1,
    position: 'relative',
  },
  chatLog: {
    flex: 1,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.58)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 22,
  },
  chatListContent: {
    padding: 14,
    paddingBottom: 132,
    gap: 14,
  },
  emptyState: {
    minHeight: 260,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptyIconWrap: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(14, 165, 233, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.22)',
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 17,
    lineHeight: 22,
    color: colors.text,
    fontWeight: '900',
    marginBottom: 8,
    letterSpacing: 0,
  },
  emptyText: {
    fontSize: 13,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 19,
  },
  bubbleContainer: {
    width: '100%',
    flexDirection: 'row',
  },
  bubbleLeft: {
    justifyContent: 'flex-start',
  },
  bubbleRight: {
    justifyContent: 'flex-end',
  },
  bubbleCard: {
    maxWidth: '88%',
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: colors.bg === '#060d16' ? 0.22 : 0.13,
    shadowRadius: 14,
    elevation: 4,
  },
  cardUser: {
    backgroundColor: colors.bg === '#060d16' ? 'rgba(14,165,233,0.22)' : 'rgba(223,244,255,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.38)',
    borderBottomRightRadius: 6,
  },
  cardPartner: {
    backgroundColor: colors.bg === '#060d16' ? 'rgba(16,185,129,0.18)' : 'rgba(221,250,238,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.34)',
    borderBottomLeftRadius: 6,
  },
  liveBubble: {
    opacity: 0.92,
    borderStyle: 'dashed',
  },
  bubbleSource: {
    color: colors.text,
    opacity: 0.78,
    marginBottom: 6,
    lineHeight: 22,
  },
  bubbleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bubbleTarget: {
    color: colors.text,
    fontWeight: '900',
    flex: 1,
    lineHeight: 26,
  },
  replayBtn: {
    backgroundColor: 'rgba(14, 165, 233, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.18)',
    borderRadius: 15,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replayBtnUser: {
    backgroundColor: 'rgba(14, 165, 233, 0.12)',
  },
  replayBtnPartner: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.18)',
  },
  bubbleTime: {
    fontSize: 10,
    color: colors.muted,
    textAlign: 'right',
    marginTop: 6,
    fontWeight: '700',
  },
  loadingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    backgroundColor: colors.bg2,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: SIZES.radiusRound,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 8,
  },
  loadingText: {
    fontSize: 12,
    color: colors.text2,
  },
  actionArea: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 10,
  },
  bottomMicCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingVertical: 0,
    paddingHorizontal: 6,
    width: '100%',
    shadowOpacity: 0,
    elevation: 0,
  },
  singleMicContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    backgroundColor: 'transparent',
    borderWidth: 0,
    paddingVertical: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  circleMicColumn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  circleMicWrapper: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleMicBtn: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.accent1,
    borderWidth: 2,
    borderColor: 'rgba(14, 165, 233, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent1,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.34,
    shadowRadius: 12,
    elevation: 6,
  },
  circleMicBtnSource: {
    backgroundColor: colors.accent1,
    borderColor: 'rgba(14, 165, 233, 0.52)',
    shadowColor: colors.accent1,
  },
  circleMicBtnTarget: {
    backgroundColor: colors.success,
    borderColor: 'rgba(16, 185, 129, 0.52)',
    shadowColor: colors.success,
  },
  circleMicBtnAuto: {
    backgroundColor: colors.accent3,
    borderColor: 'rgba(2, 132, 199, 0.52)',
    shadowColor: colors.accent3,
  },
  circleMicBtnActive: {
    backgroundColor: colors.danger,
    borderColor: 'rgba(244, 63, 94, 0.58)',
    shadowColor: colors.danger,
    shadowOpacity: 0.42,
    shadowRadius: 14,
    elevation: 8,
  },
  circleMicBtnDisabled: {
    opacity: 0.4,
  },
  circleMicLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
    color: colors.text,
    maxWidth: 104,
    textAlign: 'center',
  },
  circleMicLabelActive: {
    color: colors.danger,
  },
  micCenterSeparator: {
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  micCenterText: {
    display: 'none',
    fontSize: 0,
    fontWeight: 'bold',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    width: '90%',
    maxHeight: '80%',
    backgroundColor: colors.surfaceCard || colors.bg2,
    borderRadius: SIZES.radiusLg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceBorder || colors.border,
    paddingBottom: 10,
    marginBottom: 15,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: colors.accent1,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceAction || 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: colors.text2,
    fontSize: 14,
  },
  modalBody: {
    gap: 16,
    paddingBottom: 20,
  },
  settingItem: {
    gap: 8,
  },
  settingLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: colors.text2,
  },
  adjustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  adjustBtn: {
    width: 36,
    height: 36,
    borderRadius: SIZES.radiusSm,
    backgroundColor: colors.surfaceAction || colors.bg2,
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adjustBtnText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  btnGroup: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceInset || 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusSm,
    padding: 3,
    gap: 4,
  },
  btnGroupItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: SIZES.radiusSm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  btnGroupItemActive: {
    backgroundColor: colors.selectedBg || 'rgba(14,165,233,0.15)',
    borderColor: colors.selectedBorder || colors.accent1,
  },
  btnGroupItemDisabled: {
    opacity: 0.5,
  },
  btnGroupText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: 'bold',
  },
  controlDisabled: {
    opacity: 0.45,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  voiceSection: {
    gap: 6,
  },
  voiceScroll: {
    height: 100,
    backgroundColor: colors.surfaceInset || 'rgba(0,0,0,0.2)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusSm,
    padding: 4,
  },
  voiceItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: SIZES.radiusSm,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  voiceItemActive: {
    backgroundColor: colors.selectedBg || 'rgba(14,165,233,0.15)',
    borderColor: colors.selectedBorder || colors.accent1,
  },
  voiceItemText: {
    color: colors.text2,
    fontSize: 12,
  },
  voiceItemTextActive: {
    color: colors.selectedText || colors.accent1,
    fontWeight: 'bold',
  },
  saveBtn: {
    backgroundColor: colors.accent1,
    borderRadius: SIZES.radiusLg,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 15,
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
});
