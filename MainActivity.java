package com.flay.ai;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent; 
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkInfo;
import android.net.Uri; 
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle; 
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;

// Google Sign-In SDK
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.tasks.Task;

public class MainActivity extends Activity {

    private static final String WEBSITE_URL  = "https://devnity-ai.vercel.app";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";
    
    private static final int RC_SIGN_IN = 9001;
    private GoogleSignInClient mGoogleSignInClient;
    private static final String WEB_CLIENT_ID = "507666637583-fmkj60q6eir319nf87acqdgbruie9503.apps.googleusercontent.com";

    private WebView webview1;
    private boolean isError = false; 
    
    private PermissionRequest pendingPermissionRequest;
    private ValueCallback<Uri[]> uploadMessage;
    private final static int FILECHOOSER_RESULTCODE = 1;
    private String currentFcmToken = "";

    private Handler handler = new Handler(Looper.getMainLooper());
    private boolean hasWebBackStack = false;

    private static final String ACTION_CANCEL_DOWNLOAD = "com.devnix.ai.CANCEL_DOWNLOAD";
    private HashMap<Integer, DownloadTask> activeDownloads = new HashMap<>();
    private int notificationIdCounter = 1000;
    private BroadcastReceiver cancelReceiver;

    public class WebAppInterface {
        Context mContext;
        WebAppInterface(Context c) {
            mContext = c;
        }
        
        @JavascriptInterface
        public String getFcmToken() {
            return currentFcmToken;
        }

        @JavascriptInterface
        public void setBackStackStatus(boolean hasHistory) {
            hasWebBackStack = hasHistory;
        }

