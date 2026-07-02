package com.controlgui.mod;

import com.controlgui.mod.cef.CgCef;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.callback.CefCallback;
import org.cef.handler.CefLoadHandler;
import org.cef.handler.CefLoadHandlerAdapter;
import org.cef.handler.CefRequestHandlerAdapter;

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
}
