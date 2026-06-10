@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден. Установите его с https://nodejs.org ^(версия 18 или новее^).
  pause
  exit /b 1
)

echo Запускаю панель CONTROLGUI...
start "" http://localhost:8400
node server.js
pause
