package tw.eink.clockdashboard;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.view.WindowManager;

/**
 * Dedicated translucent wake bridge Activity declared with android:turnScreenOn="true"
 * and android:showWhenLocked="true" in AndroidManifest.xml.
 *
 * On Android 10-14 (including BOOX E-Ink tablets), sending onNewIntent() to an already-stopped
 * MainActivity often fails to wake the physical display. Launching a fresh Activity instance
 * forces WindowManagerService to turn the screen on, dismiss the lock/standby overlay, and
 * hand foreground focus cleanly back to MainActivity.
 */
public class EInkWakeActivity extends Activity {
    public static final String EXTRA_WAKE_SOURCE = "eink_wake_source";
    public static final String EXTRA_IS_TEST_WAKE = "eink_wake_is_test";

    private PowerManager.WakeLock wakeLock;
    private boolean handedOff = false;

    @SuppressWarnings("deprecation")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        applyTurnScreenOnFlags();
        acquireStrongWakeLock();
        dismissWakeNotification();

        Intent intent = getIntent();
        String source = intent != null ? intent.getStringExtra(EXTRA_WAKE_SOURCE) : null;
        if (source == null || source.isEmpty()) {
            source = "direct-activity";
        }
        boolean isTest = intent != null && intent.getBooleanExtra(EXTRA_IS_TEST_WAKE, false);

        // If launched directly by AlarmManager (Path 2) for a daily wake, ensure tomorrow is scheduled.
        if (!isTest && "alarm-activity".equals(source)) {
            EInkWakeReceiver.rescheduleDailyIfDue(getApplicationContext());
        }

        boolean alreadyHandledRecently = EInkWakeReceiver.isWakeActivityDuplicate(getApplicationContext());
        EInkWakeReceiver.recordWakeActivityStarted(getApplicationContext(), source);

        if (!alreadyHandledRecently) {
            handoffToMainActivity();
        } else {
            scheduleFinish(250L);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyTurnScreenOnFlags();
        acquireStrongWakeLock();
        dismissWakeNotification();
        if (!handedOff) {
            handoffToMainActivity();
        }
    }

    @SuppressWarnings("deprecation")
    private void applyTurnScreenOnFlags() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            }
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                            | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            );
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
                if (km != null && km.isKeyguardLocked()) {
                    km.requestDismissKeyguard(this, null);
                }
            }
        } catch (Exception ignored) {
            // Best-effort across vendor ROMs
        }
    }

    @SuppressWarnings("deprecation")
    private void acquireStrongWakeLock() {
        try {
            PowerManager pm = (PowerManager) getApplicationContext().getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (wakeLock != null && wakeLock.isHeld()) {
                return;
            }
            try {
                wakeLock = pm.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK
                                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                | PowerManager.ON_AFTER_RELEASE,
                        "tw.eink.clockdashboard:WakeActivityFullLock"
                );
            } catch (Exception ignored) {
                wakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                | PowerManager.ON_AFTER_RELEASE,
                        "tw.eink.clockdashboard:WakeActivityScreenLock"
                );
            }
            if (wakeLock != null) {
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(15000L);
            }
        } catch (Exception ignored) {
            // Best-effort
        }
    }

    private void dismissWakeNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(EInkWakeReceiver.WAKE_NOTIFICATION_ID);
            }
        } catch (Exception ignored) {
            // ignore
        }
    }

    private void handoffToMainActivity() {
        handedOff = true;
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                Intent mainIntent = EInkWakeReceiver.createLaunchMainActivityIntent(getApplicationContext());
                startActivity(mainIntent);
            } catch (Exception e) {
                EInkWakeReceiver.recordWakeError(
                        getApplicationContext(),
                        "WakeActivity->MainActivity: " + e.getMessage()
                );
            } finally {
                EInkWakeReceiver.recordInteractiveAfterActivity(getApplicationContext());
                scheduleFinish(350L);
            }
        }, 180L);
    }

    private void scheduleFinish(long delayMs) {
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                finish();
                overridePendingTransition(0, 0);
            } catch (Exception ignored) {
                // ignore
            }
        }, delayMs);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
            // ignore
        }
    }
}
