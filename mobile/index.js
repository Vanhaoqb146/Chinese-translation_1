import { registerRootComponent } from 'expo';
import { AppRegistry, NativeModules, Platform } from 'react-native';

import App from './App';

const HEADLESS_TASK_KEY = 'VoiceTranslateKeepAlive';
const KEEP_ALIVE_POLL_MS = 1000;

AppRegistry.registerHeadlessTask(HEADLESS_TASK_KEY, () => async () => {
  if (Platform.OS !== 'android') return;

  const recorder = NativeModules.AndroidAecRecorder;
  if (typeof recorder?.isForegroundServiceRunning !== 'function') {
    console.warn(
      '[background] Native keep-alive API is missing. Rebuild the Android app.',
    );
    return;
  }

  console.log('[background] Headless JS keep-alive started');
  while (true) {
    try {
      if (!(await recorder.isForegroundServiceRunning())) break;
      await new Promise((resolve) => setTimeout(resolve, KEEP_ALIVE_POLL_MS));
    } catch (error) {
      console.warn('[background] Headless JS keep-alive poll failed:', error);
      await new Promise((resolve) => setTimeout(resolve, KEEP_ALIVE_POLL_MS));
    }
  }
  console.log('[background] Headless JS keep-alive stopped');
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
