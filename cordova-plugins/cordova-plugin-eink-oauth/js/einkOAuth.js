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
};

module.exports = EInkOAuth;
