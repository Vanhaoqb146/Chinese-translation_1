import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Animated,
  Vibration,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import { COLORS, SIZES, DARK_COLORS, LIGHT_COLORS } from './src/theme';
import * as api from './src/services/api';
import Voice from './src/services/speechRecognition';
import StandardPanel from './src/components/StandardPanel';
import ConversationPanel from './src/components/ConversationPanel';
import QuickTalkPanel from './src/components/QuickTalkPanel';
import SimultaneousPanel from './src/components/SimultaneousPanel';
import { TRANSLATION_MODELS, DEFAULT_TRANSLATION_MODEL, normalizeTranslationModel } from './src/lib/translationModels';
import { startBackgroundService, stopBackgroundService } from './src/services/speechAudioRecorder';

const LANGUAGES = [
  { flag: '🇨🇳', name: '中文', translateCode: 'zh', ttsCode: 'zh-CN', ttsVoice: 'zh-CN-XiaoxiaoMultilingualNeural' },
  { flag: '🇻🇳', name: 'Tiếng Việt', translateCode: 'vi', ttsCode: 'vi-VN', ttsVoice: 'vi-VN-HoaiMyNeural' },
  { flag: '🇺🇸', name: 'English', translateCode: 'en', ttsCode: 'en-US', ttsVoice: 'en-US-JennyMultilingualNeural' },
  { flag: '🇯🇵', name: '日本語', translateCode: 'ja', ttsCode: 'ja-JP', ttsVoice: 'ja-JP-NanamiNeural' },
  { flag: '🇰🇷', name: '한국어', translateCode: 'ko', ttsCode: 'ko-KR', ttsVoice: 'ko-KR-SunHiNeural' },
];

const createEmptySessionChatLogs = () => ({
  conversation: [],
  quick: [],
  simultaneous: [],
});

const LOGIN_GRID_ROWS = [0, 1, 2, 3, 4, 5, 6];
const LOGIN_GRID_COLUMNS = [0, 1, 2, 3, 4];
const LOGIN_WAVE_BAR_HEIGHTS = [18, 30, 46, 28, 56, 34, 62, 40, 54, 30, 44, 24, 36, 20];
const LOGIN_SIGNAL_NODES = [
  { id: 'node-1', top: '13%', left: '18%', size: 4, tone: 'accent2', opacity: 0.42 },
  { id: 'node-2', top: '21%', left: '78%', size: 6, tone: 'success', opacity: 0.34 },
  { id: 'node-3', top: '39%', left: '12%', size: 5, tone: 'accent1', opacity: 0.28 },
  { id: 'node-4', top: '58%', left: '86%', size: 4, tone: 'warning', opacity: 0.26 },
  { id: 'node-5', top: '76%', left: '22%', size: 5, tone: 'accent3', opacity: 0.32 },
];

