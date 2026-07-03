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

    /* При открытой панели снимаем лимит кадров ЦЕЛИКОМ: 260 в ванилле значит
       «без лимита» (Minecraft зовёт limitDisplayFPS только при значении < 260),
       иначе интерфейс упирается в пользовательскую настройку FPS (часто 60).
       Гейт по причине NONE: AFK-троттлинг (30/10) и свёрнутое окно игры
       продолжают работать — они экономят ресурсы осмысленно, а первый же ввод
       мгновенно возвращает NONE и безлимит. (Кап меню наш первый инжект уже
       переписал в NONE при открытой панели.) */
    @Inject(method = "getFramerateLimit", at = @At("RETURN"), cancellable = true)
    private void controlgui$unlimitPanel(CallbackInfoReturnable<Integer> cir) {
        Minecraft mc = Minecraft.getInstance();
        if (!(mc.screen instanceof PanelScreen)) return;
        FramerateLimitTracker self = (FramerateLimitTracker) (Object) this;
        if (self.getThrottleReason() == FramerateLimitTracker.FramerateThrottleReason.NONE) {
            cir.setReturnValue(260);
        }
    }
}
