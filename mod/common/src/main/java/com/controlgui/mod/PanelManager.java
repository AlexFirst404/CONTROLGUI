package com.controlgui.mod;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Comparator;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/* Разворачивает и сопровождает локальную панель CONTROLGUI:
   1) если панель уже работает (например, открыто настольное приложение) —
      просто использует её;
   2) иначе находит Node.js (PATH -> установленное приложение -> скачивает
      с nodejs.org), распаковывает вшитый в jar panel.zip в общую с
      приложением папку данных и запускает node server.js.
   Всё сетевое — вне рендер-потока (свой executor). */
public final class PanelManager {

    public enum Phase { IDLE, WORKING, READY, ERROR }

    private static final String NODE_VERSION = "v22.12.0";
    private static final String BASE_URL = "http://127.0.0.1:" + Constants.PANEL_PORT;

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor((r) -> {
        Thread t = new Thread(r, "controlgui-panel");
        t.setDaemon(true);
        return t;
    });
    /* ВАЖНО: без .executor(EXEC) — синхронный send() зовётся С САМОГО EXEC,
       и если клиент доставляет ответы через тот же единственный поток,
       send() не завершается никогда (дедлок, проверено эмпирически). */
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .build();

    /* Первая версия панели, в которой появился оконный режим (desktop.html). */
    private static final String DESKTOP_UI_SINCE = "1.6.7";
    /* Первая версия панели с POST /api/quit (тихая замена устаревшей). */
    private static final String QUIT_API_SINCE = "1.6.8";

    private static volatile Phase phase = Phase.IDLE;
    private static volatile String statusText = "";
    private static volatile Process panelProc;      // null, если панель не наша
    private static volatile int generation = 0;     // растёт при (пере)запуске панели
    private static volatile boolean desktopUi = true; // умеет ли панель оконный режим
    private static volatile Path uiRoot;            // public/ свежей панели из jar
    private static volatile boolean uiOverride;     // подменять статику UI из uiRoot
    private static CompletableFuture<String> pending; // guarded by PanelManager.class

    private PanelManager() {}

    public static Phase phase() { return phase; }
    public static String statusText() { return statusText; }
    public static String baseUrl() { return BASE_URL; }
    /* Меняется, когда панель пришлось (пере)поднимать: страница в браузере
       к этому моменту мертва и её нужно перезагрузить. */
    public static int generation() { return generation; }
    /* false — работаем с чужой устаревшей панелью (например, открыто настольное
       приложение прошлой версии), И подменить её UI не удалось: грузим старый
       полноэкранный UI вместо desktop.html, иначе будет «404: файл не найден». */
    public static boolean hasDesktopUi() { return desktopUi; }

    /* Каталог public/ свежей панели из мода, когда её статикой надо ПОДМЕНЯТЬ
       ответы работающей (устаревшей) панели; null — подмена не нужна.
       Читается перехватчиком ресурсов CEF (CGBrowser) на IO-потоке. */
    public static Path uiOverrideDir() { return uiOverride ? uiRoot : null; }

    /* Гарантирует работающую панель; возвращает базовый URL. Повторные
       вызовы во время запуска возвращают тот же future. Завершённый future
       не переиспользуется: startBlocking начинается с probe(), так что при
       живой панели новый вызов завершается мгновенно, а при умершей —
       перезапускает её (никаких join() на собственном экзекьюторе). */
    public static synchronized CompletableFuture<String> ensureStarted() {
        if (pending != null && !pending.isDone()) return pending;
        phase = Phase.WORKING;
        statusText = "Подключаюсь к панели…";
        // pending — стадия ПОСЛЕ whenComplete: колбэки подписчиков (thenAccept в
        // PanelScreen) сработают только когда phase уже выставлена, иначе гонка —
        // ensureBrowser мог увидеть phase!=READY и перезагрузка молча терялась
        pending = CompletableFuture.supplyAsync(PanelManager::startBlocking, EXEC)
                .whenComplete((url, err) -> {
                    if (err != null) {
                        phase = Phase.ERROR;
                        statusText = "Ошибка: " + rootMessage(err);
                        Constants.LOG.error("Не удалось запустить панель", err);
                    } else {
                        phase = Phase.READY;
                        statusText = "";
                    }
                });
        return pending;
    }

