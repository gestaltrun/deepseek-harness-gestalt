package com.alibaba.gestalt.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "GestaltProtectedStorage")
public final class GestaltProtectedStoragePlugin extends Plugin {
    private static final String KEY_ALIAS = "com.alibaba.gestalt.mobile.protected-storage.v1";
    private static final String PREFERENCES = "gestalt-protected-storage";
    private static final int TAG_BITS = 128;

    @PluginMethod
    public void get(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        String encoded = preferences().getString(key, null);
        JSObject result = new JSObject();
        if (encoded == null) {
            call.resolve(result);
            return;
        }
        try {
            byte[] envelope = Base64.decode(encoded, Base64.NO_WRAP);
            ByteBuffer input = ByteBuffer.wrap(envelope);
            int ivLength = input.getInt();
            if (ivLength != 12 || input.remaining() <= ivLength) throw new IllegalStateException("invalid protected value");
            byte[] iv = new byte[ivLength];
            input.get(iv);
            byte[] ciphertext = new byte[input.remaining()];
            input.get(ciphertext);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(TAG_BITS, iv));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            result.put("value", new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Protected Mobile value cannot be opened", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = requireKey(call);
        String value = call.getString("value");
        if (key == null) return;
        if (value == null) {
            call.reject("Protected Mobile value is required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            ByteBuffer envelope = ByteBuffer.allocate(Integer.BYTES + iv.length + ciphertext.length);
            envelope.putInt(iv.length).put(iv).put(ciphertext);
            boolean committed = preferences().edit()
                .putString(key, Base64.encodeToString(envelope.array(), Base64.NO_WRAP))
                .commit();
            if (!committed) throw new IllegalStateException("protected value commit failed");
            call.resolve();
        } catch (Exception error) {
            call.reject("Protected Mobile value cannot be stored", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        if (preferences().edit().remove(key).commit()) call.resolve();
        else call.reject("Protected Mobile value cannot be removed");
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private String requireKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !key.matches("[A-Za-z0-9:._-]{1,256}")) {
            call.reject("Protected Mobile key is invalid");
            return null;
        }
        return key;
    }

    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        SecretKey retained = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (retained != null) return retained;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
