package com.controlgui.mod.cef;

import org.cef.callback.CefDragData;
import org.cef.misc.CefCursorType;

/* Состояние перетаскивания (drag&drop) внутри OSR-браузера. При активном
   перетаскивании курсор задаёт не страница, а разрешённая операция; кнопки
   мыши при этом эмулируются «отпущенными», чтобы не выделять текст. Свой
   аналог MCEFDragContext. */
final class CgDragContext {
    private CefDragData dragData;
    private int dragMask;
    private int cursorOverride = -1;
    private int actualCursor = -1;

    int virtualModifiers(int btnMask) {
        return dragData != null ? 0 : btnMask;
    }

    int virtualCursor(int cursorType) {
        actualCursor = cursorType;
        return cursorOverride != -1 ? cursorOverride : cursorType;
    }

    boolean isDragging() {
        return dragData != null;
    }

    CefDragData dragData() {
        return dragData;
    }

    int mask() {
        return dragMask;
    }

    int actualCursor() {
        return actualCursor;
    }

    void start(CefDragData data, int mask) {
        this.dragData = data;
        this.dragMask = mask;
    }

    void stop() {
        if (dragData != null) dragData.dispose();
        dragData = null;
        dragMask = 0;
        cursorOverride = -1;
    }

    /* true, если курсор перетаскивания изменился и его надо переустановить. */
    boolean updateCursor(int operation) {
        if (dragData == null) return false;
        int previous = cursorOverride;
        switch (operation) {
            case 0 -> cursorOverride = CefCursorType.NO_DROP.ordinal();
            case 1 -> cursorOverride = CefCursorType.COPY.ordinal();
            case 16 -> cursorOverride = CefCursorType.MOVE.ordinal();
            default -> cursorOverride = -1;
        }
        return previous != cursorOverride && cursorOverride != -1;
    }
}