    private static String rootMessage(Throwable t) {
        while (t.getCause() != null) t = t.getCause();
        return t.getMessage() != null ? t.getMessage() : t.toString();
    }

    private static String startBlocking() {
        Path dataDir = dataDir();
        try { Files.createDirectories(dataDir); }
        catch (IOException e) { throw new RuntimeException("Не создать папку данных: " + dataDir, e); }

        // 1) уже работает? (настольное приложение или прошлый запуск).
        // ВАЖНО: распаковку panel.zip делаем ПОСЛЕ probe и только когда нужна —
        // одноверсионная панель приложения работает прямо из <data>/app/<ver>,
        // и перезапись её файлов на живую дала бы 404/битую статику.
        String runningVer = probeVersion();
        if (runningVer != null) {
            if (versionAtLeast(runningVer, Constants.PANEL_VERSION)) {
                uiOverride = false;
                desktopUi = true;
                return BASE_URL; // панель не старее вшитой — просто используем
            }
            // панель устарела. ЖИВУЮ панель не трогаем (её могло открыть
            // настольное приложение — после выхода из игры оно осталось бы с
            // мёртвым бэкендом): подменяем только статику UI. /api/quit — лишь
            // крайний случай, когда подменить нечем.
            Constants.LOG.info("На порту {} панель {} (в моде {})", Constants.PANEL_PORT, runningVer, Constants.PANEL_VERSION);
            // работающая панель старее — она живёт в app/<runningVer>, наша
            // распаковка в app/<PANEL_VERSION> её не трогает
            Path pd = null;
            try { pd = extractPanel(dataDir); }
            catch (IOException e) { Constants.LOG.warn("Не распаковать панель из мода: {}", rootMessage(e)); }
            if (pd != null) {
                // статику (desktop.html, app.js, css…) отдаём из свежей панели
                // мода, а /api идёт в работающую панель — окна работают везде
                uiRoot = pd.resolve("public");
                uiOverride = true;
                desktopUi = true;
                Constants.LOG.info("UI панели подменяется на {} (API остаётся {})", Constants.PANEL_VERSION, runningVer);
                return BASE_URL;
            }
            if (versionAtLeast(runningVer, QUIT_API_SINCE) && quitStalePanel()) {
                Constants.LOG.info("Устаревшая панель остановлена — запускаю свежую");
                // порт освобождается мгновенно после выхода процесса; подстрахуемся
                for (int i = 0; i < 10 && probe(); i++) sleep(300);
            } else {
                // подменить нечем и заменить нельзя — старый полноэкранный UI
                uiOverride = false;
                desktopUi = versionAtLeast(runningVer, DESKTOP_UI_SINCE);
                return BASE_URL;
            }
        }
        uiOverride = false;
        desktopUi = true;
        generation++; // панель была мертва — открытая в браузере страница устарела

        // 2) node: PATH -> приложение -> скачать
        statusText = "Ищу Node.js…";
        String node = findNode(dataDir);

        // 3) панель из jar
        statusText = "Разворачиваю панель…";
        Path panelDir;
        try { panelDir = extractPanel(dataDir); }
        catch (IOException e) { throw new RuntimeException("Не распаковать панель: " + rootMessage(e), e); }

        // 5) запустить и дождаться готовности
        statusText = "Запускаю панель…";
        try {
            ProcessBuilder pb = new ProcessBuilder(node, "server.js");
            pb.directory(panelDir.toFile());
            pb.environment().put("CONTROLGUI_DATA", dataDir.toString());
            pb.environment().put("PORT", String.valueOf(Constants.PANEL_PORT));
            pb.redirectErrorStream(true);
            pb.redirectOutput(dataDir.resolve("mod-panel.log").toFile());
            panelProc = pb.start();
        } catch (IOException e) {
            throw new RuntimeException("Не запустить node: " + rootMessage(e), e);
        }
        for (int i = 0; i < 60; i++) {
            if (!panelProc.isAlive()) {
                panelProc = null;
                throw new RuntimeException("Панель завершилась при запуске (см. mod-panel.log в " + dataDir + ")");
            }
            if (probe()) return BASE_URL;
            sleep(500);
        }
        // не отвечает — убиваем свой процесс, иначе следующая попытка упрётся в занятый порт
        Process p = panelProc;
        panelProc = null;
        if (p != null) p.destroyForcibly();
        throw new RuntimeException("Панель не ответила за 30 секунд");
    }

