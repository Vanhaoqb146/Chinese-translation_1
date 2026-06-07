const { withAppBuildGradle } = require('@expo/config-plugins');

function addResolutionStrategy(contents) {
  const target = "android {";
  const replacement = `android {
    configurations.all {
        resolutionStrategy {
            force 'androidx.appcompat:appcompat:1.6.1'
            exclude group: 'com.android.support'
        }
    }`;
  
  if (contents.includes(target) && !contents.includes("exclude group: 'com.android.support'")) {
    return contents.replace(target, replacement);
  }
  return contents;
}

module.exports = function withAndroidResolutionStrategy(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy') {
      config.modResults.contents = addResolutionStrategy(config.modResults.contents);
    }
    return config;
  });
};
