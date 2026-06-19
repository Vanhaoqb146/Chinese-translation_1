// mobile/src/components/QuickTalkPanel.js
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
  Platform,
  Vibration,
  NativeModules,
  AppState,
} from 'react-native';
const AndroidAecRecorder = NativeModules.AndroidAecRecorder || null;
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import Voice from '../services/speechRecognition';
import { COLORS, SIZES } from '../theme';
import MicrophonePulse from './MicrophonePulse';
import { VOICE_OPTIONS_AZURE, VOICE_OPTIONS_ELEVENLABS } from '../lib/voiceOptions';
import { startBackgroundService, stopBackgroundService } from '../services/speechAudioRecorder';

const DEFAULT_QUICK_SILENCE_SECONDS = 1.0;
const MIN_QUICK_SILENCE_SECONDS = 0.8;
const MAX_QUICK_SILENCE_SECONDS = 3.0;

const clampQuickSilenceSeconds = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_QUICK_SILENCE_SECONDS;
  return Math.max(
    MIN_QUICK_SILENCE_SECONDS,
    Math.min(MAX_QUICK_SILENCE_SECONDS, Math.round(numeric * 10) / 10)
  );
};

const getSpeechLocale = (translateCode) => (
  translateCode === 'zh' ? 'zh-CN' :
  translateCode === 'vi' ? 'vi-VN' :
  translateCode === 'en' ? 'en-US' :
  translateCode === 'ja' ? 'ja-JP' :
  translateCode === 'ko' ? 'ko-KR' : 'vi-VN'
);

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

