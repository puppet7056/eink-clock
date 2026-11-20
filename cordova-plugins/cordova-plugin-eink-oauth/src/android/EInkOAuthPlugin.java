package tw.eink.clockdashboard;

import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaInterface;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.CordovaWebView;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Lightweight native Android bridge for Cordova Android 13+ (API 34):
 * - OAuth 2.0 system-browser sign-in & custom URI scheme deep-link callback (no GMS required).
 * - Android Keystore AES-256-GCM encrypted refresh_token persistence across APK updates/reboots.
 * - Night-mode best-effort radio controller (Bluetooth / Wi-Fi / Airplane Mode + quick settings).
 */
public class EInkOAuthPlugin extends CordovaPlugin {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "eink_clock_oauth_refresh_key_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private static final String PREFS_NAME = "eink_clock_oauth_secure_prefs";
    private static final String PREF_ENC_MODE = "rt_mode";
    private static final String PREF_CIPHERTEXT = "rt_ct";
    private static final String PREF_IV = "rt_iv";
    private static final String PREF_ACCOUNT_EMAIL = "acct_email";

    private static final String RADIO_PREFS_NAME = "eink_clock_night_radio_prefs";
    private static final String PREF_WIFI_DISABLED_BY_APP = "wifi_disabled_by_app";
    private static final String PREF_BT_DISABLED_BY_APP = "bt_disabled_by_app";
    private static final String PREF_AIRPLANE_ENABLED_BY_APP = "airplane_enabled_by_app";
    private static final int REQ_BLUETOOTH_CONNECT = 4401;

    private CallbackContext listenerCallbackContext = null;
    private String pendingCallbackUrl = null;

    @Override
    public void initialize(CordovaInterface cordova, CordovaWebView webView) {
        super.initialize(cordova, webView);
        Activity activity = cordova.getActivity();
        if (activity != null) {
            handlePossibleOAuthIntent(activity.getIntent());
        }
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (cordova != null && cordova.getActivity() != null && intent != null) {
            cordova.getActivity().setIntent(intent);
        }
        handlePossibleOAuthIntent(intent);
    }

    private boolean isOAuthCallbackUri(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        return scheme.startsWith("com.googleusercontent.apps.")
                || scheme.equals("tw.eink.clockdashboard.oauth");
    }

    private void handlePossibleOAuthIntent(Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (!isOAuthCallbackUri(data)) return;

        String url = data.toString();
        deliverCallbackUrl(url);
    }

    private void deliverCallbackUrl(String url) {
        if (listenerCallbackContext != null) {
            PluginResult result = new PluginResult(PluginResult.Status.OK, url);
            result.setKeepCallback(true);
            listenerCallbackContext.sendPluginResult(result);
        } else {
            pendingCallbackUrl = url;
        }
    }

