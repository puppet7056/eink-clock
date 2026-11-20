package tw.eink.clockdashboard;

import android.app.ActivityOptions;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import java.util.Calendar;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native Android AlarmManager wake scheduler & BroadcastReceiver for E-Ink Clock Dashboard.
 *
 * Uses a resilient triple-path wake strategy compatible with Android 7-14 (including BOOX E-Ink):
 * 1. AlarmManager.setAlarmClock() -> EInkWakeReceiver:
 *    - Acquires FULL_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP
 *    - Posts a silent IMPORTANCE_HIGH CATEGORY_ALARM Notification with Full-Screen Intent
 *      (Android 10-14 official BAL-exempt screen wake mechanism)
 *    - Directly starts EInkWakeActivity (succeeds immediately when overlay permission is granted)
 * 2. Parallel AlarmManager.setAlarmClock() (+800ms) -> PendingIntent.getActivity(EInkWakeActivity)
 *    with MODE_BACKGROUND_ACTIVITY_START_ALLOWED on API 34+, acting as an OS-level backup wake path.
 * 3. Persistent wake diagnostics recorded in SharedPreferences so the user can inspect exact
 *    alarm trigger & screen wake status in Settings.
 */
public class EInkWakeReceiver extends BroadcastReceiver {
    public static final String ACTION_AUTO_WAKE = "tw.eink.clockdashboard.ACTION_AUTO_WAKE";
    public static final String EXTRA_IS_TEST = "eink_wake_is_test";
    public static final String EXTRA_AUTO_WAKE_LAUNCH = "eink_auto_wake_launch";

    public static final String WAKE_CHANNEL_ID = "eink_clock_auto_wake_v1";
    public static final int WAKE_NOTIFICATION_ID = 4201;

    private static final String PREFS_NAME = "eink_clock_wake_prefs";
    private static final String PREF_ENABLED = "wake_enabled";
    private static final String PREF_HOUR = "wake_hour";
    private static final String PREF_MINUTE = "wake_minute";
    private static final String PREF_NEXT_TRIGGER = "wake_next_trigger";
    private static final String PREF_TEST_ACTIVE = "wake_test_active";

    // Diagnostic fields
    private static final String PREF_DIAG_KIND = "diag_kind";
    private static final String PREF_DIAG_SCHEDULED_AT = "diag_scheduled_at";
    private static final String PREF_DIAG_TARGET_AT = "diag_target_at";
    private static final String PREF_DIAG_ALARM_FIRED_AT = "diag_alarm_fired_at";
    private static final String PREF_DIAG_WAKE_ACTIVITY_AT = "diag_wake_activity_at";
    private static final String PREF_DIAG_WAKE_SOURCE = "diag_wake_source";
    private static final String PREF_DIAG_INTERACTIVE_BEFORE = "diag_interactive_before";
    private static final String PREF_DIAG_INTERACTIVE_AFTER = "diag_interactive_after";
    private static final String PREF_DIAG_LAST_ERROR = "diag_last_error";
    private static final String PREF_DIAG_EXACT = "diag_exact";

    private static final int REQ_CODE_DAILY_BROADCAST = 4101;
    private static final int REQ_CODE_TEST_BROADCAST = 4102;
    private static final int REQ_CODE_SHOW = 4103;
    private static final int REQ_CODE_DAILY_ACTIVITY = 4104;
    private static final int REQ_CODE_TEST_ACTIVITY = 4105;
    private static final int REQ_CODE_FULLSCREEN_INTENT = 4106;

