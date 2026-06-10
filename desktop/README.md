# CONTROLGUI Desktop

Нативное Windows-приложение (WPF + WebView2) — обёртка локальной панели
управления Minecraft-серверами **CONTROLGUI**. Использует ту же панель,
тот же интерфейс и те же данные, что и веб-версия: при запуске приложение
само поднимает `node server.js` из каталога панели (если она ещё не
запущена) и открывает её в нативном окне.

## Запуск из Rider

1. Откройте `CONTROLGUI.Desktop.sln` в JetBrains Rider.
2. Соберите и запустите (F5 / Run). Требуется .NET SDK 9 и Node.js 18+.
3. WebView2 Runtime обычно уже установлен в Windows 10/11 (Edge).

## Конфигурация

Рядом с exe создаётся `config.json`:

```json
{
  "PanelPath": "D:\\CONRTOLGUI",   // каталог панели (server.js)
  "Port": 8400,                     // порт панели
  "StopNodeOnExit": false           // глушить ли node при закрытии окна
}
```

Путь также можно задать переменной окружения `CONTROLGUI_HOME`.

По умолчанию `StopNodeOnExit: false` — при закрытии окна панель (и все
запущенные Minecraft-серверы) продолжают работать в фоне; повторное
открытие приложения просто подключается к ним.

## Структура

```
CONTROLGUI.Desktop.sln
CONTROLGUI.Desktop/
  App.xaml(.cs)          — точка входа WPF
  MainWindow.xaml(.cs)   — окно: заставка + WebView2, внешние ссылки в браузер
  PanelLauncher.cs       — поиск/запуск панели, конфиг, ожидание готовности
  app.manifest           — PerMonitorV2 DPI (чёткий рендер на HiDPI)
```

Код панели живёт в основном репозитории CONTROLGUI (ветка `main`);
этот проект — ветка `desktop-app` (каталог `desktop/`).
