package com.controlgui.mod;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
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

    /* Зовётся в конце клиентского тика из энтрипоинтов лоадеров. */
    public static void tick(Minecraft mc) {
        while (OPEN.consumeClick()) {
            if (mc.screen == null) mc.setScreen(new PanelScreen());
        }
    }
}