    private static SharedPreferences getPrefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static int immutableUpdateFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    private static Bundle buildBalAllowedActivityOptions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                ActivityOptions opts = ActivityOptions.makeBasic();
                opts.setPendingIntentBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                );
                return opts.toBundle();
            } catch (Exception ignored) {
                // fallback to null
            }
        }
        return null;
    }

    private static PendingIntent buildAlarmBroadcastOperation(Context context, boolean isTest) {
        Intent intent = new Intent(context.getApplicationContext(), EInkWakeReceiver.class);
        intent.setAction(ACTION_AUTO_WAKE);
        intent.putExtra(EXTRA_IS_TEST, isTest);
        return PendingIntent.getBroadcast(
                context.getApplicationContext(),
                isTest ? REQ_CODE_TEST_BROADCAST : REQ_CODE_DAILY_BROADCAST,
                intent,
                immutableUpdateFlags()
        );
    }

    public static Intent createWakeActivityIntent(Context context, String source, boolean isTest) {
        Intent intent = new Intent(context.getApplicationContext(), EInkWakeActivity.class);
        intent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_ACTIVITY_NO_USER_ACTION
        );
        intent.putExtra(EInkWakeActivity.EXTRA_WAKE_SOURCE, source);
        intent.putExtra(EInkWakeActivity.EXTRA_IS_TEST_WAKE, isTest);
        return intent;
    }

    private static PendingIntent buildWakeActivityPendingIntent(
            Context context,
            int requestCode,
            String source,
            boolean isTest
    ) {
        Intent wakeIntent = createWakeActivityIntent(context, source, isTest);
        Bundle options = buildBalAllowedActivityOptions();
        if (options != null) {
            return PendingIntent.getActivity(
                    context.getApplicationContext(),
                    requestCode,
                    wakeIntent,
                    immutableUpdateFlags(),
                    options
            );
        }
        return PendingIntent.getActivity(
                context.getApplicationContext(),
                requestCode,
                wakeIntent,
                immutableUpdateFlags()
        );
    }

    private static PendingIntent buildShowActivityIntent(Context context) {
        Intent launch = createLaunchMainActivityIntent(context);
        return PendingIntent.getActivity(
                context.getApplicationContext(),
                REQ_CODE_SHOW,
                launch,
                immutableUpdateFlags()
        );
    }

    public static Intent createLaunchMainActivityIntent(Context context) {
        Context appCtx = context.getApplicationContext();
        Intent launch = appCtx.getPackageManager().getLaunchIntentForPackage(appCtx.getPackageName());
        if (launch == null) {
            launch = new Intent(appCtx, MainActivity.class);
        }
        launch.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );
        launch.putExtra(EXTRA_AUTO_WAKE_LAUNCH, true);
        return launch;
    }

    private static boolean canScheduleExactAlarms(Context context) {
        AlarmManager alarmManager =
                (AlarmManager) context.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                return alarmManager.canScheduleExactAlarms();
            } catch (Exception ignored) {
                return false;
            }
        }
        return true;
    }

    private static boolean scheduleSingleAlarm(
            Context context,
            long triggerAtMillis,
            PendingIntent operation
    ) {
        AlarmManager alarmManager =
                (AlarmManager) context.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            return false;
        }

        PendingIntent showIntent = buildShowActivityIntent(context);
        if (canScheduleExactAlarms(context)) {
            try {
                AlarmManager.AlarmClockInfo clockInfo =
                        new AlarmManager.AlarmClockInfo(triggerAtMillis, showIntent);
                alarmManager.setAlarmClock(clockInfo, operation);
                return true;
            } catch (SecurityException ignored) {
                // Fall through to idle-allowed alarm
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, operation);
        } else {
            alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMillis, operation);
        }
        return false;
    }

    private static boolean scheduleDualAlarms(Context context, long triggerAtMillis, boolean isTest) {
        PendingIntent broadcastOp = buildAlarmBroadcastOperation(context, isTest);
        boolean exactBroadcast = scheduleSingleAlarm(context, triggerAtMillis, broadcastOp);

        // Backup OS-level Activity PendingIntent +800ms later in case BroadcastReceiver BAL is blocked
        PendingIntent directActivityOp = buildWakeActivityPendingIntent(
                context,
                isTest ? REQ_CODE_TEST_ACTIVITY : REQ_CODE_DAILY_ACTIVITY,
                "alarm-activity",
                isTest
        );
        scheduleSingleAlarm(context, triggerAtMillis + 800L, directActivityOp);
        return exactBroadcast;
    }

    private static void resetDiagnosticsForSchedule(
            Context context,
            String kind,
            long targetAtMillis,
            boolean exact
    ) {
        getPrefs(context)
                .edit()
                .putString(PREF_DIAG_KIND, kind)
                .putLong(PREF_DIAG_SCHEDULED_AT, System.currentTimeMillis())
                .putLong(PREF_DIAG_TARGET_AT, targetAtMillis)
                .putLong(PREF_DIAG_ALARM_FIRED_AT, 0L)
                .putLong(PREF_DIAG_WAKE_ACTIVITY_AT, 0L)
                .putString(PREF_DIAG_WAKE_SOURCE, "")
                .putBoolean(PREF_DIAG_INTERACTIVE_BEFORE, false)
                .putBoolean(PREF_DIAG_INTERACTIVE_AFTER, false)
                .putString(PREF_DIAG_LAST_ERROR, "")
                .putBoolean(PREF_DIAG_EXACT, exact)
                .apply();
    }

    public static JSONObject scheduleDailyWake(Context context, int hour, int minute) throws JSONException {
        int clampedHour = Math.max(0, Math.min(23, hour));
        int clampedMinute = Math.max(0, Math.min(59, minute));

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, clampedHour);
        cal.set(Calendar.MINUTE, clampedMinute);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);

        long now = System.currentTimeMillis();
        if (cal.getTimeInMillis() <= now + 15000L) {
            cal.add(Calendar.DAY_OF_YEAR, 1);
        }

        long triggerAtMillis = cal.getTimeInMillis();
        boolean exact = scheduleDualAlarms(context, triggerAtMillis, false);

        getPrefs(context)
                .edit()
                .putBoolean(PREF_ENABLED, true)
                .putInt(PREF_HOUR, clampedHour)
                .putInt(PREF_MINUTE, clampedMinute)
                .putLong(PREF_NEXT_TRIGGER, triggerAtMillis)
                .apply();

        JSONObject result = new JSONObject();
        result.put("scheduled", true);
        result.put("exact", exact);
        result.put("triggerAtMillis", triggerAtMillis);
        result.put("hour", clampedHour);
        result.put("minute", clampedMinute);
        return result;
    }

    public static void rescheduleDailyIfDue(Context context) {
        SharedPreferences prefs = getPrefs(context);
        if (!prefs.getBoolean(PREF_ENABLED, false)) return;
        long nextTrigger = prefs.getLong(PREF_NEXT_TRIGGER, 0L);
        if (nextTrigger <= System.currentTimeMillis() + 60000L) {
            int hour = prefs.getInt(PREF_HOUR, 7);
            int minute = prefs.getInt(PREF_MINUTE, 0);
            try {
                scheduleDailyWake(context, hour, minute);
            } catch (Exception ignored) {
                // ignore
            }
        }
    }

    public static void cancelDailyWake(Context context) {
        AlarmManager alarmManager =
                (AlarmManager) context.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            alarmManager.cancel(buildAlarmBroadcastOperation(context, false));
            alarmManager.cancel(buildWakeActivityPendingIntent(
                    context,
                    REQ_CODE_DAILY_ACTIVITY,
                    "alarm-activity",
                    false
            ));
        }
        getPrefs(context)
                .edit()
                .putBoolean(PREF_ENABLED, false)
                .putLong(PREF_NEXT_TRIGGER, 0L)
                .apply();
    }

    public static JSONObject scheduleTestWake(Context context, int delaySeconds) throws JSONException {
        int clampedDelay = Math.max(15, Math.min(600, delaySeconds));
        long triggerAtMillis = System.currentTimeMillis() + (clampedDelay * 1000L);

        getPrefs(context).edit().putBoolean(PREF_TEST_ACTIVE, true).apply();
        boolean exact = scheduleDualAlarms(context, triggerAtMillis, true);
        resetDiagnosticsForSchedule(context, "test", triggerAtMillis, exact);

        JSONObject result = new JSONObject();
        result.put("scheduled", true);
        result.put("exact", exact);
        result.put("delaySeconds", clampedDelay);
        result.put("triggerAtMillis", triggerAtMillis);
        return result;
    }

    public static boolean isWakeActivityDuplicate(Context context) {
        long lastActivityAt = getPrefs(context).getLong(PREF_DIAG_WAKE_ACTIVITY_AT, 0L);
        return lastActivityAt > 0L && (System.currentTimeMillis() - lastActivityAt) < 10000L;
    }

    public static void recordWakeActivityStarted(Context context, String source) {
        boolean interactiveNow = isScreenInteractive(context);
        getPrefs(context)
                .edit()
                .putLong(PREF_DIAG_WAKE_ACTIVITY_AT, System.currentTimeMillis())
                .putString(PREF_DIAG_WAKE_SOURCE, source != null ? source : "")
                .putBoolean(PREF_DIAG_INTERACTIVE_AFTER, interactiveNow)
                .apply();
    }

    public static void recordInteractiveAfterActivity(Context context) {
        boolean interactiveNow = isScreenInteractive(context);
        getPrefs(context)
                .edit()
                .putBoolean(PREF_DIAG_INTERACTIVE_AFTER, interactiveNow)
                .apply();
    }

    public static void recordWakeError(Context context, String err) {
        if (err == null || err.isEmpty()) return;
        getPrefs(context).edit().putString(PREF_DIAG_LAST_ERROR, err).apply();
    }

    private static boolean isScreenInteractive(Context context) {
        try {
            PowerManager pm =
                    (PowerManager) context.getApplicationContext().getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isInteractive();
        } catch (Exception ignored) {
            return false;
        }
    }

    public static JSONObject getWakeDiagnostics(Context context) throws JSONException {
        Context appCtx = context.getApplicationContext();
        SharedPreferences prefs = getPrefs(appCtx);

        boolean canExact = canScheduleExactAlarms(appCtx);
        boolean canDrawOverlays = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                canDrawOverlays = Settings.canDrawOverlays(appCtx);
            } catch (Exception ignored) {
                canDrawOverlays = false;
            }
        }

        boolean notificationsEnabled = true;
        boolean canFullScreenIntent = true;
        try {
            NotificationManager nm =
                    (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    notificationsEnabled = nm.areNotificationsEnabled();
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    canFullScreenIntent = nm.canUseFullScreenIntent();
                }
            }
        } catch (Exception ignored) {
            // ignore
        }

        boolean ignoringBatteryOpt = false;
        try {
            PowerManager pm = (PowerManager) appCtx.getSystemService(Context.POWER_SERVICE);
            if (pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                ignoringBatteryOpt = pm.isIgnoringBatteryOptimizations(appCtx.getPackageName());
            }
        } catch (Exception ignored) {
            // ignore
        }

        JSONObject result = new JSONObject();
        result.put("sdkInt", Build.VERSION.SDK_INT);
        result.put("manufacturer", Build.MANUFACTURER != null ? Build.MANUFACTURER : "");
        result.put("model", Build.MODEL != null ? Build.MODEL : "");
        result.put("enabled", prefs.getBoolean(PREF_ENABLED, false));
        result.put("hour", prefs.getInt(PREF_HOUR, 7));
        result.put("minute", prefs.getInt(PREF_MINUTE, 0));
        result.put("nextTriggerMillis", prefs.getLong(PREF_NEXT_TRIGGER, 0L));

        result.put("canExactAlarm", canExact);
        result.put("canDrawOverlays", canDrawOverlays);
        result.put("notificationsEnabled", notificationsEnabled);
        result.put("canFullScreenIntent", canFullScreenIntent);
        result.put("ignoringBatteryOpt", ignoringBatteryOpt);

        result.put("diagKind", prefs.getString(PREF_DIAG_KIND, ""));
        result.put("diagScheduledAt", prefs.getLong(PREF_DIAG_SCHEDULED_AT, 0L));
        result.put("diagTargetAt", prefs.getLong(PREF_DIAG_TARGET_AT, 0L));
        result.put("diagAlarmFiredAt", prefs.getLong(PREF_DIAG_ALARM_FIRED_AT, 0L));
        result.put("diagWakeActivityAt", prefs.getLong(PREF_DIAG_WAKE_ACTIVITY_AT, 0L));
        result.put("diagWakeSource", prefs.getString(PREF_DIAG_WAKE_SOURCE, ""));
        result.put("diagInteractiveBefore", prefs.getBoolean(PREF_DIAG_INTERACTIVE_BEFORE, false));
        result.put("diagInteractiveAfter", prefs.getBoolean(PREF_DIAG_INTERACTIVE_AFTER, false));
        result.put("diagExact", prefs.getBoolean(PREF_DIAG_EXACT, true));
        result.put("diagLastError", prefs.getString(PREF_DIAG_LAST_ERROR, ""));
        return result;
    }

    public static JSONObject getWakeStatus(Context context) throws JSONException {
        return getWakeDiagnostics(context);
    }

    public static boolean isDailyWakeEnabled(Context context) {
        return getPrefs(context).getBoolean(PREF_ENABLED, false);
    }

    @SuppressWarnings("deprecation")
    private void ensureWakeNotificationChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel existing = nm.getNotificationChannel(WAKE_CHANNEL_ID);
            if (existing == null) {
                NotificationChannel channel = new NotificationChannel(
                        WAKE_CHANNEL_ID,
                        "自動喚醒時鐘",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("用於夜間休眠結束時從待機畫面自動喚醒電子紙時鐘");
                channel.setSound(null, null);
                channel.enableVibration(false);
                channel.enableLights(false);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                channel.setBypassDnd(true);
                nm.createNotificationChannel(channel);
            }
        }
    }

    @SuppressWarnings("deprecation")
    private void postFullScreenWakeNotification(Context context, boolean isTest) {
        try {
            NotificationManager nm =
                    (NotificationManager) context.getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureWakeNotificationChannel(nm);

            PendingIntent fullScreenPi = buildWakeActivityPendingIntent(
                    context,
                    REQ_CODE_FULLSCREEN_INTENT,
                    "fullscreen-intent",
                    isTest
            );

            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new Notification.Builder(context.getApplicationContext(), WAKE_CHANNEL_ID);
                builder.setTimeoutAfter(8000L);
            } else {
                builder = new Notification.Builder(context.getApplicationContext());
                builder.setPriority(Notification.PRIORITY_MAX);
                builder.setDefaults(0);
            }

            builder.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle("電子紙時鐘")
                    .setContentText("正在自動喚醒桌面時鐘...")
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setAutoCancel(true)
                    .setContentIntent(fullScreenPi)
                    .setFullScreenIntent(fullScreenPi, true);

            nm.notify(WAKE_NOTIFICATION_ID, builder.build());
        } catch (Exception e) {
            recordWakeError(context, "FullScreenNotif: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void wakeDeviceAndLaunchClock(Context context, boolean isTest) {
        Context appCtx = context.getApplicationContext();
        boolean interactiveBefore = isScreenInteractive(appCtx);

        getPrefs(appCtx)
                .edit()
                .putLong(PREF_DIAG_ALARM_FIRED_AT, System.currentTimeMillis())
                .putBoolean(PREF_DIAG_INTERACTIVE_BEFORE, interactiveBefore)
                .apply();

        // 1. Acquire strongest available WakeLock with ACQUIRE_CAUSES_WAKEUP
        try {
            PowerManager pm = (PowerManager) appCtx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl;
                try {
                    wl = pm.newWakeLock(
                            PowerManager.FULL_WAKE_LOCK
                                    | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                    | PowerManager.ON_AFTER_RELEASE,
                            "tw.eink.clockdashboard:AutoWakeFullLock"
                    );
                } catch (Exception ignored) {
                    wl = pm.newWakeLock(
                            PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                                    | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                    | PowerManager.ON_AFTER_RELEASE,
                            "tw.eink.clockdashboard:AutoWakeScreenLock"
                    );
                }
                wl.setReferenceCounted(false);
                wl.acquire(15000L);
            }
        } catch (Exception e) {
            recordWakeError(appCtx, "WakeLock: " + e.getMessage());
        }

        // 2. Post Android 10-14 BAL-exempt Full-Screen Intent alarm notification
        postFullScreenWakeNotification(appCtx, isTest);

        // 3. Directly launch translucent EInkWakeActivity (works immediately when overlay permission granted or API <= 28)
        try {
            Intent wakeIntent = createWakeActivityIntent(appCtx, "broadcast-direct", isTest);
            appCtx.startActivity(wakeIntent);
        } catch (Exception e) {
            recordWakeError(appCtx, "DirectStart: " + e.getMessage());
        }

        boolean interactiveAfter = isScreenInteractive(appCtx);
        if (interactiveAfter) {
            getPrefs(appCtx).edit().putBoolean(PREF_DIAG_INTERACTIVE_AFTER, true).apply();
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        SharedPreferences prefs = getPrefs(context);

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            if (prefs.getBoolean(PREF_ENABLED, false)) {
                int hour = prefs.getInt(PREF_HOUR, 7);
                int minute = prefs.getInt(PREF_MINUTE, 0);
                try {
                    scheduleDailyWake(context, hour, minute);
                } catch (Exception ignored) {
                    // ignore
                }
            }
            return;
        }

        if (ACTION_AUTO_WAKE.equals(action)) {
            boolean isTest = intent.getBooleanExtra(EXTRA_IS_TEST, false);
            if (isTest) {
                if (!prefs.getBoolean(PREF_TEST_ACTIVE, false)) {
                    return;
                }
                prefs.edit().putBoolean(PREF_TEST_ACTIVE, false).apply();
                wakeDeviceAndLaunchClock(context, true);
                return;
            }

            if (!prefs.getBoolean(PREF_ENABLED, false)) {
                return;
            }

            // Reschedule for tomorrow morning before waking the Activity
            int hour = prefs.getInt(PREF_HOUR, 7);
            int minute = prefs.getInt(PREF_MINUTE, 0);
            try {
                scheduleDailyWake(context, hour, minute);
            } catch (Exception ignored) {
                // ignore
            }

            wakeDeviceAndLaunchClock(context, false);
        }
    }
}
