package ai.cosmos.timeassistant;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent it) {
        android.util.Log.i("TA-ALARM", "onReceive entered, id=" + it.getStringExtra("id") + " strong=" + Reminder.strongEnabled(c));
        String id = it.getStringExtra("id");
        String title = it.getStringExtra("title");
        String text = it.getStringExtra("text");
        try {
            Reminder.ensureChannel(c);
            Intent open = new Intent(c, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(c, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(c, Reminder.CHANNEL)
                    : new Notification.Builder(c);

            b.setContentTitle(title == null ? "该开始了" : title)
                    .setContentText(text == null ? "" : text)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setContentIntent(pi);
            // MIUI 的 buzz/beep 读的是通知对象上的字段：
            //  · 不写 → null，它拿空模式去震动，失败
            //  · setDefaults(DEFAULT_ALL) → vibrate 变成哨兵 {0}，它同样失败
            //    （日志：NotificationVibratorHelper: Error creating vibration waveform with pattern: [0]）
            // 所以只给显式的铃声和模式，不要 defaults。
            b.setPriority(Notification.PRIORITY_HIGH);
            // 注意：这里只能放 content:// URI。
            // 放 file:// 会抛 FileUriExposedException（Android 7+ 禁止向通知暴露文件路径），
            // 结果是整条通知都发不出去。
            b.setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION));
            b.setVibrate(new long[]{0, 350, 180, 350});

            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(id == null ? 1 : id.hashCode(), b.build());

            // 强提醒：某些 ROM（MIUI）不肯给第三方通知放声音/震动，
            // 这里直接用闹钟流自己播一次，不依赖通知通道。
            if (Reminder.strongEnabled(c)) {
                // 交给前台服务去放：接收器返回后进程会被冻结，直接在这里放会断
                // 就地放：实测后台广播里调用是有效的（Service 那条路在这台 ROM 上没走通）
                Reminder.playStrong(c);
            }
        } catch (Exception ex) {
            android.util.Log.e("TA-ALARM", "notify failed: " + ex, ex);
        }
    }
}
