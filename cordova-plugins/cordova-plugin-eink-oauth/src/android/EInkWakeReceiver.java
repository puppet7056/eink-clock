package tw.eink.clockdashboard;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PowerManager;
import java.util.Calendar;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native Android AlarmManager wake scheduler & BroadcastReceiver for E-Ink Clock Dashboard.
 * Wakes the device from Android Deep Sleep / Doze at the scheduled morning hour (or a 60s test),
 * turns the screen on, brings MainActivity back to foreground, and reschedules the next day.
 */
public class EInkWakeReceiver extends BroadcastReceiver {
    public static final String ACTION_AUTO_WAKE = "tw.eink.clockdashboard.ACTION_AUTO_WAKE";
    public static final String EXTRA_IS_TEST = "eink_wake_is_test";
    public static final String EXTRA_AUTO_WAKE_LAUNCH = "eink_auto_wake_launch";

    private static final String PREFS_NAME = "eink_clock_wake_prefs";
    private static final String PREF_ENABLED = "wake_enabled";
    private static final String PREF_HOUR = "wake_hour";
    private static final String PREF_MINUTE = "wake_minute";
    private static final String PREF_NEXT_TRIGGER = "wake_next_trigger";
    private static final String PREF_TEST_ACTIVE = "wake_test_active";

    private static final int REQ_CODE_DAILY = 4101;
    private static final int REQ_CODE_TEST = 4102;
    private static final int REQ_CODE_SHOW = 4103;

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

    private static PendingIntent buildAlarmOperation(Context context, boolean isTest) {
        Intent intent = new Intent(context.getApplicationContext(), EInkWakeReceiver.class);
        intent.setAction(ACTION_AUTO_WAKE);
        intent.putExtra(EXTRA_IS_TEST, isTest);
        return PendingIntent.getBroadcast(
                context.getApplicationContext(),
                isTest ? REQ_CODE_TEST : REQ_CODE_DAILY,
                intent,
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

    private static boolean scheduleAlarmAt(Context context, long triggerAtMillis, boolean isTest) {
        AlarmManager alarmManager =
                (AlarmManager) context.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            return false;
        }

        PendingIntent operation = buildAlarmOperation(context, isTest);
        PendingIntent showIntent = buildShowActivityIntent(context);

        boolean canExact = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                canExact = alarmManager.canScheduleExactAlarms();
            } catch (Exception ignored) {
                canExact = false;
            }
        }

        if (canExact) {
            try {
                AlarmManager.AlarmClockInfo clockInfo =
                        new AlarmManager.AlarmClockInfo(triggerAtMillis, showIntent);
                alarmManager.setAlarmClock(clockInfo, operation);
                return true;
            } catch (SecurityException ignored) {
                // Fall through to inexact idle-allowed alarm
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, operation);
        } else {
            alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMillis, operation);
        }
        return false;
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
        boolean exact = scheduleAlarmAt(context, triggerAtMillis, false);

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

    public static void cancelDailyWake(Context context) {
        AlarmManager alarmManager =
                (AlarmManager) context.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            alarmManager.cancel(buildAlarmOperation(context, false));
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
        boolean exact = scheduleAlarmAt(context, triggerAtMillis, true);

        JSONObject result = new JSONObject();
        result.put("scheduled", true);
        result.put("exact", exact);
        result.put("delaySeconds", clampedDelay);
        result.put("triggerAtMillis", triggerAtMillis);
        return result;
    }

    public static JSONObject getWakeStatus(Context context) throws JSONException {
        SharedPreferences prefs = getPrefs(context);
        JSONObject result = new JSONObject();
        result.put("enabled", prefs.getBoolean(PREF_ENABLED, false));
        result.put("hour", prefs.getInt(PREF_HOUR, 7));
        result.put("minute", prefs.getInt(PREF_MINUTE, 0));
        result.put("nextTriggerMillis", prefs.getLong(PREF_NEXT_TRIGGER, 0L));
        return result;
    }

    public static boolean isDailyWakeEnabled(Context context) {
        return getPrefs(context).getBoolean(PREF_ENABLED, false);
    }

    @SuppressWarnings("deprecation")
    private void wakeDeviceAndLaunchClock(Context context) {
        try {
            PowerManager pm =
                    (PowerManager) context.getApplicationContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                                | PowerManager.ON_AFTER_RELEASE,
                        "tw.eink.clockdashboard:AutoWakeLock"
                );
                wl.setReferenceCounted(false);
                wl.acquire(15000L);
            }
        } catch (Exception ignored) {
            // Best-effort screen wakeup
        }

        try {
            Intent launch = createLaunchMainActivityIntent(context);
            context.getApplicationContext().startActivity(launch);
        } catch (Exception ignored) {
            // Activity launch may be restricted on some ROMs if keyguard is locked
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
                wakeDeviceAndLaunchClock(context);
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

            wakeDeviceAndLaunchClock(context);
        }
    }
}
