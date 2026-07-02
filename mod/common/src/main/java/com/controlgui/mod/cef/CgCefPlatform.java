package com.controlgui.mod.cef;

import java.util.Locale;

/* Платформа/архитектура текущей машины и привязанная к ней контрольная сумма
   бандла java-cef. Значения sha256 зафиксированы под коммит java-cef
   {@link CgCef#JAVA_CEF_COMMIT}: скачанный архив обязан совпасть, иначе мы его
   отвергаем (защита от подмены на зеркале). Аналог MCEFPlatform, но свой. */
public enum CgCefPlatform {
    LINUX_AMD64("e64d2ffd32831cab00efc0f9d7ac68b7766b7710db42ec45e5ecaa1043c94f9b"),
    LINUX_ARM64("ae3e28e912ac30931a8b6522b28c90d9af58bcb61130103ad7987989b9d7c495"),
    WINDOWS_AMD64("aaff42ca9a0bf59f2f2590a1262f5facba6db68a90e63a31c926782750610862"),
    WINDOWS_ARM64("7710781d35b6d5ae7052de1126cbd21e872f33aebb653829c1491ab156d196be"),
    MACOS_AMD64("24dc849457bee61c31f5567964bc263e945459b8f351047e0a86fb0f0ad3f0b7"),
    MACOS_ARM64("cf973d62316448e53917aadb0c6db5dea09adcd46b1189f516245f4230d25108");

    private final String sha256;

    CgCefPlatform(String sha256) {
        this.sha256 = sha256;
    }

    /* Имя ассета на зеркале: <platform>.tar.gz, напр. windows_amd64.tar.gz. */
    public String normalizedName() {
        return name().toLowerCase(Locale.US);
    }

    /* Ожидаемая sha256 архива под текущий зафиксированный коммит java-cef. */
    public String expectedSha256() {
        return sha256;
    }

    public boolean isLinux() {
        return this == LINUX_AMD64 || this == LINUX_ARM64;
    }

    public boolean isWindows() {
        return this == WINDOWS_AMD64 || this == WINDOWS_ARM64;
    }

    public boolean isMacOS() {
        return this == MACOS_AMD64 || this == MACOS_ARM64;
    }

    public static CgCefPlatform detect() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.US);
        String arch = System.getProperty("os.arch", "").toLowerCase(Locale.US);
        boolean amd64 = arch.equals("amd64") || arch.equals("x86_64");
        boolean arm64 = arch.equals("aarch64") || arch.equals("arm64");

        if (os.startsWith("linux")) {
            if (amd64) return LINUX_AMD64;
            if (arm64) return LINUX_ARM64;
        } else if (os.startsWith("windows")) {
            if (amd64) return WINDOWS_AMD64;
            if (arm64) return WINDOWS_ARM64;
        } else if (os.startsWith("mac os x") || os.startsWith("macos") || os.startsWith("darwin")) {
            if (amd64) return MACOS_AMD64;
            if (arm64) return MACOS_ARM64;
        }
        throw new IllegalStateException("CONTROLGUI CEF: неподдерживаемая платформа " + os + " " + arch);
    }
}
