package com.controlgui.mod.cef;

import com.mojang.blaze3d.opengl.GlStateManager;
import com.mojang.blaze3d.systems.RenderSystem;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefBrowserOsr;
import org.cef.callback.CefDragData;
import org.cef.event.CefKeyEvent;
import org.cef.event.CefMouseEvent;
import org.cef.event.CefMouseWheelEvent;
import org.cef.misc.CefCursorType;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.system.MemoryUtil;

import java.awt.Point;
import java.awt.Rectangle;
import java.nio.ByteBuffer;

import static org.lwjgl.glfw.GLFW.GLFW_CURSOR;
import static org.lwjgl.glfw.GLFW.GLFW_CURSOR_HIDDEN;
import static org.lwjgl.glfw.GLFW.GLFW_CURSOR_NORMAL;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_0;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_EQUAL;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_LEFT;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_MINUS;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_R;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_RIGHT;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_RIGHT_ALT;
import static org.lwjgl.glfw.GLFW.GLFW_MOD_ALT;
import static org.lwjgl.glfw.GLFW.GLFW_MOD_CONTROL;
import static org.lwjgl.glfw.GLFW.GLFW_PRESS;
import static org.lwjgl.glfw.GLFW.GLFW_RELEASE;
import static org.lwjgl.opengl.GL11.GL_UNPACK_ROW_LENGTH;
import static org.lwjgl.opengl.GL11.GL_UNPACK_SKIP_PIXELS;
import static org.lwjgl.opengl.GL11.GL_UNPACK_SKIP_ROWS;

/* OSR-браузер Chromium: рендер в текстуру (CgCefRenderer), ввод мыши/клавиатуры,
   курсор, зум и drag&drop. Свой аналог MCEFBrowser — поведение соответствует
   контракту CEF OSR + GL Minecraft, реализация наша. */
public final class CgCefBrowser extends CefBrowserOsr {

    private final CgCefRenderer renderer;
    private final CgDragContext drag = new CgDragContext();
    private boolean browserControls = true;
    private int lastWidth;
    private int lastHeight;
    private int btnMask;
    private boolean rightAltDown;

    // всплывающие элементы (нативные <select> и т.п.)
    private volatile ByteBuffer popupGraphics;
    private volatile Rectangle popupSize;
    private volatile boolean showPopup;
    private volatile boolean popupDrawn;

    CgCefBrowser(CgCefClient client, String url, boolean transparent) {
        super(client.getHandle(), url, transparent, null);
        this.renderer = new CgCefRenderer(transparent);
        if (RenderSystem.isOnRenderThread()) renderer.initialize();
        else Minecraft.getInstance().submit(renderer::initialize);
    }

    public Identifier getTextureIdentifier() {
        return renderer.isTextureReady() ? renderer.textureIdentifier() : null;
    }

    public boolean isTextureReady() {
        return renderer.isTextureReady();
    }

    public CgCefBrowser useBrowserControls(boolean enabled) {
        this.browserControls = enabled;
        return this;
    }

    /* ── попапы ───────────────────────────────────────────────────────────── */

    @Override
    public void onPopupShow(CefBrowser browser, boolean show) {
        super.onPopupShow(browser, show);
        showPopup = show;
    }

    @Override
    public void onPopupSize(CefBrowser browser, Rectangle size) {
        super.onPopupSize(browser, size);
        if (size == null || size.width <= 0 || size.height <= 0) {
            popupSize = null;
            popupGraphics = null;
            popupDrawn = false;
            return;
        }
        popupSize = new Rectangle(size);
        int bytes = bufferSize(size.width, size.height);
        if (bytes <= 0) {
            popupGraphics = null;
            popupDrawn = false;
            return;
        }
        if (popupGraphics == null || popupGraphics.capacity() != bytes) {
            popupGraphics = ByteBuffer.allocateDirect(bytes);
        }
    }

    /* ── рендер ───────────────────────────────────────────────────────────── */

