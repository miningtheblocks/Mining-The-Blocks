import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import DynamicCube201 from '../components/DynamicCube201';

export default function Home() {
  const navigation = useNavigation();

  React.useLayoutEffect(() => {
    // Oculta el header del stack para que el GLView ocupe toda la pantalla
    try {
      navigation.setOptions({ headerShown: false });
    } catch {}
  }, [navigation]);

  return (
    <View style={styles.container}>
      <DynamicCube201 />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Forzar a ocupar toda la pantalla independientemente de insets/padding del navegador
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#000', // Fondo negro para integrar con GLView full-screen
  },
});