    private SharedPreferences getSecurePrefs() {
        Context ctx = cordova.getActivity().getApplicationContext();
        return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private SharedPreferences getRadioPrefs() {
        Context ctx = cordova.getActivity().getApplicationContext();
        return ctx.getSharedPreferences(RADIO_PREFS_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateSecretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                KEYSTORE_PROVIDER
        );
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build();
        keyGenerator.init(spec);
        return keyGenerator.generateKey();
    }

    private void persistRefreshToken(String refreshToken, String accountEmail) {
        SharedPreferences prefs = getSecurePrefs();
        SharedPreferences.Editor editor = prefs.edit();
        if (accountEmail != null && !accountEmail.isEmpty()) {
            editor.putString(PREF_ACCOUNT_EMAIL, accountEmail);
        }

        try {
            SecretKey secretKey = getOrCreateSecretKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey);
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(refreshToken.getBytes(StandardCharsets.UTF_8));
            editor.putString(PREF_ENC_MODE, "keystore");
            editor.putString(PREF_IV, Base64.encodeToString(iv, Base64.NO_WRAP));
            editor.putString(PREF_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP));
        } catch (Exception e) {
            String encoded = Base64.encodeToString(
                    refreshToken.getBytes(StandardCharsets.UTF_8),
                    Base64.NO_WRAP
            );
            editor.putString(PREF_ENC_MODE, "private_b64");
            editor.remove(PREF_IV);
            editor.putString(PREF_CIPHERTEXT, encoded);
        }
        editor.apply();
    }

    private JSONObject readStoredRefreshToken() throws JSONException {
        SharedPreferences prefs = getSecurePrefs();
        String mode = prefs.getString(PREF_ENC_MODE, "");
        String ctB64 = prefs.getString(PREF_CIPHERTEXT, "");
        String accountEmail = prefs.getString(PREF_ACCOUNT_EMAIL, "");

        JSONObject result = new JSONObject();
        result.put("refreshToken", "");
        result.put("accountEmail", accountEmail != null ? accountEmail : "");

        if (ctB64 == null || ctB64.isEmpty()) {
            return result;
        }

        try {
            if ("keystore".equals(mode)) {
                String ivB64 = prefs.getString(PREF_IV, "");
                if (ivB64 == null || ivB64.isEmpty()) {
                    clearStoredRefreshToken();
                    return result;
                }
                SecretKey secretKey = getOrCreateSecretKey();
                byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
                byte[] ct = Base64.decode(ctB64, Base64.NO_WRAP);
                Cipher cipher = Cipher.getInstance(TRANSFORMATION);
                cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_BITS, iv));
                byte[] plain = cipher.doFinal(ct);
                result.put("refreshToken", new String(plain, StandardCharsets.UTF_8));
            } else if ("private_b64".equals(mode)) {
                byte[] plain = Base64.decode(ctB64, Base64.NO_WRAP);
                result.put("refreshToken", new String(plain, StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            clearStoredRefreshToken();
            result.put("refreshToken", "");
            result.put("accountEmail", "");
        }
        return result;
    }

    private void clearStoredRefreshToken() {
        getSecurePrefs().edit().clear().apply();
    }

    @SuppressWarnings("deprecation")
    private BluetoothAdapter getBluetoothAdapter(Context appCtx) {
        try {
            BluetoothManager bm = (BluetoothManager) appCtx.getSystemService(Context.BLUETOOTH_SERVICE);
            if (bm != null && bm.getAdapter() != null) {
                return bm.getAdapter();
            }
            return BluetoothAdapter.getDefaultAdapter();
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean hasBluetoothConnectPermission(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ctx.checkSelfPermission("android.permission.BLUETOOTH_CONNECT")
                    == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private JSONObject applyNightRadioMode(Activity activity, boolean enterNightMode) throws JSONException {
        Context appCtx = activity.getApplicationContext();
        SharedPreferences radioPrefs = getRadioPrefs();
        SharedPreferences.Editor editor = radioPrefs.edit();

        String airplaneStatus = "unchanged";
        String wifiStatus = "unchanged";
        String bluetoothStatus = "unchanged";
        boolean needsManualShortcut = false;

        // 1. Airplane Mode (only writable if WRITE_SECURE_SETTINGS was granted via ADB / system privilege)
        boolean hasSecureSettings = false;
        try {
            hasSecureSettings = appCtx.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Exception ignored) {
            hasSecureSettings = false;
        }

        if (enterNightMode) {
            boolean alreadyAirplane =
                    Settings.Global.getInt(appCtx.getContentResolver(), Settings.Global.AIRPLANE_MODE_ON, 0) == 1;
            if (alreadyAirplane) {
                airplaneStatus = "already_on";
            } else if (hasSecureSettings) {
                try {
                    Settings.Global.putInt(appCtx.getContentResolver(), Settings.Global.AIRPLANE_MODE_ON, 1);
                    try {
                        Intent apIntent = new Intent(Intent.ACTION_AIRPLANE_MODE_CHANGED);
                        apIntent.putExtra("state", true);
                        appCtx.sendBroadcast(apIntent);
                    } catch (Exception ignored) {
                        // Protected broadcast on newer Android; setting value still updated
                    }
                    editor.putBoolean(PREF_AIRPLANE_ENABLED_BY_APP, true);
                    airplaneStatus = "enabled";
                } catch (Exception ignored) {
                    airplaneStatus = "os_restricted";
                    needsManualShortcut = true;
                }
            } else {
                airplaneStatus = "os_restricted";
                needsManualShortcut = true;
            }
        } else if (radioPrefs.getBoolean(PREF_AIRPLANE_ENABLED_BY_APP, false)) {
            editor.putBoolean(PREF_AIRPLANE_ENABLED_BY_APP, false);
            if (hasSecureSettings) {
                try {
                    Settings.Global.putInt(appCtx.getContentResolver(), Settings.Global.AIRPLANE_MODE_ON, 0);
                    try {
                        Intent apIntent = new Intent(Intent.ACTION_AIRPLANE_MODE_CHANGED);
                        apIntent.putExtra("state", false);
                        appCtx.sendBroadcast(apIntent);
                    } catch (Exception ignored) {
                        // ignore
                    }
                    airplaneStatus = "restored";
                } catch (Exception ignored) {
                    airplaneStatus = "os_restricted";
                }
            } else {
                airplaneStatus = "os_restricted";
            }
        }

        // 2. Wi-Fi (Android <= 9 or permissive ROMs support setWifiEnabled; Android 10+ targetSdk>=29 restricts it)
        try {
            WifiManager wifiManager = (WifiManager) appCtx.getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                wifiStatus = "unsupported";
            } else if (enterNightMode) {
                if (!wifiManager.isWifiEnabled()) {
                    wifiStatus = "already_off";
                } else {
                    boolean ok = wifiManager.setWifiEnabled(false);
                    if (ok) {
                        editor.putBoolean(PREF_WIFI_DISABLED_BY_APP, true);
                        wifiStatus = "disabled";
                    } else {
                        wifiStatus = "os_restricted";
                        needsManualShortcut = true;
                    }
                }
            } else if (radioPrefs.getBoolean(PREF_WIFI_DISABLED_BY_APP, false)) {
                editor.putBoolean(PREF_WIFI_DISABLED_BY_APP, false);
                boolean ok = wifiManager.setWifiEnabled(true);
                wifiStatus = ok ? "restored" : "os_restricted";
            }
        } catch (Exception ignored) {
            wifiStatus = "os_restricted";
            if (enterNightMode) needsManualShortcut = true;
        }

        // 3. Bluetooth (works on Android 7-12 with BLUETOOTH_CONNECT on API 31-32; restricted on API 33+)
        try {
            BluetoothAdapter btAdapter = getBluetoothAdapter(appCtx);
            if (btAdapter == null) {
                bluetoothStatus = "unsupported";
            } else if (!hasBluetoothConnectPermission(appCtx)) {
                bluetoothStatus = "permission_needed";
                if (enterNightMode && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        cordova.requestPermission(
                                this,
                                REQ_BLUETOOTH_CONNECT,
                                "android.permission.BLUETOOTH_CONNECT"
                        );
                    } catch (Exception ignored) {
                        // ignore
                    }
                    needsManualShortcut = true;
                }
            } else if (enterNightMode) {
                if (!btAdapter.isEnabled()) {
                    bluetoothStatus = "already_off";
                } else {
                    boolean ok = btAdapter.disable();
                    if (ok) {
                        editor.putBoolean(PREF_BT_DISABLED_BY_APP, true);
                        bluetoothStatus = "disabled";
                    } else {
                        bluetoothStatus = "os_restricted";
                        needsManualShortcut = true;
                    }
                }
            } else if (radioPrefs.getBoolean(PREF_BT_DISABLED_BY_APP, false)) {
                editor.putBoolean(PREF_BT_DISABLED_BY_APP, false);
                boolean ok = btAdapter.enable();
                bluetoothStatus = ok ? "restored" : "os_restricted";
            }
        } catch (SecurityException ignored) {
            bluetoothStatus = "permission_needed";
            if (enterNightMode) needsManualShortcut = true;
        } catch (Exception ignored) {
            bluetoothStatus = "os_restricted";
            if (enterNightMode) needsManualShortcut = true;
        }

        editor.apply();

        JSONObject result = new JSONObject();
        result.put("sdkInt", Build.VERSION.SDK_INT);
        result.put("enterNightMode", enterNightMode);
        result.put("airplane", airplaneStatus);
        result.put("wifi", wifiStatus);
        result.put("bluetooth", bluetoothStatus);
        result.put("needsManualShortcut", needsManualShortcut);
        return result;
    }

    private void openWirelessSettings(Activity activity, String target) {
        if (activity == null) return;
        Intent intent = null;

        if ("wifi".equals(target)) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                intent = new Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY);
            } else {
                intent = new Intent(Settings.ACTION_WIFI_SETTINGS);
            }
        } else if ("bluetooth".equals(target)) {
            intent = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
        } else {
            intent = new Intent(Settings.ACTION_AIRPLANE_MODE_SETTINGS);
        }

        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(intent);
            return;
        } catch (Exception ignored) {
            // Fall back to generic wireless settings
        }

        Intent fallback = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(fallback);
        } catch (Exception ignored) {
            Intent settingsRoot = new Intent(Settings.ACTION_SETTINGS);
            settingsRoot.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(settingsRoot);
        }
    }

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        if ("openAuthUrl".equals(action)) {
            String url = args.optString(0, "");
            if (url.isEmpty()) {
                callbackContext.error("Empty OAuth URL");
                return true;
            }
            try {
                Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                browserIntent.addCategory(Intent.CATEGORY_BROWSABLE);
                browserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                cordova.getActivity().startActivity(browserIntent);
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to open system browser: " + e.getMessage());
            }
            return true;
        }

        if ("listen".equals(action)) {
            listenerCallbackContext = callbackContext;
            if (pendingCallbackUrl != null) {
                String url = pendingCallbackUrl;
                pendingCallbackUrl = null;
                PluginResult result = new PluginResult(PluginResult.Status.OK, url);
                result.setKeepCallback(true);
                callbackContext.sendPluginResult(result);
            } else {
                PluginResult noop = new PluginResult(PluginResult.Status.NO_RESULT);
                noop.setKeepCallback(true);
                callbackContext.sendPluginResult(noop);
            }
            return true;
        }

        if ("consumePendingCallback".equals(action)) {
            String url = pendingCallbackUrl != null ? pendingCallbackUrl : "";
            pendingCallbackUrl = null;
            callbackContext.success(url);
            return true;
        }

        if ("saveRefreshToken".equals(action)) {
            String refreshToken = args.optString(0, "");
            String accountEmail = args.optString(1, "");
            if (refreshToken.isEmpty()) {
                callbackContext.error("Empty refresh token");
                return true;
            }
            try {
                persistRefreshToken(refreshToken, accountEmail);
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to save refresh token: " + e.getMessage());
            }
            return true;
        }

        if ("saveAccountEmail".equals(action)) {
            String accountEmail = args.optString(0, "");
            try {
                if (!accountEmail.isEmpty()) {
                    getSecurePrefs().edit().putString(PREF_ACCOUNT_EMAIL, accountEmail).apply();
                }
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to save account email: " + e.getMessage());
            }
            return true;
        }

        if ("loadRefreshToken".equals(action)) {
            try {
                callbackContext.success(readStoredRefreshToken());
            } catch (Exception e) {
                callbackContext.error("Failed to load refresh token: " + e.getMessage());
            }
            return true;
        }

        if ("clearRefreshToken".equals(action)) {
            try {
                clearStoredRefreshToken();
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to clear refresh token: " + e.getMessage());
            }
            return true;
        }

        if ("setNightRadioMode".equals(action)) {
            boolean enterNightMode = args.optBoolean(0, true);
            try {
                JSONObject res = applyNightRadioMode(cordova.getActivity(), enterNightMode);
                callbackContext.success(res);
            } catch (Exception e) {
                callbackContext.error("Failed to update night radio mode: " + e.getMessage());
            }
            return true;
        }

        if ("openWirelessSettings".equals(action)) {
            String target = args.optString(0, "airplane");
            try {
                openWirelessSettings(cordova.getActivity(), target);
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to open wireless settings: " + e.getMessage());
            }
            return true;
        }

        return false;
    }
}
