package com.controlgui.mod;

import com.controlgui.mod.cef.CgCef;
import net.minecraft.client.Minecraft;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RegisterKeyMappingsEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.GameShuttingDownEvent;

@Mod(value = Constants.MOD_ID, dist = Dist.CLIENT)
public class ControlGuiNeoForge {

    public ControlGuiNeoForge(IEventBus modBus) {
        CgCef.bootstrap(); // подготовка/загрузка встроенного движка Chromium
        modBus.addListener(this::onRegisterKeys);
        NeoForge.EVENT_BUS.addListener(this::onClientTick);
        NeoForge.EVENT_BUS.addListener(this::onScreenKey);
        NeoForge.EVENT_BUS.addListener(this::onShutdown);
        CGBrowser.installHandlers();
    }

    private void onRegisterKeys(RegisterKeyMappingsEvent event) {
        event.register(CGKeys.OPEN);
    }

    private void onClientTick(ClientTickEvent.Post event) {
        CGKeys.tick(Minecraft.getInstance());
    }

    // панель открывается и из любого чужого экрана (меню, пауза)
    private void onScreenKey(ScreenEvent.KeyPressed.Pre event) {
        if (CGKeys.shouldOpenFrom(event.getScreen(), event.getKeyEvent())) {
            Minecraft.getInstance().setScreen(new PanelScreen(true));
            event.setCanceled(true);
        }
    }

    private void onShutdown(GameShuttingDownEvent event) {
        PanelManager.shutdown();
        CgCef.shutdown();
    }
}