    @Override
    public void onPaint(CefBrowser browser, boolean popup, Rectangle[] dirtyRects, ByteBuffer buffer, int width, int height) {
        if (dirtyRects == null || dirtyRects.length == 0 || buffer == null) return;

        Rectangle[] rects = new Rectangle[dirtyRects.length];
        for (int i = 0; i < dirtyRects.length; i++) {
            rects[i] = dirtyRects[i] == null ? null : new Rectangle(dirtyRects[i]);
        }
        Rectangle popupSnapshot = popupSize == null ? null : new Rectangle(popupSize);
        boolean showPopupSnapshot = showPopup;

        if (RenderSystem.isOnRenderThread()) {
            paintOnRenderThread(popup, rects, buffer, width, height, popupSnapshot, showPopupSnapshot);
            return;
        }
        // CEF-поток: копируем буфер, доставляем на render-поток
        ByteBuffer copy = cloneForAsync(buffer);
        Minecraft.getInstance().submit(() -> {
            try {
                paintOnRenderThread(popup, rects, copy, width, height, popupSnapshot, showPopupSnapshot);
            } finally {
                MemoryUtil.memFree(copy);
            }
        });
    }

    private void paintOnRenderThread(boolean popup, Rectangle[] rects, ByteBuffer buffer,
                                     int width, int height, Rectangle popupRect, boolean showPopupSnapshot) {
        if (!popup) {
            if (lastWidth != width || lastHeight != height) {
                lastWidth = width;
                lastHeight = height;
                renderer.paintFull(buffer, width, height);
                return;
            }
            if (!renderer.supportsDirtyRectUpload()) {
                renderer.paintFull(buffer, width, height);
                if (!showPopupSnapshot) {
                    popupGraphics = null;
                    popupSize = null;
                    popupDrawn = false;
                }
                return;
            }

            GlStateManager._bindTexture(renderer.textureId());
            GlStateManager._pixelStore(GL_UNPACK_ROW_LENGTH, width);
            for (Rectangle rect : rects) {
                Rectangle clipped = clip(rect, width, height);
                if (clipped == null) continue;
                GlStateManager._pixelStore(GL_UNPACK_SKIP_PIXELS, clipped.x);
                GlStateManager._pixelStore(GL_UNPACK_SKIP_ROWS, clipped.y);
                renderer.paintRegion(buffer, clipped.x, clipped.y, clipped.width, clipped.height);
            }

            if ((popupDrawn || showPopupSnapshot) && popupRect != null) {
                Rectangle clippedPopup = clip(popupRect, width, height);
                if (clippedPopup == null) {
                    popupGraphics = null;
                    popupSize = null;
                    popupDrawn = false;
                    return;
                }
                if (!showPopupSnapshot) {
                    GlStateManager._pixelStore(GL_UNPACK_SKIP_PIXELS, clippedPopup.x);
                    GlStateManager._pixelStore(GL_UNPACK_SKIP_ROWS, clippedPopup.y);
                    renderer.paintRegion(buffer, clippedPopup.x, clippedPopup.y, clippedPopup.width, clippedPopup.height);
                    popupGraphics = null;
                    popupSize = null;
                    popupDrawn = false;
                } else if (popupDrawn) {
                    ByteBuffer pop = popupGraphics;
                    int need = bufferSize(popupRect.width, popupRect.height);
                    if (pop == null || need <= 0 || pop.capacity() < need) return;
                    GlStateManager._pixelStore(GL_UNPACK_ROW_LENGTH, popupRect.width);
                    GlStateManager._pixelStore(GL_UNPACK_SKIP_PIXELS, clippedPopup.x - popupRect.x);
                    GlStateManager._pixelStore(GL_UNPACK_SKIP_ROWS, clippedPopup.y - popupRect.y);
                    renderer.paintRegion(pop, clippedPopup.x, clippedPopup.y, clippedPopup.width, clippedPopup.height);
                }
            }
        } else {
            if (popupRect == null || popupRect.width <= 0 || popupRect.height <= 0 || !renderer.supportsDirtyRectUpload()) {
                return;
            }
            GlStateManager._bindTexture(renderer.textureId());
            ByteBuffer pop = popupGraphics;
            int need = bufferSize(popupRect.width, popupRect.height);
            if (need <= 0) {
                popupGraphics = null;
                popupDrawn = false;
                return;
            }
            if (pop == null || pop.capacity() != need) {
                pop = ByteBuffer.allocateDirect(need);
                popupGraphics = pop;
            }
            boolean painted = false;
            for (Rectangle rect : rects) {
                Rectangle clipped = clip(rect, Math.min(width, popupRect.width), Math.min(height, popupRect.height));
                if (clipped == null) continue;
                GlStateManager._pixelStore(GL_UNPACK_ROW_LENGTH, width);
                GlStateManager._pixelStore(GL_UNPACK_SKIP_PIXELS, clipped.x);
                GlStateManager._pixelStore(GL_UNPACK_SKIP_ROWS, clipped.y);
                renderer.paintRegion(buffer, popupRect.x + clipped.x, popupRect.y + clipped.y, clipped.width, clipped.height);
                copyRows(buffer, width, pop, popupRect.width, clipped);
                painted = true;
            }
            popupDrawn = painted;
        }
    }

