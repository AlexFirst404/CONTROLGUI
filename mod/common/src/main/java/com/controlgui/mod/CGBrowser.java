package com.controlgui.mod;

import com.cinemamod.mcef.MCEF;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.callback.CefCallback;
import org.cef.handler.CefLoadHandler;
import org.cef.handler.CefLoadHandlerAdapter;
import org.cef.handler.CefRequestHandlerAdapter;

/* Обработчики уровня CefClient. Главное — приём самоподписанного сертификата
   центра CONTROLGUI: без этого удалённые панели из игры недоступны (Chromium
   молча режет такие соединения; --disable-web-security на TLS не влияет).
   Браузер выделен под интерфейс панели, поэтому это безопасный компромисс. */
public final class CGBrowser {

    private static boolean installed;

    private CGBrowser() {}

    /* Зовётся из энтрипоинтов обоих лоадеров; ждёт инициализации Chromium. */
    public static void installHandlers() {
        if (MCEF.isInitialized()) install();
        else MCEF.scheduleForInit((ok) -> { if (ok) install(); });
    }

    private static synchronized void install() {
        if (installed) return;
        installed = true;
        // слот request-handler в CefClient один (first-wins) — занимаем сразу
        MCEF.getClient().getHandle().addRequestHandler(new CefRequestHandlerAdapter() {
            @Override
            public boolean onCertificateError(CefBrowser browser, CefLoadHandler.ErrorCode certError,
                                              String requestUrl, CefCallback callback) {
                if (callback == null) return false;
                callback.Continue();
                return true;
            }
        });
        // после коммита страницы переприменяем зум (CEF хранит его по хосту)
        MCEF.getClient().addLoadHandler(new CefLoadHandlerAdapter() {
            @Override
            public void onLoadEnd(CefBrowser browser, CefFrame frame, int httpStatusCode) {
                if (frame != null && frame.isMain()) PanelScreen.onPageLoaded();
            }
        });
        Constants.LOG.info("CONTROLGUI: обработчики браузера установлены");
    }
}
