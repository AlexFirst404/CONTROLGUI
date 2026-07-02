package com.controlgui.mod.mixin;

import com.controlgui.mod.cef.CgCef;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.util.ARGB;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/* Индикатор подготовки встроенного Chromium в главном меню: загрузка
   начинается сразу при старте игры, и пользователь видит прогресс ещё до
   первого открытия панели (иначе кажется, что ничего не происходит). */
@Mixin(TitleScreen.class)
public abstract class TitleScreenMixin extends Screen {

    protected TitleScreenMixin(Component title) {
        super(title);
    }

    @Inject(method = "render", at = @At("TAIL"))
    private void controlgui$cefProgress(GuiGraphics g, int mouseX, int mouseY, float partialTick, CallbackInfo ci) {
        boolean busy = CgCef.busy();
        boolean failed = CgCef.isFailed();
        if (!busy && !failed) return;

        int x = 10;
        int barW = 170;
        int barH = 6;
        int y = this.height - 22;

        String text = CgCef.statusText();
        if (text == null || text.isEmpty()) text = "CONTROLGUI: подготовка Chromium…";
        else text = "CONTROLGUI: " + text;
        text = this.font.plainSubstrByWidth(text, this.width - x - 10);
        g.drawString(this.font, text, x, y - 12, ARGB.opaque(failed ? 0xFF6A5E : 0xC9E4B4));

        if (!busy) return; // при ошибке полоска не нужна — только текст
        float p = CgCef.progress();
        g.fill(x - 1, y - 1, x + barW + 1, y + barH + 1, 0xC0000000);
        g.fill(x, y, x + barW, y + barH, ARGB.opaque(0x2E2E2E));
        if (p >= 0f) {
            g.fill(x, y, x + Math.round(barW * Math.min(1f, p)), y + barH, ARGB.opaque(0x80DA5B));
        } else {
            // фаза без известного прогресса — «бегающий» сегмент
            long t = System.currentTimeMillis() % 1200L;
            int seg = barW / 4;
            int off = (int) ((barW + seg) * t / 1200L) - seg;
            int a = Math.max(0, off);
            int b = Math.min(barW, off + seg);
            if (b > a) g.fill(x + a, y, x + b, y + barH, ARGB.opaque(0x80DA5B));
        }
    }
}
