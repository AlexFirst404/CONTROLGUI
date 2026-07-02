package com.controlgui.mod.cef;

import com.controlgui.mod.Constants;
import com.mojang.blaze3d.systems.RenderSystem;
import net.minecraft.client.Minecraft;
import org.cef.CefApp;
import org.cef.CefClient;
import org.cef.CefSettings;
import org.cef.misc.CefCursorType;
import org.lwjgl.glfw.GLFW;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/* Собственный движок Chromium внутри мода (без стороннего MCEF). Тянет натив
   java-cef под платформу, инициализирует CEF на render-потоке, крутит его
   message loop покадрово и отдаёт OSR-браузеры для панели. Публичный фасад —
   аналог MCEF, но целиком наш и заточенный под CONTROLGUI. */
public final class CgCef {

    /* Зафиксированный коммит java-cef, под который завезён org.cef и посчитаны
       контрольные суммы (см. CgCefPlatform). Менять только вместе с ними. */
    public static final String JAVA_CEF_COMMIT = "eaeb3d4370aa3526ee237ad1981ad59af3de4dd1";
    /* Зеркало с нативными сборками java-cef (совместимо с нашим org.cef). */
    public static final String NATIVES_MIRROR = "https://github.com/Keksuccino/mcef_resources/releases/download";

    @FunctionalInterface
    public interface InitListener {
        void onInit(boolean ok);
    }

    private static volatile CefApp cefApp;
    private static volatile CgCefClient client;
    private static CgCefPlatform platform;
    private static Path nativesRoot;

    private static volatile boolean bootstrapped;
    private static volatile boolean nativesReady;
    private static volatile boolean nativesFailed;
    private static volatile boolean initFailed;
    private static volatile boolean disposed;
    private static volatile String statusText = "";
    private static volatile float nativesProgress = -1f; // 0..1 в текущей фазе; -1 — нет

    // сериализует нативный памп (render-поток) и dispose (хук завершения /
    // macOS-раннабл), чтобы два вызова CEF не пересеклись во время сноса
    private static final Object CEF_LOCK = new Object();
    private static final List<InitListener> awaitingInit = new ArrayList<>();
    private static final Map<CefCursorType, Long> glfwCursors = new ConcurrentHashMap<>();

    private CgCef() {}

    /* Один раз при старте клиента: определяем платформу, задаём пути и (если
       нужно) в фоне качаем натив. Инициализация CEF произойдёт позже, на
       render-потоке (см. onClientRenderTick). */
    public static synchronized void bootstrap() {
        if (bootstrapped) return;
        bootstrapped = true;
        try {
            platform = CgCefPlatform.detect();
            Minecraft mc = Minecraft.getInstance();
            File gameDir = (mc != null && mc.gameDirectory != null) ? mc.gameDirectory : new File(".").getAbsoluteFile();
            nativesRoot = new File(gameDir, "controlgui-cef").getAbsoluteFile().toPath();
            Files.createDirectories(nativesRoot);

            Path platformDir = CgCefNatives.platformDir(nativesRoot, platform);
            System.setProperty("mcef.libraries.path", nativesRoot.toString());
            System.setProperty("jcef.path", platformDir.toString());

            if (CgCefNatives.isInstalled(nativesRoot, platform)) {
                nativesReady = true;
                Constants.LOG.info("CONTROLGUI CEF: натив уже установлен ({})", platform.normalizedName());
                return;
            }

            statusText = "Подготовка Chromium…";
            Thread t = new Thread(CgCef::runDownload, "CONTROLGUI-CEF-Download");
            t.setDaemon(true);
            t.start();
        } catch (Throwable e) {
            nativesFailed = true;
            statusText = "Chromium недоступен: " + e.getMessage();
            Constants.LOG.error("CONTROLGUI CEF: не удалось подготовить движок", e);
        }
    }

    private static void runDownload() {
        try {
            CgCefNatives.install(nativesRoot, platform, new CgCefNatives.Sink() {
                @Override public void status(String text) { statusText = text; }
                @Override public void progress(float ratio) { nativesProgress = ratio; }
            });
            statusText = "";
            nativesReady = true;
            Constants.LOG.info("CONTROLGUI CEF: натив установлен ({})", platform.normalizedName());
        } catch (Throwable e) {
            nativesFailed = true;
            statusText = "Не удалось загрузить Chromium: " + e.getMessage();
            Constants.LOG.error("CONTROLGUI CEF: загрузка нативa не удалась", e);
        } finally {
            nativesProgress = -1f;
        }
    }

