const fs = require('fs');
const path = require('path');
const { withDangerousMod, withAndroidManifest } = require('@expo/config-plugins');

const TEMPLATE_DIR = path.join(__dirname, 'plugins', 'android-aec');
const MODULE_FILE = 'AndroidAecRecorderModule.kt';
const PACKAGE_FILE = 'AndroidAecRecorderPackage.kt';
const SERVICE_FILE = 'VoiceTranslateService.kt';

function getAndroidPackage(config) {
  const packageName = config.android?.package;
  if (!packageName) {
    throw new Error('Android package is required for AndroidAecRecorder config plugin.');
  }
  return packageName;
}

function getPackageSourceDir(projectRoot, packageName) {
  return path.join(
    projectRoot,
    'android',
    'app',
    'src',
    'main',
    'java',
    ...packageName.split('.')
  );
}

function copyTemplate(templateName, targetPath, packageName) {
  const templatePath = path.join(TEMPLATE_DIR, templateName);
  const contents = fs
    .readFileSync(templatePath, 'utf8')
    .replace(/__ANDROID_AEC_PACKAGE__/g, packageName);

  fs.writeFileSync(targetPath, contents);
}

function ensureAecSources(projectRoot, packageName) {
  const sourceDir = getPackageSourceDir(projectRoot, packageName);
  fs.mkdirSync(sourceDir, { recursive: true });

  copyTemplate(MODULE_FILE, path.join(sourceDir, MODULE_FILE), packageName);
  copyTemplate(PACKAGE_FILE, path.join(sourceDir, PACKAGE_FILE), packageName);
  copyTemplate(SERVICE_FILE, path.join(sourceDir, SERVICE_FILE), packageName);
}

function registerAecPackage(projectRoot, packageName) {
  const sourceDir = getPackageSourceDir(projectRoot, packageName);
  const mainApplicationPath = path.join(sourceDir, 'MainApplication.kt');

  if (!fs.existsSync(mainApplicationPath)) {
    throw new Error(`MainApplication.kt not found at ${mainApplicationPath}`);
  }

  const contents = fs.readFileSync(mainApplicationPath, 'utf8');
  if (contents.includes('AndroidAecRecorderPackage()')) {
    return;
  }

  const nextContents = contents.replace(
    /PackageList\(this\)\.packages\.apply \{\s*/,
    (match) => `${match}              add(AndroidAecRecorderPackage())\n`
  );

  if (nextContents === contents) {
    throw new Error('Unable to register AndroidAecRecorderPackage in MainApplication.kt');
  }

  fs.writeFileSync(mainApplicationPath, nextContents);
}

function addServiceAndPermissions(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;
    const packageName = config.android?.package || 'com.voicetranslate.ai';

    // Ensure uses-permission array exists
    if (!androidManifest['uses-permission']) {
      androidManifest['uses-permission'] = [];
    }

    const permissionsToAdd = [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MICROPHONE',
      'android.permission.WAKE_LOCK'
    ];

    permissionsToAdd.forEach((perm) => {
      const exists = androidManifest['uses-permission'].some(
        (p) => p.$['android:name'] === perm
      );
      if (!exists) {
        androidManifest['uses-permission'].push({
          $: { 'android:name': perm },
        });
      }
    });

    // Ensure application element exists
    if (!Array.isArray(androidManifest.application)) {
      androidManifest.application = [{}];
    }
    const application = androidManifest.application[0];

    // Ensure service array exists
    if (!application.service) {
      application.service = [];
    }

    // Add VoiceTranslateService
    const serviceName = `${packageName}.VoiceTranslateService`;
    const serviceExists = application.service.some(
      (s) => s.$['android:name'] === serviceName
    );

    if (!serviceExists) {
      application.service.push({
        $: {
          'android:name': serviceName,
          'android:foregroundServiceType': 'microphone',
          'android:exported': 'false',
        },
      });
    } else {
      const service = application.service.find(
        (s) => s.$['android:name'] === serviceName
      );
      service.$['android:foregroundServiceType'] = 'microphone';
      service.$['android:exported'] = 'false';
    }

    return config;
  });
}

module.exports = function withAndroidAecRecorder(config) {
  let nextConfig = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const packageName = getAndroidPackage(modConfig);
      const projectRoot = modConfig.modRequest.projectRoot;

      ensureAecSources(projectRoot, packageName);
      registerAecPackage(projectRoot, packageName);

      return modConfig;
    },
  ]);

  return addServiceAndPermissions(nextConfig);
};
