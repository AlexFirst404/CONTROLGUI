package com.controlgui.mod.mixin;

import com.controlgui.mod.cef.CgCef;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/* Каждый кадр на render-потоке двигаем цикл сообщений Chromium (и, когда натив
   готов, инициализируем движок). CEF с внешним пампом требует этого вызова
   регулярно, иначе браузер «замерзает». */
@Mixin(GameRenderer.class)
public class CefPumpMixin {

    @Inject(method = "render", at = @At("HEAD"))
    public void controlgui$pumpCef(DeltaTracker deltaTracker, boolean renderLevel, CallbackInfo info) {
        CgCef.onClientRenderTick();
    }
}