    private static void copyRows(ByteBuffer src, int srcWidth, ByteBuffer dst, int dstWidth, Rectangle rect) {
        long srcAddr = MemoryUtil.memAddress(src);
        long dstAddr = MemoryUtil.memAddress(dst);
        int bytesPerRow = rect.width << 2;
        for (int row = 0; row < rect.height; row++) {
            int srcOffset = ((rect.y + row) * srcWidth + rect.x) << 2;
            int dstOffset = ((rect.y + row) * dstWidth + rect.x) << 2;
            MemoryUtil.memCopy(srcAddr + srcOffset, dstAddr + dstOffset, bytesPerRow);
        }
    }

    private static Rectangle clip(Rectangle rect, int maxWidth, int maxHeight) {
        if (rect == null || maxWidth <= 0 || maxHeight <= 0) return null;
        int x = Math.max(0, rect.x);
        int y = Math.max(0, rect.y);
        int maxX = Math.min(maxWidth, rect.x + rect.width);
        int maxY = Math.min(maxHeight, rect.y + rect.height);
        int width = maxX - x;
        int height = maxY - y;
        if (width <= 0 || height <= 0) return null;
        return new Rectangle(x, y, width, height);
    }

    private static int bufferSize(int width, int height) {
        if (width <= 0 || height <= 0) return 0;
        long size = (long) width * height * 4L;
        return size <= 0 || size > Integer.MAX_VALUE ? 0 : (int) size;
    }

    private static ByteBuffer cloneForAsync(ByteBuffer source) {
        ByteBuffer slice = source.duplicate();
        slice.clear();
        ByteBuffer copy = MemoryUtil.memAlloc(slice.remaining());
        copy.put(slice);
        copy.flip();
        return copy;
    }

    public void resize(int width, int height) {
        browser_rect_.setBounds(0, 0, width, height);
        wasResized(width, height);
    }

    /* ── ввод ─────────────────────────────────────────────────────────────── */

    public void sendKeyPress(int keyCode, long scanCode, int modifiers) {
        if (keyCode == GLFW_KEY_RIGHT_ALT) rightAltDown = true;
        int mods = normalizeAltGr(modifiers);
        if (browserControls && handleShortcut(keyCode, mods)) return;
        CefKeyEvent e = new CefKeyEvent(CefKeyEvent.KEY_PRESS, keyCode, (char) keyCode, mods);
        e.scancode = scanCode;
        sendKeyEvent(e);
    }

    public void sendKeyRelease(int keyCode, long scanCode, int modifiers) {
        int mods = normalizeAltGr(modifiers);
        if (browserControls && isShortcut(keyCode, mods)) {
            if (keyCode == GLFW_KEY_RIGHT_ALT) rightAltDown = false;
            return;
        }
        CefKeyEvent e = new CefKeyEvent(CefKeyEvent.KEY_RELEASE, keyCode, (char) keyCode, mods);
        e.scancode = scanCode;
        sendKeyEvent(e);
        if (keyCode == GLFW_KEY_RIGHT_ALT) rightAltDown = false;
    }

    public void sendKeyTyped(char c, int modifiers) {
        int mods = normalizeAltGr(modifiers);
        if (browserControls && isShortcut(c, mods)) return;
        CefKeyEvent e = new CefKeyEvent(CefKeyEvent.KEY_TYPE, c, c, mods);
        sendKeyEvent(e);
    }

