package com.controlgui.mod.mixin;

import com.controlgui.mod.PanelScreen;
import com.mojang.blaze3d.platform.FramerateLimitTracker;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/* Ваниль режет FPS до 60, когда открыт экран без загруженного мира
   (OUT_OF_LEVEL_MENU). Для панели CONTROLGUI снимаем ИМЕННО этот кап
   (инжект на RETURN): троттлинг свёрнутого окна (10 FPS) и AFK (30/10)
   остаются работать — они экономят ресурсы осмысленно. В мире капа нет. */
@Mixin(FramerateLimitTracker.class)
public class FramerateLimitTrackerMixin {

    @Inject(method = "getThrottleReason", at = @At("RETURN"), cancellable = true)
    private void controlgui$uncapPanel(CallbackInfoReturnable<FramerateLimitTracker.FramerateThrottleReason> cir) {
        if (cir.getReturnValue() == FramerateLimitTracker.FramerateThrottleReason.OUT_OF_LEVEL_MENU
                && Minecraft.getInstance().screen instanceof PanelScreen) {
            cir.setReturnValue(FramerateLimitTracker.FramerateThrottleReason.NONE);
        }
    }
}
