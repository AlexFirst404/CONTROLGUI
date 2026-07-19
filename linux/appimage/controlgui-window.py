#!/usr/bin/env python3
# Нативное окно WebKitGTK для AppImage. URL и иконку берёт из окружения
# (CONTROLGUI_URL, CONTROLGUI_ICON), чтобы работать из любого каталога.
import os
# Программный рендерер WebKitGTK: без этого на части систем (VM, Wayland,
# некоторые GPU-драйверы) падает "Failed to create GBM buffer" и окно
# остаётся пустым. setdefault — можно переопределить через окружение.
os.environ.setdefault('WEBKIT_DISABLE_DMABUF_RENDERER', '1')
os.environ.setdefault('WEBKIT_DISABLE_COMPOSITING_MODE', '1')
import gi
gi.require_version('Gtk', '3.0')
try:
    gi.require_version('WebKit2', '4.1')
except ValueError:
    gi.require_version('WebKit2', '4.0')
from gi.repository import Gtk, WebKit2, GLib  # noqa: E402

# WM_CLASS для группировки/иконки в панели задач — без устаревшего set_wmclass
GLib.set_prgname('CONTROLGUI')

URL = os.environ.get('CONTROLGUI_URL', 'http://127.0.0.1:8400')
ICON = os.environ.get('CONTROLGUI_ICON', '')
# клиент-режим (controlgui connect <url>): удалённая панель с самоподписанным сертом
REMOTE = os.environ.get('CONTROLGUI_REMOTE', '0') == '1'

win = Gtk.Window()
win.set_title('CONTROLGUI — панель Minecraft-серверов' + (' (удалённо)' if REMOTE else ''))
win.set_default_size(1380, 900)
if ICON and os.path.exists(ICON):
    try:
        win.set_icon_from_file(ICON)
    except Exception:
        pass

web = WebKit2.WebView()

if REMOTE and URL.startswith('https://'):
    # Самоподписанный серт удалённой панели: TOFU-пин отпечатка (SHA-256 DER).
    # Первый раз — спрашиваем пользователя и запоминаем; дальше принимаем ТОЛЬКО
    # тот же серт (молча игнорировать все TLS-ошибки было бы небезопасно).
    import hashlib
    import json
    from urllib.parse import urlsplit
    data_dir = os.environ.get('CONTROLGUI_DATA', os.path.expanduser('~/.local/share/controlgui'))
    pins_path = os.path.join(data_dir, 'gui-known-hosts.json')
    host = urlsplit(URL).hostname or ''
    port = urlsplit(URL).port or 8433
    key = '%s:%s' % (host, port)

    def load_pins():
        try:
            with open(pins_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}

    def save_pin(fp):
        pins = load_pins()
        pins[key] = fp
        os.makedirs(data_dir, exist_ok=True)
        with open(pins_path, 'w', encoding='utf-8') as f:
            json.dump(pins, f, indent=2)

    def on_tls_error(_web, failing_uri, certificate, errors):
        try:
            der = certificate.props.certificate.get_data()
            fp = hashlib.sha256(bytes(der)).hexdigest()
        except Exception:
            return False  # не смогли прочитать серт — показываем стандартную ошибку
        pins = load_pins()
        known = pins.get(key)
        if known == fp:
            allow = True
        elif known is None:
            dlg = Gtk.MessageDialog(transient_for=win, flags=0, message_type=Gtk.MessageType.QUESTION,
                                    buttons=Gtk.ButtonsType.YES_NO, text='Первое подключение к ' + key)
            dlg.format_secondary_text('Отпечаток сертификата (SHA-256):\n' + fp +
                                      '\n\nСверьте с показанным в панели (Настройки → Удалённый доступ). Доверять?')
            allow = dlg.run() == Gtk.ResponseType.YES
            dlg.destroy()
            if allow:
                save_pin(fp)
        else:
            dlg = Gtk.MessageDialog(transient_for=win, flags=0, message_type=Gtk.MessageType.ERROR,
                                    buttons=Gtk.ButtonsType.OK, text='ОТПЕЧАТОК СЕРТИФИКАТА ИЗМЕНИЛСЯ')
            dlg.format_secondary_text('Ожидался:\n%s\n\nПолучен:\n%s\n\nЕсли вы перевыпускали серт — удалите строку в %s и подключитесь заново.' % (known, fp, pins_path))
            dlg.run()
            dlg.destroy()
            allow = False
        if allow:
            web.get_context().allow_tls_certificate_for_host(certificate, host)
            web.load_uri(URL)  # повторная загрузка уже с разрешённым сертом
        return True  # ошибку обработали сами

    web.connect('load-failed-with-tls-errors', on_tls_error)

web.load_uri(URL)
win.add(web)
win.connect('destroy', Gtk.main_quit)
win.show_all()
Gtk.main()
