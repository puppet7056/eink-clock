package tw.eink.clockdashboard;

import android.content.Intent;
import android.net.Uri;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaInterface;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.CordovaWebView;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Lightweight native Android OAuth 2.0 bridge for Cordova Android 13+ (API 34).
 * Opens Google OAuth URLs in the system browser (no GMS required; works on BOOX/Viwoods/E-Ink)
 * and delivers custom URI scheme redirect callbacks back into the WebView via onNewIntent.
 */
public class EInkOAuthPlugin extends CordovaPlugin {
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

        return false;
    }
}
