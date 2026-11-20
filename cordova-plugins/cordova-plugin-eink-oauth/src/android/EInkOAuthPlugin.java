package tw.eink.clockdashboard;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
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
 * Lightweight native Android bridge for Cordova Android 13+ (API 34):
 * - OAuth 2.0 system-browser sign-in & custom URI scheme deep-link callback (no GMS required).
 * - Android Keystore AES-256-GCM encrypted refresh_token persistence across APK updates/reboots.
 * - AlarmManager.setAlarmClock() deep-sleep auto-wake scheduler & screen-turn-on window flags.
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
    private static final int REQ_POST_NOTIFICATIONS = 4301;

    private CallbackContext listenerCallbackContext = null;
    private String pendingCallbackUrl = null;

    @Override
    public void initialize(CordovaInterface cordova, CordovaWebView webView) {
        super.initialize(cordova, webView);
        Activity activity = cordova.getActivity();
        if (activity != null) {
            Intent launchIntent = activity.getIntent();
            boolean wokenByAlarm =
                    launchIntent != null
                            && launchIntent.getBooleanExtra(EInkWakeReceiver.EXTRA_AUTO_WAKE_LAUNCH, false);
            if (wokenByAlarm || EInkWakeReceiver.isDailyWakeEnabled(activity)) {
                applyWakeWindowFlags(activity, true, wokenByAlarm);
            }
            handlePossibleOAuthIntent(launchIntent);
        }
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (cordova != null && cordova.getActivity() != null && intent != null) {
            Activity activity = cordova.getActivity();
            activity.setIntent(intent);
            if (intent.getBooleanExtra(EInkWakeReceiver.EXTRA_AUTO_WAKE_LAUNCH, false)) {
                applyWakeWindowFlags(activity, true, true);
            }
        }
        handlePossibleOAuthIntent(intent);
    }

    @SuppressWarnings("deprecation")
    private void applyWakeWindowFlags(Activity activity, boolean allowWakeOverLock, boolean requestDismissKeyguard) {
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    activity.setShowWhenLocked(allowWakeOverLock);
                    activity.setTurnScreenOn(allowWakeOverLock);
                } else {
                    int flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD;
                    if (allowWakeOverLock) {
                        activity.getWindow().addFlags(flags);
                    } else {
                        activity.getWindow().clearFlags(flags);
                    }
                }
                if (requestDismissKeyguard && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
                    if (km != null && km.isKeyguardLocked()) {
                        km.requestDismissKeyguard(activity, null);
                    }
                }
            } catch (Exception ignored) {
                // Ignore ROM-specific window flag restrictions
            }
        });
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

        if ("scheduleDailyWake".equals(action)) {
            int hour = args.optInt(0, 7);
            int minute = args.optInt(1, 0);
            try {
                Activity activity = cordova.getActivity();
                maybeRequestPostNotifications(activity);
                applyWakeWindowFlags(activity, true, false);
                JSONObject res = EInkWakeReceiver.scheduleDailyWake(activity, hour, minute);
                callbackContext.success(res);
            } catch (Exception e) {
                callbackContext.error("Failed to schedule daily wake: " + e.getMessage());
            }
            return true;
        }

        if ("cancelDailyWake".equals(action)) {
            try {
                Activity activity = cordova.getActivity();
                EInkWakeReceiver.cancelDailyWake(activity);
                applyWakeWindowFlags(activity, false, false);
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to cancel daily wake: " + e.getMessage());
            }
            return true;
        }

        if ("scheduleTestWake".equals(action)) {
            int delaySeconds = args.optInt(0, 60);
            try {
                Activity activity = cordova.getActivity();
                maybeRequestPostNotifications(activity);
                applyWakeWindowFlags(activity, true, false);
                JSONObject res = EInkWakeReceiver.scheduleTestWake(activity, delaySeconds);
                callbackContext.success(res);
            } catch (Exception e) {
                callbackContext.error("Failed to schedule test wake: " + e.getMessage());
            }
            return true;
        }

        if ("getWakeStatus".equals(action)) {
            try {
                JSONObject res = EInkWakeReceiver.getWakeStatus(cordova.getActivity());
                callbackContext.success(res);
            } catch (Exception e) {
                callbackContext.error("Failed to get wake status: " + e.getMessage());
            }
            return true;
        }

        if ("openWakePermissionSettings".equals(action)) {
            String target = args.optString(0, "overlay");
            try {
                openWakePermissionSettings(cordova.getActivity(), target);
                callbackContext.success();
            } catch (Exception e) {
                callbackContext.error("Failed to open settings: " + e.getMessage());
            }
            return true;
        }

        return false;
    }

    private void maybeRequestPostNotifications(Activity activity) {
        if (activity == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                String perm = "android.permission.POST_NOTIFICATIONS";
                if (activity.checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
                    cordova.requestPermission(this, REQ_POST_NOTIFICATIONS, perm);
                }
            } catch (Exception ignored) {
                // ignore
            }
        }
    }

    private void openWakePermissionSettings(Activity activity, String target) {
        if (activity == null) return;
        String pkg = activity.getPackageName();
        Uri pkgUri = Uri.parse("package:" + pkg);
        Intent intent = null;

        if ("overlay".equals(target) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkgUri);
        } else if ("exact_alarm".equals(target) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkgUri);
        } else if ("fullscreen".equals(target) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkgUri);
        } else if ("notifications".equals(target) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        }

        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                activity.startActivity(intent);
                return;
            } catch (Exception ignored) {
                // Fall back to app details page below
            }
        }

        Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri);
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(fallback);
    }
}
