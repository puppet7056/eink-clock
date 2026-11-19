package tw.eink.clockdashboard;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
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
 * Lightweight native Android OAuth 2.0 bridge for Cordova Android 13+ (API 34).
 * - Opens Google OAuth URLs in the system browser (no GMS required; works on BOOX/Viwoods/Read6).
 * - Delivers custom URI scheme redirect callbacks back into the WebView via onNewIntent.
 * - Persists ONLY the OAuth refresh_token encrypted with Android Keystore AES-256-GCM
 *   in app-private SharedPreferences so APK upgrades and reboots keep users signed in
 *   without ever storing access tokens in WebView localStorage/sessionStorage.
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

    private CallbackContext listenerCallbackContext = null;
    private String pendingCallbackUrl = null;

    @Override
    public void initialize(CordovaInterface cordova, CordovaWebView webView) {
        super.initialize(cordova, webView);
        Intent launchIntent = cordova.getActivity().getIntent();
        handlePossibleOAuthIntent(launchIntent);
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
            // Fallback for E-Ink ROMs with non-standard Keystore TEE:
            // still isolated inside Android app-private MODE_PRIVATE storage (never in WebView storage)
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
            // Key invalidated or corrupted: clear safely and prompt clean sign-in
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

        return false;
    }
}
