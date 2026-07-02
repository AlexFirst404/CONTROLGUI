package com.controlgui.mod.cef;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/* Скачивание и распаковка нативного бандла java-cef (Chromium) под текущую
   платформу. Полностью на стандартной библиотеке: HttpURLConnection + GZIP +
   собственный мини-читатель tar (ustar/GNU longname), без commons-compress.
   Архив проверяется по зашитой sha256 (см. CgCefPlatform). Свой аналог
   MCEFDownloader — заточен под наш мод, без зеркал/настроек/меню. */
final class CgCefNatives {

    /* Куда пишем прогресс/статус, чтобы показать в меню и на экране панели. */
    interface Sink {
        void status(String text);
        /* 0..1 внутри текущей фазы (загрузка, затем распаковка). */
        default void progress(float ratio) {}
    }

    private static final int BUF = 64 * 1024;
    private static final long MAX_ARCHIVE_BYTES = 900L * 1024L * 1024L;
    private static final long MAX_EXTRACTED_BYTES = 2_500L * 1024L * 1024L;
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 60_000;

    private CgCefNatives() {}

    /* Абсолютный каталог, куда распаковываются либы под платформу:
       <root>/<platform> (именно его читает org.cef через jcef.path). */
    static Path platformDir(Path root, CgCefPlatform platform) {
        return root.resolve(platform.normalizedName());
    }

    private static Path markerFile(Path root, CgCefPlatform platform) {
        return root.resolve("." + platform.normalizedName() + "-" + CgCef.JAVA_CEF_COMMIT + ".ok");
    }

    /* Уже установлено под нужный коммит? Тогда качать не нужно. */
    static boolean isInstalled(Path root, CgCefPlatform platform) {
        Path dir = platformDir(root, platform);
        return Files.isDirectory(dir) && Files.isRegularFile(markerFile(root, platform));
    }

    /* Блокирующая установка: качаем .tar.gz, сверяем sha256, распаковываем в
       <root>, помечаем маркером. Зовётся из фонового потока. */
    static void install(Path root, CgCefPlatform platform, Sink sink) throws IOException {
        Files.createDirectories(root);
        String tag = "java-cef-" + CgCef.JAVA_CEF_COMMIT;
        String url = CgCef.NATIVES_MIRROR + "/" + tag + "/" + platform.normalizedName() + ".tar.gz";
        Path archive = root.resolve(platform.normalizedName() + ".tar.gz");

        sink.status("Загрузка Chromium (~200 МБ)…");
        download(url, archive, sink);

        sink.status("Проверка целостности…");
        String actual = sha256(archive);
        if (!actual.equalsIgnoreCase(platform.expectedSha256())) {
            Files.deleteIfExists(archive);
            throw new IOException("sha256 архива Chromium не совпала: ожидалось "
                    + platform.expectedSha256() + ", получено " + actual);
        }

        sink.status("Распаковка Chromium…");
        // на всякий случай чистим прошлую (частичную) установку под платформу
        Path platDir = platformDir(root, platform);
        if (Files.exists(platDir)) deleteRecursively(platDir);
        extractTarGz(archive, root, sink);
        Files.deleteIfExists(archive);

        // проверяем, что ключевая нативная либа реально на месте — иначе распаковка
        // прошла криво (напр. неучтённый формат tar): чистим и НЕ ставим маркер,
        // чтобы следующий запуск перекачал, а не закэшировал битую установку
        verifyExtraction(platDir, platform);

        // маркер — последним, атомарно означает «готово»
        Files.writeString(markerFile(root, platform), CgCef.JAVA_CEF_COMMIT, StandardCharsets.UTF_8);
    }

    /* Ключевые файлы, которые org.cef грузит через System.load — если после
       распаковки их нет по ожидаемому пути, установка испорчена. */
    private static void verifyExtraction(Path platDir, CgCefPlatform platform) throws IOException {
        String[] required;
        if (platform.isWindows()) {
            required = new String[] { "libcef.dll", "jcef.dll", "jcef_helper.exe" };
        } else if (platform.isLinux()) {
            required = new String[] { "libcef.so", "libjcef.so", "jcef_helper" };
        } else {
            required = new String[] { "jcef_app.app/Contents/Java/libjcef.dylib" };
        }
        for (String rel : required) {
            Path p = platDir.resolve(rel);
            if (!Files.isRegularFile(p)) {
                deleteRecursively(platDir);
                throw new IOException("распаковка Chromium повреждена: нет " + rel
                        + " (формат архива не поддержан?)");
            }
        }
    }