        @JavascriptInterface
        public void triggerGoogleSignIn() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (mGoogleSignInClient != null) {
                        mGoogleSignInClient.signOut(); 
                        Intent signInIntent = mGoogleSignInClient.getSignInIntent();
                        startActivityForResult(signInIntent, RC_SIGN_IN); 
                    }
                }
            });
        }

        @JavascriptInterface
        public void showRewardedVideoAd() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    webview1.evaluateJavascript("javascript:onAdRewardEarned();", null);
                }
            });
        }

        @JavascriptInterface
        public void showDownloadRewardedAd() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    webview1.evaluateJavascript("javascript:onDownloadAdRewardEarned();", null);
                }
            });
        }

        @JavascriptInterface
        public void retryConnection() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.retryConnection();
                }
            });
        }

        @JavascriptInterface
        public void downloadVideo(final String fileUrl, final String fileName, final String posterUrl) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        int notifId = notificationIdCounter++;
                        DownloadTask task = new DownloadTask(notifId, fileUrl, fileName, posterUrl);
                        activeDownloads.put(notifId, task);
                        new Thread(task).start();
                        Toast.makeText(mContext, "Download Started...", Toast.LENGTH_SHORT).show();
                    } catch (Exception e) {
                        Toast.makeText(mContext, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                }
            });
        }
    }

    private class DownloadTask implements Runnable {
        private final int notificationId;
        private final String urlStr;
        private final String fileName;
        private final String posterUrl;
        private boolean isCancelled = false;
        private HttpURLConnection connection = null;

        public DownloadTask(int notificationId, String urlStr, String fileName, String posterUrl) {
            this.notificationId = notificationId;
            this.urlStr = urlStr;
            this.fileName = fileName;
            this.posterUrl = posterUrl;
        }

        public void cancel() {
            isCancelled = true;
            if (connection != null) {
                try { connection.disconnect(); } catch (Exception ignored) {}
            }
        }

        private boolean isValidR2Url(String url) {
            if (url == null || url.isEmpty()) return false;
            return url.startsWith("https://") && (url.contains(".r2.dev") || url.contains(".r2.cloudflarestorage.com") || url.contains("r2"));
        }

        @Override
        public void run() {
            Thread.currentThread().setPriority(Thread.MAX_PRIORITY);

            Bitmap largeIcon = null;
            if (posterUrl != null && !posterUrl.isEmpty()) {
                try {
                    URL url = new URL(posterUrl);
                    largeIcon = BitmapFactory.decodeStream(url.openConnection().getInputStream());
                } catch (Exception ignored) {}
            }

            String channelId = "flaynity_download_channel";
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(channelId, "Downloads", NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(channel);
            }

            Intent cancelIntent = new Intent(ACTION_CANCEL_DOWNLOAD);
            cancelIntent.putExtra("notif_id", notificationId);
            PendingIntent cancelPendingIntent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                cancelPendingIntent = PendingIntent.getBroadcast(MainActivity.this, notificationId, cancelIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            } else {
                cancelPendingIntent = PendingIntent.getBroadcast(MainActivity.this, notificationId, cancelIntent, PendingIntent.FLAG_UPDATE_CURRENT);
            }

            NotificationCompat.Builder builder = new NotificationCompat.Builder(MainActivity.this, channelId)
                .setContentTitle(fileName.replace(".mp4", ""))
                .setContentText("Connecting...")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel download", cancelPendingIntent);

            if (largeIcon != null) {
                builder.setLargeIcon(largeIcon);
            }

            nm.notify(notificationId, builder.build());

            InputStream input = null;
            OutputStream output = null;
            try {
                if (!isValidR2Url(urlStr)) {
                    throw new Exception("Invalid secure download source.");
                }

                URL url = new URL(urlStr);
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(10000); 
                connection.setReadTimeout(15000);    
                connection.setRequestProperty("Accept-Encoding", "identity"); 
                connection.setRequestProperty("Connection", "Keep-Alive"); 
                connection.connect();

                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new Exception("HTTP response: " + connection.getResponseCode());
                }

                int fileLength = connection.getContentLength();
                input = new BufferedInputStream(connection.getInputStream(), 128 * 1024);

                File downloadDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File flaynityDir = new File(downloadDir, "Devnix-ai");
                if (!flaynityDir.exists()) {
                    flaynityDir.mkdirs();
                }
                File file = new File(flaynityDir, fileName);
                
                output = new BufferedOutputStream(new FileOutputStream(file), 128 * 1024);

                byte[] data = new byte[128 * 1024]; 
                long total = 0;
                int count;
                long lastUpdateTime = 0;
                int lastProgressPercent = -1;

                while ((count = input.read(data)) != -1) {
                    if (isCancelled) {
                        throw new Exception("Cancelled");
                    }
                    total += count;
                    output.write(data, 0, count);

                    long currentTime = System.currentTimeMillis();
                    int progressPercent = (fileLength > 0) ? (int) (total * 100 / fileLength) : -1;
                    
                    if (progressPercent != lastProgressPercent && (currentTime - lastUpdateTime > 800)) { 
                        lastUpdateTime = currentTime;
                        lastProgressPercent = progressPercent;
                        
                        String progressText;
                        if (fileLength > 0) {
                            String currentMB = String.format("%.1f", (double)total / (1024 * 1024));
                            String totalMB = String.format("%.1f", (double)fileLength / (1024 * 1024));
                            progressText = currentMB + " MB / " + totalMB + " MB (" + progressPercent + "%)";
                        } else {
                            progressText = String.format("%.1f", (double)total / (1024 * 1024)) + " MB";
                        }

                        builder.setContentText(progressText);
                        if (progressPercent >= 0) {
                            builder.setProgress(100, progressPercent, false);
                        } else {
                            builder.setProgress(100, 0, true);
                        }
                        nm.notify(notificationId, builder.build());
                    }
                }

                output.flush();
                output.close();
                output = null;
                input.close();
                input = null;

                android.media.MediaScannerConnection.scanFile(
                    MainActivity.this,
                    new String[] { file.getAbsolutePath() },
                    new String[] { "video/mp4" },
                    null
                );

                builder.setContentText("Download Complete")
                    .setProgress(0, 0, false)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setOnlyAlertOnce(false);
                builder.mActions.clear(); 
                nm.notify(notificationId, builder.build());
                
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Download Complete: " + fileName, Toast.LENGTH_SHORT).show());

            } catch (Exception e) {
                if (isCancelled) {
                    nm.cancel(notificationId);
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "Download Cancelled", Toast.LENGTH_SHORT).show());
                } else {
                    builder.setContentText("Download Failed: " + e.getMessage())
                        .setProgress(0, 0, false);
                    builder.mActions.clear();
                    nm.notify(notificationId, builder.build());
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "Download Failed: " + e.getMessage(), Toast.LENGTH_SHORT).show());
                }
            } finally {
                try { if (output != null) output.close(); } catch (Exception ignored) {}
                try { if (input != null) input.close(); } catch (Exception ignored) {}
                if (connection != null) connection.disconnect();
            }
            activeDownloads.remove(notificationId);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        super.onCreate(savedInstanceState);
        
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        );

        setContentView(R.layout.main);
        webview1 = findViewById(R.id.webview1);

        setupFullScreen(); 

        cancelReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_CANCEL_DOWNLOAD.equals(intent.getAction())) {
                    int notifId = intent.getIntExtra("notif_id", -1);
                    DownloadTask task = activeDownloads.get(notifId);
                    if (task != null) {
                        task.cancel();
                    }
                }
            }
        };

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(cancelReceiver, new IntentFilter(ACTION_CANCEL_DOWNLOAD), Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(cancelReceiver, new IntentFilter(ACTION_CANCEL_DOWNLOAD));
        }

        try {
            GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(WEB_CLIENT_ID) 
                .requestEmail()
                .build();
            mGoogleSignInClient = GoogleSignIn.getClient(this, gso); 
        } catch (Exception e) {
            android.util.Log.e("GOOGLE_AUTH_INIT", "Initialization failed: " + e.getMessage());
        }
        
        setupWebView();
        startLoadingApp();
        checkAndRequestPermissions();
        fetchFcmToken();
        registerNetworkCallback();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            setupFullScreen();
        }
    }

    private void setupFullScreen() {
        Window window = getWindow();
        if (window == null) return; 
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false); 
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            int uiOptions = View.SYSTEM_UI_FLAG_LAYOUT_STABLE 
                          | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                          | View.SYSTEM_UI_FLAG_FULLSCREEN 
                          | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            window.getDecorView().setSystemUiVisibility(uiOptions);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.getAttributes().layoutInDisplayCutoutMode = 
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        int currentNightMode = newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        String themeMode = "light";
        if (currentNightMode == Configuration.UI_MODE_NIGHT_YES) {
            themeMode = "dark";
        }
        final String finalTheme = themeMode;
        runOnUiThread(() -> {
            if (webview1 != null) {
                webview1.evaluateJavascript("javascript:selectThemeVal('" + finalTheme + "');", null);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == RC_SIGN_IN) {
            Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(data); 
            try {
                GoogleSignInAccount account = task.getResult(ApiException.class);
                if (account != null) {
                    String idToken = account.getIdToken(); 
                    webview1.evaluateJavascript("javascript:handleNativeGoogleSignIn('" + idToken + "');", null);
                }
            } catch (ApiException e) {
                android.util.Log.e("GOOGLE_AUTH_FAILED", "Code: " + e.getStatusCode());
                final int errorCode = e.getStatusCode();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Google Error Code: " + errorCode, Toast.LENGTH_LONG).show();
                    }
                });
                webview1.evaluateJavascript("javascript:showNotification('Google Sign-In Failed (Code " + errorCode + ")', 'error');", null);
            }
        } 
        else if (requestCode == FILECHOOSER_RESULTCODE) {
            if (uploadMessage == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK) {
                if (data != null) {
                    String dataString = data.getDataString();
                    ClipData clipData = data.getClipData();
                    if (clipData != null) {
                        results = new Uri[clipData.getItemCount()];
                        for (int i = 0; i < clipData.getItemCount(); i++) {
                            ClipData.Item item = clipData.getItemAt(i);
                            results[i] = item.getUri();
                        }
                    }
                    if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    }
                }
            }
            uploadMessage.onReceiveValue(results);
            uploadMessage = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    private void startLoadingApp() {
        isError = false;
        if (isNetworkAvailable()) {
            webview1.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            webview1.loadUrl(WEBSITE_URL);
        } else {
            webview1.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
            webview1.loadUrl(WEBSITE_URL);
        }
    }

    private void setupWebView() {
        WebSettings ws = webview1.getSettings();
        
        String defaultUA = ws.getUserAgentString();
        if (defaultUA != null) {
            String customUA = defaultUA.replaceAll("(?i);\\s*wv", "")
                                       .replaceAll("(?i)Version/\\d+\\.\\d+\\s*", "");
            ws.setUserAgentString(customUA); 
        }
        
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setGeolocationEnabled(true);
        
        ws.setAllowContentAccess(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        
        ws.setSupportMultipleWindows(true);
        ws.setJavaScriptCanOpenWindowsAutomatically(true);
        
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        
        ws.setMediaPlaybackRequiresUserGesture(false); 
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webview1.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
        }
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        webview1.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        
        ws.setLoadsImagesAutomatically(true);
        
        webview1.setVerticalScrollBarEnabled(false);
        webview1.setHorizontalScrollBarEnabled(false);
        webview1.setScrollBarStyle(View.SCROLLBARS_OUTSIDE_OVERLAY);

        webview1.addJavascriptInterface(new WebAppInterface(this), "AndroidBridge");

        webview1.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, Bitmap fav) {
                super.onPageStarted(v, url, fav);
                isError = false; 
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                if (!isError && !url.equals("about:blank") && !url.equals(OFFLINE_URL)) {
                    v.evaluateJavascript("if (typeof syncFcmToken === 'function') { syncFcmToken(); }", null);
                }
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String url) {
                super.onReceivedError(v, code, desc, url);
                if (url != null && (url.startsWith(WEBSITE_URL) || url.equals("about:blank"))) {
                    isError = true;
                    webview1.loadUrl(OFFLINE_URL);
                }
            }

            @TargetApi(Build.VERSION_CODES.M)
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                super.onReceivedError(v, r, e);
                if (r.isForMainFrame()) {
                    isError = true;
                    webview1.loadUrl(OFFLINE_URL);
                }
            }

            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) { h.proceed(); }
            
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return handleUrlRouting(url);
            }

            @TargetApi(Build.VERSION_CODES.N)
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return handleUrlRouting(request.getUrl().toString());
            }
        });

        webview1.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView v, String url, String msg, JsResult r) {
                new AlertDialog.Builder(MainActivity.this).setMessage(msg)
                    .setPositiveButton("OK", (d, w) -> r.confirm()).setCancelable(false).show();
                return true;
            }
            @Override
            public boolean onJsConfirm(WebView v, String url, String msg, JsResult r) {
                new AlertDialog.Builder(MainActivity.this).setMessage(msg)
                    .setPositiveButton("Yes", (d, w) -> r.confirm())
                    .setNegativeButton("No",  (d, w) -> r.cancel()).setCancelable(false).show();
                return true;
            }
            @Override
            public void onGeolocationPermissionsShowPrompt(String o, GeolocationPermissions.Callback c) {
                c.invoke(o, true, false);
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(new WebView(view.getContext()) {
                    @Override
                    public void loadUrl(String url) {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            getContext().startActivity(intent);
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                    }
                });
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    java.util.ArrayList<String> missingPermissions = new java.util.ArrayList<>();
                    for (String resource : request.getResources()) {
                        if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                                MainActivity.this.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_DENIED) {
                                missingPermissions.add(android.Manifest.permission.RECORD_AUDIO);
                            }
                        }
                        if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                                MainActivity.this.checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_DENIED) {
                                missingPermissions.add(android.Manifest.permission.CAMERA);
                            }
                        }
                    }

                    if (!missingPermissions.isEmpty()) {
                        pendingPermissionRequest = request;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            MainActivity.this.requestPermissions(missingPermissions.toArray(new String[0]), 102);
                        }
                    } else {
                        request.grant(request.getResources());
                    }
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, WebChromeClient.FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                    uploadMessage = null;
                }
                uploadMessage = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILECHOOSER_RESULTCODE);
                } catch (ActivityNotFoundException e) {
                    uploadMessage = null;
                    Toast.makeText(MainActivity.this, "Cannot open file chooser", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });

        webview1.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String cd, String mt, long cl) {
                try {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, cd, mt));
                    req.allowScanningByMediaScanner();
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) { 
                        dm.enqueue(req); 
                        Toast.makeText(MainActivity.this, "Downloading...", Toast.LENGTH_SHORT).show(); 
                    }
                } catch (Exception e) { 
                    Toast.makeText(MainActivity.this, "Download failed", Toast.LENGTH_SHORT).show(); 
                }
            }
        });
    }

    private boolean handleUrlRouting(String url) {
        if (url == null) return false;

        if (url.startsWith("http://") || url.startsWith("https://")) {
            if (!url.contains("devnix-ai.pages.dev") && 
                !url.contains("file:///android_asset") && 
                !url.contains("pub-bcff9c709dbe44d7a50c78e9a0f9bd59.r2.dev") && 
                !url.contains("r2.cloudflarestorage.com")) {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                    return true; 
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
            if (url.contains("t.me") || url.contains("telegram.me") || url.contains("telegram.dog")) {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
            return false; 
        }

        try {
            Intent intent;
            if (url.startsWith("intent:")) {
                intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            }

            if (intent != null) {
                if (getPackageManager().resolveActivity(intent, 0) != null) {
                    startActivity(intent);
                } else {
                    String fallbackUrl = intent.getStringExtra("browser_fallback_url");
                    if (fallbackUrl != null) {
                        webview1.loadUrl(fallbackUrl);
                    }
                }
                return true; 
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
        return true; 
    }

    private void retryConnection() {
        if (!isNetworkAvailable()) {
            Toast.makeText(this, "Still No Internet Connection 😕", Toast.LENGTH_SHORT).show();
            return; 
        }

        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                isError = false;
                String js = "if(typeof window.Devnix-aiNetworkOnline === 'function'){ window.Devnix-aiNetworkOnline(); } else { window.location.href = '" + WEBSITE_URL + "'; }";
                webview1.evaluateJavascript(js, null);
            }
        });
    }

    private void fetchFcmToken() {
        try {
            com.google.firebase.iid.FirebaseInstanceId.getInstance().getInstanceId()
                .addOnCompleteListener(new com.google.android.gms.tasks.OnCompleteListener<com.google.firebase.iid.InstanceIdResult>() {
                    @Override
                    public void onComplete(com.google.android.gms.tasks.Task<com.google.firebase.iid.InstanceIdResult> task) {
                        if (task.isSuccessful() && task.getResult() != null) {
                            currentFcmToken = task.getResult().getToken();
                            android.util.Log.d("FCM_TOKEN", "Cached successfully: " + currentFcmToken);
                            
                            try {
                                com.google.firebase.messaging.FirebaseMessaging.getInstance().subscribeToTopic("all");
                            } catch (Exception e) {
                                android.util.Log.e("FCM_TOKEN", "Subscribe to all failed: " + e.getMessage());
                            }
                        } else {
                            android.util.Log.e("FCM_TOKEN", "Token fetch failed", task.getException());
                        }
                    }
                });
        } catch (Exception e) {
            android.util.Log.e("FCM_TOKEN", "Primary fetch failed: " + e.getMessage());
            try {
                currentFcmToken = com.google.firebase.iid.FirebaseInstanceId.getInstance().getToken();
            } catch (Exception ex) {
                android.util.Log.e("FCM_TOKEN", "Fallback failed: " + ex.getMessage());
            }
        }
    }

    private void registerNetworkCallback() {
        try {
            ConnectivityManager connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && connectivityManager != null) {
                connectivityManager.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                String js = "if(typeof window.Devnix-aiNetworkOnline === 'function'){ window.Devnix-aiNetworkOnline(); }";
                                webview1.evaluateJavascript(js, null);
                                if (isError) {
                                    retryConnection();
                                }
                            }
                        });
                    }

                    @Override
                    public void onLost(Network network) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                String js = "if(typeof window.Devnix-aiNetworkOffline === 'function'){ window.Devnix-aiNetworkOffline(); }";
                                webview1.evaluateJavascript(js, null);
                            }
                        });
                    }
                });
            }
        } catch (Exception e) {
            android.util.Log.e("NETWORK_CALLBACK", "Initialization error: " + e.getMessage());
        }
    }

    private void checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            java.util.ArrayList<String> permissions = new java.util.ArrayList<>();
            
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_DENIED) {
                permissions.add(android.Manifest.permission.RECORD_AUDIO);
            }

            if (Build.VERSION.SDK_INT >= 33) { 
                if (checkSelfPermission("android.permission.READ_MEDIA_IMAGES") == android.content.pm.PackageManager.PERMISSION_DENIED) {
                    permissions.add("android.permission.READ_MEDIA_IMAGES");
                }
                if (checkSelfPermission("android.permission.READ_MEDIA_VIDEO") == android.content.pm.PackageManager.PERMISSION_DENIED) {
                    permissions.add("android.permission.READ_MEDIA_VIDEO");
                }
                if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_DENIED) {
                    permissions.add("android.permission.POST_NOTIFICATIONS");
                }
            } else {
                if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_DENIED) {
                    permissions.add(android.Manifest.permission.READ_EXTERNAL_STORAGE);
                }
                if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_DENIED) {
                    permissions.add(android.Manifest.permission.WRITE_EXTERNAL_STORAGE);
                }
            }
            
            if (!permissions.isEmpty()) {
                requestPermissions(permissions.toArray(new String[0]), 101);
            }
        }
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            NetworkInfo activeNetwork = cm.getActiveNetworkInfo();
            return activeNetwork != null && activeNetwork.isConnected();
        }
        return false;
    }

    @Override
    public void onBackPressed() {
        if (hasWebBackStack) {
            webview1.evaluateJavascript("javascript:executeBackAction();", null);
        } else {
            finishAffinity();
        }
    }

    @Override protected void onResume()  { super.onResume();  webview1.onResume();  }
    @Override protected void onPause()   { super.onPause();   webview1.onPause();   }
    @Override 
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacksAndMessages(null);
        try {
            unregisterReceiver(cancelReceiver);
        } catch (Exception ignored) {}
        
        webview1.destroy();
    }
}