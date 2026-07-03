package com.controlgui.mod;

import org.cef.callback.CefCallback;
import org.cef.handler.CefResourceHandler;
import org.cef.misc.IntRef;
import org.cef.misc.StringRef;
import org.cef.network.CefRequest;
import org.cef.network.CefResponse;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;

/* Отдаёт браузеру файл свежего UI панели с диска (из панели, вшитой в мод).
   Используется, когда на порту работает панель прошлой версии: её статику
   подменяем нашей, а /api идёт как обычно — окна работают и со старым
   приложением, без обновления .exe. */
final class CGUiResource implements CefResourceHandler {

    private static final Map<String, String> MIME = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"),
            Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("json", "application/json"),
            Map.entry("png", "image/png"),
            Map.entry("ico", "image/x-icon"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("woff2", "font/woff2"),
            Map.entry("ttf", "font/ttf"),
            Map.entry("otf", "font/otf"));

    private final Path file;
    private InputStream in;
    private long length = -1;

    CGUiResource(Path file) {
        this.file = file;
    }

    @Override
    public boolean processRequest(CefRequest request, CefCallback callback) {
        try {
            length = Files.size(file);
            in = Files.newInputStream(file);
        } catch (IOException e) {
            Constants.LOG.warn("CONTROLGUI: не открыть файл UI {}", file, e);
            callback.cancel();
            return false;
        }
        callback.Continue();
        return true;
    }

    @Override
    public void getResponseHeaders(CefResponse response, IntRef responseLength, StringRef redirectUrl) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        String ct = dot >= 0 ? MIME.get(name.substring(dot + 1).toLowerCase(Locale.ROOT)) : null;
        if (ct == null) ct = "application/octet-stream";
        // ВАЖНО: CefResponse.setMimeType ждёт ЧИСТЫЙ mime-тип ("text/html"), а не полный
        // Content-Type со «; charset=utf-8». Со charset Chromium не распознаёт тип как HTML,
        // показывает ИСХОДНИК страницы как текст, а кириллица без utf-8 превращается в
        // мозаику. Тип отдаём чистым, а charset — отдельным заголовком Content-Type.
        int semi = ct.indexOf(';');
        String baseType = semi >= 0 ? ct.substring(0, semi).trim() : ct;
        response.setMimeType(baseType);
        response.setHeaderByName("Content-Type", ct, true);
        response.setStatus(200);
        response.setStatusText("OK");
        responseLength.set(length >= 0 && length <= Integer.MAX_VALUE ? (int) length : -1);
    }

    @Override
    public boolean readResponse(byte[] dataOut, int bytesToRead, IntRef bytesRead, CefCallback callback) {
        try {
            int n = in.read(dataOut, 0, bytesToRead);
            if (n <= 0) {
                closeQuietly();
                bytesRead.set(0);
                return false;
            }
            bytesRead.set(n);
            return true;
        } catch (IOException e) {
            closeQuietly();
            bytesRead.set(0);
            return false;
        }
    }

    @Override
    public void cancel() {
        closeQuietly();
    }

    private void closeQuietly() {
        try {
            if (in != null) in.close();
        } catch (IOException ignored) {
        }
        in = null;
    }
}
