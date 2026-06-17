// metro.config.js — config del bundler Metro.
//
// CRIT-22 v? (2026-06-17): habilitamos unstable_enablePackageExports porque
// @sentry/react-native v7+ declara `"type": "all"` en su package.json y usa
// imports sin extensión (e.g., `from './utf8ToBytes'`). Sin package exports
// habilitado, el resolver de Metro no resuelve esos imports a runtime y
// dispara "UnableToResolveError: utf8ToBytes" recurrente.
//
// Doc: https://reactnative.dev/blog/2023/06/21/package-exports-support

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Habilita resolución según el campo "exports" de package.json (RFC modernizado).
// Requerido para Sentry RN 7+. Compat con todos los packages de Expo SDK 54.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
