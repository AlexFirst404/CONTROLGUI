package com.controlgui.mod.cef;

import com.mojang.blaze3d.opengl.GlStateManager;
import com.mojang.blaze3d.opengl.GlTexture;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.GpuTexture;
import com.mojang.blaze3d.textures.TextureFormat;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;

import java.nio.ByteBuffer;
import java.util.UUID;

import static org.lwjgl.opengl.GL12.GL_BGRA;
import static org.lwjgl.opengl.GL12.GL_RGBA;
import static org.lwjgl.opengl.GL12.GL_TEXTURE_2D;
import static org.lwjgl.opengl.GL12.GL_UNPACK_ROW_LENGTH;
import static org.lwjgl.opengl.GL12.GL_UNPACK_SKIP_PIXELS;
import static org.lwjgl.opengl.GL12.GL_UNPACK_SKIP_ROWS;
import static org.lwjgl.opengl.GL12.GL_UNSIGNED_INT_8_8_8_8_REV;
import static org.lwjgl.opengl.GL12.glTexImage2D;
import static org.lwjgl.opengl.GL12.glTexSubImage2D;

/* Приёмник пикселей Chromium: заводит GPU-текстуру нужного размера и заливает
   в неё кадры (пришедшие из CEF в формате BGRA). Регистрирует её в
   TextureManager как Identifier, чтобы панель рисовалась через GuiGraphics.blit.
   Все операции — на render-потоке. Свой аналог MCEFRenderer. */
final class CgCefRenderer {

    private final boolean transparent;
    private final Identifier textureId;
    private final CgDirectTexture directTexture;
    private GpuTexture texture;
    private int texWidth;
    private int texHeight;
    private boolean registered;
    private ByteBuffer rgbaScratch; // конвертация BGRA→RGBA для fallback-пути

    CgCefRenderer(boolean transparent) {
        this.transparent = transparent;
        String uid = UUID.randomUUID().toString().replace("-", "");
        this.textureId = Identifier.fromNamespaceAndPath("controlgui", "browser_" + uid);
        this.directTexture = new CgDirectTexture();
    }

    void initialize() {
        Minecraft.getInstance().getTextureManager().register(textureId, directTexture);
        registered = true;
        syncViewIfNeeded();
    }

    Identifier textureIdentifier() {
        return textureId;
    }

    boolean isTextureReady() {
        if (texture == null || !registered) return false;
        if (RenderSystem.isOnRenderThread()) syncViewIfNeeded();
        return directTexture.viewReady();
    }

    int textureId() {
        return texture instanceof GlTexture gl ? gl.glId() : 0;
    }

    boolean supportsDirtyRectUpload() {
        return texture instanceof GlTexture && textureId() != 0;
    }

    boolean isTransparent() {
        return transparent;
    }

    void cleanup() {
        if (texture != null) {
            texture.close();
            texture = null;
        }
        rgbaScratch = null;
        if (registered) {
            Minecraft.getInstance().getTextureManager().release(textureId);
            registered = false;
        }
    }

    /* Полный кадр: (пере)создаём текстуру при смене размера и заливаем целиком. */
    void paintFull(ByteBuffer buffer, int width, int height) {
        RenderSystem.assertOnRenderThread();
        if (texture == null || texWidth != width || texHeight != height) {
            if (texture != null) texture.close();
            texture = RenderSystem.getDevice().createTexture(
                    "CONTROLGUI Browser " + width + "x" + height,
                    GpuTexture.USAGE_TEXTURE_BINDING | GpuTexture.USAGE_COPY_DST,
                    TextureFormat.RGBA8, width, height, 1, 1);
            texWidth = width;
            texHeight = height;
        }
        syncViewIfNeeded();

        if (texture instanceof GlTexture gl) {
            GlStateManager._bindTexture(gl.glId());
            GlStateManager._pixelStore(GL_UNPACK_ROW_LENGTH, width);
            GlStateManager._pixelStore(GL_UNPACK_SKIP_PIXELS, 0);
            GlStateManager._pixelStore(GL_UNPACK_SKIP_ROWS, 0);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0,
                    GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, buffer);
            return;
        }
        uploadViaEncoder(buffer, 0, 0, width, height);
    }

    /* Подобласть (грязный прямоугольник). Только для GL-текстуры; для fallback
       вызывается из paintFull целиком. */
    void paintRegion(ByteBuffer buffer, int x, int y, int width, int height) {
        RenderSystem.assertOnRenderThread();
        syncViewIfNeeded();
        if (texture instanceof GlTexture gl) {
            GlStateManager._bindTexture(gl.glId());
            glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, width, height,
                    GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, buffer);
            return;
        }
        uploadViaEncoder(buffer, x, y, width, height);
    }

    private void syncViewIfNeeded() {
        if (!registered || texture == null || texture.isClosed()) return;
        boolean stale = !directTexture.viewReady()
                || directTexture.width() != texWidth
                || directTexture.height() != texHeight
                || directTexture.boundTexture() != texture;
        if (stale) directTexture.bind(texture, texWidth, texHeight);
    }

    /* Fallback для не-GL бэкендов: через command encoder, с конвертацией BGRA→RGBA
       (encoder ждёт RGBA). Предполагается плотно упакованный прямоугольник. */
    private void uploadViaEncoder(ByteBuffer buffer, int destX, int destY, int width, int height) {
        if (texture == null || buffer == null) return;
        int need = width * height * 4;
        if (need <= 0 || buffer.capacity() < need) return;

        if (rgbaScratch == null || rgbaScratch.capacity() < need) {
            rgbaScratch = ByteBuffer.allocateDirect(need);
        }
        ByteBuffer src = buffer.duplicate();
        src.position(0);
        src.limit(need);
        ByteBuffer dst = rgbaScratch.duplicate();
        dst.clear();
        dst.limit(need);
        for (int i = 0; i < need; i += 4) {
            byte b = src.get(i);
            byte g = src.get(i + 1);
            byte r = src.get(i + 2);
            byte a = src.get(i + 3);
            dst.put(i, r);
            dst.put(i + 1, g);
            dst.put(i + 2, b);
            dst.put(i + 3, a);
        }
        dst.position(0);
        RenderSystem.getDevice().createCommandEncoder().writeToTexture(
                texture, dst.slice(), NativeImage.Format.RGBA, 0, 0, destX, destY, width, height);
    }
}
