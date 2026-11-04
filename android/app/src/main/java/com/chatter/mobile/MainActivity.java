package com.chatter.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final String APP_URL = "https://chatter-n6rv.onrender.com/app";
    private static final String APP_HOST = "chatter-n6rv.onrender.com";
    private static final String CHECKOUT_HOST = "checkout.paystack.com";
    private static final int MEDIA_PERMISSION_REQUEST = 41;
    private static final int GREEN = Color.rgb(36, 92, 67);
    private static final int PAPER = Color.rgb(245, 244, 237);

    private WebView webView;
    private FrameLayout root;
    private View loadingView;
    private View errorView;
    private PermissionRequest pendingPermissionRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(PAPER);
        getWindow().setNavigationBarColor(PAPER);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom()
            );
            return insets;
        });
        webView = new WebView(this);
        configureWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        loadingView = createLoadingView();
        errorView = createErrorView();
        root.addView(loadingView, overlayParams());
        root.addView(errorView, overlayParams());
        errorView.setVisibility(View.GONE);
        setContentView(root);
        webView.loadUrl(APP_URL);
    }

    private FrameLayout.LayoutParams overlayParams() {
        return new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
    }

    private View createLoadingView() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(PAPER);
        TextView logo = new TextView(this);
        logo.setText("c");
        logo.setTextColor(Color.rgb(215, 237, 146));
        logo.setTextSize(42);
        logo.setGravity(Gravity.CENTER);
        logo.setTypeface(null, android.graphics.Typeface.BOLD);
        logo.setBackgroundColor(GREEN);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(84, 84);
        logoParams.bottomMargin = 20;
        layout.addView(logo, logoParams);

        TextView title = new TextView(this);
        title.setText("Chatter");
        title.setTextColor(Color.rgb(23, 37, 30));
        title.setTextSize(22);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        layout.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Getting your space ready…");
        subtitle.setTextColor(Color.rgb(120, 130, 122));
        subtitle.setTextSize(14);
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        subtitleParams.topMargin = 8;
        layout.addView(subtitle, subtitleParams);

        ProgressBar spinner = new ProgressBar(this);
        LinearLayout.LayoutParams spinnerParams = new LinearLayout.LayoutParams(28, 28);
        spinnerParams.topMargin = 22;
        layout.addView(spinner, spinnerParams);
        return layout;
    }

    private View createErrorView() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(32, 24, 32, 24);
        layout.setBackgroundColor(PAPER);

        TextView title = new TextView(this);
        title.setText("Can’t connect to Chatter");
        title.setTextColor(Color.rgb(23, 37, 30));
        title.setTextSize(22);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        layout.addView(title);

        TextView description = new TextView(this);
        description.setText("Check your internet connection, then try Chatter again.");
        description.setTextColor(Color.rgb(120, 130, 122));
        description.setTextSize(14);
        description.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams descriptionParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        descriptionParams.topMargin = 9;
        layout.addView(description, descriptionParams);

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setTextColor(Color.WHITE);
        retry.setBackgroundTintList(android.content.res.ColorStateList.valueOf(GREEN));
        retry.setOnClickListener(view -> retryLoading());
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        retryParams.topMargin = 20;
        layout.addView(retry, retryParams);
        return layout;
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        webView.setBackgroundColor(PAPER);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme())
                    && (APP_HOST.equals(uri.getHost()) || CHECKOUT_HOST.equals(uri.getHost()))) return false;
                if ("https".equals(uri.getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (android.content.ActivityNotFoundException ignored) {
                        showError();
                    }
                    return true;
                }
                if ("http".equals(uri.getScheme())) return true;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (android.content.ActivityNotFoundException ignored) {
                    showError();
                }
                return true;
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                loadingView.setVisibility(View.GONE);
                errorView.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    Uri origin = request.getOrigin();
                    if (!"https".equals(origin.getScheme()) || !APP_HOST.equals(origin.getHost())) {
                        request.deny();
                        return;
                    }
                    grantWebPermission(request);
                });
            }
        });
    }

    private void grantWebPermission(PermissionRequest request) {
        String[] resources = request.getResources();
        if (resources.length == 0) {
            request.deny();
            return;
        }
        boolean needsCamera = false;
        boolean needsMicrophone = false;
        for (String resource : resources) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needsCamera = true;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needsMicrophone = true;
            if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                && !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                request.deny();
                return;
            }
        }

        java.util.ArrayList<String> required = new java.util.ArrayList<>();
        if (needsCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            required.add(Manifest.permission.CAMERA);
        }
        if (needsMicrophone && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            required.add(Manifest.permission.RECORD_AUDIO);
        }
        if (required.isEmpty()) {
            request.grant(resources);
            return;
        }
        pendingPermissionRequest = request;
        requestPermissions(required.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != MEDIA_PERMISSION_REQUEST || pendingPermissionRequest == null) return;
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) granted &= result == PackageManager.PERMISSION_GRANTED;
        if (granted) pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
        else pendingPermissionRequest.deny();
        pendingPermissionRequest = null;
    }

    private void retryLoading() {
        errorView.setVisibility(View.GONE);
        loadingView.setVisibility(View.VISIBLE);
        webView.loadUrl(APP_URL);
    }

    private void showError() {
        loadingView.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
        webView.destroy();
        super.onDestroy();
    }
}
