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
    static final String CHANNEL = "plan4"; // 换 id：通道创建后配置不可改，老通道是静音的

    static void ensureChannel(Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            // 老通道（没声音没震动）删掉，免得用户还留着
            for (String old : new String[]{"plan", "plan2", "plan3"}) {
                if (nm.getNotificationChannel(old) != null) nm.deleteNotificationChannel(old);
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
        } catch (Exception ex) {
            android.util.Log.e("TA-ALARM", "ensureChannel failed: " + ex, ex);
        }
    }

    /** 用户在设置里选的提示音（空 = 用系统默认） */
    static String soundPref(Context c) {
        try {
            return prefs(c).getString("sound", "");
        } catch (Exception e) {
            return "";
        }
    }

    static void setSoundPref(Context c, String uri) {
        try {
            prefs(c).edit().putString("sound", uri == null ? "" : uri).apply();
        } catch (Exception ignored) {
        }
    }

    /** 实际播放用的铃声地址：优先用户选的，否则系统默认 */
    static android.net.Uri pickSound(Context c) {
        String s = soundPref(c);
        if (s != null && s.length() > 0) {
            try {
                return android.net.Uri.parse(s);
            } catch (Exception ignored) {
            }
        }
        return android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION);
    }

    /** 给设置页显示的名字 */
    static String soundName(Context c) {
        try {
            android.net.Uri u = pickSound(c);
            if (u == null) return "系统默认";
            android.media.Ringtone rt = android.media.RingtoneManager.getRingtone(c, u);
            if (rt == null) return "系统默认";
            String t = rt.getTitle(c);
            return t == null || t.length() == 0 ? "系统默认" : t;
        } catch (Exception e) {
            return "系统默认";
        }
    }

    /** 试听用的播放器，切歌时先停掉上一个 */
    private static android.media.MediaPlayer preview;

    /** 播放一段铃声（只播一次）。uri 可以是 content:// 或本地文件路径 */
    static void playOnce(Context c, String uri) {
        stopPreview();
        try {
            android.media.MediaPlayer mp = new android.media.MediaPlayer();
            mp.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            if (uri != null && uri.startsWith("file:")) {
                mp.setDataSource(uri.substring(5));
            } else if (uri != null && uri.length() > 0) {
                mp.setDataSource(c, android.net.Uri.parse(uri));
            } else {
                mp.setDataSource(c, pickSound(c));
            }
            mp.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
                public void onCompletion(android.media.MediaPlayer m) {
                    try {
                        m.release();
                    } catch (Exception ignored) {
                    }
                }
            });
            mp.prepare();
            mp.start();
            preview = mp;
        } catch (Exception ex) {
            android.util.Log.e("TA-ALARM", "playOnce failed: " + ex, ex);
        }
    }

    static void stopPreview() {
        try {
            if (preview != null) {
                if (preview.isPlaying()) preview.stop();
                preview.release();
            }
        } catch (Exception ignored) {
        }
        preview = null;
    }

    /** 系统里所有通知铃声：[{uri,title}] */
    static String listRingtones(Context c) {
        try {
            android.media.RingtoneManager rm = new android.media.RingtoneManager(c);
            rm.setType(android.media.RingtoneManager.TYPE_NOTIFICATION);
            android.database.Cursor cur = rm.getCursor();
            org.json.JSONArray arr = new org.json.JSONArray();
            int i = 0;
            while (cur != null && cur.moveToNext() && i < 40) {
                android.net.Uri u = rm.getRingtoneUri(cur.getPosition());
                String t = cur.getString(android.media.RingtoneManager.TITLE_COLUMN_INDEX);
                if (u == null) continue;
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("uri", u.toString());
                o.put("title", t);
                arr.put(o);
                i++;
            }
            if (cur != null) cur.close();
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /** 把用户挑的音频文件复制进 App 目录，之后离线也能播 */
    static String importSound(Context c, android.net.Uri src) {
        try {
            java.io.InputStream in = c.getContentResolver().openInputStream(src);
            if (in == null) return "";
            java.io.File f = new java.io.File(c.getFilesDir(), "ringtone_custom");
            java.io.FileOutputStream out = new java.io.FileOutputStream(f);
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > 3 * 1024 * 1024) break; // 别让一个音频撑爆
                out.write(buf, 0, n);
            }
            out.close();
            in.close();
            return "file:" + f.getAbsolutePath();
        } catch (Exception ex) {
            android.util.Log.e("TA-ALARM", "importSound failed: " + ex, ex);
            return "";
        }
    }

    /** 给设置页显示的名字（本地文件就显示文件名） */
    static String soundNameOf(Context c, String uri) {
        if (uri == null || uri.length() == 0) return "系统默认";
        if (uri.startsWith("file:")) return "自定义文件";
        try {
            android.media.Ringtone rt = android.media.RingtoneManager.getRingtone(c, android.net.Uri.parse(uri));
            String t = rt == null ? null : rt.getTitle(c);
            return t == null || t.length() == 0 ? "系统默认" : t;
        } catch (Exception e) {
            return "系统默认";
        }
    }

    /** 强提醒开关（用户设置，存在 prefs 里） */
    static boolean strongEnabled(Context c) {
        try {
            if (prefs(c).contains("strong")) return prefs(c).getBoolean("strong", false);
            // 首次运行：小米系默认开。这类 ROM 不给第三方通知放声音/震动，
            // 不开就只剩一个安静的横幅。其它品牌默认关，免得跟系统提示音重复。
            String m = (android.os.Build.MANUFACTURER + " " + android.os.Build.BRAND).toLowerCase();
            return m.contains("xiaomi") || m.contains("redmi") || m.contains("poco");
        } catch (Exception e) {
            return false;
        }
    }

    static void setStrong(Context c, boolean on) {
        try {
            prefs(c).edit().putBoolean("strong", on).apply();
        } catch (Exception ignored) {
        }
    }

    /**
     * 用闹钟流播一次提示音 + 震一下。
     * 闹钟流不受"静音模式"影响，也不走通知通道——MIUI 不给通知放声音时靠这个兜底。
     */
    static void playStrong(final Context c) {
        android.util.Log.i("TA-ALARM", "playStrong enter");
        // 声音
        try {
            android.net.Uri uri = pickSound(c);
            if (uri == null) uri = android.provider.Settings.System.DEFAULT_NOTIFICATION_URI;
            final android.media.MediaPlayer mp = new android.media.MediaPlayer();
            mp.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            mp.setDataSource(c, uri);
            mp.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
                public void onCompletion(android.media.MediaPlayer m) {
                    try {
                        m.release();
                    } catch (Exception ignored) {
                    }
                }
            });
            mp.prepare();
            mp.start();
        } catch (Exception ex) {
            android.util.Log.e("TA-ALARM", "playStrong sound failed: " + ex);
        }

        // 震动
        try {
            long[] pattern = new long[]{0, 350, 180, 350};
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                android.os.VibratorManager vm =
                        (android.os.VibratorManager) c.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) vm.getDefaultVibrator().vibrate(
                        android.os.VibrationEffect.createWaveform(pattern, -1));
            } else {
                android.os.Vibrator v = (android.os.Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(android.os.VibrationEffect.createWaveform(pattern, -1));
            }
        } catch (Exception ex) {
            android.util.Log.e("TA-ALARM", "playStrong vibrate failed: " + ex);
        }
    }

    /**
     * 系统默认通知音的真实地址。
     * RingtoneManager.getDefaultUri() 返回的是 content://settings/system/notification_sound，
     * 是个「再去查一次设置」的间接地址；某些 ROM 解析它失败就静默无声。
     * 这里直接把 Settings 里存的值取出来（常见是 file:///system/media/audio/...）。
     */
    static android.net.Uri soundUri(Context c) {
        try {
            String v = android.provider.Settings.System.getString(
                    c.getContentResolver(), android.provider.Settings.System.NOTIFICATION_SOUND);
            if (v != null && v.length() > 0) return android.net.Uri.parse(v);
        } catch (Exception ignored) {
        }
        return android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION);
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
                    // 用闹钟级别的闹钟：系统不敢推迟，Doze 也绕开。
                    // 普通 setExactAndAllowWhileIdle 在国产 ROM 的后台管控下经常被吞。
                    Intent show = new Intent(c, MainActivity.class);
                    show.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    PendingIntent showPi = PendingIntent.getActivity(c, 0, show,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showPi), fire);
                } catch (Exception se) {
                    android.util.Log.e("TA-ALARM", "setAlarmClock failed, fallback: " + se);
                    try {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
                    } catch (Exception e2) {
                        am.set(AlarmManager.RTC_WAKEUP, at, fire);
                    }
                }
            }
        } catch (Exception ignored) {
        }
    }
}
