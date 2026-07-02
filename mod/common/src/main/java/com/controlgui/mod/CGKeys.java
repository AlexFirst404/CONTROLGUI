package com.controlgui.mod;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractTextAreaWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractSignEditScreen;
import net.minecraft.client.gui.screens.inventory.BookEditScreen;
import net.minecraft.client.input.KeyEvent;
import org.lwjgl.glfw.GLFW;

/* Горячая клавиша открытия панели (по умолчанию O, меняется в настройках
   управления). Общая для обоих лоадеров; регистрируется каждым по-своему. */
public final class CGKeys {

    public static final KeyMapping OPEN = new KeyMapping(
            "key." + Constants.MOD_ID + ".open",
            InputConstants.Type.KEYSYM,
            GLFW.GLFW_KEY_O,
            KeyMapping.Category.MISC);

    private CGKeys() {}

    /* Зовётся в конце клиентского тика из энтрипоинтов лоадеров (в игре). */
    public static void tick(Minecraft mc) {
        while (OPEN.consumeClick()) {
            if (mc.screen == null) mc.setScreen(new PanelScreen());
        }
    }

    /* Открывать ли панель по нажатию клавиши в ЧУЖОМ экране (главное меню,
       пауза и т.п.). Не срабатываем, когда пользователь набирает текст:
       клавиша по умолчанию — буква O, перехватывать её в поиске креатива
       или редакторе книги значит ломать ввод (а в книге — терять текст). */
    public static boolean shouldOpenFrom(Screen screen, KeyEvent event) {
        if (screen instanceof PanelScreen) return false;
        if (!OPEN.matches(event)) return false;
        GuiEventListener focused = screen.getFocused();
        if (focused instanceof EditBox || focused instanceof AbstractTextAreaWidget) return false;
        // креатив-поиск ставит фокус только на самом виджете, не на экране
        for (GuiEventListener child : screen.children()) {
            if (child instanceof EditBox box && box.isFocused()) return false;
        }
        // книга и табличка принимают текст без обычных виджетов
        if (screen instanceof BookEditScreen || screen instanceof AbstractSignEditScreen) return false;
        return true;
    }
}
