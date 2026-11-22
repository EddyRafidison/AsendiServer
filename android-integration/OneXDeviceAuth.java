package com.onex.security;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.cert.Certificate;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * OneX device-authentication helper for a native Java Android client.
 * Private signing and token-encryption keys remain in Android Keystore.
 * Never persist the account seed or export either private key.
 */
public final class OneXDeviceAuth {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String PREFS = "onex_device_auth";
    private static final String KEY_ALIAS_PREFIX = "onex_device_p256_";
    private static final String TOKEN_KEY_ALIAS_PREFIX = "onex_token_aes_";
    private static final String SESSION_TOKEN_PREFIX = "session_token_";
    private static final int GCM_IV_LENGTH_BYTES = 12;
    private static final int GCM_TAG_LENGTH_BITS = 128;

    private final Context appContext;
    private final String username;
    private final String keyAlias;
    private final String tokenKeyAlias;
    private final String deviceId;

    public OneXDeviceAuth(Context context, String username) throws Exception {
        if (context == null || username == null || username.trim().isEmpty()) {
            throw new IllegalArgumentException("Context and username are required");
        }
        this.appContext = context.getApplicationContext();
        this.username = username.trim().toUpperCase(Locale.ROOT);
        String accountKey = sha256Hex(this.username).substring(0, 32);
        this.keyAlias = KEY_ALIAS_PREFIX + accountKey;
        this.tokenKeyAlias = TOKEN_KEY_ALIAS_PREFIX + accountKey;
        this.deviceId = getOrCreateDeviceId();
        ensureSigningKeyPair();
    }

    public String getDeviceId() {
        return deviceId;
    }

    /** Base64-encoded X.509 SubjectPublicKeyInfo (SPKI) DER. */
    public String getPublicKeyBase64() throws Exception {
        KeyStore keyStore = loadKeyStore();
        Certificate certificate = keyStore.getCertificate(keyAlias);
        if (certificate == null) throw new IllegalStateException("Device signing key is missing");
        return Base64.encodeToString(certificate.getPublicKey().getEncoded(), Base64.NO_WRAP);
    }

    /** Sign the exact challenge_message returned by POST /app/device/challenge. */
    public String signChallenge(String challengeMessage) throws Exception {
        return sign(challengeMessage);
    }

