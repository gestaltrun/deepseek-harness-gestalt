package com.alibaba.gestalt.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GestaltProtectedStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
