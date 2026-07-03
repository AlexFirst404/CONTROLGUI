package com.controlgui.mod;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Constants {

    public static final String MOD_ID = "controlgui";
    public static final String MOD_NAME = "CONTROLGUI";
    /* Версия панели, зашитой в jar (assets/controlgui/panel.zip). Должна
       совпадать с app-версией в lib/api.js на момент сборки мода. */
    public static final String PANEL_VERSION = "1.6.12";
    /* Порт локальной панели — тот же, что у настольного приложения. */
    public static final int PANEL_PORT = 8400;

    public static final Logger LOG = LoggerFactory.getLogger(MOD_NAME);
}
