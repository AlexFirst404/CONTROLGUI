package com.controlgui.mod.cef;

import org.cef.CefClient;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandler;
import org.cef.network.CefRequest;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/* Обёртка вокруг org.cef.CefClient. У CefClient слот load-обработчика один
   (first-wins), поэтому мультиплексируем сами: занимаем слот собой и рассылаем
   события списку подписчиков (нам нужен один — переприменение зума после
   загрузки страницы). Request-handler ставит CGBrowser напрямую на getHandle().
   Свой аналог MCEFClient, урезанный до необходимого. */
public final class CgCefClient implements CefLoadHandler {

    private final CefClient handle;
    private final List<CefLoadHandler> loadHandlers = new CopyOnWriteArrayList<>();

    CgCefClient(CefClient handle) {
        this.handle = handle;
        handle.addLoadHandler(this);
    }

    public CefClient getHandle() {
        return handle;
    }

    public void addLoadHandler(CefLoadHandler handler) {
        loadHandlers.add(handler);
    }

    @Override
    public void onLoadingStateChange(CefBrowser browser, boolean isLoading, boolean canGoBack, boolean canGoForward) {
        for (CefLoadHandler h : loadHandlers) h.onLoadingStateChange(browser, isLoading, canGoBack, canGoForward);
    }

    @Override
    public void onLoadStart(CefBrowser browser, CefFrame frame, CefRequest.TransitionType transitionType) {
        for (CefLoadHandler h : loadHandlers) h.onLoadStart(browser, frame, transitionType);
    }

    @Override
    public void onLoadEnd(CefBrowser browser, CefFrame frame, int httpStatusCode) {
        for (CefLoadHandler h : loadHandlers) h.onLoadEnd(browser, frame, httpStatusCode);
    }

    @Override
    public void onLoadError(CefBrowser browser, CefFrame frame, ErrorCode errorCode, String errorText, String failedUrl) {
        for (CefLoadHandler h : loadHandlers) h.onLoadError(browser, frame, errorCode, errorText, failedUrl);
    }
}