    /* Возвращает true, если нажатие обработано как «браузерный» хоткей. */
    private boolean handleShortcut(int keyCode, int mods) {
        if (mods == GLFW_MOD_CONTROL) {
            switch (keyCode) {
                case GLFW_KEY_R -> { reload(); return true; }
                case GLFW_KEY_EQUAL -> { if (getZoomLevel() < 9) setZoomLevel(getZoomLevel() + 1); return true; }
                case GLFW_KEY_MINUS -> { if (getZoomLevel() > -9) setZoomLevel(getZoomLevel() - 1); return true; }
                case GLFW_KEY_0 -> { setZoomLevel(0); return true; }
                default -> { return false; }
            }
        } else if (mods == GLFW_MOD_ALT) {
            if (keyCode == GLFW_KEY_LEFT && canGoBack()) { goBack(); return true; }
            if (keyCode == GLFW_KEY_RIGHT && canGoForward()) { goForward(); return true; }
        }
        return false;
    }

    private boolean isShortcut(int keyCode, int mods) {
        if (mods == GLFW_MOD_CONTROL) {
            return keyCode == GLFW_KEY_R || keyCode == GLFW_KEY_EQUAL
                    || keyCode == GLFW_KEY_MINUS || keyCode == GLFW_KEY_0;
        }
        if (mods == GLFW_MOD_ALT) {
            return (keyCode == GLFW_KEY_LEFT && canGoBack()) || (keyCode == GLFW_KEY_RIGHT && canGoForward());
        }
        return false;
    }

    /* GLFW на многих раскладках сообщает AltGr как Ctrl+Alt — снимаем это, чтобы
       не глотать ввод символов правым Alt. */
    private int normalizeAltGr(int modifiers) {
        if (rightAltDown && (modifiers & GLFW_MOD_ALT) == 0) rightAltDown = false;
        if (!rightAltDown) return modifiers;
        if ((modifiers & GLFW_MOD_CONTROL) == 0 || (modifiers & GLFW_MOD_ALT) == 0) return modifiers;
        return modifiers & ~(GLFW_MOD_CONTROL | GLFW_MOD_ALT);
    }

    public void sendMouseMove(int mouseX, int mouseY) {
        CefMouseEvent e = new CefMouseEvent(CefMouseEvent.MOUSE_MOVED, mouseX, mouseY, 0, 0, drag.virtualModifiers(btnMask));
        sendMouseEvent(e);
        if (drag.isDragging()) dragTargetDragOver(new Point(mouseX, mouseY), 0, drag.mask());
    }

    // число кликов последнего нажатия — тем же значением помечаем отпускание,
    // иначе CEF не синтезирует dblclick в DOM (двойной клик не срабатывает)
    private int pressClickCount = 1;

    public void sendMousePress(int mouseX, int mouseY, int button) {
        sendMousePress(mouseX, mouseY, button, 1);
    }

    /* clickCount: 1 — обычный клик, 2 — двойной (Minecraft сам определяет по
       таймингу и отдаёт в mouseClicked). Без корректного clickCount страница
       не получает событие dblclick — не открывались окна по двойному клику. */
    public void sendMousePress(int mouseX, int mouseY, int button, int clickCount) {
        button = swapMiddleRight(button);
        if (button == 0) btnMask |= CefMouseEvent.BUTTON1_MASK;
        else if (button == 1) btnMask |= CefMouseEvent.BUTTON2_MASK;
        else if (button == 2) btnMask |= CefMouseEvent.BUTTON3_MASK;
        pressClickCount = clickCount < 1 ? 1 : clickCount;
        sendMouseEvent(new CefMouseEvent(GLFW_PRESS, mouseX, mouseY, pressClickCount, button, btnMask));
    }

