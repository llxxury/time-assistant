package ai.cosmos.timeassistant;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends Activity {
    private static final String DATA_FILE = "time-assistant-v1.json";
    private static final String HOST = "appassets.local";
    private WebView web;

    @Override
    protected void onCreate(Bundle b) {
        setTheme(android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(b);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u == null || !HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null) path = "/";
                if (path.startsWith("/")) path = path.substring(1);
                if (path.isEmpty()) path = "web/index.html";
                try {
                    InputStream in = getAssets().open(path);
                    return new WebResourceResponse(mimeOf(path), "utf-8", in);
                } catch (IOException e) {
                    return null;
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, android.webkit.WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    v.loadData("<meta name=viewport content='width=device-width'>"
                            + "<div style='font:16px sans-serif;padding:24px'>"
                            + "<h3>椤甸潰娌¤兘鍔犺浇</h3><p>" + err.getDescription() + "</p>"
                            + "<p style='color:#888'>鎶婅繖涓埅鍥惧彂缁欏紑鍙戝氨琛屻€?/p></div>",
                            "text/html", "utf-8");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Cosmos");

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl("http://" + HOST + "/web/index.html");

        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
            }
        }
        installCrashHandler();
        Reminder.ensureChannel(this);
    }

    private static String mimeOf(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            try {
                java.io.StringWriter sw = new java.io.StringWriter();
                e.printStackTrace(new java.io.PrintWriter(sw));
                FileOutputStream out = new FileOutputStream(new File(getFilesDir(), "crash.log"), true);
                out.write(("\n--- " + new java.util.Date() + " ---\n").getBytes("UTF-8"));
                out.write(sw.toString().getBytes("UTF-8"));
                out.close();
            } catch (Exception ignored) {
            }
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    public class Bridge {
        /**
         * 复制到剪贴板。WebView 里 navigator.clipboard 不可用（appassets.local 不是安全上下文），
         * 所以诊断报告这种「一键复制」走这里。
         */
        @JavascriptInterface
        public boolean copy(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm == null) return false;
                cm.setPrimaryClip(ClipData.newPlainText("time-assistant", text));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /**
         * 导出文本文件到系统「下载」目录。
         * WebView 里 a.download 不工作（没有 DownloadListener），所以走这里。
         * 返回 content:// URI（能直接拿去分享）；API 26–28 退回 app 外部目录，返回绝对路径。
         * 失败返回空串。
         */
        @JavascriptInterface
        public String exportFile(String name, String mime, String content) {
            try {
                String safe = name == null ? "export.txt" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                byte[] bytes = content.getBytes("UTF-8");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return "";
                    os.write(bytes);
                    os.close();
                    return uri.toString();
                }
                File dir = new File(getExternalFilesDir(null), "exports");
                if (!dir.exists() && !dir.mkdirs()) return "";
                File f = new File(dir, safe);
                FileOutputStream out = new FileOutputStream(f);
                out.write(bytes);
                out.close();
                return f.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }

        /** 把导出的文件丢进系统分享面板（只接受 content://，文件路径没法直接分享） */
        @JavascriptInterface
        public boolean shareUri(String uri, String mime, String title) {
            try {
                if (uri == null || !uri.startsWith("content://")) return false;
                Intent it = new Intent(Intent.ACTION_SEND);
                it.setType(mime == null ? "application/octet-stream" : mime);
                it.putExtra(Intent.EXTRA_STREAM, Uri.parse(uri));
                it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(it, title == null ? "分享" : title);
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String crashLog() {
            try {
                File f = new File(getFilesDir(), "crash.log");
                if (!f.exists()) return "";
                byte[] buf = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
                in.close();
                String all = new String(buf, "UTF-8");
                return all.length() > 6000 ? all.substring(all.length() - 6000) : all;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String load() {
            File f = new File(getFilesDir(), DATA_FILE);
            if (!f.exists()) return null;
            try {
                byte[] buf = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n <= 0) break;
                    off += n;
                }
                in.close();
                return new String(buf, "UTF-8");
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public boolean save(String json) {
            try {
                FileOutputStream out = new FileOutputStream(new File(getFilesDir(), DATA_FILE));
                out.write(json.getBytes("UTF-8"));
                out.close();
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void testNotify() {
            try {
                Intent it = new Intent(MainActivity.this, AlarmReceiver.class);
                it.putExtra("id", "test");
                it.putExtra("title", "娴嬭瘯鎻愰啋");
                it.putExtra("text", "鑳界湅鍒拌繖鏉★紝璇存槑閫氱煡閫氫簡");
                PendingIntent pi = PendingIntent.getBroadcast(MainActivity.this, 999999, it,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
                if (am == null) return;
                long at = System.currentTimeMillis() + 10000;
                if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void setReminders(String json) {
            try {
                Reminder.apply(MainActivity.this, json);
            } catch (Exception ignored) {
            }
        }
    }
}