    /* ── обнаружение/скачивание Node.js ─────────────────────────────────── */

    private static String findNode(Path dataDir) {
        if (nodeWorks("node")) return "node";
        if (isWindows()) {
            String app = System.getenv("LOCALAPPDATA");
            if (app != null) {
                Path p = Path.of(app, "Programs", "CONTROLGUI", "node.exe");
                if (Files.isRegularFile(p) && nodeWorks(p.toString())) return p.toString();
            }
        }
        Path cached = findRuntimeNode(dataDir);
        // скачанный ранее node мог быть повреждён (оборванная загрузка) — проверяем
        if (cached != null && nodeWorks(cached.toString())) return cached.toString();
        return downloadNode(dataDir).toString();
    }

    private static boolean nodeWorks(String bin) {
        try {
            Process p = new ProcessBuilder(bin, "--version").redirectErrorStream(true).start();
            // сперва ждём завершения с таймаутом: readAllBytes на зависшем
            // бинарнике заблокировал бы запуск навсегда; вывод -‑version
            // крошечный и в пайп-буфер помещается целиком
            if (!p.waitFor(8, java.util.concurrent.TimeUnit.SECONDS)) { p.destroyForcibly(); return false; }
            String out = new String(p.getInputStream().readAllBytes()).trim();
            // нужен современный node (панель использует fetch и т.п.)
            if (p.exitValue() != 0 || !out.startsWith("v")) return false;
            int major = Integer.parseInt(out.substring(1).split("\\.")[0]);
            return major >= 18;
        } catch (Exception e) {
            return false;
        }
    }

    private static Path runtimeDir(Path dataDir) { return dataDir.resolve("mod-runtime"); }

    private static Path findRuntimeNode(Path dataDir) {
        Path rt = runtimeDir(dataDir);
        if (!Files.isDirectory(rt)) return null;
        String bin = isWindows() ? "node.exe" : "node";
        try (var stream = Files.list(rt)) {
            return stream
                    .filter(Files::isDirectory)
                    .sorted(Comparator.comparing(Path::getFileName).reversed())
                    .map((d) -> {
                        Path direct = d.resolve(bin);
                        Path inBin = d.resolve("bin").resolve(bin);
                        if (Files.isRegularFile(direct)) return direct;
                        if (Files.isRegularFile(inBin)) return inBin;
                        return null;
                    })
                    .filter(java.util.Objects::nonNull)
                    .findFirst().orElse(null);
        } catch (IOException e) {
            return null;
        }
    }

