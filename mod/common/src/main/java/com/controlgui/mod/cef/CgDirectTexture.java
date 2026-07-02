package com.controlgui.mod.cef;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.GpuTexture;
import net.minecraft.client.renderer.texture.AbstractTexture;

/* Обёртка, которая отдаёт TextureManager'у Minecraft уже существующую
   GPU-текстуру браузера (её создаёт и обновляет CgCefRenderer). Своя
   реализация MCEFDirectTexture: держим view поверх чужой текстуры, чтобы
   GuiGraphics.blit мог рисовать её как обычную. */
public final class CgDirectTexture extends AbstractTexture {

    private int width;
    private int height;

    public void bind(GpuTexture source, int width, int height) {
        if (this.textureView != null) {
            this.textureView.close();
            this.textureView = null;
        }
        this.texture = null;
        if (source != null && !source.isClosed() && width > 0 && height > 0) {
            this.texture = source;
            this.textureView = RenderSystem.getDevice().createTextureView(this.texture);
            this.width = width;
            this.height = height;
        } else {
            this.width = 0;
            this.height = 0;
        }
    }

    public int width() {
        return width;
    }

    public int height() {
        return height;
    }

    public GpuTexture boundTexture() {
        return this.texture;
    }

    public boolean viewReady() {
        return this.texture != null && !this.texture.isClosed()
                && this.textureView != null && !this.textureView.isClosed();
    }

    @Override
    public void close() {
        if (this.textureView != null) {
            this.textureView.close();
            this.textureView = null;
        }
        this.texture = null;
        this.width = 0;
        this.height = 0;
    }
}
