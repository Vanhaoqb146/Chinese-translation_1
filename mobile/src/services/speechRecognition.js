import { Platform } from 'react-native';

let speechModule = null;
let languageModelFreeForm = 'free_form';

const noop = () => {};

const ANDROID_INTENT_OPTION_MIN_API = {
  EXTRA_ENABLE_LANGUAGE_DETECTION: 34,
  EXTRA_ENABLE_LANGUAGE_SWITCH: 34,
  EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: 34,
  EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: 34,
  EXTRA_LANGUAGE_SWITCH_INITIAL_ACTIVE_DURATION_TIME_MILLIS: 35,
  EXTRA_LANGUAGE_SWITCH_MAX_SWITCHES: 35,
};

const createDefaultEvents = () => ({
  onSpeechStart: noop,
  onSpeechRecognized: noop,
  onSpeechEnd: noop,
  onRecognitionEnd: noop,
  onSpeechError: noop,
  onSpeechResults: noop,
  onSpeechPartialResults: noop,
  onSpeechLanguageDetection: noop,
  onSpeechVolumeChanged: noop,
});

function getSpeechModule() {
  if (speechModule) return speechModule;

  try {
    const speechRecognition = require('expo-speech-recognition');
    speechModule = speechRecognition.ExpoSpeechRecognitionModule;
    languageModelFreeForm =
      speechRecognition.RecognizerIntentExtraLanguageModel?.LANGUAGE_MODEL_FREE_FORM ||
      languageModelFreeForm;
    return speechModule;
  } catch (error) {
    throw new Error(
      `Native speech recognition module is not available. Rebuild the app after installing expo-speech-recognition. ${error.message || error}`
    );
  }
}

function getResultPayload(event) {
  const results = event?.results || [];
  const value = results
    .map((result) => result?.transcript)
    .filter((value) => typeof value === 'string' && value.trim().length > 0);

  const confidence = Number(results[0]?.confidence);
  return {
    value,
    confidence: Number.isFinite(confidence) ? confidence : null,
    isFinal: Boolean(event?.isFinal),
    results,
  };
}

function getAndroidApiLevel() {
  const version = Platform.Version;
  const apiLevel = typeof version === 'string' ? Number.parseInt(version, 10) : Number(version);
  return Number.isFinite(apiLevel) ? apiLevel : null;
}

function getCompatibleAndroidIntentOptions(options) {
  if (Platform.OS !== 'android') return options;

  const apiLevel = getAndroidApiLevel();
  if (!apiLevel) return options;

  return Object.entries(options).reduce((compatibleOptions, [key, value]) => {
    const minApi = ANDROID_INTENT_OPTION_MIN_API[key];
    if (minApi && apiLevel < minApi) return compatibleOptions;

    compatibleOptions[key] = value;
    return compatibleOptions;
  }, {});
}

class VoiceCompatibilityAdapter {
  constructor() {
    this._events = createDefaultEvents();
    this._subscriptions = null;
  }

  _ensureListeners() {
    if (this._subscriptions) return;

    const recognitionModule = getSpeechModule();
    this._subscriptions = [
      recognitionModule.addListener('start', () => {
        this._events.onSpeechStart({});
      }),
      recognitionModule.addListener('speechstart', () => {
        this._events.onSpeechRecognized({});
      }),
      recognitionModule.addListener('speechend', () => {
        this._events.onSpeechEnd({});
      }),
      recognitionModule.addListener('end', () => {
        this._events.onSpeechEnd({});
        this._events.onRecognitionEnd({});
      }),
      recognitionModule.addListener('result', (event) => {
        const payload = getResultPayload(event);
        if (!payload.value.length) return;

        if (event?.isFinal) {
          this._events.onSpeechResults(payload);
        } else {
          this._events.onSpeechPartialResults(payload);
        }
      }),
      recognitionModule.addListener('languagedetection', (event) => {
        this._events.onSpeechLanguageDetection(event || {});
      }),
      recognitionModule.addListener('error', (event) => {
        this._events.onSpeechError({
          error: event?.error,
          message: event?.message,
          code: event?.code,
        });
      }),
      recognitionModule.addListener('volumechange', (event) => {
        this._events.onSpeechVolumeChanged({ value: event?.value });
      }),
    ];
  }

  _removeListeners() {
    if (!this._subscriptions) return;
    this._subscriptions.forEach((subscription) => subscription.remove());
    this._subscriptions = null;
  }

  async start(locale, options = {}) {
    const recognitionModule = getSpeechModule();
    const permission = await recognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error('Speech recognition permission was not granted.');
    }