export default function App() {
  // Login signal-field animations: no gesture hooks, so inputs remain untouched.
  const signalDrift = useRef(new Animated.Value(0)).current;
  const signalPulse = useRef(new Animated.Value(0)).current;
  const scanLine = useRef(new Animated.Value(0)).current;
  const waveBars = useRef(
    LOGIN_WAVE_BAR_HEIGHTS.map((_, index) => new Animated.Value(index % 2 === 0 ? 0.72 : 0.48))
  ).current;

  // Trigger loop animations on mount
  useEffect(() => {
    const driftLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(signalDrift, {
          toValue: 1,
          duration: 15000,
          useNativeDriver: true,
        }),
        Animated.timing(signalDrift, {
          toValue: 0,
          duration: 17000,
          useNativeDriver: true,
        }),
      ])
    );

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(signalPulse, {
          toValue: 1,
          duration: 2600,
          useNativeDriver: true,
        }),
        Animated.timing(signalPulse, {
          toValue: 0,
          duration: 3000,
          useNativeDriver: true,
        }),
      ])
    );

    const scanLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLine, {
          toValue: 1,
          duration: 4200,
          useNativeDriver: true,
        }),
        Animated.delay(1200),
        Animated.timing(scanLine, {
          toValue: 0,
          duration: 1,
          useNativeDriver: true,
        }),
      ])
    );

    const waveAnimations = waveBars.map((bar, index) => (
      Animated.loop(
        Animated.sequence([
          Animated.timing(bar, {
            toValue: 1.12 + (index % 4) * 0.08,
            duration: 820 + index * 34,
            useNativeDriver: true,
          }),
          Animated.timing(bar, {
            toValue: 0.42 + (index % 3) * 0.1,
            duration: 920 + index * 28,
            useNativeDriver: true,
          }),
        ])
      )
    ));

    driftLoop.start();
    pulseLoop.start();
    scanLoop.start();
    waveAnimations.forEach((anim) => anim.start());

    return () => {
      driftLoop.stop();
      pulseLoop.stop();
      scanLoop.stop();
      waveAnimations.forEach((anim) => anim.stop());
    };
  }, [signalDrift, signalPulse, scanLine, waveBars]);

  // Navigation & Session
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Focus States for Inputs
  const [userFocus, setUserFocus] = useState(false);
  const [passFocus, setPassFocus] = useState(false);

  // App Configurations
  const [apiBase, setApiBase] = useState(api.DEFAULT_API_BASE);
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_TRANSLATION_MODEL);
  const [theme, setTheme] = useState('dark'); // 'dark' | 'light'
  const [menuCollapsed, setMenuCollapsed] = useState(false);

  const themeColors = theme === 'dark' ? DARK_COLORS : LIGHT_COLORS;
  const styles = useMemo(() => getStyles(themeColors), [themeColors]);

  const [viewMode, setViewMode] = useState('standard');
  const activeModeLabel = {
    standard: 'Dịch thuật',
    conversation: 'Giao tiếp',
    quick: 'Giao tiếp nhanh',
    simultaneous: 'Giao tiếp song song',
    history: 'Lịch sử',
    settings: 'Cài đặt',
  }[viewMode] || 'VoiceTranslate';

  // Translation Panel State
  const [srcIdx, setSrcIdx] = useState(0); // Default: Chinese
  const [tgtIdx, setTgtIdx] = useState(1); // Default: Vietnamese
  const [sourceText, setSourceText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);

  // Recording & Playback State
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [sound, setSound] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  
  // Live STT States
  const [partialText, setPartialText] = useState('');
  const [finalText, setFinalText] = useState('');
  const partialTextRef = useRef('');
  const finalTextRef = useRef('');

  // History State
  const [historyList, setHistoryList] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessionChatLogs, setSessionChatLogs] = useState(createEmptySessionChatLogs);

  const ttsPlayerRef = useRef(null);
  const ttsSessionIdRef = useRef(0);
  const recordingRef = useRef(null);
  const isRecordingRef = useRef(false);
  const historyRequestRef = useRef(null);
  const isStartingRecognitionRef = useRef(false);
  const recognitionStopRequestedRef = useRef(false);
  const recognitionSessionRef = useRef(0);
  const recognitionHandledRef = useRef(false);
  const recognitionStopFallbackRef = useRef(null);
  const finalizeRecognitionRef = useRef(null);

  // Load user session and configurations on mount
  useEffect(() => {
    async function loadSession() {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
          staysActiveInBackground: true,
        });

        const savedUser = await api.getSavedUser();
        if (savedUser) setUser(savedUser);

        const currentBase = await api.getApiBaseUrl();
        setApiBase(currentBase);

        const configs = await api.getLocalConfigs();
        setApiKey(configs.apiKey);
        setSelectedModel(normalizeTranslationModel(configs.model));

        const savedTheme = await api.getAppTheme();
        setTheme(savedTheme);
      } catch (e) {
        console.warn('Failed to load local config storage:', e);
      } finally {
        setAuthChecked(true);
      }
    }
    loadSession();
  }, []);

  const loadHistory = useCallback(() => {
    if (!user) return Promise.resolve();
    if (historyRequestRef.current) return historyRequestRef.current;

    setHistoryLoading(true);
    const request = api.fetchHistory(user.username)
      .then((list) => {
        setHistoryList(list);
      })
      .catch((error) => {
        if (api.isAuthenticationError(error)) {
          setUser(null);
          setHistoryList([]);
          setSessionChatLogs(createEmptySessionChatLogs());
          setViewMode('standard');
          Alert.alert(
            'Phiên đăng nhập hết hạn',
            'Vui lòng đăng nhập lại để tiếp tục sử dụng.'
          );
          return;
        }

        console.warn('History fetch error:', error);
      })
      .finally(() => {
        if (historyRequestRef.current === request) {
          historyRequestRef.current = null;
        }
        setHistoryLoading(false);
      });

    historyRequestRef.current = request;
    return request;
  }, [user]);

  // Fetch History once user changes or logs in
  useEffect(() => {
    if (user) {
      loadHistory();
    }
  }, [user, loadHistory]);

  const updateSessionChatLog = useCallback((mode, nextValue) => {
    setSessionChatLogs((prev) => {
      const currentLog = prev[mode] || [];
      const nextLog = typeof nextValue === 'function' ? nextValue(currentLog) : nextValue;

      return {
        ...prev,
        [mode]: Array.isArray(nextLog) ? nextLog : [],
      };
    });
  }, []);

  const setConversationChatLog = useCallback((nextValue) => {
    updateSessionChatLog('conversation', nextValue);
  }, [updateSessionChatLog]);

  const setQuickChatLog = useCallback((nextValue) => {
    updateSessionChatLog('quick', nextValue);
  }, [updateSessionChatLog]);

  const setSimultaneousChatLog = useCallback((nextValue) => {
    updateSessionChatLog('simultaneous', nextValue);
  }, [updateSessionChatLog]);

  // Auth: handle login submission
  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      Alert.alert('Lỗi', 'Vui lòng điền đầy đủ tài khoản và mật khẩu.');
      return;
    }
    setAuthLoading(true);
    try {
      const loggedUser = await api.login(username, password);
      setUser(loggedUser);
    } catch (error) {
      Alert.alert('Đăng nhập thất bại', error.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // Auth: handle logout
  const handleLogout = async () => {
    Alert.alert('Đăng xuất', 'Bạn có chắc chắn muốn đăng xuất?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Đăng xuất',
        style: 'destructive',
        onPress: async () => {
          await api.logout();
          setUser(null);
          setHistoryList([]);
          setSessionChatLogs(createEmptySessionChatLogs());
          setSourceText('');
          setTranslatedText('');
          setPartialText('');
          setFinalText('');
          partialTextRef.current = '';
          finalTextRef.current = '';
          setViewMode('standard');
        },
      },
    ]);
  };

  // Save base URL changes
  const saveBaseUrl = async (newUrl) => {
    try {
      await api.setApiBaseUrl(newUrl);
      setApiBase(newUrl);
    } catch (e) {
      Alert.alert('Lỗi', 'Không thể lưu máy chủ mới.');
    }
  };

  const handleThemeChange = async (newTheme) => {
    setTheme(newTheme);
    await api.saveAppTheme(newTheme);
  };

  // Save Settings panel configuration
  const handleSaveSettings = async () => {
    try {
      await api.saveLocalConfigs(apiKey, selectedModel);
      Alert.alert('Thành công', 'Cấu hình đã được lưu an toàn.');
    } catch (e) {
      Alert.alert('Lỗi', 'Không thể lưu cài đặt.');
    }
  };

  // Swap Source and Target Languages
  const swapLanguages = () => {
    setSrcIdx(tgtIdx);
    setTgtIdx(srcIdx);
    // Clear texts during language swap
    setSourceText('');
    setTranslatedText('');
    stopAudio();
  };

  // STT: Start audio recognition.
  const startRecording = async () => {
    if (Platform.OS === 'android') Vibration.vibrate([0, 100]);
    if (isRecordingRef.current || isStartingRecognitionRef.current) return;

    const sessionId = recognitionSessionRef.current + 1;
    recognitionSessionRef.current = sessionId;
    recognitionHandledRef.current = false;
    recognitionStopRequestedRef.current = false;
    isStartingRecognitionRef.current = true;
    finalizeRecognitionRef.current = null;
    if (recognitionStopFallbackRef.current) {
      clearTimeout(recognitionStopFallbackRef.current);
      recognitionStopFallbackRef.current = null;
    }
    isRecordingRef.current = true;
    setIsRecording(true);
    setPartialText('');
    setFinalText('');
    partialTextRef.current = '';
    finalTextRef.current = '';

    try {
      // 1. Request microphone permission
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        isStartingRecognitionRef.current = false;
        isRecordingRef.current = false;
        setIsRecording(false);
        Alert.alert('Quyền truy cập', 'Vui lòng cấp quyền Microphone để thực hiện nhận dạng giọng nói.');
        return;
      }

      await stopAudio();
      await startBackgroundService(
        'VoiceTranslate AI đang nghe...',
        'Nhận dạng giọng nói đang hoạt động.'
      );

      // Configure Voice listeners dynamically before starting
      Voice.onSpeechStart = () => {
        setPartialText('');
        setFinalText('');
        partialTextRef.current = '';
        finalTextRef.current = '';
      };
      Voice.onSpeechResults = (e) => {
        if (e.value && e.value[0]) {
          setFinalText(e.value[0]);
          finalTextRef.current = e.value[0];
        }
      };
      Voice.onSpeechPartialResults = (e) => {
        if (e.value && e.value[0]) {
          setPartialText(e.value[0]);
          partialTextRef.current = e.value[0];
        }
      };
      Voice.onSpeechError = (e) => {
        if (sessionId !== recognitionSessionRef.current) return;

        const isExpectedStopError =
          recognitionStopRequestedRef.current &&
          (e?.error === 'client' || Number(e?.code) === 5);
        const isNoSpeech =
          e?.error === 'no-speech' ||
          e?.error === 'speech-timeout';

        if (!isExpectedStopError && !isNoSpeech) {
          console.warn('Voice recognition error:', e);
        }
      };
      const finalizeRecognition = () => {
        if (sessionId !== recognitionSessionRef.current || recognitionHandledRef.current) {
          return;
        }

        recognitionHandledRef.current = true;
        isStartingRecognitionRef.current = false;
        isRecordingRef.current = false;
        setIsRecording(false);

        if (recognitionStopFallbackRef.current) {
          clearTimeout(recognitionStopFallbackRef.current);
          recognitionStopFallbackRef.current = null;
        }

        const textToTranslate = finalTextRef.current || partialTextRef.current;
        if (textToTranslate?.trim()) {
          processVoiceTranslationText(textToTranslate.trim());
        } else {
          stopBackgroundService();
        }
      };
      finalizeRecognitionRef.current = finalizeRecognition;
      Voice.onRecognitionEnd = finalizeRecognition;

      const srcLang = LANGUAGES[srcIdx].translateCode;
      const speechLocale = srcLang === 'zh' ? 'zh-CN' : 
                           srcLang === 'vi' ? 'vi-VN' : 
                           srcLang === 'en' ? 'en-US' : 
                           srcLang === 'ja' ? 'ja-JP' : 
                           srcLang === 'ko' ? 'ko-KR' : 'vi-VN';

      await Voice.start(speechLocale);
      isStartingRecognitionRef.current = false;

      if (recognitionStopRequestedRef.current && sessionId === recognitionSessionRef.current) {
        recognitionStopFallbackRef.current = setTimeout(() => {
          finalizeRecognitionRef.current?.();
        }, 1500);
        await Voice.stop();
      }
    } catch (err) {
      if (sessionId !== recognitionSessionRef.current) return;
      console.error('Failed to start Voice recording', err);
      isStartingRecognitionRef.current = false;
      recognitionStopRequestedRef.current = false;
      isRecordingRef.current = false;
      setIsRecording(false);
      Alert.alert('Lỗi', 'Không thể khởi động bộ nhận dạng giọng nói.');
    }
  };

  // STT: Stop Recording
  const stopRecording = async () => {
    if (Platform.OS === 'android') Vibration.vibrate([0, 100]);
    if (!isRecordingRef.current && !isStartingRecognitionRef.current) return;

    recognitionStopRequestedRef.current = true;
    isRecordingRef.current = false;
    setIsRecording(false);

    if (isStartingRecognitionRef.current) return;

    try {
      recognitionStopFallbackRef.current = setTimeout(() => {
        finalizeRecognitionRef.current?.();
      }, 1500);
      await Voice.stop();
    } catch (err) {
      console.error('Failed to stop Voice recording', err);
    }
  };

  // Live Text translation process (No Whisper audio file uploading)
  const processVoiceTranslationText = async (text) => {
    setIsTranslating(true);
    setSourceText(text);
    setTranslatedText('Đang dịch thuật...');

    try {
      const srcLang = LANGUAGES[srcIdx];
      const tgtLang = LANGUAGES[tgtIdx];

      // GPT Translate
      const translation = await api.translateText({
        text: text,
        sourceLang: srcLang.translateCode,
        targetLang: tgtLang.translateCode,
        engine: selectedModel,
        apiKey,
      });

      setTranslatedText(translation);

      // Play edge TTS
      playTts(translation, tgtLang.ttsCode, tgtLang.ttsVoice);

      // Save translation in History database
      await api.saveHistory({
        userId: user.username,
        source: text,
        target: translation,
        fromLang: srcLang.translateCode,
        toLang: tgtLang.translateCode,
      });

      loadHistory();
    } catch (e) {
      console.error('Live translation processing failed:', e);
      setTranslatedText(`Lỗi kết nối: ${e.message}`);
      stopBackgroundService();
    } finally {
      setIsTranslating(false);
    }
  };

  // TTS: Fetch and Play Speech synthesis with dynamic options (provider, speed)
  const playTts = async (text, lang, voice, options = {}) => {
    const sessionId = ++ttsSessionIdRef.current;
    try {
      await stopAudio();

      const { provider = 'azure', speed = 1.0 } = options;
      const audioSource = await api.getTtsAudioSource({ text, lang, voice, provider });
      
      if (sessionId !== ttsSessionIdRef.current) {
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true, // Keep it true so it doesn't break recording permissions state
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: true,
      });

      let newSound = null;
      try {
        const { sound } = await Audio.Sound.createAsync(
          audioSource,
          { shouldPlay: false }
        );
        newSound = sound;
      } catch (loadError) {
        console.warn('[🔊 TTS] Failed to create sound:', loadError);
        throw loadError;
      }

      if (sessionId !== ttsSessionIdRef.current) {
        console.log(`[🔊 TTS] Session ${sessionId} superseded by ${ttsSessionIdRef.current}. Unloading sound.`);
        await newSound.unloadAsync();
        return;
      }

      const handleStatusUpdate = async (status) => {
        if (!status?.isLoaded) {
          if (ttsPlayerRef.current === newSound) {
            ttsPlayerRef.current = null;
            setSound(null);
            setIsPlaying(false);
            if (viewMode === 'standard') {
              await stopBackgroundService();
            }
            if (options.onPlaybackFinished) {
              try { options.onPlaybackFinished(); } catch (e) {}
            }
          }
          return;
        }

        if (status.error) {
          console.warn('[🔊 TTS] Playback status error:', status.error);
          setIsPlaying(false);
          if (ttsPlayerRef.current === newSound) {
            ttsPlayerRef.current = null;
          }
          try {
            await newSound.unloadAsync();
          } catch (e) {}
          setSound(null);
          if (viewMode === 'standard') {
            await stopBackgroundService();
          }
          if (options.onPlaybackFinished) {
            try { options.onPlaybackFinished(); } catch (e) {}
          }
          return;
        }

        if (status.didJustFinish) {
          setIsPlaying(false);
          if (ttsPlayerRef.current === newSound) {
            ttsPlayerRef.current = null;
          }
          try {
            await newSound.unloadAsync();
          } catch (e) {}
          setSound(null);
          if (viewMode === 'standard') {
            await stopBackgroundService();
          }
          if (options.onPlaybackFinished) {
            try { options.onPlaybackFinished(); } catch (e) {}
          }
        }
      };

      try {
        ttsPlayerRef.current = newSound;
        setSound(newSound);
        setIsPlaying(true);

        if (speed !== 1.0) {
          await newSound.setRateAsync(speed, true);
        }

        newSound.setOnPlaybackStatusUpdate(handleStatusUpdate);

        await newSound.playAsync();
      } catch (configError) {
        console.warn('[🔊 TTS] Configuration/playback error:', configError);
        if (newSound) {
          try { await newSound.unloadAsync(); } catch (e) {}
        }
        ttsPlayerRef.current = null;
        setSound(null);
        setIsPlaying(false);
        throw configError;
      }
    } catch (error) {
      console.warn('[🔊 TTS] playTts general error:', error);
      if (viewMode === 'standard') {
        await stopBackgroundService();
      }
      if (options.onPlaybackFinished) {
        try { options.onPlaybackFinished(); } catch (e) {}
      }
    }
  };

  // Stop currently playing audio streams
  const stopAudio = async () => {
    const soundToStop = ttsPlayerRef.current || sound;
    if (soundToStop) {
      ttsPlayerRef.current = null;
      try {
        await soundToStop.stopAsync();
        await soundToStop.unloadAsync();
      } catch (e) {
        // ignore errors on already closed sessions
      }
      setSound(null);
      setIsPlaying(false);
    }
  };

  // History: Delete a record
  const deleteHistoryItem = async (id) => {
    try {
      await api.deleteHistory(id);
      setHistoryList((prev) => prev.filter((item) => item.id !== id));
    } catch (e) {
      Alert.alert('Lỗi', 'Không thể xóa mục lịch sử.');
    }
  };

  // History: Clear all history of current user
  const clearAllHistory = async () => {
    Alert.alert('Xóa lịch sử', 'Bạn có chắc chắn muốn xóa toàn bộ lịch sử dịch thuật?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa tất cả',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteHistory(null, user.username);
            setHistoryList([]);
          } catch (e) {
            Alert.alert('Lỗi', 'Không thể xóa lịch sử.');
          }
        },
      },
    ]);
  };

  if (!authChecked) {
    return (
      <SafeAreaProvider>
        <View style={[styles.app, styles.center]}>
          <ActivityIndicator size="large" color={COLORS.accent1} />
        </View>
      </SafeAreaProvider>
    );
  }

  // =============== LOGIN INTERFACE ===============
  if (!user) {
    const colors = themeColors;
    return (
      <SafeAreaProvider>
      <SafeAreaView style={[styles.app, styles.loginApp]}>
        <StatusBar style="light" />

        <View style={styles.loginBackdrop} pointerEvents="none">
          <View style={styles.loginBeamTop} />
          <View style={styles.loginBeamBottom} />

          <View style={styles.loginGrid}>
            {LOGIN_GRID_ROWS.map((row) => (
              <View
                key={`login-grid-row-${row}`}
                style={[styles.loginGridLineH, { top: `${12 + row * 13}%` }]}
              />
            ))}
            {LOGIN_GRID_COLUMNS.map((column) => (
              <View
                key={`login-grid-column-${column}`}
                style={[styles.loginGridLineV, { left: `${12 + column * 19}%` }]}
              />
            ))}
          </View>

          <Animated.View
            style={[
              styles.loginSignalPlane,
              {
                transform: [
                  {
                    translateX: signalDrift.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-18, 22],
                    }),
                  },
                  {
                    translateY: signalDrift.interpolate({
                      inputRange: [0, 1],
                      outputRange: [12, -14],
                    }),
                  },
                  { rotate: '-8deg' },
                ],
              },
            ]}
          >
            <View style={[styles.loginSignalRail, styles.loginSignalRailTop]} />
            <View style={[styles.loginSignalRail, styles.loginSignalRailMid]} />
            <View style={[styles.loginSignalRail, styles.loginSignalRailBottom]} />
          </Animated.View>

          {LOGIN_SIGNAL_NODES.map((node) => (
            <Animated.View
              key={node.id}
              style={[
                styles.loginSignalNode,
                {
                  top: node.top,
                  left: node.left,
                  width: node.size,
                  height: node.size,
                  backgroundColor: colors[node.tone] || colors.accent1,
                  opacity: signalPulse.interpolate({
                    inputRange: [0, 1],
                    outputRange: [node.opacity, Math.min(node.opacity + 0.24, 0.68)],
                  }),
                },
              ]}
            />
          ))}

          <Animated.View
            style={[
              styles.loginScanLine,
              {
                opacity: scanLine.interpolate({
                  inputRange: [0, 0.12, 0.72, 1],
                  outputRange: [0, 0.42, 0.18, 0],
                }),
                transform: [
                  {
                    translateY: scanLine.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-90, 720],
                    }),
                  },
                ],
              },
            ]}
          />
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={[styles.container, styles.loginContainer]}
        >
          <View style={styles.loginCard}>
            <View style={styles.logoArea}>
              <View style={styles.logoSignalWrap}>
                <Animated.View
                  style={[
                    styles.logoSignalRing,
                    styles.logoSignalRingOuter,
                    {
                      opacity: signalPulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.18, 0.44],
                      }),
                      transform: [
                        {
                          scale: signalPulse.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0.96, 1.08],
                          }),
                        },
                      ],
                    },
                  ]}
                />
                <Animated.View
                  style={[
                    styles.logoSignalRing,
                    styles.logoSignalRingInner,
                    {
                      opacity: signalPulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.28, 0.58],
                      }),
                    },
                  ]}
                />
                <View style={styles.logoIconCircle}>
                  <Feather name="mic" size={30} color="#fff" />
                </View>
              </View>
              <Text style={styles.logoText} numberOfLines={1}>VoiceTranslate <Text style={styles.logoBadge}>AI</Text></Text>
              <View style={styles.loginWaveform} pointerEvents="none">
                {waveBars.map((bar, index) => (
                  <Animated.View
                    key={`login-wave-${index}`}
                    style={[
                      styles.loginWaveBar,
                      {
                        height: LOGIN_WAVE_BAR_HEIGHTS[index],
                        backgroundColor: index === 5 ? colors.success : index === 10 ? colors.warning : colors.accent2,
                        opacity: 0.42 + (index % 5) * 0.08,
                        transform: [{ scaleY: bar }],
                      },
                    ]}
                  />
                ))}
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Tài khoản</Text>
              <View style={[styles.inputWrapper, userFocus && styles.inputWrapperFocused]}>
                <Feather name="user" size={16} color={userFocus ? colors.accent1 : colors.muted} style={styles.inputIcon} />
                <TextInput
                  style={styles.inputField}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Nhập tài khoản"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  onFocus={() => setUserFocus(true)}
                  onBlur={() => setUserFocus(false)}
                />
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Mật khẩu</Text>
              <View style={[styles.inputWrapper, passFocus && styles.inputWrapperFocused]}>
                <Feather name="lock" size={16} color={passFocus ? colors.accent1 : colors.muted} style={styles.inputIcon} />
                <TextInput
                  style={styles.inputField}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Nhập mật khẩu"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  autoCapitalize="none"
                  onFocus={() => setPassFocus(true)}
                  onBlur={() => setPassFocus(false)}
                />
              </View>
            </View>

            {authLoading ? (
              <ActivityIndicator size="small" color={colors.accent1} style={styles.loginLoading} />
            ) : (
              <TouchableOpacity style={styles.loginBtn} onPress={handleLogin} activeOpacity={0.85}>
                <View style={styles.loginBtnContent}>
                  <Text style={styles.loginBtnText}>Đăng Nhập</Text>
                  <Feather name="log-in" size={16} color="#fff" />
                </View>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  // =============== MAIN APPLICATION INTERFACE ===============
  return (
    <SafeAreaProvider>
    <SafeAreaView style={styles.app}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      
      {/* Background pastel orbs for a premium colorful look */}
      <View style={styles.loginBgOrb1} />
      <View style={styles.loginBgOrb2} />
      <View style={styles.loginBgOrb3} />

      {/* MINI HEADER BRAND LOGO */}
      <View style={styles.header}>
        <View style={styles.logoMini}>
          <View style={styles.logoMiniMark}>
            <Feather name="mic" size={18} color="#fff" />
          </View>
          <View style={styles.logoMiniCopy}>
            <Text style={styles.logoMiniText} numberOfLines={1}>VoiceTranslate <Text style={styles.logoMiniBadge}>AI</Text></Text>
            <View style={styles.logoMiniMeta}>
              <View style={styles.logoMiniDot} />
              <Text style={styles.logoMiniSub} numberOfLines={1}>{activeModeLabel}</Text>
            </View>
          </View>
        </View>

        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.menuToggleBtn}
            onPress={() => setMenuCollapsed((visible) => !visible)}
            activeOpacity={0.82}
          >
            <Feather
              name={menuCollapsed ? 'menu' : 'chevron-up'}
              size={16}
              color={themeColors.text}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Feather name="log-out" size={14} color={themeColors.danger} />
          </TouchableOpacity>
        </View>
      </View>

      {/* HORIZONTAL SLIDING MODE SWITCHER TABS */}
      {!menuCollapsed && (
      <View style={styles.modeSwitcherContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeSwitcherScroll}>
          <TouchableOpacity
            style={[styles.modeTab, viewMode === 'standard' && styles.modeTabActive]}
            onPress={() => { setViewMode('standard'); stopAudio(); }}
          >
            <Feather
              name="file-text"
              size={13}
              color={viewMode === 'standard' ? themeColors.selectedText : themeColors.text2}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.modeTabText, viewMode === 'standard' && styles.modeTabTextActive]}>Dịch thuật</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, viewMode === 'conversation' && styles.modeTabActive]}
            onPress={() => { setViewMode('conversation'); stopAudio(); }}
          >
            <Feather
              name="message-circle"
              size={13}
              color={viewMode === 'conversation' ? themeColors.selectedText : themeColors.text2}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.modeTabText, viewMode === 'conversation' && styles.modeTabTextActive]}>Giao tiếp</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, viewMode === 'quick' && styles.modeTabActive]}
            onPress={() => { setViewMode('quick'); stopAudio(); }}
          >
            <Feather
              name="zap"
              size={13}
              color={viewMode === 'quick' ? themeColors.selectedText : themeColors.text2}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.modeTabText, viewMode === 'quick' && styles.modeTabTextActive]}>Giao tiếp nhanh</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, viewMode === 'simultaneous' && styles.modeTabActive]}
            onPress={() => { setViewMode('simultaneous'); stopAudio(); }}
          >
            <Feather
              name="mic"
              size={13}
              color={viewMode === 'simultaneous' ? themeColors.selectedText : themeColors.text2}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.modeTabText, viewMode === 'simultaneous' && styles.modeTabTextActive]}>Giao tiếp song song</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, viewMode === 'history' && styles.modeTabActive]}
            onPress={() => { setViewMode('history'); stopAudio(); loadHistory(); }}
          >
            <Feather
              name="clock"
              size={13}
              color={viewMode === 'history' ? themeColors.selectedText : themeColors.text2}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.modeTabText, viewMode === 'history' && styles.modeTabTextActive]}>Lịch sử</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeTab, viewMode === 'settings' && styles.modeTabActive]}
            onPress={() => { setViewMode('settings'); stopAudio(); }}
          >
            <Feather
              name="settings"
              size={13}
              color={viewMode === 'settings' ? themeColors.selectedText : themeColors.text2}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.modeTabText, viewMode === 'settings' && styles.modeTabTextActive]}>Cài đặt</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
      )}

      {/* DYNAMIC SCREEN NAVIGATION ROUTER */}
      {viewMode === 'standard' && (
        <ScrollView contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled">
          {/* LANGUAGE SWAP BAR */}
          <View style={styles.langBar}>
            <View style={styles.langChip}>
              <Text style={styles.langFlag}>{LANGUAGES[srcIdx].flag}</Text>
              <Text style={styles.langName}>{LANGUAGES[srcIdx].name}</Text>
            </View>

            <TouchableOpacity style={styles.swapBtn} onPress={swapLanguages}>
              <Feather name="repeat" size={16} color={themeColors.accent1} />
            </TouchableOpacity>

            <View style={styles.langChip}>
              <Text style={styles.langFlag}>{LANGUAGES[tgtIdx].flag}</Text>
              <Text style={styles.langName}>{LANGUAGES[tgtIdx].name}</Text>
            </View>
          </View>

          <StandardPanel
            srcIdx={srcIdx}
            tgtIdx={tgtIdx}
            LANGUAGES={LANGUAGES}
            sourceText={sourceText}
            setSourceText={setSourceText}
            translatedText={translatedText}
            setTranslatedText={setTranslatedText}
            isTranslating={isTranslating}
            setIsTranslating={setIsTranslating}
            isRecording={isRecording}
            startRecording={startRecording}
            stopRecording={stopRecording}
            playTts={playTts}
            isPlaying={isPlaying}
            user={user}
            apiKey={apiKey}
            selectedModel={selectedModel}
            api={api}
            loadHistory={loadHistory}
            themeColors={themeColors}
            partialText={partialText}
          />
        </ScrollView>
      )}

      {viewMode === 'conversation' && (
        <View style={[styles.panelScreen, menuCollapsed && styles.panelScreenCompact]}>
          <ConversationPanel
            srcIdx={srcIdx}
            tgtIdx={tgtIdx}
            LANGUAGES={LANGUAGES}
            user={user}
            apiKey={apiKey}
            selectedModel={selectedModel}
            api={api}
            playTts={playTts}
            isPlaying={isPlaying}
            stopAudio={stopAudio}
            themeColors={themeColors}
            chatLog={sessionChatLogs.conversation}
            setChatLog={setConversationChatLog}
          />
        </View>
      )}

      {viewMode === 'quick' && (
        <View style={[styles.panelScreen, menuCollapsed && styles.panelScreenCompact]}>
          <QuickTalkPanel
            srcIdx={srcIdx}
            tgtIdx={tgtIdx}
            LANGUAGES={LANGUAGES}
            user={user}
            apiKey={apiKey}
            selectedModel={selectedModel}
            api={api}
            playTts={playTts}
            isPlaying={isPlaying}
            stopAudio={stopAudio}
            themeColors={themeColors}
            chatLog={sessionChatLogs.quick}
            setChatLog={setQuickChatLog}
          />
        </View>
      )}

      {viewMode === 'simultaneous' && (
        <View style={[styles.panelScreen, menuCollapsed && styles.panelScreenCompact]}>
          <SimultaneousPanel
            srcIdx={srcIdx}
            tgtIdx={tgtIdx}
            LANGUAGES={LANGUAGES}
            user={user}
            apiKey={apiKey}
            selectedModel={selectedModel}
            api={api}
            sound={sound}
            setSound={setSound}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            stopAudio={stopAudio}
            themeColors={themeColors}
            chatLog={sessionChatLogs.simultaneous}
            setChatLog={setSimultaneousChatLog}
          />
        </View>
      )}

      {viewMode === 'history' && (
        <ScrollView contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled">
          <View style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <Text style={styles.historyTitle}>📜 LỊCH SỬ DỊCH GẦN ĐÂY</Text>
              {historyList.length > 0 && (
                <TouchableOpacity onPress={clearAllHistory}>
                  <Text style={styles.clearAllBtn}>Xóa tất cả</Text>
                </TouchableOpacity>
              )}
            </View>

            {historyLoading ? (
              <ActivityIndicator size="small" color={themeColors.accent1} style={{ marginVertical: 20 }} />
            ) : historyList.length === 0 ? (
              <Text style={styles.noHistoryText}>Chưa có lịch sử dịch thuật nào.</Text>
            ) : (
              <View style={styles.historyList}>
                {historyList.slice(0, 30).map((item) => (
                  <View key={item.id} style={styles.historyItem}>
                    <View style={styles.historyBody}>
                      <Text style={styles.historySource}>{item.source}</Text>
                      <Text style={styles.historyTarget}>{item.target}</Text>
                    </View>
                    <View style={styles.historyActions}>
                      <TouchableOpacity
                        onPress={() => {
                          const voiceCode = item.toLang === LANGUAGES[tgtIdx].translateCode ? LANGUAGES[tgtIdx].ttsVoice : LANGUAGES[srcIdx].ttsVoice;
                          const ttsCode = item.toLang === LANGUAGES[tgtIdx].translateCode ? LANGUAGES[tgtIdx].ttsCode : LANGUAGES[srcIdx].ttsCode;
                          playTts(item.target, ttsCode, voiceCode);
                        }}
                        style={styles.itemActionBtn}
                      >
                        <Feather name="volume-2" size={14} color={themeColors.text} />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => deleteHistoryItem(item.id)} style={styles.itemActionBtn}>
                        <Feather name="trash-2" size={14} color={themeColors.danger} />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}

      {viewMode === 'settings' && (
        <ScrollView contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled">
          <View style={styles.settingsCard}>
            <Text style={styles.settingTitle}>⚙️ CÀI ĐẶT CẤU HÌNH CHUNG</Text>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>URL MÁY CHỦ (BACKEND API)</Text>
              <TextInput
                style={styles.input}
                value={apiBase}
                onChangeText={saveBaseUrl}
                placeholder="Nhập URL API Server"
                placeholderTextColor={themeColors.muted}
                autoCapitalize="none"
              />
            </View>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>🔑 OPENAI / DEEPSEEK API KEY</Text>
              <TextInput
                style={styles.input}
                value={apiKey}
                onChangeText={setApiKey}
                placeholder="Để trống nếu đã cấu hình env trên Server"
                placeholderTextColor={themeColors.muted}
                secureTextEntry
              />
            </View>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>🤖 ĐỘNG CƠ DỊCH THUẬT (LLM)</Text>
              <View style={styles.modelSelector}>
                {TRANSLATION_MODELS.map((model) => (
                  <TouchableOpacity
                    key={model.id}
                    style={[styles.modelOption, selectedModel === model.id && styles.modelOptionActive]}
                    onPress={() => setSelectedModel(model.id)}
                  >
                    <Text style={[styles.modelOptionText, selectedModel === model.id && styles.modelOptionTextActive]}>
                      {model.label.replace('OpenAI ', '')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>🎨 GIAO DIỆN HỆ THỐNG</Text>
              <View style={styles.modelSelector}>
                <TouchableOpacity
                  style={[styles.modelOption, theme === 'light' && styles.modelOptionActive]}
                  onPress={() => handleThemeChange('light')}
                >
                  <Text style={[styles.modelOptionText, theme === 'light' && styles.modelOptionTextActive]}>☀️ Sáng</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modelOption, theme === 'dark' && styles.modelOptionActive]}
                  onPress={() => handleThemeChange('dark')}
                >
                  <Text style={[styles.modelOptionText, theme === 'dark' && styles.modelOptionTextActive]}>🌙 Tối</Text>
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity style={styles.settingsSaveBtn} onPress={handleSaveSettings}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Feather name="save" size={14} color="#fff" />
                <Text style={styles.settingsSaveBtnText}>Lưu Cài Đặt</Text>
              </View>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
    </SafeAreaProvider>
  );
}

const getStyles = (colors) => StyleSheet.create({
  // General layout
  app: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: Platform.OS === 'android' ? 42 : 0,
  },
  container: {
    flex: 1,
    padding: 20,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: {
    color: colors.muted,
    fontStyle: 'italic',
  },

  // Login Card styles
  loginApp: {
    overflow: 'hidden',
  },
  loginContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: Platform.OS === 'android' ? 28 : 18,
  },
  loginBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
  loginBeamTop: {
    position: 'absolute',
    top: 44,
    left: -90,
    right: -60,
    height: 126,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(14, 165, 233, 0.10)' : 'rgba(14, 165, 233, 0.13)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(125, 211, 252, 0.14)' : 'rgba(2, 132, 199, 0.18)',
    transform: [{ rotate: '-10deg' }],
  },
  loginBeamBottom: {
    position: 'absolute',
    left: -70,
    right: -90,
    bottom: 80,
    height: 150,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(16, 185, 129, 0.07)' : 'rgba(16, 185, 129, 0.10)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(110, 231, 183, 0.12)' : 'rgba(4, 120, 87, 0.14)',
    transform: [{ rotate: '9deg' }],
  },
  loginGrid: {
    position: 'absolute',
    top: 34,
    left: 18,
    right: 18,
    bottom: 30,
    opacity: colors.bg === '#060d16' ? 0.32 : 0.42,
  },
  loginGridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(148, 163, 184, 0.16)' : 'rgba(14, 116, 144, 0.13)',
  },
  loginGridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(148, 163, 184, 0.12)' : 'rgba(14, 116, 144, 0.10)',
  },
  loginSignalPlane: {
    position: 'absolute',
    top: 118,
    left: -86,
    right: -86,
    height: 390,
    borderWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(14, 165, 233, 0.13)' : 'rgba(2, 132, 199, 0.16)',
    opacity: colors.bg === '#060d16' ? 0.62 : 0.48,
  },
  loginSignalRail: {
    position: 'absolute',
    left: 28,
    right: 28,
    height: 1,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(14, 165, 233, 0.38)' : 'rgba(2, 132, 199, 0.32)',
  },
  loginSignalRailTop: {
    top: 82,
  },
  loginSignalRailMid: {
    top: 194,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(16, 185, 129, 0.26)' : 'rgba(4, 120, 87, 0.24)',
  },
  loginSignalRailBottom: {
    bottom: 74,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(245, 158, 11, 0.20)' : 'rgba(180, 83, 9, 0.20)',
  },
  loginSignalNode: {
    position: 'absolute',
    borderRadius: 2,
    borderWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(255,255,255,0.28)' : 'rgba(12,26,42,0.18)',
  },
  loginScanLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 2,
    backgroundColor: colors.accent2,
  },
  loginCard: {
    width: '88%',
    maxWidth: 360,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(8, 18, 30, 0.92)' : 'rgba(255, 255, 255, 0.94)',
    borderRadius: SIZES.radiusLg,
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 24,
    borderWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(148, 163, 184, 0.16)' : 'rgba(14, 165, 233, 0.16)',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: colors.bg === '#060d16' ? 0.38 : 0.16,
    shadowRadius: 24,
    elevation: 10,
    zIndex: 10,
  },
  loginBgOrb1: {
    position: 'absolute',
    top: -100,
    left: -100,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: colors.accent1,
    opacity: colors.bg === '#060d16' ? 0.06 : 0.12,
  },
  loginBgOrb2: {
    position: 'absolute',
    bottom: -80,
    right: -80,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: colors.accent3,
    opacity: colors.bg === '#060d16' ? 0.06 : 0.12,
  },
  loginBgOrb3: {
    position: 'absolute',
    top: '30%',
    left: '10%',
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: colors.accent2,
    opacity: colors.bg === '#060d16' ? 0.04 : 0.08,
  },
  logoArea: {
    alignItems: 'center',
    marginBottom: 20,
    width: '100%',
  },
  logoSignalWrap: {
    width: 88,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  logoSignalRing: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 999,
  },
  logoSignalRingOuter: {
    width: 88,
    height: 88,
    borderColor: colors.bg === '#060d16' ? 'rgba(16, 185, 129, 0.48)' : 'rgba(4, 120, 87, 0.34)',
  },
  logoSignalRingInner: {
    width: 68,
    height: 68,
    borderColor: colors.bg === '#060d16' ? 'rgba(14, 165, 233, 0.52)' : 'rgba(2, 132, 199, 0.36)',
  },
  logoIconCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.bg === '#060d16' ? colors.success : colors.accent3,
    borderWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(255, 255, 255, 0.26)' : 'rgba(255, 255, 255, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.bg === '#060d16' ? colors.success : colors.accent3,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: colors.bg === '#060d16' ? 0.42 : 0.24,
    shadowRadius: 16,
    elevation: 7,
  },
  logoText: {
    fontSize: 24,
    lineHeight: 29,
    fontWeight: '900',
    color: colors.text,
    letterSpacing: 0,
  },
  logoBadge: {
    color: colors.success,
    fontWeight: '900',
  },
  loginWaveform: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 14,
  },
  loginWaveBar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: colors.accent2,
  },
  inputGroup: {
    width: '100%',
    marginBottom: 14,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.text2,
    textTransform: 'uppercase',
    marginBottom: 7,
    letterSpacing: 0,
  },
  inputWrapper: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(3, 8, 15, 0.62)' : 'rgba(238, 244, 248, 0.72)',
    borderWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(148, 163, 184, 0.14)' : 'rgba(14, 165, 233, 0.14)',
    borderRadius: SIZES.radiusMd,
    paddingHorizontal: 13,
  },
  inputWrapperFocused: {
    borderColor: colors.accent1,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(8, 18, 30, 0.92)' : 'rgba(255, 255, 255, 0.98)',
  },
  inputIcon: {
    marginRight: 9,
  },
  inputField: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 14,
    color: colors.text,
  },
  input: {
    width: '100%',
    backgroundColor: colors.surfaceInset || 'rgba(0,0,0,0.2)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: colors.text,
  },
  loginBtn: {
    width: '100%',
    minHeight: 50,
    backgroundColor: colors.bg === '#060d16' ? colors.accent1 : colors.accent3,
    borderRadius: SIZES.radiusMd,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    shadowColor: colors.accent1,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: colors.bg === '#060d16' ? 0.34 : 0.20,
    shadowRadius: 14,
    elevation: 6,
  },
  loginBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loginBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
  },
  loginLoading: {
    marginVertical: 14,
  },
  // Main screen styles
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.bg === '#060d16' ? colors.border : 'rgba(14, 165, 233, 0.08)',
    backgroundColor: colors.bg === '#060d16' ? 'rgba(6, 13, 22, 0.62)' : 'rgba(238, 244, 248, 0.24)',
  },
  logoMini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  logoMiniMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent1,
    borderWidth: 1,
    borderColor: colors.bg === '#060d16' ? 'rgba(255,255,255,0.18)' : 'rgba(14,165,233,0.30)',
    shadowColor: colors.accent1,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 5,
  },
  logoMiniCopy: {
    flexShrink: 1,
    minWidth: 0,
  },
  logoMiniText: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '900',
    color: colors.text,
    letterSpacing: 0,
  },
  logoMiniBadge: {
    color: colors.accent2,
    fontWeight: '900',
  },
  logoMiniMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
    gap: 6,
  },
  logoMiniDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  logoMiniSub: {
    fontSize: 10,
    lineHeight: 12,
    color: colors.text2,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settingsCircle: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusRound,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutBtn: {
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: SIZES.radiusRound,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuToggleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glassBg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },

  // Inline Settings Panel
  settingsPanel: {
    backgroundColor: colors.surfaceCard || colors.bg2,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceBorder || colors.border,
    padding: 16,
  },
  settingsCard: {
    backgroundColor: colors.surfaceCard || colors.bg2,
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusLg,
    padding: 16,
    marginTop: 16,
  },
  settingTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: colors.accent1,
    marginBottom: 12,
    letterSpacing: 1,
  },
  settingRow: {
    marginBottom: 12,
  },
  settingLabel: {
    fontSize: 10,
    fontWeight: 'bold',
    color: colors.text2,
    marginBottom: 6,
  },
  infoLabel: {
    fontSize: 10,
    color: colors.muted,
    marginTop: 4,
  },
  modelSelector: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceInset || 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusSm,
    padding: 3,
    gap: 4,
  },
  modelOption: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: SIZES.radiusSm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modelOptionActive: {
    backgroundColor: colors.selectedBg || colors.accent1,
    borderWidth: 1,
    borderColor: colors.selectedBorder || colors.accent1,
  },
  modelOptionText: {
    fontSize: 13,
    color: colors.text2,
    fontWeight: 'bold',
  },
  modelOptionTextActive: {
    color: colors.selectedText || '#fff',
  },
  settingsSaveBtn: {
    backgroundColor: colors.accent1,
    borderRadius: SIZES.radiusSm,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 20,
  },
  settingsSaveBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 13,
  },

  // Scrollbody
  scrollBody: {
    padding: 16,
    paddingBottom: 60,
  },
  panelScreen: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
  },
  panelScreenCompact: {
    paddingTop: 8,
  },

  // Lang swap bar
  langBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusLg,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  langChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  langFlag: {
    fontSize: 20,
  },
  langName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: colors.text,
  },
  swapBtn: {
    marginHorizontal: 24,
    width: 32,
    height: 32,
    borderRadius: SIZES.radiusRound,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swapBtnText: {
    fontSize: 16,
    color: colors.accent2,
  },

  // Panels
  panelsContainer: {
    gap: 12,
    marginBottom: 20,
  },
  panel: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusLg,
    padding: 16,
    minHeight: 120,
  },
  panelSource: {
    borderLeftWidth: 4,
    borderLeftColor: colors.accent1,
  },
  panelTarget: {
    borderLeftWidth: 4,
    borderLeftColor: colors.success,
  },
  panelHeaderLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: colors.text2,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  targetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  panelBodyText: {
    fontSize: 16,
    color: colors.text,
    lineHeight: 24,
  },

  // Recording Button Area
  recordingArea: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 16,
  },
  translatingText: {
    fontSize: 13,
    color: colors.accent2,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  recordBtn: {
    width: 76,
    height: 76,
    borderRadius: SIZES.radiusRound,
    backgroundColor: colors.accent1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent1,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  recordBtnRecording: {
    backgroundColor: colors.danger,
    transform: [{ scale: 1.1 }],
    shadowColor: colors.danger,
  },
  recordBtnIcon: {
    fontSize: 32,
    color: '#fff',
  },
  recordInstruction: {
    fontSize: 12,
    fontWeight: 'bold',
    color: colors.text2,
    marginTop: 10,
    letterSpacing: 1,
  },

  // History Card styles
  historyCard: {
    backgroundColor: colors.surfaceCard || colors.bg2,
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusLg,
    padding: 16,
    marginTop: 16,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 8,
  },
  historyTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: colors.text,
    letterSpacing: 1,
  },
  clearAllBtn: {
    fontSize: 11,
    color: colors.danger,
    fontWeight: 'bold',
  },
  noHistoryText: {
    fontSize: 13,
    color: colors.muted,
    fontStyle: 'italic',
    textAlign: 'center',
    marginVertical: 12,
  },
  historyList: {
    gap: 8,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceItem || 'rgba(0,0,0,0.15)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  historyBody: {
    flex: 1,
    paddingRight: 8,
  },
  historySource: {
    fontSize: 13,
    color: colors.text2,
    marginBottom: 2,
  },
  historyTarget: {
    fontSize: 14,
    color: colors.text,
    fontWeight: '500',
  },
  historyActions: {
    flexDirection: 'row',
    gap: 8,
  },
  itemActionBtn: {
    backgroundColor: colors.surfaceAction || 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    width: 32,
    height: 32,
    borderRadius: SIZES.radiusRound,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeSwitcherContainer: {
    backgroundColor: 'transparent',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modeSwitcherScroll: {
    paddingHorizontal: 16,
    gap: 6,
    alignItems: 'center',
  },
  modeTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: colors.surfaceAction || colors.glassBg || 'rgba(30, 41, 59, 0.2)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.glassBorder || 'rgba(255, 255, 255, 0.04)',
  },
  modeTabActive: {
    backgroundColor: colors.selectedBg || colors.accent1,
    borderColor: colors.selectedBorder || colors.accent1,
    shadowColor: colors.selectedShadow || colors.accent1,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  modeTabText: {
    color: colors.text2,
    fontSize: 12,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: colors.selectedText || '#fff',
  },
});