    /**
     * Store the opaque tkn returned by POST /app/signin using an AES-GCM key in Android Keystore.
     * Call this immediately after a successful sign-in or session renewal.
     */
    public void saveSessionToken(String token) throws Exception {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) {
            throw new IllegalArgumentException("Invalid OneX session token");
        }
        SecretKey secretKey = getOrCreateTokenEncryptionKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey);
        cipher.updateAAD(sessionTokenAad());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        ByteBuffer payload = ByteBuffer.allocate(iv.length + encrypted.length);
        payload.put(iv);
        payload.put(encrypted);

        SharedPreferences preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean saved = preferences.edit()
                .putString(SESSION_TOKEN_PREFIX + accountPreferenceKey(),
                        Base64.encodeToString(payload.array(), Base64.NO_WRAP))
                .commit();
        if (!saved) throw new IllegalStateException("Unable to persist the encrypted OneX session token");
    }

    /** Return the decrypted session token, or null when no usable token is stored. */
    public String loadSessionToken() throws Exception {
        SharedPreferences preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String encoded = preferences.getString(SESSION_TOKEN_PREFIX + accountPreferenceKey(), null);
        if (encoded == null || encoded.isEmpty()) return null;

        try {
            byte[] payload = Base64.decode(encoded, Base64.NO_WRAP);
            if (payload.length <= GCM_IV_LENGTH_BYTES + 16) {
                clearSessionToken();
                return null;
            }
            byte[] iv = new byte[GCM_IV_LENGTH_BYTES];
            byte[] encrypted = new byte[payload.length - GCM_IV_LENGTH_BYTES];
            System.arraycopy(payload, 0, iv, 0, iv.length);
            System.arraycopy(payload, iv.length, encrypted, 0, encrypted.length);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateTokenEncryptionKey(),
                    new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            cipher.updateAAD(sessionTokenAad());
            String token = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
            if (!token.matches("[A-Za-z0-9_-]{43}")) {
                clearSessionToken();
                return null;
            }
            return token;
        } catch (Exception exception) {
            clearSessionToken();
            return null;
        }
    }

    /** Remove the locally stored session token, for example after logout or a revoked-session response. */
    public void clearSessionToken() {
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(SESSION_TOKEN_PREFIX + accountPreferenceKey())
                .commit();
    }

    /**
     * Create headers for every protected OneX API request.
     * pathAndQuery must exactly match the HTTPS request's raw path and query string.
     */
    public Map<String, String> createRequestHeaders(String method, String pathAndQuery,
                                                    byte[] exactRequestBody, String token) throws Exception {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) {
            throw new IllegalArgumentException("A valid OneX session token is required");
        }
        if (exactRequestBody == null || exactRequestBody.length > 256 * 1024) {
            throw new IllegalArgumentException("The exact HTTP request body is required");
        }
        long timestamp = System.currentTimeMillis();
        String nonce = randomBase64Url(32);
        String bodyHash = sha256Hex(exactRequestBody);
        String message = buildRequestMessage(method, pathAndQuery, timestamp, nonce, token, bodyHash);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("X-OneX-Device-Id", deviceId);
        headers.put("X-OneX-Device-Timestamp", String.valueOf(timestamp));
        headers.put("X-OneX-Device-Nonce", nonce);
        headers.put("X-OneX-Device-Signature", sign(message));
        return headers;
    }

    public static String buildRequestMessage(String method, String pathAndQuery,
                                             long timestamp, String nonce, String token, String bodyHash) {
        if (method == null || method.trim().isEmpty() || pathAndQuery == null ||
                pathAndQuery.length() > 2048 || nonce == null ||
                !nonce.matches("[A-Za-z0-9_-]{22,80}") || token == null ||
                !token.matches("[A-Za-z0-9_-]{43}") || bodyHash == null ||
                !bodyHash.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("Invalid OneX request-signature fields");
        }
        return "ONEX-API-DEVICE-V1\n"
                + method.toUpperCase(Locale.ROOT) + "\n"
                + pathAndQuery + "\n"
                + timestamp + "\n"
                + nonce + "\n"
                + token + "\n"
                + bodyHash;
    }

    private String sign(String message) throws Exception {
        KeyStore keyStore = loadKeyStore();
        PrivateKey privateKey = (PrivateKey) keyStore.getKey(keyAlias, null);
        if (privateKey == null) throw new IllegalStateException("Device private key is unavailable");
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(privateKey);
        signature.update(message.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP);
    }

    private void ensureSigningKeyPair() throws Exception {
        KeyStore keyStore = loadKeyStore();
        if (keyStore.containsAlias(keyAlias)) {
            try {
                if (keyStore.getCertificate(keyAlias) != null && keyStore.getKey(keyAlias, null) != null) return;
            } catch (Exception ignored) {
                // Regenerate an invalidated or unreadable local key; the server will require seed authorization.
            }
            keyStore.deleteEntry(keyAlias);
        }

        KeyPairGenerator generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build();
        generator.initialize(spec);
        generator.generateKeyPair();
    }

    private SecretKey getOrCreateTokenEncryptionKey() throws Exception {
        KeyStore keyStore = loadKeyStore();
        if (keyStore.containsAlias(tokenKeyAlias)) {
            try {
                java.security.Key key = keyStore.getKey(tokenKeyAlias, null);
                if (key instanceof SecretKey) return (SecretKey) key;
            } catch (Exception ignored) {
                // Replace an invalidated local encryption key; a missing token requires a new sign-in.
            }
            keyStore.deleteEntry(tokenKeyAlias);
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                tokenKeyAlias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build();
        generator.init(spec);
        return generator.generateKey();
    }

    private byte[] sessionTokenAad() {
        return ("ONEX-SESSION-TOKEN-V1\n" + username).getBytes(StandardCharsets.UTF_8);
    }

    private KeyStore loadKeyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        return keyStore;
    }

    private String getOrCreateDeviceId() {
        SharedPreferences preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String preferenceKey = "device_id_" + accountPreferenceKey();
        String existing = preferences.getString(preferenceKey, null);
        if (existing != null && existing.matches("[A-Za-z0-9_-]{22,80}")) return existing;
        String created = randomBase64Url(32);
        boolean saved = preferences.edit().putString(preferenceKey, created).commit();
        if (!saved) throw new IllegalStateException("Unable to persist the OneX device identifier");
        return created;
    }

    private String accountPreferenceKey() {
        return sha256Hex(username).substring(0, 24);
    }

    private static String randomBase64Url(int bytes) {
        byte[] value = new byte[bytes];
        new SecureRandom().nextBytes(value);
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String sha256Hex(byte[] value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
            StringBuilder output = new StringBuilder(digest.length * 2);
            for (byte item : digest) output.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            return output.toString();
        } catch (Exception exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private static String sha256Hex(String value) {
        return sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }
}
