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

            // ---- блокировка браузерных функций (kiosk-режим) ----
            var s = Web.CoreWebView2.Settings;
            s.AreDevToolsEnabled = false;             // F12 / Ctrl+Shift+I не открывают DevTools
            s.AreBrowserAcceleratorKeysEnabled = false; // F12, Ctrl+R, Ctrl+F, Ctrl+P, Ctrl+± и т.п.
            s.AreDefaultContextMenusEnabled = false;  // правый клик — без меню «Назад/Обновить/...»
            s.IsZoomControlEnabled = false;           // Ctrl+колесо и Ctrl+± не меняют масштаб
            s.IsStatusBarEnabled = false;             // нижняя полоса со ссылками
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            // на всякий случай гасим F5/Ctrl-R/F12 и на уровне DOM (до их обработки браузером)
            Web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
                window.addEventListener('keydown', function (e) {
                  var k = (e.key || '').toLowerCase();
                  if (k === 'f5' || k === 'f12'
                      || (e.ctrlKey && (k === 'r' || k === 'p' || k === 'u' || k === 'j'))
                      || ((e.ctrlKey && e.shiftKey) && (k === 'i' || k === 'j' || k === 'c' || k === 'r'))) {
                    e.preventDefault(); e.stopPropagation();
                  }
                }, true);
                window.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);
            ");

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

    // ---- кастомный тайтлбар ----

    private void OnMinimize(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void OnMaximizeRestore(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;
    }

    private void OnCloseWindow(object sender, RoutedEventArgs e)
    {
        Close();
    }

    /// <summary>
    /// Безрамочное окно при разворачивании вылезает за края экрана на толщину
    /// рамки ресайза — компенсируем отступом; заодно меняем глиф кнопки.
    /// </summary>
    private void OnStateChanged(object? sender, EventArgs e)
    {
        var maximized = WindowState == WindowState.Maximized;
        Root.Margin = maximized ? new Thickness(7) : new Thickness(0);
        BtnMax.ToolTip = maximized ? "Восстановить" : "Развернуть";
        IcMax.Visibility = maximized ? Visibility.Collapsed : Visibility.Visible;
        IcRestore.Visibility = maximized ? Visibility.Visible : Visibility.Collapsed;
    }
}
