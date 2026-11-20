package tw.eink.clockdashboard;

import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
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
 * 電子紙時鐘原生 Android 橋接外掛（支援 Cordova Android 13+ / API 34）：
 * - 系統瀏覽器 OAuth 2.0 PKCE 登入與自訂網址協定回呼（不依賴 GMS）
 * - Android Keystore AES-256-GCM 加密保存 refresh_token，更新 APK 免重登
 * - 原生視窗 FLAG_KEEP_SCREEN_ON 常亮控制（啟動與恢復前景時立即生效，避免被系統預設休眠覆蓋）
 * - 系統級 ACTION_TIME_TICK 每分鐘整點推送，防止電子紙 WebView 節流計時器造成時鐘停住
 * - 夜間模式無線開關控制（藍牙／Wi-Fi／飛航模式與系統快捷頁開啟）
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
    private static final String PREF_KEEP_SCREEN_ON = "keep_screen_on";
    private static final int REQ_BLUETOOTH_CONNECT = 4401;
    // 每 4 分鐘透過 ON_AFTER_RELEASE 重設系統無操作休眠計時器，防止 BOOX 30 分鐘（甚至 5 分鐘）自動休眠
    private static final long USER_ACTIVITY_PULSE_INTERVAL_MS = 4L * 60L * 1000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private CallbackContext listenerCallbackContext = null;
    private CallbackContext timeTickCallbackContext = null;
    private String pendingCallbackUrl = null;
    private BroadcastReceiver timeTickReceiver = null;
    private boolean timeTickRegistered = false;
    private boolean isInForeground = false;
    private boolean keepScreenOnEnabled = true;
    private long lastUserActivityPulseAt = 0L;
    private PowerManager.WakeLock foregroundWakeLock = null;
    private PowerManager.WakeLock pulseWakeLock = null;
    private Runnable releasePulseRunnable = null;

    @Override
    public void initialize(CordovaInterface cordova, CordovaWebView webView) {
        super.initialize(cordova, webView);
        Activity activity = cordova.getActivity();
        if (activity != null) {
            isInForeground = true;
            keepScreenOnEnabled = getRadioPrefs().getBoolean(PREF_KEEP_SCREEN_ON, true);
            applyKeepScreenOnState(activity, keepScreenOnEnabled);
            registerTimeTickReceiver(activity);
            handlePossibleOAuthIntent(activity.getIntent());
        }
    }

    @Override
    public void onResume(boolean multitasking) {
        super.onResume(multitasking);
        Activity activity = cordova != null ? cordova.getActivity() : null;
        if (activity != null) {
            isInForeground = true;
            keepScreenOnEnabled = getRadioPrefs().getBoolean(PREF_KEEP_SCREEN_ON, true);
            applyKeepScreenOnState(activity, keepScreenOnEnabled);
            registerTimeTickReceiver(activity);
            // 回到前景時主動通知前端校正時間一次
            deliverTimeTick();
        }
    }

    @Override
    public void onPause(boolean multitasking) {
        super.onPause(multitasking);
        isInForeground = false;
        releaseAllWakeLocks();
        Activity activity = cordova != null ? cordova.getActivity() : null;
        if (activity != null) {
            unregisterTimeTickReceiver(activity);
        }
    }

    @Override
    public void onDestroy() {
        isInForeground = false;
        releaseAllWakeLocks();
        Activity activity = cordova != null ? cordova.getActivity() : null;
        if (activity != null) {
            unregisterTimeTickReceiver(activity);
        }
        super.onDestroy();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (cordova != null && cordova.getActivity() != null && intent != null) {
            cordova.getActivity().setIntent(intent);
        }
        handlePossibleOAuthIntent(intent);
    }

    private void applyKeepScreenOnState(Activity activity, boolean keepOn) {
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            try {
                // 第一層：Android 主視窗常亮旗標
                if (keepOn) {
                    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
                // 第二層：DecorView 與 WebView 元件層級常亮旗標（避免全螢幕切換時旗標被覆寫）
                View decorView = activity.getWindow().getDecorView();
                if (decorView != null) {
                    decorView.setKeepScreenOn(keepOn);
                }
                if (webView != null && webView.getView() != null) {
                    webView.getView().setKeepScreenOn(keepOn);
                }
            } catch (Exception ignored) {
                // 忽略個別機型視窗旗標限制
            }
        });

        // 第三層與第四層：前景 WakeLock 與使用者活動計時器重設（僅於前景且開啟常亮時持有，休眠或離場立即釋放）
        if (keepOn && isInForeground) {
            acquireForegroundWakeLock(activity);
            pulseUserActivityTimerIfDue(activity, true);
        } else {
            releaseAllWakeLocks();
        }
    }

    @SuppressWarnings("deprecation")
    private synchronized void acquireForegroundWakeLock(Activity activity) {
        if (activity == null) return;
        try {
            if (foregroundWakeLock != null && foregroundWakeLock.isHeld()) {
                return;
            }
            PowerManager pm =
                    (PowerManager) activity.getApplicationContext().getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            try {
                foregroundWakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ON_AFTER_RELEASE,
                        "tw.eink.clockdashboard:ForegroundKeepScreenOn"
                );
            } catch (Exception ignored) {
                foregroundWakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_DIM_WAKE_LOCK | PowerManager.ON_AFTER_RELEASE,
                        "tw.eink.clockdashboard:ForegroundDimKeepOn"
                );
            }
            if (foregroundWakeLock != null) {
                foregroundWakeLock.setReferenceCounted(false);
                foregroundWakeLock.acquire();
            }
        } catch (Exception ignored) {
            // 若個別機型拒絕 WakeLock 則維持視窗與 View 層常亮
        }
    }

    @SuppressWarnings("deprecation")
    private synchronized void pulseUserActivityTimerIfDue(Activity activity, boolean force) {
        if (activity == null || !isInForeground || !keepScreenOnEnabled) return;
        long now = System.currentTimeMillis();
        if (!force && (now - lastUserActivityPulseAt) < USER_ACTIVITY_PULSE_INTERVAL_MS) {
            return;
        }
        try {
            PowerManager pm =
                    (PowerManager) activity.getApplicationContext().getSystemService(Context.POWER_SERVICE);
            if (pm == null || !pm.isInteractive()) {
                return;
            }
            // 透過短暫持有並釋放附帶 ON_AFTER_RELEASE 的喚醒鎖，觸發系統重設「無操作休眠計時器」回 0 分鐘
            releasePulseWakeLockOnly();
            PowerManager.WakeLock wl;
            try {
                wl = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ON_AFTER_RELEASE,
                        "tw.eink.clockdashboard:UserActivityResetPulse"
                );
            } catch (Exception ignored) {
                wl = pm.newWakeLock(
                        PowerManager.SCREEN_DIM_WAKE_LOCK | PowerManager.ON_AFTER_RELEASE,
                        "tw.eink.clockdashboard:UserActivityDimPulse"
                );
            }
            wl.setReferenceCounted(false);
            wl.acquire(1000L);
            pulseWakeLock = wl;
            lastUserActivityPulseAt = now;

            releasePulseRunnable = this::releasePulseWakeLockOnly;
            mainHandler.postDelayed(releasePulseRunnable, 200L);
        } catch (Exception ignored) {
            // 安全略過
        }
    }

    private synchronized void releasePulseWakeLockOnly() {
        if (releasePulseRunnable != null) {
            mainHandler.removeCallbacks(releasePulseRunnable);
            releasePulseRunnable = null;
        }
        try {
            if (pulseWakeLock != null && pulseWakeLock.isHeld()) {
                pulseWakeLock.release();
            }
        } catch (Exception ignored) {
            // 忽略重複釋放例外
        } finally {
            pulseWakeLock = null;
        }
    }

    private synchronized void releaseAllWakeLocks() {
        releasePulseWakeLockOnly();
        try {
            if (foregroundWakeLock != null && foregroundWakeLock.isHeld()) {
                foregroundWakeLock.release();
            }
        } catch (Exception ignored) {
            // 忽略重複釋放例外
        } finally {
            foregroundWakeLock = null;
        }
    }

    private void registerTimeTickReceiver(Activity activity) {
        if (activity == null || timeTickRegistered) return;
        try {
            if (timeTickReceiver == null) {
                timeTickReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        if (intent != null && Intent.ACTION_TIME_TICK.equals(intent.getAction())) {
                            // 借用每分鐘系統推播，每 4 分鐘重設一次無操作休眠計時器（零額外計時器耗電）
                            Activity act = cordova != null ? cordova.getActivity() : null;
                            if (act != null && isInForeground && keepScreenOnEnabled) {
                                acquireForegroundWakeLock(act);
                                pulseUserActivityTimerIfDue(act, false);
                            }
                            deliverTimeTick();
                        }
                    }
                };
            }
            IntentFilter filter = new IntentFilter(Intent.ACTION_TIME_TICK);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                activity.registerReceiver(timeTickReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                activity.registerReceiver(timeTickReceiver, filter);
            }
            timeTickRegistered = true;
        } catch (Exception ignored) {
            timeTickRegistered = false;
        }
    }

    private void unregisterTimeTickReceiver(Activity activity) {
        if (activity == null || !timeTickRegistered || timeTickReceiver == null) return;
        try {
            activity.unregisterReceiver(timeTickReceiver);
        } catch (Exception ignored) {
            // 若系統已註銷則安全略過
        } finally {
            timeTickRegistered = false;
        }
    }

    private void deliverTimeTick() {
        if (timeTickCallbackContext == null) return;
        try {
            PluginResult result = new PluginResult(PluginResult.Status.OK, System.currentTimeMillis());
            result.setKeepCallback(true);
            timeTickCallbackContext.sendPluginResult(result);
        } catch (Exception ignored) {
            // 忽略 WebView 尚未就緒或已銷毀時的回呼錯誤
        }
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

        // 1. 飛航模式（僅於已透過 ADB 授予 WRITE_SECURE_SETTINGS 權限時可直接切換）
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
                        // 新版 Android 保護廣播，設定值本身仍已更新
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
                        // 安全略過
                    }
                    airplaneStatus = "restored";
                } catch (Exception ignored) {
                    airplaneStatus = "os_restricted";
                }
            } else {
                airplaneStatus = "os_restricted";
            }
        }

        // 2. Wi-Fi（Android 9 以下可直接切換；Android 10 以上受系統限制）
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

        // 3. 藍牙（Android 7～12 可於授權後直接開關；Android 13 以上受系統限制）
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
                        // 安全略過
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
        Intent intent;

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
            // 若機型不支援特定設定頁則退回無線與網路設定
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

        if ("setKeepScreenOn".equals(action)) {
            boolean keepOn = args.optBoolean(0, true);
            try {
                keepScreenOnEnabled = keepOn;
                getRadioPrefs().edit().putBoolean(PREF_KEEP_SCREEN_ON, keepOn).apply();
                applyKeepScreenOnState(cordova.getActivity(), keepOn);
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to update keep screen on: " + e.getMessage());
            }
            return true;
        }

        if ("listenTimeTick".equals(action)) {
            timeTickCallbackContext = callbackContext;
            Activity activity = cordova.getActivity();
            if (activity != null) {
                registerTimeTickReceiver(activity);
            }
            PluginResult noop = new PluginResult(PluginResult.Status.NO_RESULT);
            noop.setKeepCallback(true);
            callbackContext.sendPluginResult(noop);
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
