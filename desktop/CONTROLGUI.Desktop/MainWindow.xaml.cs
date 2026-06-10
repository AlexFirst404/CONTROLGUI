using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace ControlGui.Desktop;

public partial class MainWindow : Window
{
    private readonly PanelLauncher _launcher = new();

    public MainWindow()
    {
        InitializeComponent();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        var progress = new Progress<string>(text => SplashText.Text = text);
        try
        {
            await _launcher.EnsurePanelAsync(progress);

            SplashText.Text = "Открываю интерфейс…";
            var dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CONTROLGUI", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataDir);
            await Web.EnsureCoreWebView2Async(environment);

            // внешние ссылки (EULA, adoptium и т.п.) — в системный браузер
            Web.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                TryOpenInBrowser(args.Uri);
            };
            Web.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (args.Uri is { } uri && !uri.StartsWith(_launcher.PanelUrl, StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    TryOpenInBrowser(uri);
                }
            };
            Web.CoreWebView2.DocumentTitleChanged += (_, _) =>
                Title = Web.CoreWebView2.DocumentTitle is { Length: > 0 } t
                    ? t
                    : "CONTROLGUI — Панель Minecraft-серверов";

            Web.Source = new Uri(_launcher.PanelUrl);
            Web.Visibility = Visibility.Visible;
            Splash.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            SplashBar.Visibility = Visibility.Collapsed;
            SplashText.Text = ex.Message;
            MessageBox.Show(this, ex.Message, "CONTROLGUI — ошибка запуска",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private static void TryOpenInBrowser(string uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch
        {
            // нет обработчика — молча игнорируем
        }
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        _launcher.Shutdown();
    }
}