    public void sendMouseRelease(int mouseX, int mouseY, int button) {
        button = swapMiddleRight(button);
        if (button == 0 && (btnMask & CefMouseEvent.BUTTON1_MASK) != 0) btnMask ^= CefMouseEvent.BUTTON1_MASK;
        else if (button == 1 && (btnMask & CefMouseEvent.BUTTON2_MASK) != 0) btnMask ^= CefMouseEvent.BUTTON2_MASK;
        else if (button == 2 && (btnMask & CefMouseEvent.BUTTON3_MASK) != 0) btnMask ^= CefMouseEvent.BUTTON3_MASK;
        sendMouseEvent(new CefMouseEvent(GLFW_RELEASE, mouseX, mouseY, pressClickCount, button, btnMask));
        if (drag.isDragging() && button == 0) finishDragging(mouseX, mouseY);
    }

    private static int swapMiddleRight(int button) {
        // в MC средняя и правая кнопки поменяны местами относительно CEF
        if (button == 1) return 2;
        if (button == 2) return 1;
        return button;
    }

    public void sendMouseWheel(int mouseX, int mouseY, double amount, int modifiers) {
        if (browserControls && (modifiers & GLFW_MOD_CONTROL) != 0) {
            if (amount > 0) { if (getZoomLevel() < 9) setZoomLevel(getZoomLevel() + 1); }
            else if (getZoomLevel() > -9) setZoomLevel(getZoomLevel() - 1);
            return;
        }
        if (!CgCefPlatform.detect().isMacOS()) {
            amount = amount < 0 ? Math.floor(amount) : Math.ceil(amount);
            amount *= 3;
        }
        sendMouseWheelEvent(new CefMouseWheelEvent(CefMouseWheelEvent.WHEEL_UNIT_SCROLL, mouseX, mouseY, amount, modifiers));
    }

    /* ── drag&drop ────────────────────────────────────────────────────────── */

    @Override
    public boolean startDragging(CefBrowser browser, CefDragData dragData, int mask, int x, int y) {
        drag.start(dragData, mask);
        dragTargetDragEnter(drag.dragData(), new Point(x, y), btnMask, drag.mask());
        return false; // OSR — нативный drag не работает, ведём сами
    }

    @Override
    public void updateDragCursor(CefBrowser browser, int operation) {
        if (drag.updateCursor(operation)) {
            onCursorChange(this, drag.virtualCursor(drag.actualCursor()));
        }
        super.updateDragCursor(browser, operation);
    }

    public void finishDragging(int x, int y) {
        dragTargetDrop(new Point(x, y), btnMask);
        dragTargetDragLeave();
        drag.stop();
        onCursorChange(this, drag.actualCursor());
    }

    /* Прерывает незавершённое перетаскивание и сбрасывает состояние кнопок.
       Нужно при закрытии панели (Esc) посреди drag: иначе нативный CefDragData
       утекает, а btnMask «залипает» и ломает ввод при следующем открытии. */
    public void cancelDrag() {
        if (drag.isDragging()) {
            try { dragTargetDragLeave(); } catch (Throwable ignored) {}
            drag.stop();
        }
        btnMask = 0;
    }

    /* ── курсор ───────────────────────────────────────────────────────────── */

    @Override
    public boolean onCursorChange(CefBrowser browser, int cursorType) {
        cursorType = drag.virtualCursor(cursorType);
        setCursor(resolveCursor(cursorType));
        return super.onCursorChange(browser, cursorType);
    }

    public void setCursor(CefCursorType cursorType) {
        long window = Minecraft.getInstance().getWindow().handle();
        if (cursorType == CefCursorType.NONE) {
            GLFW.glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_HIDDEN);
        } else {
            GLFW.glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
            GLFW.glfwSetCursor(window, CgCef.glfwCursorHandle(cursorType));
        }
    }

    private static CefCursorType resolveCursor(int cursorId) {
        CefCursorType[] all = CefCursorType.values();
        return cursorId < 0 || cursorId >= all.length ? CefCursorType.POINTER : all[cursorId];
    }

    /* ── закрытие ─────────────────────────────────────────────────────────── */

    public void close() {
        cleanupOnRenderThread();
        super.close(true);
    }

    private void cleanupOnRenderThread() {
        if (RenderSystem.isOnRenderThread()) {
            renderer.cleanup();
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        if (mc == null || !mc.isRunning()) return;
        try {
            mc.submit(renderer::cleanup).join();
        } catch (Throwable ignored) {
        }
    }
}
