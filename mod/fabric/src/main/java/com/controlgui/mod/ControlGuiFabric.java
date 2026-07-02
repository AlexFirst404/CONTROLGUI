package com.controlgui.mod;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;

public class ControlGuiFabric implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        KeyBindingHelper.registerKeyBinding(CGKeys.OPEN);
        ClientTickEvents.END_CLIENT_TICK.register(CGKeys::tick);
        ClientLifecycleEvents.CLIENT_STOPPING.register((client) -> PanelManager.shutdown());
    }
}
