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
};

module.exports = EInkOAuth;
