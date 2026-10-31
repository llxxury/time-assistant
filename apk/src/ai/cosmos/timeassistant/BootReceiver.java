package ai.cosmos.timeassistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent it) {
        try {
            Reminder.apply(c, Reminder.prefs(c).getString(Reminder.KEY, "[]"));
        } catch (Exception ignored) {
        }
    }
}