export default function QuickTalkPanel({
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
  const [micMode, setMicMode] = useState('hold'); // Default hold for fast press & hold response
  const [silenceSeconds, setSilenceSeconds] = useState(DEFAULT_QUICK_SILENCE_SECONDS);
  const [muteSrc, setMuteSrc] = useState(false);
  const [muteTgt, setMuteTgt] = useState(false);

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [localChatLog, setLocalChatLog] = useState([]);
  const chatLog = persistedChatLog || localChatLog;
  const setChatLog = setPersistedChatLog || setLocalChatLog;
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeManualLang, setActiveManualLang] = useState(null); // 'src' | 'tgt'
  const [isSpeechActive, setIsSpeechActive] = useState(false);

  // Live STT States
  const [liveText, setLiveText] = useState('');
  const liveTextRef = useRef('');
  const accumulatedTextRef = useRef('');
  const interimTextRef = useRef('');
  const silenceTimerRef = useRef(null);

  // Refs for tracking recording
  const isTtsPlayingRef = useRef(false);
  const isProcessingRef = useRef(false);
  
  const micModeRef = useRef(micMode);
  const silenceSecondsRef = useRef(silenceSeconds);
  const isRecordingRef = useRef(false);
  const activeManualLangRef = useRef(activeManualLang);
  const providerRef = useRef(provider);
  const speedRef = useRef(speed);
  const srcVoiceRef = useRef(srcVoice);
  const tgtVoiceRef = useRef(tgtVoice);
  const autoTTSRef = useRef(autoTTS);
  const muteSrcRef = useRef(muteSrc);
  const muteTgtRef = useRef(muteTgt);

  const isResumingRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const isNativeTimerRunningRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const isSpeakingRef = useRef(false);

  const scrollViewRef = useRef(null);

  micModeRef.current = micMode;
  silenceSecondsRef.current = silenceSeconds;
  activeManualLangRef.current = activeManualLang;
  isProcessingRef.current = isProcessing;
  providerRef.current = provider;
  speedRef.current = speed;
  srcVoiceRef.current = srcVoice;
  tgtVoiceRef.current = tgtVoice;
  autoTTSRef.current = autoTTS;
  muteSrcRef.current = muteSrc;
  muteTgtRef.current = muteTgt;

  useEffect(() => {
    isTtsPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      appStateRef.current = nextAppState;
    });
    return () => {
      subscription.remove();
    };
  }, []);

  // Load saved settings on mount
  useEffect(() => {
    async function loadSettings() {
      const saved = await api.getModeSettings('quick');
      if (saved) {
        const savedProvider = saved.provider || 'azure';

        if (saved.fontSize) setFontSize(saved.fontSize);
        if (saved.provider) setProvider(savedProvider);
        if (saved.speed) setSpeed(saved.speed);
        setSrcVoice(getSafeVoiceForLang(savedProvider, LANGUAGES[srcIdx].translateCode, saved.srcVoice));
        setTgtVoice(getSafeVoiceForLang(savedProvider, LANGUAGES[tgtIdx].translateCode, saved.tgtVoice));
        if (saved.autoTTS !== undefined) setAutoTTS(saved.autoTTS);
        if (saved.micMode) setMicMode(saved.micMode);
        if (saved.silenceSeconds) setSilenceSeconds(clampQuickSilenceSeconds(saved.silenceSeconds));
        if (saved.muteSrc !== undefined) setMuteSrc(saved.muteSrc);
        if (saved.muteTgt !== undefined) setMuteTgt(saved.muteTgt);
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
    };
    api.saveModeSettings('quick', currentSettings);
  }, [api, fontSize, provider, speed, srcVoice, tgtVoice, autoTTS, micMode, silenceSeconds, muteSrc, muteTgt]);

  // Keep selected voices compatible with the current provider and language pair.
  useEffect(() => {
    setSrcVoice((currentVoice) => getSafeVoiceForLang(provider, LANGUAGES[srcIdx].translateCode, currentVoice));
    setTgtVoice((currentVoice) => getSafeVoiceForLang(provider, LANGUAGES[tgtIdx].translateCode, currentVoice));
  }, [provider, LANGUAGES, srcIdx, tgtIdx]);

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      cleanupRecording();
    };
  }, []);

  const cleanupRecording = async () => {
    try {
      clearSilenceTimer();
      setIsSpeechActive(false);
      await Voice.stop();
      await Voice.destroy();
    } catch (e) {}
  };

  const clearSilenceTimer = () => {
    console.log(`[🎙 Quick DEBUG] clearSilenceTimer: isNativeTimerRunning=${isNativeTimerRunningRef.current}, silenceTimer=${!!silenceTimerRef.current}`);
    if (Platform.OS === 'android' && AndroidAecRecorder && isNativeTimerRunningRef.current) {
      AndroidAecRecorder.cancelBackgroundTimer()
        .catch((err) => {
          console.warn('[🎙 Quick] cancelBackgroundTimer failed', err);
        });
      isNativeTimerRunningRef.current = false;
    }
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const startSilenceTimer = (langType) => {
    console.log(`[🎙 Quick DEBUG] startSilenceTimer: silenceSeconds=${silenceSecondsRef.current}`);
    clearSilenceTimer();
    lastSpeechAtRef.current = Date.now();

    const useNativeTimer = Platform.OS === 'android' && AndroidAecRecorder && appStateRef.current !== 'active';

    if (useNativeTimer) {
      console.log('[🎙 Quick DEBUG] startSilenceTimer: USING NATIVE TIMER');
      isNativeTimerRunningRef.current = true;
      
      const checkIntervalMs = 500;
      AndroidAecRecorder.startBackgroundTimer(checkIntervalMs)
        .then(function handleTick(fired) {
          if (fired) {
            if (!isNativeTimerRunningRef.current) return;
            
            const elapsed = Date.now() - lastSpeechAtRef.current;
            const limit = liveTextRef.current.trim() === ''
              ? Math.max(6000, silenceSecondsRef.current * 1000 * 2)
              : silenceSecondsRef.current * 1000;
            
            console.log(`[🎙 Quick DEBUG] Silence check (native): elapsed=${elapsed}ms, limit=${limit}ms, isRecording=${isRecordingRef.current}, liveText="${liveTextRef.current}"`);

            if (
              isProcessingRef.current ||
              isTtsPlayingRef.current ||
              (!isRecordingRef.current && !isResumingRef.current)
            ) {
              lastSpeechAtRef.current = Date.now();
            } else if (elapsed >= limit) {
              console.log(`[🎙 Quick DEBUG] Silence check (native) limit reached. stopRecognitionAndTranslate.`);
              isNativeTimerRunningRef.current = false;
              stopRecognitionAndTranslate(langType);
              return;
            }
            
            // Re-schedule native timer
            AndroidAecRecorder.startBackgroundTimer(checkIntervalMs)
              .then(handleTick)
              .catch(() => {
                isNativeTimerRunningRef.current = false;
              });
          }
        })
        .catch((err) => {
          console.warn('[🎙 Quick] Native background check loop failed, fallback:', err);
          isNativeTimerRunningRef.current = false;
        });
    } else {
      console.log('[🎙 Quick DEBUG] startSilenceTimer: USING JS INTERVAL');
      silenceTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - lastSpeechAtRef.current;
        const limit = liveTextRef.current.trim() === ''
          ? Math.max(6000, silenceSecondsRef.current * 1000 * 2)
          : silenceSecondsRef.current * 1000;
        
        console.log(`[🎙 Quick DEBUG] Silence check (JS): elapsed=${elapsed}ms, limit=${limit}ms, isRecording=${isRecordingRef.current}, liveText="${liveTextRef.current}"`);

        if (
          isProcessingRef.current ||
          isTtsPlayingRef.current ||
          (!isRecordingRef.current && !isResumingRef.current)
        ) {
          lastSpeechAtRef.current = Date.now();
          return;
        }
        
        if (elapsed >= limit) {
          console.log(`[🎙 Quick DEBUG] Silence check (JS) limit reached. stopRecognitionAndTranslate.`);
          clearSilenceTimer();
          stopRecognitionAndTranslate(langType);
        }
      }, 500);
    }
  };

  const updateSpeechTimestamp = (langType) => {
    console.log(`[🎙 Quick DEBUG] updateSpeechTimestamp called, micMode=${micModeRef.current}`);
    lastSpeechAtRef.current = Date.now();
    if (micModeRef.current !== 'hold' && !silenceTimerRef.current && !isNativeTimerRunningRef.current) {
      startSilenceTimer(langType);
    }
  };

  const triggerContinuousMicRestart = (langType, isResume = false) => {
    console.log(`[🎙 Quick DEBUG] triggerContinuousMicRestart: langType=${langType}, isResume=${isResume}, isRecording=${isRecordingRef.current}`);
    if (Platform.OS === 'android' && AndroidAecRecorder) {
      AndroidAecRecorder.cancelBackgroundTimer()
        .then(() => AndroidAecRecorder.startBackgroundTimer(500))
        .then((fired) => {
          console.log(`[🎙 Quick DEBUG] Android restart timer fired=${fired}, isRecording=${isRecordingRef.current}`);
          if (fired && isRecordingRef.current) {
            startRecordingLoop(langType || activeManualLangRef.current || 'src', isResume);
          }
        })
        .catch((err) => {
          console.warn('[🎙 Quick] Restart timer failed, starting immediately:', err);
          if (isRecordingRef.current) {
            startRecordingLoop(langType || activeManualLangRef.current || 'src', isResume);
          }
        });
    } else {
      setTimeout(() => {
        console.log(`[🎙 Quick DEBUG] iOS/Fallback restart timeout fired, isRecording=${isRecordingRef.current}`);
        if (isRecordingRef.current) {
          startRecordingLoop(langType || activeManualLangRef.current || 'src', isResume);
        }
      }, 500);
    }
  };

  // Start Speech Capture (Universal for Click and Hold)
  const startRecordingLoop = async (langType, isResume = false) => {
    if (Platform.OS === 'android') Vibration.vibrate([0, 100]);
    if (isRecordingRef.current && !isResume) return;
    if (isProcessing) return;
    if (isResume) {
      isResumingRef.current = true;
    }

    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Cập quyền', 'Vui lòng cấp quyền micro trong cài đặt để sử dụng.');
        if (isResume) isResumingRef.current = false;
        return;
      }

      await startBackgroundService(
        'VoiceTranslate AI đang nghe...',
        'Giao tiếp nhanh đang hoạt động ở chế độ nền.'
      );



      isRecordingRef.current = false;
      // Reset any running instance
      try {
        await Voice.stop();
        await Voice.destroy();
      } catch (e) {}

      if (!isResume) {
        setLiveText('');
        liveTextRef.current = '';
        accumulatedTextRef.current = '';
        interimTextRef.current = '';
      }
      if (!isResume) {
        clearSilenceTimer();
      }

      // Configure Voice listeners dynamically before starting
      Voice.onSpeechStart = () => {
        if (!isResumingRef.current) {
          setLiveText('');
          liveTextRef.current = '';
          accumulatedTextRef.current = '';
          interimTextRef.current = '';
        }
        isResumingRef.current = false;
        setIsSpeechActive(true);
      };

      Voice.onSpeechResults = (e) => {
        if (e.value && e.value[0]) {
          accumulatedTextRef.current = (accumulatedTextRef.current + ' ' + e.value[0]).trim();
          interimTextRef.current = '';
          liveTextRef.current = accumulatedTextRef.current;
          setLiveText(accumulatedTextRef.current);
          
          updateSpeechTimestamp(langType);
        }
      };

      Voice.onSpeechPartialResults = (e) => {
        if (e.value && e.value[0]) {
          interimTextRef.current = e.value[0];
          const fullText = (accumulatedTextRef.current + ' ' + interimTextRef.current).trim();
          liveTextRef.current = fullText;
          setLiveText(fullText);

          updateSpeechTimestamp(langType);
        }
      };

      Voice.onSpeechError = (e) => {
        console.warn('Voice recognition error inside QuickTalkPanel:', e);
        setIsSpeechActive(false);
      };

      isSpeakingRef.current = false;

      Voice.onSpeechRecognized = () => {
        console.log('[🎙 Quick DEBUG] Voice.onSpeechRecognized (speechstart)');
        isSpeakingRef.current = true;
        lastSpeechAtRef.current = Date.now();
      };

      Voice.onSpeechEnd = () => {
        console.log('[🎙 Quick DEBUG] Voice.onSpeechEnd (speechend)');
        isSpeakingRef.current = false;
        lastSpeechAtRef.current = Date.now();
      };

      Voice.onRecognitionEnd = () => {
        console.log(`[🎙 Quick DEBUG] Voice.onRecognitionEnd: isRecordingRef=${isRecordingRef.current}, activeManualLangRef=${activeManualLangRef.current}`);
        setIsSpeechActive(false);

        // If the session ended naturally/unexpectedly while we are still supposed to be recording
        if (
          activeManualLangRef.current &&
          isRecordingRef.current &&
          !isProcessingRef.current &&
          !isTtsPlayingRef.current
        ) {
          isRecordingRef.current = true; // Keep true
          triggerContinuousMicRestart(langType, true); // isResume = true
        } else {
          isRecordingRef.current = false;
        }
      };

      const srcLang = LANGUAGES[srcIdx];
      const tgtLang = LANGUAGES[tgtIdx];
      let inputLang = srcLang;
      if (langType === 'tgt') {
        inputLang = tgtLang;
      }

      const speechLocale = getSpeechLocale(inputLang.translateCode);

      isRecordingRef.current = true;
      setActiveManualLang(langType);
      
      isResumingRef.current = !!isResume;
      console.log(`[🎙 Quick DEBUG] startRecordingLoop calling Voice.start, locale=${speechLocale}, isResume=${isResume}`);
      await Voice.start(speechLocale, {
        continuous: true, // Luôn thu âm liên tục để tránh tự động ngắt mic khi người dùng tạm nghỉ nói ở chế độ nhấn giữ (Hold)
        volumeChangeEventOptions: {
          enabled: true,
        },
      });
      console.log('[🎙 Quick DEBUG] Voice.start successfully resolved');
      if (micModeRef.current !== 'hold') {
        startSilenceTimer(langType);
      }
    } catch (err) {
      console.error('Failed to start Voice recording:', err);
      setActiveManualLang(null);
      isRecordingRef.current = false;
      isResumingRef.current = false;
    }
  };

  // Stop manual click recording
  const stopClickRecording = async () => {
    if (!isRecordingRef.current) return;
    await stopRecognitionAndTranslate(activeManualLangRef.current);
  };

  // Stop hold recording
  const stopHoldRecording = async () => {
    if (!isRecordingRef.current) return;
    await stopRecognitionAndTranslate(activeManualLangRef.current, { stopDelayMs: 600 });
  };

  // Stop recognition and translate
  const stopRecognitionAndTranslate = async (langType, options = {}) => {
    if (Platform.OS === 'android') Vibration.vibrate([0, 100]);
    const stopDelayMs = options.stopDelayMs || 0;

    clearSilenceTimer();

    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setIsSpeechActive(false);

    try {
      if (stopDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, stopDelayMs));
      }
      await Voice.stop();

      // Wait briefly for Voice events to settle
      setTimeout(async () => {
        const textToTranslate = liveTextRef.current;
        setLiveText('');
        liveTextRef.current = '';

        if (textToTranslate && textToTranslate.trim()) {
          setIsProcessing(true);
          try {
            const srcLang = LANGUAGES[srcIdx];
            const tgtLang = LANGUAGES[tgtIdx];
            
            let inputLang = srcLang;
            let outputLang = tgtLang;

            if (langType === 'tgt') {
              inputLang = tgtLang;
              outputLang = srcLang;
            }

            const translation = await api.translateText({
              text: textToTranslate,
              sourceLang: inputLang.translateCode,
              targetLang: outputLang.translateCode,
              engine: selectedModel,
              apiKey,
            });

            // Add to log
            const newEntry = {
              id: Date.now(),
              sourceText: textToTranslate,
              translatedText: translation,
              isUser: inputLang.translateCode === srcLang.translateCode,
              fromLang: inputLang.translateCode,
              toLang: outputLang.translateCode,
              time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
            };

            setChatLog(prev => [...prev, newEntry]);

            // Save PostgreSQL in the background so fast TTS is not delayed.
            if (user?.username) {
              api.saveHistory({
                userId: user.username,
                source: textToTranslate,
                target: translation,
                fromLang: inputLang.translateCode,
                toLang: outputLang.translateCode,
              }).catch((historyError) => {
                console.warn('QuickTalk history save failed:', historyError);
              });
            }

            // TTS Options
            const currentVoice = getSafeVoiceForLang(
              providerRef.current,
              outputLang.translateCode,
              outputLang.translateCode === srcLang.translateCode ? srcVoiceRef.current : tgtVoiceRef.current
            );
            const currentTtsCode = outputLang.ttsCode;
            const isMuted = (outputLang.translateCode === srcLang.translateCode && muteSrcRef.current) ||
                            (outputLang.translateCode === tgtLang.translateCode && muteTgtRef.current);

            if (autoTTSRef.current && !isMuted) {
              await playTts(translation, currentTtsCode, currentVoice, {
                provider: providerRef.current,
                speed: speedRef.current,
              });
            } else {
              await stopBackgroundService();
            }
          } catch (e) {
            console.warn('Voice translation failed:', e);
            await stopBackgroundService();
          } finally {
            setIsProcessing(false);
            setActiveManualLang(null);
          }
        } else {
          setActiveManualLang(null);
          await stopBackgroundService();
        }
      }, 300);
    } catch (err) {
      console.error('Failed to stop Voice recording:', err);
      setActiveManualLang(null);
      isRecordingRef.current = false;
      await stopBackgroundService();
    }
  };

  // Replay a message
  const handleReplay = async (text, toLang) => {
    const isSrc = toLang === LANGUAGES[srcIdx].translateCode;
    const lang = isSrc ? LANGUAGES[srcIdx] : LANGUAGES[tgtIdx];
    const voice = getSafeVoiceForLang(provider, lang.translateCode, isSrc ? srcVoice : tgtVoice);
    await playTts(text, lang.ttsCode, voice, { provider, speed });
  };

  // Get candidate voices lists
  const srcLangCode = LANGUAGES[srcIdx].translateCode;
  const tgtLangCode = LANGUAGES[tgtIdx].translateCode;
  const azureVoicesSrc = VOICE_OPTIONS_AZURE[srcLangCode] || [];
  const azureVoicesTgt = VOICE_OPTIONS_AZURE[tgtLangCode] || [];
  const voicesListSrc = provider === 'elevenlabs' ? VOICE_OPTIONS_ELEVENLABS : azureVoicesSrc;
  const voicesListTgt = provider === 'elevenlabs' ? VOICE_OPTIONS_ELEVENLABS : azureVoicesTgt;
  const isMicListening = (langType) => activeManualLang === langType;

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

        <Text style={styles.headerTitle}>Giao tiếp nhanh</Text>

        <TouchableOpacity style={styles.settingsBtn} onPress={() => setSettingsVisible(true)}>
          <Feather name="settings" size={16} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.chatStage}>
      {/* CHAT LOG VIEW (REPLACES PRESET SUGGESTIONS GRID) */}
      <ScrollView
        ref={scrollViewRef}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
        style={styles.chatLog}
        contentContainerStyle={styles.chatListContent}
      >
        {chatLog.length === 0 ? (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconWrapper}>
              <Feather name="zap" size={24} color={colors.accent1} />
            </View>
            <Text style={styles.emptyTextTitle}>Giao tiếp siêu tốc</Text>
            <Text style={styles.emptyTextSub}>
              {micMode === 'hold' 
                ? 'Nhấn và Giữ nút Micro bên dưới để nói, nhả tay ra hệ thống sẽ dịch và phát loa ngay lập tức.'
                : 'Nhấp chạm nút Micro để nói, nói xong im lặng khoảng 1 giây hệ thống sẽ tự động ngắt và dịch.'}
            </Text>
          </View>
        ) : (
          chatLog.map((chat) => (
            <View key={chat.id} style={[styles.bubbleContainer, chat.isUser ? styles.bubbleRight : styles.bubbleLeft]}>
              <View style={[styles.bubbleCard, chat.isUser ? styles.cardUser : styles.cardPartner]}>
                <Text style={[styles.bubbleSource, { fontSize: fontSize - 2 }]}>{chat.sourceText}</Text>
                <View style={styles.bubbleFooter}>
                  <Text style={[styles.bubbleTarget, { fontSize: fontSize }]}>{chat.translatedText}</Text>
                  <TouchableOpacity
                    onPress={() => handleReplay(chat.translatedText, chat.toLang)}
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
        {liveText.trim() !== '' && (
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
            <Text style={styles.loadingText}>Đang dịch siêu tốc...</Text>
          </View>
        )}
      </ScrollView>

      {/* MIC CONTROL ZONE */}
      <View style={styles.actionArea}>
        <View style={styles.bottomMicCard}>
          {/* Source Mic */}
          <View style={styles.circleMicColumn}>
            <View style={styles.circleMicWrapper}>
              {isMicListening('src') && (
                <MicrophonePulse isRecording={true} color={colors.danger} size={64} />
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
                {...(micMode === 'click' ? {
                  onPress: () => activeManualLang === 'src' ? stopClickRecording() : startRecordingLoop('src')
                } : {
                  onPressIn: () => startRecordingLoop('src'),
                  onPressOut: stopHoldRecording
                })}
              >
                <Feather
                  name={isMicListening('src') ? (micMode === 'click' ? "square" : "mic") : "mic"}
                  size={22}
                  color="#fff"
                />
              </TouchableOpacity>
            </View>
            <Text style={[styles.circleMicLabel, isMicListening('src') && styles.circleMicLabelActive]}>
              {LANGUAGES[srcIdx].flag} {micMode === 'hold' ? 'Giữ nói' : LANGUAGES[srcIdx].name}
            </Text>
          </View>

          {/* Spacer */}
          <View style={styles.micCenterSeparator}>
            <Feather name="zap" size={14} color={colors.accent1} />
            <Text style={styles.micCenterText}>Cấp tốc</Text>
          </View>

          {/* Target Mic */}
          <View style={styles.circleMicColumn}>
            <View style={styles.circleMicWrapper}>
              {isMicListening('tgt') && (
                <MicrophonePulse isRecording={true} color={colors.danger} size={64} />
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
                {...(micMode === 'click' ? {
                  onPress: () => activeManualLang === 'tgt' ? stopClickRecording() : startRecordingLoop('tgt')
                } : {
                  onPressIn: () => startRecordingLoop('tgt'),
                  onPressOut: stopHoldRecording
                })}
              >
                <Feather
                  name={isMicListening('tgt') ? (micMode === 'click' ? "square" : "mic") : "mic"}
                  size={22}
                  color="#fff"
                />
              </TouchableOpacity>
            </View>
            <Text style={[styles.circleMicLabel, isMicListening('tgt') && styles.circleMicLabelActive]}>
              {LANGUAGES[tgtIdx].flag} {micMode === 'hold' ? 'Giữ nói' : LANGUAGES[tgtIdx].name}
            </Text>
          </View>
        </View>
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
              <Text style={styles.modalTitle}>⚙️ Cài đặt Giao tiếp nhanh</Text>
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

              {/* Mobile STT engine replacing Web Speech on native devices */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Nhận dạng giọng nói (STT)</Text>
                <View style={styles.btnGroup}>
                  <View style={[styles.btnGroupItem, styles.btnGroupItemActive]}>
                    <Text style={styles.btnGroupText}>Native Speech</Text>
                  </View>
                </View>
              </View>

              {/* Provider Button Group */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Nhà cung cấp giọng nói (TTS)</Text>
                <View style={styles.btnGroup}>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, provider === 'azure' && styles.btnGroupItemActive]}
                    onPress={() => setProvider('azure')}
                  >
                    <Text style={styles.btnGroupText}>Azure</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, provider === 'elevenlabs' && styles.btnGroupItemActive]}
                    onPress={() => setProvider('elevenlabs')}
                  >
                    <Text style={styles.btnGroupText}>ElevenLabs</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Speed Settings */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Tốc độ phát âm: {speed.toFixed(1)}x</Text>
                <View style={styles.adjustRow}>
                  <TouchableOpacity onPress={() => setSpeed(Math.max(0.8, speed - 0.1))} style={styles.adjustBtn}>
                    <Text style={styles.adjustBtnText}>-</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSpeed(Math.min(2.0, speed + 0.1))} style={styles.adjustBtn}>
                    <Text style={styles.adjustBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Mic Mode Picker */}
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Chế độ Micro</Text>
                <View style={styles.btnGroup}>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, micMode === 'click' && styles.btnGroupItemActive]}
                    onPress={() => setMicMode('click')}
                  >
                    <Text style={styles.btnGroupText}>Bấm nói</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, micMode === 'hold' && styles.btnGroupItemActive]}
                    onPress={() => setMicMode('hold')}
                  >
                    <Text style={styles.btnGroupText}>Nhấn giữ</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Silence Seconds Settings */}
              {micMode === 'click' && (
                <View style={styles.settingItem}>
                  <Text style={styles.settingLabel}>Thời gian im lặng ngắt mic: {silenceSeconds.toFixed(1)}s</Text>
                  <View style={styles.adjustRow}>
                    <TouchableOpacity onPress={() => setSilenceSeconds(Math.max(0.8, silenceSeconds - 0.2))} style={styles.adjustBtn}>
                      <Text style={styles.adjustBtnText}>-</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setSilenceSeconds(Math.min(3.0, silenceSeconds + 0.2))} style={styles.adjustBtn}>
                      <Text style={styles.adjustBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Switch options */}
              <View style={styles.switchRow}>
                <Text style={styles.settingLabel}>Tự động phát giọng nói dịch</Text>
                <Switch value={autoTTS} onValueChange={setAutoTTS} trackColor={{ true: colors.selectedSolid || colors.accent1 }} />
              </View>

              {/* Voice Selector Source */}
              <View style={styles.voiceSection}>
                <Text style={styles.settingLabel}>{LANGUAGES[srcIdx].flag} Giọng {LANGUAGES[srcIdx].name}</Text>
                <ScrollView style={styles.voiceScroll} nestedScrollEnabled>
                  {voicesListSrc.map((v) => (
                    <TouchableOpacity
                      key={v.id}
                      style={[styles.voiceItem, srcVoice === v.id && styles.voiceItemActive]}
                      onPress={() => setSrcVoice(v.id)}
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
                      style={[styles.voiceItem, tgtVoice === v.id && styles.voiceItemActive]}
                      onPress={() => setTgtVoice(v.id)}
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
    marginBottom: 10,
  },
  speakerRow: {
    flexDirection: 'row',
    gap: 8,
  },
  speakerBtn: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusSm,
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
    fontSize: 14,
    fontWeight: 'bold',
    color: colors.text,
  },
  settingsBtn: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusSm,
    width: 32,
    height: 32,
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
    flexGrow: 1,
    padding: 14,
    paddingBottom: 132,
    gap: 14,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  emptyIconWrapper: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(14, 165, 233, 0.15)' : 'rgba(14, 165, 233, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTextTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '900',
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: 0,
  },
  emptyTextSub: {
    fontSize: 13,
    color: colors.text2,
    lineHeight: 19,
    textAlign: 'center',
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
    color: colors.accent2,
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
    backgroundColor: colors.selectedBg || 'rgba(6,182,212,0.15)',
    borderColor: colors.selectedBorder || colors.accent2,
  },
  btnGroupText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: 'bold',
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
    backgroundColor: colors.selectedBg || 'rgba(6,182,212,0.15)',
    borderColor: colors.selectedBorder || colors.accent2,
  },
  voiceItemText: {
    color: colors.text2,
    fontSize: 12,
  },
  voiceItemTextActive: {
    color: colors.selectedText || colors.accent2,
    fontWeight: 'bold',
  },
  saveBtn: {
    backgroundColor: colors.accent2,
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
