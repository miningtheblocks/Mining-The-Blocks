module.exports = {
  dependencies: {
    // COMPLETELY DISABLE react-native-reanimated
    'react-native-reanimated': {
      platforms: {
        android: {
          sourceDir: null,
          packageImportPath: null,
        },
        ios: {
          podspecPath: null,
        },
      },
    },
    // COMPLETELY DISABLE react-native-gesture-handler  
    'react-native-gesture-handler': {
      platforms: {
        android: {
          sourceDir: null,
          packageImportPath: null,
        },
        ios: {
          podspecPath: null,
        },
      },
    },
  },
};