    private static Path downloadNode(Path dataDir) {
        String os = isWindows() ? "win" : (isMac() ? "darwin" : "linux");
        String arch = System.getProperty("os.arch", "").contains("aarch64") || System.getProperty("os.arch", "").contains("arm") ? "arm64" : "x64";
        String ext = isWindows() ? "zip" : "tar.gz";
        String name = "node-" + NODE_VERSION + "-" + os + "-" + arch;
        String url = "https://nodejs.org/dist/" + NODE_VERSION + "/" + name + "." + ext;

        Path rt = runtimeDir(dataDir);
        Path archive = rt.resolve(name + "." + ext);
        try {
            Files.createDirectories(rt);
            statusText = "Скачиваю Node.js…";
            HttpRequest req = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMinutes(5)).build();
            HttpResponse<InputStream> res = HTTP.send(req, HttpResponse.BodyHandlers.ofInputStream());
            if (res.statusCode() != 200) throw new IOException("HTTP " + res.statusCode() + " при скачивании Node.js");
            long total = res.headers().firstValueAsLong("content-length").orElse(-1);
            try (InputStream in = res.body(); var out = Files.newOutputStream(archive)) {
                byte[] buf = new byte[65536];
                long done = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    if (total > 0) statusText = "Скачиваю Node.js… " + (done * 100 / total) + "%";
                }
            }
            statusText = "Распаковываю Node.js…";
            if (isWindows()) unzip(Files.newInputStream(archive), rt);
            else {
                Process tar = new ProcessBuilder("tar", "-xzf", archive.toString(), "-C", rt.toString())
                        .redirectErrorStream(true).start();
                tar.getInputStream().readAllBytes();
                if (!tar.waitFor(5, java.util.concurrent.TimeUnit.MINUTES) || tar.exitValue() != 0) {
                    throw new IOException("tar не смог распаковать Node.js");
                }
            }
            Files.deleteIfExists(archive);
            Path node = findRuntimeNode(dataDir);
            if (node == null) throw new IOException("node не найден после распаковки");
            return node;
        } catch (Exception e) {
            try { Files.deleteIfExists(archive); } catch (IOException x) { /* не критично */ }
            throw new RuntimeException("Не удалось получить Node.js: " + rootMessage(e), e);
        }
    }

    /* ── панель из jar ──────────────────────────────────────────────────── */

    private static Path extractPanel(Path dataDir) throws IOException {
        // раскладка как у настольного приложения: <data>/app/<версия>
        Path dir = dataDir.resolve("app").resolve(Constants.PANEL_VERSION);
        Path marker = dir.resolve(".cg-mod-panel");
        if (Files.isRegularFile(marker) && Files.isRegularFile(dir.resolve("server.js"))) return dir;
        Files.createDirectories(dir);
        try (InputStream raw = PanelManager.class.getResourceAsStream("/assets/" + Constants.MOD_ID + "/panel.zip")) {
            if (raw == null) throw new IOException("panel.zip не найден в jar мода");
            unzip(raw, dir);
        }
        Files.writeString(marker, Constants.PANEL_VERSION);
        return dir;
    }

    private static void unzip(InputStream raw, Path target) throws IOException {
        Path root = target.toAbsolutePath().normalize();
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(raw))) {
            ZipEntry e;
            while ((e = zip.getNextEntry()) != null) {
                Path out = root.resolve(e.getName()).normalize();
                if (!out.startsWith(root)) throw new IOException("Небезопасный путь в архиве: " + e.getName());
                if (e.isDirectory()) {
                    Files.createDirectories(out);
                } else {
                    Files.createDirectories(out.getParent());
                    Files.copy(zip, out, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    /* ── статус/завершение ──────────────────────────────────────────────── */

    private static boolean probe() {
        return probeVersion() != null;
    }

    /* null — панели на порту нет; иначе её версия ("1.6.6"; "0" — не распознали,
       но это точно панель CONTROLGUI). Версию берём СТРОГО из поля app ответа
       /api/status: тело содержит и пути (root, java), где слово CONTROLGUI
       с цифрами может встретиться раньше и подменить версию. */
    private static String probeVersion() {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(BASE_URL + "/api/status"))
                    .timeout(Duration.ofMillis(1500)).GET().build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200 || res.body() == null) return null;
            JsonElement parsed = JsonParser.parseString(res.body());
            if (!parsed.isJsonObject()) return null;
            JsonObject o = parsed.getAsJsonObject();
            // на порту может жить посторонний сервис — панель узнаём по полю app
            if (!o.has("app") || !o.get("app").isJsonPrimitive()) return null;
            String app = o.get("app").getAsString();
            if (!app.startsWith("CONTROLGUI")) return null;
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("(\\d+(?:\\.\\d+)*)").matcher(app);
            return m.find() ? m.group(1) : "0";
        } catch (Exception e) {
            return null;
        }
    }

    /* a >= b для версий вида 1.6.7 (покомпонентно, числами). */
    private static boolean versionAtLeast(String a, String b) {
        String[] pa = a.split("\\."), pb = b.split("\\.");
        int n = Math.max(pa.length, pb.length);
        for (int i = 0; i < n; i++) {
            int va, vb;
            try { va = i < pa.length ? Integer.parseInt(pa[i]) : 0; } catch (NumberFormatException e) { va = 0; }
            try { vb = i < pb.length ? Integer.parseInt(pb[i]) : 0; } catch (NumberFormatException e) { vb = 0; }
            if (va != vb) return va > vb;
        }
        return true;
    }

    /* Просит устаревшую панель завершиться (она откажет, если на ней работают
       серверы). true — панель подтвердила выход. */
    private static boolean quitStalePanel() {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(BASE_URL + "/api/quit"))
                    .timeout(Duration.ofSeconds(3))
                    .header("X-CG-Local", "1")
                    .POST(HttpRequest.BodyPublishers.noBody()).build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            return res.statusCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    /* Вызывается при выходе из игры: панель, запущенную модом, гасим,
       только если ТОЧНО знаем, что на ней не работают Minecraft-серверы.
       Не смогли проверить — дерево процессов не трогаем (гасим только сам
       node; его java-дети переживают это и панель подхватит их как
       «осиротевшие» при следующем запуске). */
    public static void shutdown() {
        Process proc = panelProc;
        if (proc == null || !proc.isAlive()) return;
        Boolean serversRunning = null; // null = не удалось проверить
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(BASE_URL + "/api/servers"))
                    .timeout(Duration.ofMillis(2000)).GET().build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 200) {
                JsonElement parsed = JsonParser.parseString(res.body());
                JsonArray list = parsed.isJsonArray() ? parsed.getAsJsonArray()
                        : parsed.getAsJsonObject().getAsJsonArray("servers");
                if (list != null) {
                    serversRunning = false;
                    for (JsonElement el : list) {
                        JsonObject s = el.getAsJsonObject();
                        String st = s.has("status") ? s.get("status").getAsString() : "stopped";
                        // именно живой процесс сервера (а не «скачивается»/«ошибка»)
                        if ("running".equals(st) || "starting".equals(st) || "stopping".equals(st)) {
                            serversRunning = true;
                            break;
                        }
                    }
                }
            }
        } catch (Exception e) {
            // ответа нет — считаем состояние неизвестным
        }
        if (Boolean.TRUE.equals(serversRunning)) {
            Constants.LOG.info("Панель оставлена работать: на ней запущены серверы Minecraft");
            return;
        }
        ProcessHandle h = proc.toHandle();
        if (serversRunning == null) {
            Constants.LOG.info("Останавливаю панель CONTROLGUI (без дочерних процессов — состояние серверов неизвестно)");
            h.destroy();
            return;
        }
        Constants.LOG.info("Останавливаю панель CONTROLGUI");
        h.descendants().forEach(ProcessHandle::destroy);
        h.destroy();
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }
    private static boolean isMac() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac");
    }

    private static Path dataDir() {
        if (isWindows()) {
            String app = System.getenv("LOCALAPPDATA");
            return Path.of(app != null ? app : System.getProperty("user.home"), "CONTROLGUI");
        }
        if (isMac()) {
            return Path.of(System.getProperty("user.home"), "Library", "Application Support", "CONTROLGUI");
        }
        String xdg = System.getenv("XDG_DATA_HOME");
        return xdg != null && !xdg.isEmpty()
                ? Path.of(xdg, "controlgui")
                : Path.of(System.getProperty("user.home"), ".local", "share", "controlgui");
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
