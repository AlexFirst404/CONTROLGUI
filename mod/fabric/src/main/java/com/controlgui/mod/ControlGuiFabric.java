package com.controlgui.mod;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenKeyboardEvents;

public class ControlGuiFabric implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        KeyBindingHelper.registerKeyBinding(CGKeys.OPEN);
        ClientTickEvents.END_CLIENT_TICK.register(CGKeys::tick);
        ClientLifecycleEvents.CLIENT_STOPPING.register((client) -> PanelManager.shutdown());
        // панель открывается и из любого чужого экрана (меню, пауза)
        ScreenEvents.BEFORE_INIT.register((client, screen, w, h) ->
                ScreenKeyboardEvents.allowKeyPress(screen).register((scr, key) -> {
                    if (CGKeys.shouldOpenFrom(scr, key)) {
                        client.setScreen(new PanelScreen(true));
                        return false;
                    }
                    return true;
                }));
        CGBrowser.installHandlers();
    }
}
