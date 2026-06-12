using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace ControlGui.Desktop;

/// <summary>
/// Находит и при необходимости запускает локальную панель CONTROLGUI
/// (node server.js). Панель и все её данные — те же, что у веб-версии.
/// </summary>
public sealed class PanelLauncher
{
    public sealed record Config(string PanelPath, int Port, bool StopNodeOnExit)
    {
        public static Config Default { get; } = new(@"D:\CONRTOLGUI", 8400, false);
    }

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMilliseconds(1500) };

    private Process? _node;

    public Config Settings { get; }

    public string PanelUrl => $"http://localhost:{Settings.Port}/";

    /// <summary>true, если node запущен этим приложением (а не работал заранее)</summary>
    public bool StartedByUs { get; private set; }

    public PanelLauncher()
    {
        Settings = LoadConfig();
    }

    /// <summary>config.json рядом с exe; создаётся с настройками по умолчанию</summary>
    private static Config LoadConfig()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "config.json");
        try
        {
            if (File.Exists(path))
            {
                var loaded = JsonSerializer.Deserialize<Config>(File.ReadAllText(path),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (loaded is { PanelPath.Length: > 0 }) return loaded;
            }
            else
            {
                File.WriteAllText(path, JsonSerializer.Serialize(Config.Default,
                    new JsonSerializerOptions { WriteIndented = true }));
            }
        }
        catch
        {
            // конфиг повреждён или нет прав — работаем с настройками по умолчанию
        }

        var env = Environment.GetEnvironmentVariable("CONTROLGUI_HOME");
        return string.IsNullOrWhiteSpace(env) ? Config.Default : Config.Default with { PanelPath = env };
    }

    public async Task<bool> IsPanelAliveAsync()
    {
        try
        {
            using var response = await Http.GetAsync(PanelUrl + "api/status");
            // 200 — открытая панель; 401 — панель под паролем (требует входа),
            // но УЖЕ работает на этом порту, поэтому второй node запускать нельзя
            return response.IsSuccessStatusCode
                || response.StatusCode == System.Net.HttpStatusCode.Unauthorized;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Гарантирует работающую панель: переиспользует уже запущенную или
    /// стартует node server.js из каталога панели. Бросает исключение с
    /// человекочитаемым сообщением, если запуск невозможен.
    /// </summary>
    public async Task EnsurePanelAsync(IProgress<string>? progress = null)
    {
        if (await IsPanelAliveAsync())
        {
            progress?.Report("Панель уже запущена — подключаюсь…");
            return;
        }

        var serverJs = Path.Combine(Settings.PanelPath, "server.js");
        if (!File.Exists(serverJs))
        {
            throw new InvalidOperationException(
                $"Не найден файл панели:\n{serverJs}\n\n" +
                "Укажите каталог панели CONTROLGUI в config.json (поле panelPath) рядом с программой.");
        }

        progress?.Report("Запускаю панель (node server.js)…");
        var startInfo = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = "server.js",
            WorkingDirectory = Settings.PanelPath,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.Environment["PORT"] = Settings.Port.ToString();

        try
        {
            _node = Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                "Не удалось запустить node. Установите Node.js 18+ (https://nodejs.org) " +
                "и убедитесь, что node есть в PATH.\n\n" + ex.Message);
        }

        StartedByUs = true;

        for (var attempt = 0; attempt < 40; attempt++)
        {
            if (_node is { HasExited: true })
            {
                throw new InvalidOperationException(
                    $"Процесс панели завершился сразу после запуска (код {_node.ExitCode}). " +
                    $"Проверьте каталог {Settings.PanelPath} — возможно, порт {Settings.Port} занят.");
            }
            if (await IsPanelAliveAsync()) return;
            await Task.Delay(500);
        }

        throw new TimeoutException("Панель не ответила за 20 секунд. Проверьте её вручную: " + PanelUrl);
    }

    /// <summary>
    /// По умолчанию панель остаётся работать после закрытия окна — так
    /// Minecraft-серверы продолжают жить. stopNodeOnExit=true в config.json
    /// завершает node вместе с приложением.
    /// </summary>
    public void Shutdown()
    {
        if (!Settings.StopNodeOnExit || !StartedByUs) return;
        try
        {
            if (_node is { HasExited: false }) _node.Kill(entireProcessTree: false);
        }
        catch
        {
            // процесс уже завершился
        }
    }
}
