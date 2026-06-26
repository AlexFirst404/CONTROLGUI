# CONTROLGUI для macOS (.dmg)

Сборка `.app` + `.dmg` с встроенным Node — пользователю **ничего ставить не нужно**.
Панель поднимается локально и открывается в браузере (или в отдельном окне
Chrome/Edge, если они установлены). Данные серверов хранятся в
`~/Library/Application Support/CONTROLGUI` (вне самого приложения).

## Сборка

Запускать **на macOS** (нужен `hdiutil` из системы):

```sh
sh mac/build-dmg.sh           # версия 1.3.0 по умолчанию
sh mac/build-dmg.sh 1.3.0     # явная версия
```

Скрипт сам определит архитектуру (Apple Silicon `arm64` / Intel `x64`),
скачает соответствующий `node-darwin`, соберёт `CONTROLGUI.app` и упакует в
`CONTROLGUI-<версия>-macos-<arch>.dmg`. Иконка генерируется из
`public/assets/controlgui.png`, если есть `sips`/`iconutil`.

CI: ветка `mac-dmg`, workflow **Build macOS DMG** (`.github/workflows/dmg.yml`)
собирает оба варианта (arm64 + Intel) и прикрепляет к релизу.

## Установка и первый запуск (Gatekeeper)

Приложение **не нотаризовано** (подпись ad-hoc), поэтому при первом запуске
macOS покажет предупреждение «не удаётся проверить разработчика». Варианты:

1. Перетащить `CONTROLGUI.app` из `.dmg` в `Applications`, затем
   **правый клик по приложению → «Открыть» → «Открыть»** (один раз).
2. Или снять карантин в терминале:
   `xattr -dr com.apple.quarantine /Applications/CONTROLGUI.app`

Для «бесшовного» запуска без предупреждений нужна платная подпись Apple
Developer ID + нотаризация (`codesign` Developer ID + `notarytool`).