    /* Зовётся из мидлвара рендера (GameRenderer.render, HEAD) каждый кадр на
       render-потоке: доинициализирует CEF когда натив готов и крутит его цикл. */
    public static void onClientRenderTick() {
        if (disposed) return; // движок снесён — ни пампа, ни повторной инициализации
        if (client != null) {
            // блокировка (не занятая) гарантирует, что памп не пересечётся с dispose,
            // который зануляет cefApp и зовёт N_Shutdown из другого потока
            synchronized (CEF_LOCK) {
                if (disposed || cefApp == null) return;
                try {
                    cefApp.N_DoMessageLoopWork();
                } catch (Throwable ignored) {
                    // единичный сбой пампа не должен ронять рендер игры
                }
            }
            return;
        }
        if (nativesReady && !nativesFailed && !initFailed) {
            initialize();
        }
    }

    private static synchronized void initialize() {
        if (client != null || initFailed || disposed) return;
        if (!RenderSystem.isOnRenderThread()) return;
        try {
            makeNativesExecutable();

            String[] switches = { "--autoplay-policy=no-user-gesture-required" };
            if (!CefApp.startup(switches)) {
                throw new IllegalStateException("CefApp.startup вернул false");
            }

            CefSettings settings = new CefSettings();
            settings.windowless_rendering_enabled = true;
            settings.log_severity = CefSettings.LogSeverity.LOGSEVERITY_DISABLE;
            // прозрачный фон — панель рисуется поверх заблюренной игры
            settings.background_color = settings.new ColorType(0, 255, 255, 255);
            // work around Google «this browser may not be secure»
            settings.user_agent_product = "CONTROLGUI/1";
            // сохраняем cookies/сессию между запусками игры
            Path cache = nativesRoot.resolve("cef-cache");
            try {
                Files.createDirectories(cache);
                settings.cache_path = cache.toAbsolutePath().toString();
                settings.persist_session_cookies = true;
            } catch (Exception e) {
                Constants.LOG.warn("CONTROLGUI CEF: постоянный кэш недоступен, работаем без него", e);
            }

            cefApp = CefApp.getInstance(switches, settings);
            CefClient rawClient = cefApp.createClient();
            client = new CgCefClient(rawClient);

            // корректное завершение jcef-процессов
            if (platform.isMacOS()) {
                cefApp.macOSTerminationRequestRunnable = () -> {
                    shutdown();
                    Minecraft.getInstance().stop();
                };
            } else {
                Runtime.getRuntime().addShutdownHook(new Thread(CgCef::shutdown, "CONTROLGUI-CEF-Shutdown"));
            }

            statusText = "";
            Constants.LOG.info("CONTROLGUI CEF: движок Chromium инициализирован");
            List<InitListener> pending;
            synchronized (awaitingInit) {
                pending = new ArrayList<>(awaitingInit);
                awaitingInit.clear();
            }
            for (InitListener l : pending) {
                try { l.onInit(true); } catch (Throwable t) { Constants.LOG.warn("CONTROLGUI CEF: init-слушатель упал", t); }
            }
        } catch (Throwable e) {
            initFailed = true;
            statusText = "Не удалось запустить Chromium: " + e.getMessage();
            Constants.LOG.error("CONTROLGUI CEF: инициализация не удалась", e);
            List<InitListener> pending;
            synchronized (awaitingInit) {
                pending = new ArrayList<>(awaitingInit);
                awaitingInit.clear();
            }
            for (InitListener l : pending) {
                try { l.onInit(false); } catch (Throwable ignored) {}
            }
        }
    }

