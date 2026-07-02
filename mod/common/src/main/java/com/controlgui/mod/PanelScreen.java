package com.controlgui.mod;

import com.cinemamod.mcef.MCEF;
import com.cinemamod.mcef.MCEFBrowser;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.util.ARGB;
import org.lwjgl.glfw.GLFW;

/* Панель CONTROLGUI внутри игры: настоящий веб-интерфейс панели (MCEF,
   прозрачная страница в режиме ?ingame=1) поверх слегка заблюренного мира.
   Браузер живёт между открытиями экрана — вход и состояние сохраняются. */
public class PanelScreen extends Screen {

    private static MCEFBrowser browser; // общий на всё время игры
    private static int loadedGeneration = -1; // с какой «жизнью» панели загружена страница

    public PanelScreen() {
        super(Component.literal(Constants.MOD_NAME));
    }

    @Override
    protected void init() {
        super.init();
        PanelManager.ensureStarted().thenAccept((base) -> {
            if (this.minecraft == null) return;
            this.minecraft.execute(this::ensureBrowser);
        });
        if (browser != null) resizeBrowser();
    }

    /* Создаёт браузер (или перезагружает страницу, если панель с тех пор
       перезапускалась и в браузере повис ERR_CONNECTION_REFUSED). Только
       на клиентском потоке. */
    private void ensureBrowser() {
        if (this.minecraft == null || this.minecraft.screen != this) return;
        if (!MCEF.isInitialized()) return; // Chromium ещё качается — доберём в tick()
        if (PanelManager.phase() != PanelManager.Phase.READY) return;
        if (browser == null) {
            browser = MCEF.createBrowser(PanelManager.baseUrl() + "/?ingame=1", true);
            loadedGeneration = PanelManager.generation();
        } else if (loadedGeneration != PanelManager.generation()) {
            browser.loadURL(PanelManager.baseUrl() + "/?ingame=1");
            loadedGeneration = PanelManager.generation();
        }
        resizeBrowser();
    }

    @Override
    public void tick() {
        super.tick();
        // первый запуск: MCEF мог доинициализироваться уже при открытом
        // экране — одноразовый колбэк в init() это пропустил
        if (browser == null) ensureBrowser();
    }

    @Override
    public void removed() {
        super.removed();
        // страница могла оставить курсор «рука»/«текст» — возвращаем стрелку,
        // иначе он протекает во все остальные экраны игры (браузер не закрываем)
        if (browser != null) {
            try { browser.setCursor(org.cef.misc.CefCursorType.POINTER); }
            catch (Exception e) { /* не критично */ }
        }
    }

    private void resizeBrowser() {
        if (browser == null || this.minecraft == null) return;
        double scale = this.minecraft.getWindow().getGuiScale();
        browser.resize((int) (this.width * scale), (int) (this.height * scale));
    }

    @Override
    public void resize(int w, int h) {
        super.resize(w, h);
        resizeBrowser();
    }

    /* Только блюр мира — без ванильного тёмного градиента: за интерфейсом
       должна быть «чуть заблюренная игра». В меню (без мира) — обычный фон. */
    @Override
    public void renderBackground(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        if (this.minecraft != null && this.minecraft.level != null) {
            renderBlurredBackground(graphics);
        } else {
            super.renderBackground(graphics, mouseX, mouseY, partialTick);
        }
    }

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        super.render(graphics, mouseX, mouseY, partialTick);
        boolean drawn = false;
        if (browser != null && browser.isTextureReady()) {
            Identifier tex = browser.getTextureIdentifier();
            if (tex != null) {
                graphics.blit(RenderPipelines.GUI_TEXTURED, tex,
                        0, 0, 0.0F, 0.0F, this.width, this.height, this.width, this.height);
                drawn = true;
            }
        }
        if (drawn && PanelManager.phase() != PanelManager.Phase.ERROR) return;
        // панель поднимается или упала — статус поверх всего
        String note = PanelManager.phase() == PanelManager.Phase.ERROR
                ? PanelManager.statusText()
                : (!MCEF.isInitialized()
                    ? "Chromium (MCEF) ещё загружается — попробуйте чуть позже"
                    : (PanelManager.statusText().isEmpty() ? "Открываю панель…" : PanelManager.statusText()));
        int y = this.height / 2 - 4;
        graphics.fill(0, y - 8, this.width, y + 14, 0xA0000000);
        graphics.drawCenteredString(this.font, note, this.width / 2, y, ARGB.opaque(0xE0E0E0));
    }

    /* ── проброс ввода в браузер (координаты — в пикселях браузера) ─────── */

    private int browserX(double guiX) {
        return (int) (guiX * (this.minecraft != null ? this.minecraft.getWindow().getGuiScale() : 1));
    }

    private int browserY(double guiY) {
        return (int) (guiY * (this.minecraft != null ? this.minecraft.getWindow().getGuiScale() : 1));
    }

    @Override
    public boolean mouseClicked(MouseButtonEvent event, boolean isDoubleClick) {
        if (super.mouseClicked(event, isDoubleClick)) return true;
        if (browser == null) return false;
        browser.sendMousePress(browserX(event.x()), browserY(event.y()), event.button());
        browser.setFocus(true);
        return true;
    }

    @Override
    public boolean mouseReleased(MouseButtonEvent event) {
        if (super.mouseReleased(event)) return true;
        if (browser == null) return false;
        browser.sendMouseRelease(browserX(event.x()), browserY(event.y()), event.button());
        browser.setFocus(true);
        return true;
    }

    @Override
    public void mouseMoved(double mouseX, double mouseY) {
        if (browser != null) browser.sendMouseMove(browserX(mouseX), browserY(mouseY));
        super.mouseMoved(mouseX, mouseY);
    }

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double scrollX, double scrollY) {
        if (super.mouseScrolled(mouseX, mouseY, scrollX, scrollY)) return true;
        if (browser == null) return false;
        if (scrollY != 0) browser.sendMouseWheel(browserX(mouseX), browserY(mouseY), scrollY, 0);
        // горизонтальную прокрутку страницы понимают как Shift+колесо
        if (scrollX != 0) browser.sendMouseWheel(browserX(mouseX), browserY(mouseY), scrollX, GLFW.GLFW_MOD_SHIFT);
        return true;
    }

    @Override
    public boolean keyPressed(KeyEvent event) {
        if (super.keyPressed(event)) return true; // Esc закрывает экран
        if (browser == null) return false;
        browser.sendKeyPress(event.key(), event.scancode(), event.modifiers());
        browser.setFocus(true);
        return true;
    }

    @Override
    public boolean keyReleased(KeyEvent event) {
        if (super.keyReleased(event)) return true;
        if (browser == null) return false;
        browser.sendKeyRelease(event.key(), event.scancode(), event.modifiers());
        browser.setFocus(true);
        return true;
    }

    @Override
    public boolean charTyped(CharacterEvent event) {
        if (super.charTyped(event)) return true;
        if (browser == null || event.codepoint() == 0) return false;
        browser.sendKeyTyped((char) event.codepoint(), event.modifiers());
        browser.setFocus(true);
        return true;
    }

    @Override
    public boolean isPauseScreen() {
        return false; // мир продолжает жить (и рендериться под блюром)
    }
}
