package ai.cosmos.timeassistant;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

public class Reminder {
    static final String PREFS = "reminders";
    static final String KEY = "list";
    static final String CHANNEL = "plan2"; // 换 id：通道创建后配置不可改，老通道是静音的

    static void ensureChannel(Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            // 老通道（没声音没震动）删掉，免得用户还留着
            if (nm.getNotificationChannel("plan") != null) {
                nm.deleteNotificationChannel("plan");
            }

            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL, "计划提醒", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("到点提醒该做哪一段");
                // 关键：不显式设置的话，通道默认静音且不震动
                ch.enableVibration(true);
                ch.setVibrationPattern(new long[]{0, 350, 180, 350});
                ch.enableLights(true);
                ch.setLightColor(0xFF7FA8C9);
                ch.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
                ch.setSound(
                        android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION),
                        new android.media.AudioAttributes.Builder()
                                .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build());
                nm.createNotificationChannel(ch);
            }
        } catch (Exception ignored) {
        }
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static PendingIntent pi(Context c, String id) {
        Intent it = new Intent(c, AlarmReceiver.class);
        return PendingIntent.getBroadcast(c, id.hashCode(), it,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 覆盖式设定全部提醒：先撤旧的，再按 JSON 重新建 */
    static void apply(Context c, String json) {
        ensureChannel(c);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        try {
            JSONArray old = new JSONArray(prefs(c).getString(KEY, "[]"));
            for (int i = 0; i < old.length(); i++) {
                am.cancel(pi(c, old.getJSONObject(i).optString("id", "x" + i)));
            }
        } catch (Exception ignored) {
        }

        prefs(c).edit().putString(KEY, json == null ? "[]" : json).apply();

        try {
            JSONArray arr = new JSONArray(json == null ? "[]" : json);
            long now = System.currentTimeMillis();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                long at = o.optLong("at", 0);
                if (at <= now) continue;
                String id = o.optString("id", "r" + i);
                Intent it = new Intent(c, AlarmReceiver.class);
                it.putExtra("id", id);
                it.putExtra("title", o.optString("title", "该开始了"));
                it.putExtra("text", o.optString("text", ""));
                PendingIntent fire = PendingIntent.getBroadcast(c, id.hashCode(), it,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                try {
                    if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
                    } else {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
                    }
                } catch (SecurityException se) {
                    am.set(AlarmManager.RTC_WAKEUP, at, fire);
                }
            }
        } catch (Exception ignored) {
        }
    }
}
