var exec = require('cordova/exec');

var EInkOAuth = {
  openAuthUrl: function (url, onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'openAuthUrl', [url]);
  },
  listen: function (onCallbackUrl, onError) {
    exec(onCallbackUrl || function () {}, onError || function () {}, 'EInkOAuth', 'listen', []);
  },
  consumePendingCallback: function (onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'consumePendingCallback', []);
  },
  saveRefreshToken: function (refreshToken, accountEmail, onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'saveRefreshToken', [
      refreshToken || '',
      accountEmail || '',
    ]);
  },
  saveAccountEmail: function (accountEmail, onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'saveAccountEmail', [
      accountEmail || '',
    ]);
  },
  loadRefreshToken: function (onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'loadRefreshToken', []);
  },
  clearRefreshToken: function (onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'clearRefreshToken', []);
  },
  scheduleDailyWake: function (hour, minute, onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'scheduleDailyWake', [
      Number(hour) || 0,
      Number(minute) || 0,
    ]);
  },
  cancelDailyWake: function (onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'cancelDailyWake', []);
  },
  scheduleTestWake: function (delaySeconds, onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'scheduleTestWake', [
      Number(delaySeconds) || 60,
    ]);
  },
  getWakeStatus: function (onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'getWakeStatus', []);
  },
  openWakePermissionSettings: function (target, onSuccess, onError) {
    exec(onSuccess || function () {}, onError || function () {}, 'EInkOAuth', 'openWakePermissionSettings', [
      target || 'overlay',
    ]);
  },
};

module.exports = EInkOAuth;
