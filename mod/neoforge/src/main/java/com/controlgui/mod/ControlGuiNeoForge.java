package com.controlgui.mod;

import net.minecraft.client.Minecraft;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RegisterKeyMappingsEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.GameShuttingDownEvent;

@Mod(value = Constants.MOD_ID, dist = Dist.CLIENT)
public class ControlGuiNeoForge {

    public ControlGuiNeoForge(IEventBus modBus) {
        modBus.addListener(this::onRegisterKeys);
        NeoForge.EVENT_BUS.addListener(this::onClientTick);
        NeoForge.EVENT_BUS.addListener(this::onShutdown);
    }

    private void onRegisterKeys(RegisterKeyMappingsEvent event) {
        event.register(CGKeys.OPEN);
    }

    private void onClientTick(ClientTickEvent.Post event) {
        CGKeys.tick(Minecraft.getInstance());
    }

    private void onShutdown(GameShuttingDownEvent event) {
        PanelManager.shutdown();
    }
}
