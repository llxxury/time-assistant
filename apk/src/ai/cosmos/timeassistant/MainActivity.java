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

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends Activity {
    private static final String DATA_FILE = "time-assistant-v1.json";
    private static final String HOST = "appassets.local";
    private static final int REQ_PICK = 1001;
    private String pendingImport = null;
    private WebView web;

    @Override
    protected void onCreate(Bundle b) {
        setTheme(android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(b);

        // 允许 chrome://inspect 调试。某些 ROM 会剥掉 manifest 里的 debuggable，
        // 所以不能靠 FLAG_DEBUGGABLE 判断；只有插着 USB 调试才可能被连上。
        WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        // 关掉 WebView 的 overscroll 光晕/拉伸：上下拉到头会「弹」，很像网页
        web.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
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
                            + "<h3>页面没能加载</h3><p>" + err.getDescription() + "</p>"
                            + "<p style='color:#888'>把这个截图发给开发就行。</p></div>",
                            "text/html", "utf-8");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Cosmos");

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 铺满整屏：内容画到状态栏和导航栏底下，让 CSS 的 safe-area 去避让
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        web.loadUrl("http://" + HOST + "/web/index.html");

        // WebView 读不到 env(safe-area-inset-*)，把系统栏高度喂给 CSS
        web.postDelayed(new Runnable() {
            public void run() {
                if (web != null) web.evaluateJavascript(buildInsetsScript(), null);
            }
        }, 400);
        web.postDelayed(new Runnable() {
            public void run() {
                if (web != null) web.evaluateJavascript(buildInsetsScript(), null);
            }
        }, 1600);

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

    /** 文件选择器回来：把内容暂存起来，再回调页面去取 */
    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK) return;
        pendingImport = null;
        if (res == RESULT_OK && data != null && data.getData() != null) {
            try {
                InputStream in = getContentResolver().openInputStream(data.getData());
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                int total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > 8 * 1024 * 1024) break; // 别被超大文件拖死
                    bos.write(buf, 0, n);
                }
                in.close();
                pendingImport = new String(bos.toByteArray(), "UTF-8");
            } catch (Exception e) {
                pendingImport = null;
            }
        }
        notifyImportDone();
    }

    private void notifyImportDone() {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.__TA_IMPORT && window.__TA_IMPORT()", null);
        });
    }

    /** 把状态栏 / 导航栏高度写进 CSS 变量，页面用它做安全区避让 */
    private String buildInsetsScript() {
        int top = 0;
        int bottom = 0;
        try {
            android.content.res.Resources r = getResources();
            int idTop = r.getIdentifier("status_bar_height", "dimen", "android");
            if (idTop > 0) top = r.getDimensionPixelSize(idTop);
            int idNav = r.getIdentifier("navigation_bar_height", "dimen", "android");
            if (idNav > 0) bottom = r.getDimensionPixelSize(idNav);
        } catch (Exception e) {
        }
        float d = getResources().getDisplayMetrics().density;
        return "document.documentElement.style.setProperty('--safe-top','" + (top / d) + "px');"
                + "document.documentElement.style.setProperty('--safe-bottom','" + (bottom / d) + "px');";
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
        /** 导出二进制（base64）：分享图片用。落盘方式和 exportFile 一致，只是先解码 */
        @JavascriptInterface
        public String exportBase64(String name, String mime, String b64) {
            try {
                String safe = name == null ? "share.png" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES);
                    Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
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

        /**
         * 告诉原生当前界面底色：涂窗口/WebView 背景，避免滚动时露出白底；
         * 并按亮度切换状态栏、导航栏图标的明暗。
         */
        @JavascriptInterface
        public void setChrome(final String hex) {
            try {
                final int c = android.graphics.Color.parseColor(hex);
                int lum = (int) (0.299 * android.graphics.Color.red(c)
                        + 0.587 * android.graphics.Color.green(c)
                        + 0.114 * android.graphics.Color.blue(c));
                final boolean dark = lum < 140;
                runOnUiThread(new Runnable() {
                    public void run() {
                        getWindow().getDecorView().setBackgroundColor(c);
                        if (web != null) web.setBackgroundColor(c);
                        if (Build.VERSION.SDK_INT >= 30) {
                            android.view.WindowInsetsController ic = getWindow().getInsetsController();
                            if (ic != null) {
                                int bars = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                        | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                                ic.setSystemBarsAppearance(dark ? 0 : bars, bars);
                            }
                        } else {
                            int vis = getWindow().getDecorView().getSystemUiVisibility();
                            int flags = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                                    | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                            getWindow().getDecorView().setSystemUiVisibility(dark ? (vis & ~flags) : (vis | flags));
                        }
                    }
                });
            } catch (Exception e) {
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
            File dir = getFilesDir();
            File target = new File(dir, DATA_FILE);
            File tmp = new File(dir, DATA_FILE + ".tmp");
            File bak = new File(dir, DATA_FILE + ".bak");
            FileOutputStream out = null;
            try {
                // 先写临时文件并 fsync，再原子 rename。中途被杀 / 掉电只会留下 .tmp，
                // 原存档完好——比「直接覆盖」安全一个量级。
                out = new FileOutputStream(tmp);
                out.write(json.getBytes("UTF-8"));
                out.flush();
                out.getFD().sync();
                out.close();
                out = null;
                if (target.exists()) copyFile(target, bak); // 上一份好数据留底
                if (!tmp.renameTo(target)) {
                    copyFile(tmp, target);                  // rename 极少失败，兜一下
                    tmp.delete();
                }
                return true;
            } catch (Exception e) {
                if (out != null) {
                    try {
                        out.close();
                    } catch (Exception ignored) {
                    }
                }
                return false;
            }
        }

        /** 上一份存档（.bak），坏档时用来恢复 */
        @JavascriptInterface
        public String loadBackup() {
            return readFile(new File(getFilesDir(), DATA_FILE + ".bak"));
        }

        /**
         * 删掉主存档，只保留 .bak。
         * 从备份恢复时先调它——否则紧接着的 save() 会把「坏掉的主存档」复制进 .bak，
         * 把唯一的好备份冲掉。
         */
        @JavascriptInterface
        public boolean discardPrimary() {
            try {
                File f = new File(getFilesDir(), DATA_FILE);
                return !f.exists() || f.delete();
            } catch (Exception e) {
                return false;
            }
        }

        private void copyFile(File from, File to) throws IOException {
            FileInputStream in = new FileInputStream(from);
            FileOutputStream out = new FileOutputStream(to);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush();
                out.getFD().sync();
            } finally {
                try {
                    in.close();
                } catch (Exception ignored) {
                }
                try {
                    out.close();
                } catch (Exception ignored) {
                }
            }
        }

        private String readFile(File f) {
            if (f == null || !f.exists()) return null;
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

        /** 让用户挑一个文件导入（系统文件选择器），选完通过 window.__TA_IMPORT 回调 */
        @JavascriptInterface
        public void pickFile() {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(i, REQ_PICK);
            } catch (Exception e) {
                pendingImport = null;
                notifyImportDone();
            }
        }

        /** 取回刚选中的文件内容（取一次就清空） */
        @JavascriptInterface
        public String takeImport() {
            String t = pendingImport;
            pendingImport = null;
            return t;
        }

        @JavascriptInterface
        public void testNotify() {
            try {
                Intent it = new Intent(MainActivity.this, AlarmReceiver.class);
                it.putExtra("id", "test");
                it.putExtra("title", "测试提醒");
                it.putExtra("text", "能看到这条，说明通知通了");
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