    /* ── загрузка ────────────────────────────────────────────────────────── */

    /* Скольки соединениями качать (GitHub-CDN часто режет скорость одного
       соединения — параллельные сегменты заметно быстрее). */
    private static final int MAX_SEGMENTS = 6;
    private static final long MIN_SEGMENT_BYTES = 8L * 1024 * 1024;

    private static void download(String urlString, Path output, Sink sink) throws IOException {
        Path part = output.resolveSibling(output.getFileName() + ".part");
        Files.deleteIfExists(part);
        try {
            Probe p = probeUrl(urlString);
            if (p.total > MAX_ARCHIVE_BYTES) throw new IOException("архив Chromium слишком большой");
            if (p.ranges && p.total > MIN_SEGMENT_BYTES * 2) {
                downloadSegmented(p, part, sink);
            } else {
                downloadSingle(p.finalUrl, part, sink);
            }
            try {
                Files.move(part, output, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailed) {
                Files.move(part, output, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(part);
        }
    }

    private record Probe(String finalUrl, long total, boolean ranges) {}

    /* Пробный запрос одного байта: узнаём конечный URL (после редиректов),
       полный размер и умеет ли сервер Range-докачку. */
    private static Probe probeUrl(String urlString) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = openFollowingRedirects(urlString, "bytes=0-0");
            int code = conn.getResponseCode();
            String finalUrl = conn.getURL().toString();
            if (code == 206) {
                // Content-Range: bytes 0-0/123456789
                String cr = conn.getHeaderField("Content-Range");
                long total = -1;
                if (cr != null) {
                    int slash = cr.lastIndexOf('/');
                    if (slash >= 0) {
                        try { total = Long.parseLong(cr.substring(slash + 1).trim()); }
                        catch (NumberFormatException ignored) {}
                    }
                }
                return new Probe(finalUrl, total, total > 0);
            }
            if (code >= 200 && code < 300) {
                return new Probe(finalUrl, conn.getContentLengthLong(), false);
            }
            throw new IOException("HTTP " + code + " при загрузке " + urlString);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /* Параллельная сегментная загрузка в один файл (позиционные записи через
       общий FileChannel — он потокобезопасен). Каждый сегмент докачивается с
       места обрыва, до 3 попыток. */
    private static void downloadSegmented(Probe p, Path part, Sink sink) throws IOException {
        long total = p.total();
        int segments = (int) Math.max(1, Math.min(MAX_SEGMENTS, total / MIN_SEGMENT_BYTES));
        java.util.concurrent.atomic.AtomicLong done = new java.util.concurrent.atomic.AtomicLong();
        java.util.concurrent.atomic.AtomicInteger lastPct = new java.util.concurrent.atomic.AtomicInteger(-1);
        java.util.concurrent.atomic.AtomicReference<IOException> failure = new java.util.concurrent.atomic.AtomicReference<>();

        try (java.nio.channels.FileChannel ch = java.nio.channels.FileChannel.open(part,
                java.nio.file.StandardOpenOption.CREATE,
                java.nio.file.StandardOpenOption.WRITE,
                java.nio.file.StandardOpenOption.TRUNCATE_EXISTING)) {

            Thread[] workers = new Thread[segments];
            long chunk = total / segments;
            for (int i = 0; i < segments; i++) {
                final long start = i * chunk;
                final long end = (i == segments - 1) ? total - 1 : start + chunk - 1;
                workers[i] = new Thread(() -> {
                    // курсор в массиве: streamRange двигает его ПО МЕРЕ записи, и
                    // при обрыве ретрай продолжает точно с места обрыва (иначе
                    // повторные байты задвоили бы счётчик done)
                    long[] cursor = { start };
                    for (int attempt = 1; attempt <= 3 && failure.get() == null; attempt++) {
                        try {
                            streamRange(p.finalUrl(), cursor, end, ch, done, lastPct, total, sink, failure);
                            if (cursor[0] > end) return; // сегмент докачан
                        } catch (IOException e) {
                            if (attempt == 3) {
                                failure.compareAndSet(null, new IOException(
                                        "сегмент " + start + "-" + end + ": " + e.getMessage(), e));
                            } else {
                                try { Thread.sleep(700L * attempt); } catch (InterruptedException ie) { return; }
                            }
                        }
                    }
                }, "CONTROLGUI-CEF-dl-" + i);
                workers[i].setDaemon(true);
                workers[i].start();
            }
            for (Thread w : workers) {
                try { w.join(); } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("загрузка прервана");
                }
            }
        }
        if (failure.get() != null) throw failure.get();
        if (done.get() != total) {
            throw new IOException("загрузка неполная: " + done.get() + " из " + total + " байт");
        }
    }

    /* Качает диапазон [cursor[0]..end] в канал с позиционной записью, двигая
       cursor[0] по мере записи — при исключении он указывает на место обрыва. */
    private static void streamRange(String url, long[] cursor, long end,
                                    java.nio.channels.FileChannel ch,
                                    java.util.concurrent.atomic.AtomicLong done,
                                    java.util.concurrent.atomic.AtomicInteger lastPct,
                                    long total, Sink sink,
                                    java.util.concurrent.atomic.AtomicReference<IOException> failure) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = openFollowingRedirects(url, "bytes=" + cursor[0] + "-" + end);
            int code = conn.getResponseCode();
            if (code != 206) throw new IOException("HTTP " + code + " (нет Range)");
            byte[] buf = new byte[BUF];
            try (InputStream in = new BufferedInputStream(conn.getInputStream(), BUF)) {
                int n;
                while ((n = in.read(buf)) != -1 && failure.get() == null) {
                    java.nio.ByteBuffer bb = java.nio.ByteBuffer.wrap(buf, 0, n);
                    long pos = cursor[0];
                    while (bb.hasRemaining()) pos += ch.write(bb, pos);
                    cursor[0] = pos;
                    reportDownload(done.addAndGet(n), total, lastPct, sink);
                }
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /* Обычная загрузка одним потоком (сервер без Range). */
    private static void downloadSingle(String url, Path part, Sink sink) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = openFollowingRedirects(url, null);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("HTTP " + code + " при загрузке " + url);
            long total = conn.getContentLengthLong();
            if (total > MAX_ARCHIVE_BYTES) throw new IOException("архив Chromium слишком большой");
            java.util.concurrent.atomic.AtomicInteger lastPct = new java.util.concurrent.atomic.AtomicInteger(-1);
            long read = 0;
            byte[] buf = new byte[BUF];
            try (InputStream in = new BufferedInputStream(conn.getInputStream(), BUF);
                 OutputStream out = new BufferedOutputStream(Files.newOutputStream(part), BUF)) {
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    read += n;
                    if (read > MAX_ARCHIVE_BYTES) throw new IOException("архив Chromium превысил лимит");
                    if (total > 0) reportDownload(read, total, lastPct, sink);
                }
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void reportDownload(long done, long total,
                                       java.util.concurrent.atomic.AtomicInteger lastPct, Sink sink) {
        int pct = (int) (done * 100 / total);
        int prev = lastPct.get();
        if (pct != prev && lastPct.compareAndSet(prev, pct)) {
            sink.status("Загрузка Chromium… " + pct + "%");
            sink.progress(done / (float) total);
        }
    }

    /* GitHub release-ссылки редиректят на objects.githubusercontent.com; JDK не
       переходит между разными протоколами/хостами автоматически на всех сборках —
       ведём цепочку редиректов вручную (до 5). Range передаётся на каждом шаге. */
    private static HttpURLConnection openFollowingRedirects(String urlString, String range) throws IOException {
        String current = urlString;
        for (int i = 0; i < 5; i++) {
            HttpURLConnection conn = (HttpURLConnection) URI.create(current).toURL().openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", "CONTROLGUI-CEF");
            if (range != null) conn.setRequestProperty("Range", range);
            conn.connect();
            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_MOVED_PERM || code == HttpURLConnection.HTTP_MOVED_TEMP
                    || code == HttpURLConnection.HTTP_SEE_OTHER || code == 307 || code == 308) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null) throw new IOException("редирект без Location: " + current);
                current = URI.create(current).resolve(loc).toString();
                continue;
            }
            return conn;
        }
        throw new IOException("слишком много редиректов: " + urlString);
    }

