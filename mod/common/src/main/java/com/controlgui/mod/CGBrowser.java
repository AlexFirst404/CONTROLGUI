package com.controlgui.mod;

import com.controlgui.mod.cef.CgCef;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.callback.CefCallback;
import org.cef.handler.CefLoadHandler;
import org.cef.handler.CefLoadHandlerAdapter;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.handler.CefResourceHandler;
import org.cef.handler.CefResourceRequestHandler;
import org.cef.handler.CefResourceRequestHandlerAdapter;
import org.cef.misc.BoolRef;
import org.cef.network.CefRequest;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/* Обработчики уровня CefClient. Главное — приём самоподписанного сертификата
   центра CONTROLGUI: без этого удалённые панели из игры недоступны (Chromium
   молча режет такие соединения; настройки web-security на TLS не влияют).
   Браузер выделен под интерфейс панели, поэтому это безопасный компромисс. */
public final class CGBrowser {

    private static boolean installed;

    private CGBrowser() {}

    /* Зовётся из энтрипоинтов обоих лоадеров; ждёт инициализации Chromium. */
    public static void installHandlers() {
        if (CgCef.isInitialized()) install();
        else CgCef.scheduleForInit((ok) -> { if (ok) install(); });
    }

    private static synchronized void install() {
        if (installed) return;
        installed = true;
        // слот request-handler в CefClient один (first-wins) — занимаем сразу
        CgCef.getClient().getHandle().addRequestHandler(new CefRequestHandlerAdapter() {
            @Override
            public boolean onCertificateError(CefBrowser browser, CefLoadHandler.ErrorCode certError,
                                              String requestUrl, CefCallback callback) {
                if (callback == null) return false;
                callback.Continue();
                return true;
            }

            /* Подмена статики UI: когда на порту панель прошлой версии, её
               HTML/JS/CSS заменяются файлами свежей панели из мода, а /api
               уходит в сеть как обычно. Зовётся на IO-потоке CEF. */
            @Override
            public CefResourceRequestHandler getResourceRequestHandler(CefBrowser browser, CefFrame frame,
                    CefRequest request, boolean isNavigation, boolean isDownload, String requestInitiator,
                    BoolRef disableDefaultHandling) {
                Path file = overrideFileFor(request);
                if (file == null) return null; // не наше — обычная сеть
                return new CefResourceRequestHandlerAdapter() {
                    @Override
                    public CefResourceHandler getResourceHandler(CefBrowser b, CefFrame f, CefRequest r) {
                        return new CGUiResource(file);
                    }
                };
            }
        });
        // после коммита страницы переприменяем зум (CEF хранит его по хосту)
        CgCef.getClient().addLoadHandler(new CefLoadHandlerAdapter() {
            @Override
            public void onLoadEnd(CefBrowser browser, CefFrame frame, int httpStatusCode) {
                if (frame != null && frame.isMain()) PanelScreen.onPageLoaded();
            }
        });
        Constants.LOG.info("CONTROLGUI: обработчики браузера установлены");
    }

    /* Файл свежего UI, которым надо ответить на запрос, или null (обычная сеть).
       Подменяем только GET-статику нашей локальной панели: /api, /agent и /r
       не трогаем; отсутствующий локально файл тоже уходит в сеть. */
    private static Path overrideFileFor(CefRequest request) {
        Path root = PanelManager.uiOverrideDir();
        if (root == null || request == null) return null;
        String method = request.getMethod();
        if (method != null && !"GET".equalsIgnoreCase(method)) return null;
        String url = request.getURL();
        String base = PanelManager.baseUrl();
        if (url == null || !url.startsWith(base)) return null;
        String path = url.substring(base.length());
        int cut = path.indexOf('?');
        if (cut >= 0) path = path.substring(0, cut);
        cut = path.indexOf('#');
        if (cut >= 0) path = path.substring(0, cut);
        if (path.isEmpty() || "/".equals(path)) path = "/index.html";
        if (path.startsWith("/api/") || path.startsWith("/agent/") || path.startsWith("/r/")) return null;
        try {
            String decoded = URLDecoder.decode(path, StandardCharsets.UTF_8);
            Path file = root.resolve(decoded.substring(1)).normalize();
            // защита от выхода за public/ + отдаём только реально существующие файлы
            if (!file.startsWith(root) || !Files.isRegularFile(file)) return null;
            return file;
        } catch (IllegalArgumentException e) {
            // кривой %-эскейп или недопустимые для ФС символы (InvalidPathException —
            // подкласс) — нельзя дать исключению уйти в нативный JNI-колбэк
            return null;
        }
    }
}
