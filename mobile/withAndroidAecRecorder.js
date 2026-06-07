const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const TEMPLATE_DIR = path.join(__dirname, 'plugins', 'android-aec');
const MODULE_FILE = 'AndroidAecRecorderModule.kt';
const PACKAGE_FILE = 'AndroidAecRecorderPackage.kt';

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

module.exports = function withAndroidAecRecorder(config) {
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const packageName = getAndroidPackage(modConfig);
      const projectRoot = modConfig.modRequest.projectRoot;

      ensureAecSources(projectRoot, packageName);
      registerAecPackage(projectRoot, packageName);

      return modConfig;
    },
  ]);
};