    private static String sha256(Path file) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IOException("нет SHA-256", e);
        }
        byte[] buf = new byte[BUF];
        try (InputStream in = new BufferedInputStream(Files.newInputStream(file), BUF)) {
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        return HexFormat.of().formatHex(md.digest()).toLowerCase(Locale.ROOT);
    }

    /* ── распаковка tar.gz (минимальный ustar/GNU-читатель) ──────────────── */

    /* Считает прочитанные из файла (сжатые) байты — по ним точный прогресс
       распаковки: сжатое читается линейно от 0 до размера архива. */
    private static final class CountingIn extends java.io.FilterInputStream {
        long count;
        CountingIn(InputStream in) { super(in); }
        @Override public int read() throws IOException {
            int b = super.read();
            if (b >= 0) count++;
            return b;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            if (n > 0) count += n;
            return n;
        }
    }

    private static void extractTarGz(Path tarGz, Path outRoot, Sink sink) throws IOException {
        Path root = outRoot.toAbsolutePath().normalize();
        long archiveSize = Math.max(1, Files.size(tarGz));
        long written = 0;
        long lastNote = 0;
        CountingIn counting;
        try (InputStream fin = new BufferedInputStream(Files.newInputStream(tarGz), BUF);
             GZIPInputStream gin = new GZIPInputStream(counting = new CountingIn(fin), BUF)) {
            byte[] header = new byte[512];
            String longName = null;
            // отложенное состояние GNU-sparse (PAX 1.0): macOS-бандл java-cef
            // хранит нативы «разреженными» — реальное имя и размер приходят в
            // 'x'-заголовке, а следующий '0'-блок несёт карту дырок + данные
            String sparseName = null;
            long sparseRealSize = -1;
            while (true) {
                if (!readFully(gin, header, 0, 512)) break; // усечённый архив — считаем концом
                if (isAllZero(header)) break;               // два нулевых блока — конец архива

                long size = parseOctal(header, 124, 12);
                char type = (char) (header[156] & 0xFF);
                String name = longName != null ? longName : parseName(header);
                longName = null;

                if (type == 'L') { // GNU long name — имя лежит в данных этого блока
                    longName = readString(gin, size);
                    skipPadding(gin, size);
                    continue;
                }
                if (type == 'K') { // GNU long link target — нам не нужен, пропускаем
                    skip(gin, size + padding(size));
                    continue;
                }
                if (type == 'x' || type == 'g') { // pax-заголовки
                    byte[] pax = new byte[(int) size];
                    if (!readFully(gin, pax, 0, (int) size)) throw new IOException("усечённый tar (pax)");
                    skipPadding(gin, size);
                    Map<String, String> rec = parsePax(pax);
                    // GNU-sparse 1.0: карта дырок лежит в данных следующего блока
                    if ("1".equals(rec.get("GNU.sparse.major"))) {
                        sparseName = rec.get("GNU.sparse.name");
                        String rs = rec.get("GNU.sparse.realsize");
                        sparseRealSize = rs != null ? Long.parseLong(rs.trim()) : -1;
                    }
                    // pax может переопределять путь и для обычных длинных имён
                    if (rec.containsKey("path") && sparseName == null) longName = rec.get("path");
                    continue;
                }

                // разреженный файл (GNU-sparse 1.0): имя/размер — из 'x', тело — здесь
                if (sparseName != null && (type == '0' || type == '\0')) {
                    Path out = resolveInside(root, sparseName);
                    if (out.getParent() != null) Files.createDirectories(out.getParent());
                    if (Files.isSymbolicLink(out)) Files.delete(out);
                    written += writeSparse(gin, out, size, sparseRealSize);
                    if (written > MAX_EXTRACTED_BYTES) throw new IOException("распаковка Chromium превысила лимит");
                    skipPadding(gin, size);
                    sparseName = null;
                    sparseRealSize = -1;
                    continue;
                }
                sparseName = null;
                sparseRealSize = -1;

                Path out = resolveInside(root, name);
                if (type == '5' || name.endsWith("/")) { // каталог
                    Files.createDirectories(out);
                    continue;
                }
                if (type == '2') { // симлинк (в основном для macOS-бандла)
                    String target = new String(header, 157, 100, StandardCharsets.UTF_8).trim();
                    int nul = target.indexOf('\0');
                    if (nul >= 0) target = target.substring(0, nul);
                    Files.createDirectories(out.getParent());
                    Files.deleteIfExists(out);
                    try {
                        Files.createSymbolicLink(out, out.getFileSystem().getPath(target));
                    } catch (IOException | UnsupportedOperationException ignored) {
                        // ФС без симлинков — не критично для Windows/Linux
                    }
                    continue;
                }
                if (type == '1') { // hardlink — пропускаем данные (их нет)
                    continue;
                }

                // обычный файл
                if (out.getParent() != null) Files.createDirectories(out.getParent());
                if (Files.isSymbolicLink(out)) Files.delete(out); // не пишем сквозь симлинк
                try (OutputStream os = new BufferedOutputStream(Files.newOutputStream(out), BUF)) {
                    long remaining = size;
                    byte[] buf = new byte[BUF];
                    while (remaining > 0) {
                        int want = (int) Math.min(buf.length, remaining);
                        int n = gin.read(buf, 0, want);
                        if (n < 0) throw new IOException("неожиданный конец tar в " + name);
                        os.write(buf, 0, n);
                        remaining -= n;
                        written += n;
                        if (written > MAX_EXTRACTED_BYTES) throw new IOException("распаковка Chromium превысила лимит");
                    }
                }
                skipPadding(gin, size);

                if (written - lastNote > 4L * 1024 * 1024) {
                    lastNote = written;
                    float p = Math.min(0.99f, counting.count / (float) archiveSize);
                    sink.status("Распаковка Chromium… " + (int) (p * 100) + "%");
                    sink.progress(p);
                }
            }
        }
    }

    /* Разбор PAX-записей вида "<len> key=value\n". len — длина всей записи в
       байтах (включая цифры длины, пробел и завершающий \n). */
    private static Map<String, String> parsePax(byte[] data) {
        Map<String, String> out = new HashMap<>();
        int pos = 0;
        int len = data.length;
        while (pos < len) {
            int sp = pos;
            while (sp < len && data[sp] != ' ') sp++;
            if (sp >= len) break;
            int recLen;
            try {
                recLen = Integer.parseInt(new String(data, pos, sp - pos, StandardCharsets.UTF_8).trim());
            } catch (NumberFormatException e) {
                break;
            }
            if (recLen <= 0 || pos + recLen > len) break;
            int contentStart = sp + 1;
            int recEnd = pos + recLen; // указывает за завершающий \n
            int eq = contentStart;
            while (eq < recEnd && data[eq] != '=') eq++;
            if (eq < recEnd) {
                String key = new String(data, contentStart, eq - contentStart, StandardCharsets.UTF_8);
                int valEnd = Math.max(eq + 1, recEnd - 1); // отбрасываем завершающий \n
                String val = new String(data, eq + 1, valEnd - (eq + 1), StandardCharsets.UTF_8);
                out.put(key, val);
            }
            pos = recEnd;
        }
        return out;
    }

    /* Распаковка тела GNU-sparse 1.0: поток начинается с карты дырок
       (ASCII-десятичные числа через \n: сначала N пар, затем 2N чисел
       offset/length), дополненной NUL до границы 512, далее — сами блоки
       данных. Пишем каждый блок по своему смещению в файл размером realSize,
       дырки остаются нулями. Возвращает итоговый размер файла. */
    private static long writeSparse(InputStream in, Path out, long streamSize, long realSize) throws IOException {
        long[] consumed = { 0 };
        long count = readDecimal(in, consumed);
        if (count < 0 || count > 10_000_000) throw new IOException("некорректная sparse-карта: " + count);
        long[] offsets = new long[(int) count];
        long[] lengths = new long[(int) count];
        for (int i = 0; i < count; i++) {
            offsets[i] = readDecimal(in, consumed);
            lengths[i] = readDecimal(in, consumed);
        }
        // карта дополнена нулями до кратности 512
        skip(in, padding(consumed[0]));

        long realLen = realSize >= 0
                ? realSize
                : (count > 0 ? offsets[(int) count - 1] + lengths[(int) count - 1] : 0);

        byte[] buf = new byte[BUF];
        try (RandomAccessFile raf = new RandomAccessFile(out.toFile(), "rw")) {
            raf.setLength(realLen);
            for (int i = 0; i < count; i++) {
                raf.seek(offsets[i]);
                long rem = lengths[i];
                while (rem > 0) {
                    int want = (int) Math.min(buf.length, rem);
                    int n = in.read(buf, 0, want);
                    if (n < 0) throw new IOException("неожиданный конец tar (sparse-данные)");
                    raf.write(buf, 0, n);
                    rem -= n;
                }
            }
        }
        return realLen;
    }

    /* Читает ASCII-десятичное число, завершённое \n; в consumed[0] прибавляет
       число прочитанных байт (включая \n). */
    private static long readDecimal(InputStream in, long[] consumed) throws IOException {
        long value = 0;
        boolean any = false;
        while (true) {
            int b = in.read();
            if (b < 0) throw new IOException("неожиданный конец sparse-карты");
            consumed[0]++;
            if (b == '\n') break;
            if (b >= '0' && b <= '9') {
                value = value * 10 + (b - '0');
                any = true;
            }
        }
        if (!any) throw new IOException("пустое число в sparse-карте");
        return value;
    }

    /* Защита от zip-slip: путь записи обязан лежать внутри корня. */
    private static Path resolveInside(Path root, String entryName) throws IOException {
        String normalized = entryName.replace('\\', '/');
        Path resolved = root.resolve(normalized).normalize();
        if (!resolved.startsWith(root)) throw new IOException("запись tar выходит за каталог: " + entryName);
        return resolved;
    }

    private static String parseName(byte[] header) {
        String name = cstr(header, 0, 100);
        String prefix = cstr(header, 345, 155); // ustar prefix
        return prefix.isEmpty() ? name : prefix + "/" + name;
    }

    private static String cstr(byte[] b, int off, int len) {
        int end = off;
        int limit = off + len;
        while (end < limit && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    private static long parseOctal(byte[] b, int off, int len) {
        long value = 0;
        int i = off;
        int limit = off + len;
        while (i < limit && (b[i] == ' ' || b[i] == 0)) i++;
        while (i < limit && b[i] >= '0' && b[i] <= '7') {
            value = (value << 3) + (b[i] - '0');
            i++;
        }
        return value;
    }

    private static long padding(long size) {
        long rem = size % 512;
        return rem == 0 ? 0 : 512 - rem;
    }

    private static void skipPadding(InputStream in, long size) throws IOException {
        skip(in, padding(size));
    }

    private static String readString(InputStream in, long size) throws IOException {
        byte[] data = new byte[(int) size];
        if (!readFully(in, data, 0, (int) size)) throw new IOException("усечённый tar (longname)");
        String s = new String(data, StandardCharsets.UTF_8);
        int nul = s.indexOf('\0');
        return nul >= 0 ? s.substring(0, nul) : s;
    }

    private static boolean readFully(InputStream in, byte[] buf, int off, int len) throws IOException {
        int got = 0;
        while (got < len) {
            int n = in.read(buf, off + got, len - got);
            if (n < 0) break; // EOF: неполный блок трактуем как конец архива
            got += n;
        }
        return got == len;
    }

    private static void skip(InputStream in, long n) throws IOException {
        long remaining = n;
        byte[] buf = new byte[(int) Math.min(BUF, Math.max(1, remaining))];
        while (remaining > 0) {
            int want = (int) Math.min(buf.length, remaining);
            int r = in.read(buf, 0, want);
            if (r < 0) break;
            remaining -= r;
        }
    }

    private static boolean isAllZero(byte[] b) {
        for (byte value : b) if (value != 0) return false;
        return true;
    }

    private static void deleteRecursively(Path path) {
        try {
            if (!Files.exists(path)) return;
            Files.walk(path)
                    .sorted((a, b) -> b.getNameCount() - a.getNameCount())
                    .forEach(p -> {
                        try { Files.deleteIfExists(p); } catch (IOException ignored) {}
                    });
        } catch (IOException ignored) {
        }
    }
}