    if (typeof recognitionModule.isRecognitionAvailable === 'function' && !recognitionModule.isRecognitionAvailable()) {
      const services =
        typeof recognitionModule.getSpeechRecognitionServices === 'function'
          ? recognitionModule.getSpeechRecognitionServices()
          : [];
      throw new Error(
        `Speech recognition is not available on this device. Services: ${services.join(', ') || 'none'}`
      );
    }

    this._ensureListeners();

    // Query available speech services on Android to force Google Speech Services if installed
    let androidRecognitionServicePackage = undefined;
    if (Platform.OS === 'android') {
      try {
        const services = typeof recognitionModule.getSpeechRecognitionServices === 'function'
          ? recognitionModule.getSpeechRecognitionServices()
          : [];
        if (services.includes('com.google.android.googlequicksearchbox')) {
          androidRecognitionServicePackage = 'com.google.android.googlequicksearchbox';
        }
      } catch (e) {
        console.warn('[speechRecognition] Failed to check speech recognition services:', e);
      }
    }

    const androidIntentOptions = getCompatibleAndroidIntentOptions({
      EXTRA_LANGUAGE_MODEL: languageModelFreeForm,
      EXTRA_PARTIAL_RESULTS: true,
      EXTRA_MAX_RESULTS: options.EXTRA_MAX_RESULTS || 5,
      EXTRA_MASK_OFFENSIVE_WORDS: false,
      EXTRA_LANGUAGE: locale,
      ...(options.androidIntentOptions || {}),
    });
    const androidApiLevel = getAndroidApiLevel();
    const androidLiveAec =
      Platform.OS === 'android' &&
      Boolean(options.androidLiveAec) &&
      androidApiLevel >= 33;
    if (Platform.OS === 'android' && options.continuous) {
      console.log(
        `[speechRecognition] live input locale=${locale} api=${androidApiLevel ?? 'unknown'} ` +
        `path=${androidLiveAec ? 'voice-communication-aec' : 'standard-recognizer'} ` +
        `service=${androidRecognitionServicePackage || 'default'}`
      );
    }

    const startOptions = {
      lang: locale,
      interimResults: true,
      maxAlternatives: options.EXTRA_MAX_RESULTS || 5,
      continuous: Boolean(options.continuous),
      requiresOnDeviceRecognition: false,
      androidIntentOptions,
      ...(Platform.OS === 'android' ? { androidLiveAec } : {}),
      volumeChangeEventOptions: options.volumeChangeEventOptions,
    };

    if (Platform.OS === 'android' && androidRecognitionServicePackage) {
      startOptions.androidRecognitionServicePackage = androidRecognitionServicePackage;
    }

    recognitionModule.start(startOptions);
  }

  async stop() {
    try {
      getSpeechModule().stop();
    } catch (error) {
      if (!String(error?.message || error).includes('inactive')) throw error;
    }
  }

  async cancel() {
    try {
      getSpeechModule().abort();
    } catch (error) {
      if (!String(error?.message || error).includes('inactive')) throw error;
    }
  }

  async destroy() {
    await this.cancel();
    this._removeListeners();
    this.removeAllListeners();
  }

  removeAllListeners() {
    this._events = createDefaultEvents();
  }

  async isAvailable() {
    return getSpeechModule().isRecognitionAvailable();
  }

  getSpeechRecognitionServices() {
    return getSpeechModule().getSpeechRecognitionServices();
  }

  async isRecognizing() {
    const state = await getSpeechModule().getStateAsync();
    return state === 'recognizing' || state === 'starting';
  }

  set onSpeechStart(fn) {
    this._events.onSpeechStart = fn || noop;
  }

  set onSpeechRecognized(fn) {
    this._events.onSpeechRecognized = fn || noop;
  }

  set onSpeechEnd(fn) {
    this._events.onSpeechEnd = fn || noop;
  }

  set onSpeechError(fn) {
    this._events.onSpeechError = fn || noop;
  }

  set onRecognitionEnd(fn) {
    this._events.onRecognitionEnd = fn || noop;
  }

  set onSpeechResults(fn) {
    this._events.onSpeechResults = fn || noop;
  }

  set onSpeechPartialResults(fn) {
    this._events.onSpeechPartialResults = fn || noop;
  }

  set onSpeechLanguageDetection(fn) {
    this._events.onSpeechLanguageDetection = fn || noop;
  }

  set onSpeechVolumeChanged(fn) {
    this._events.onSpeechVolumeChanged = fn || noop;
  }
}

const voiceCompatibilityAdapter = new VoiceCompatibilityAdapter();

export default voiceCompatibilityAdapter;
