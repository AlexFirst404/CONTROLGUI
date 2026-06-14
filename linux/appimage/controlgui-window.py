#!/usr/bin/env python3
# Нативное окно WebKitGTK для AppImage. URL и иконку берёт из окружения
# (CONTROLGUI_URL, CONTROLGUI_ICON), чтобы работать из любого каталога.
import os
import gi
gi.require_version('Gtk', '3.0')
try:
    gi.require_version('WebKit2', '4.1')
except ValueError:
    gi.require_version('WebKit2', '4.0')
from gi.repository import Gtk, WebKit2  # noqa: E402

URL = os.environ.get('CONTROLGUI_URL', 'http://127.0.0.1:8400')
ICON = os.environ.get('CONTROLGUI_ICON', '')

win = Gtk.Window()
win.set_title('CONTROLGUI — панель Minecraft-серверов')
win.set_default_size(1380, 900)
try:
    win.set_wmclass('CONTROLGUI', 'CONTROLGUI')
except Exception:
    pass
if ICON and os.path.exists(ICON):
    try:
        win.set_icon_from_file(ICON)
    except Exception:
        pass

web = WebKit2.WebView()
web.load_uri(URL)
win.add(web)
win.connect('destroy', Gtk.main_quit)
win.show_all()
Gtk.main()