    /* jcef_helper под Linux/macOS должен быть исполняемым (tar-распаковка бит не
       сохраняет). Порт логики CefUtil.init. */
    private static void makeNativesExecutable() {
        if (platform.isWindows()) return;
        String jcefPath = System.getProperty("jcef.path");
        if (jcefPath == null) return;
        if (platform.isLinux()) {
            setExecutable(new File(jcefPath, "jcef_helper"));
        } else if (platform.isMacOS()) {
            String base = jcefPath + "/jcef_app.app/Contents/Frameworks/";
            setExecutable(new File(base + "jcef Helper.app/Contents/MacOS/jcef Helper"));
            setExecutable(new File(base + "jcef Helper (GPU).app/Contents/MacOS/jcef Helper (GPU)"));
            setExecutable(new File(base + "jcef Helper (Plugin).app/Contents/MacOS/jcef Helper (Plugin)"));
            setExecutable(new File(base + "jcef Helper (Renderer).app/Contents/MacOS/jcef Helper (Renderer)"));
        }
    }

    private static void setExecutable(File file) {
        if (!file.exists()) return;
        try {
            Set<PosixFilePermission> perms = EnumSet.of(
                    PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE,
                    PosixFilePermission.GROUP_READ, PosixFilePermission.GROUP_EXECUTE,
                    PosixFilePermission.OTHERS_READ, PosixFilePermission.OTHERS_EXECUTE);
            Files.setPosixFilePermissions(file.toPath(), perms);
        } catch (Exception e) {
            Constants.LOG.warn("CONTROLGUI CEF: не удалось сделать {} исполняемым", file, e);
        }
    }

    public static boolean isInitialized() {
        return client != null;
    }

    /* Провалилась установка/инициализация — панель покажет причину. */
    public static boolean isFailed() {
        return nativesFailed || initFailed;
    }

    /* Движок ещё готовится (качается/распаковывается натив) — для индикатора
       в главном меню. */
    public static boolean busy() {
        return bootstrapped && !nativesReady && !nativesFailed;
    }

    /* Прогресс текущей фазы подготовки, 0..1; -1 — неизвестен. */
    public static float progress() {
        return nativesProgress;
    }

    public static String statusText() {
        return statusText;
    }

    public static CgCefClient getClient() {
        if (client == null) throw new IllegalStateException("CONTROLGUI CEF не инициализирован");
        return client;
    }

    public static void scheduleForInit(InitListener listener) {
        // проверку client и добавление в список делаем под тем же замком, под
        // которым initialize() сливает список, иначе колбэк можно потерять в гонке
        synchronized (awaitingInit) {
            if (client == null && !initFailed && !disposed) {
                awaitingInit.add(listener);
                return;
            }
        }
        listener.onInit(client != null);
    }

    /* Создаёт OSR-браузер под панель. Только на render-потоке (иначе маршалим). */
    public static CgCefBrowser createBrowser(String url, boolean transparent) {
        if (!RenderSystem.isOnRenderThread()) {
            return Minecraft.getInstance().submit(() -> createBrowser(url, transparent)).join();
        }
        if (client == null) throw new IllegalStateException("CONTROLGUI CEF не инициализирован");
        CgCefBrowser browser = new CgCefBrowser(client, url, transparent);
        browser.setCloseAllowed();
        browser.createImmediately();
        return browser;
    }

    public static synchronized void shutdown() {
        // под CEF_LOCK, чтобы не пересечься с нативным пампом на render-потоке;
        // disposed=true заодно запрещает повторную инициализацию после сноса
        synchronized (CEF_LOCK) {
            if (disposed) return;
            disposed = true;
            CefClient raw = client != null ? client.getHandle() : null;
            CefApp app = cefApp;
            client = null;
            cefApp = null;
            try {
                if (raw != null) raw.dispose();
            } catch (Throwable ignored) {}
            try {
                if (app != null) app.dispose();
            } catch (Throwable ignored) {}
        }
    }

    /* GLFW-хэндл курсора под тип CEF (с кэшем). Зовётся на render-потоке. */
    static long glfwCursorHandle(CefCursorType cursorType) {
        if (cursorType == null || cursorType.glfwId == 0) return 0L;
        Long cached = glfwCursors.get(cursorType);
        if (cached != null) return cached;
        long handle = GLFW.glfwCreateStandardCursor(cursorType.glfwId);
        if (handle == 0L) return 0L;
        glfwCursors.put(cursorType, handle);
        return handle;
    }
}
