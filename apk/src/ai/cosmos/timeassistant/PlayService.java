package ai.cosmos.timeassistant;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * 只做一件事：把提示音放完 + 震一下，然后自己停掉。
 *
 * 为什么不在广播接收器里直接放：onReceive 一返回，后台进程可能马上被冻结，
 * MediaPlayer.prepare() 还没完成就断了。放在 Service 里，进程能多活几秒，
 * 配合闹钟广播带来的 10 秒临时白名单，足够把一声放完。
 *
 * 注意：这里**不**用 startForegroundService。MIUI 在后台不给启动前台服务，
 * 5 秒内没 startForeground 就直接抛 ForegroundServiceDidNotStartInTimeException 崩掉。
 */
public class PlayService extends Service {
    @Override
    public IBinder onBind(Intent it) {
        return null;
    }

    @Override
    public int onStartCommand(Intent it, int flags, int startId) {
        try {
            Reminder.playStrong(this);
        } catch (Exception ex) {
            android.util.Log.e("TA-ALARM", "PlayService play failed: " + ex, ex);
        }
        // 给播放留出时间，然后自己退
        new Thread(new Runnable() {
            public void run() {
                try {
                    Thread.sleep(3500);
                } catch (Exception ignored) {
                }
                stopSelf();
            }
        }).start();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        try {
            stopSelf();
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
