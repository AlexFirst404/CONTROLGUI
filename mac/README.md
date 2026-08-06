# CONTROLGUI для macOS (.pkg)

Сборка `.app` + `.pkg`-установщика с встроенным Node — пользователю **ничего
ставить не нужно**. Установщик кладёт `CONTROLGUI.app` в `/Applications`. Панель
поднимается локально и открывается в браузере (или в отдельном окне Chrome/Edge,
если они установлены). Данные серверов хранятся в
`~/Library/Application Support/CONTROLGUI` (вне самого приложения).

## Сборка

Запускать **на macOS** (нужен `pkgbuild` из системы):

```sh
sh mac/build-pkg.sh           # версия 2.4.0 по умолчанию
sh mac/build-pkg.sh 2.4.0     # явная версия
```

Скрипт сам определит архитектуру (Apple Silicon `arm64` / Intel `x64`),
скачает соответствующий `node-darwin`, соберёт `CONTROLGUI.app` и упакует в
`CONTROLGUI-<версия>-macos-<arch>.pkg`. Иконка генерируется из
`public/assets/controlgui.png`, если есть `sips`/`iconutil`.

CI: ветка `mac-dmg`, workflow **Build macOS PKG** (`.github/workflows/pkg.yml`)
собирает оба варианта (arm64 + Intel) и прикрепляет к релизу.

## Установка и первый запуск (Gatekeeper)

Установщик **не нотаризован** (подпись ad-hoc), поэтому при первом запуске
macOS может предупредить, что разработчик не проверён. Варианты:

1. Двойной клик по `.pkg` → пройти установщик. Если Gatekeeper блокирует:
   **System Settings → Privacy & Security → «Open Anyway»**, либо правый клик
   по `.pkg` → «Open».
2. Или установить из терминала: `sudo installer -pkg CONTROLGUI-*.pkg -target /`
3. Снять карантин с приложения: `xattr -dr com.apple.quarantine /Applications/CONTROLGUI.app`

Для «бесшовной» установки без предупреждений нужна платная подпись Apple
Developer ID + нотаризация (`productsign` Developer ID Installer + `notarytool`).
