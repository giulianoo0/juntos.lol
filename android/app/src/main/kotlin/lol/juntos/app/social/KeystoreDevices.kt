package lol.juntos.app.social

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import lol.juntos.app.entry.Prefs
import lol.juntos.core.social.DeviceKey
import lol.juntos.core.social.DeviceStore
import lol.juntos.core.social.DmCrypto

/**
 * The message key of each account signed in on this phone. The pair is made in software,
 * so its owner can carry it to another device, and its private half is kept sealed on disk
 * by an AES key that lives in the Android Keystore and never leaves it.
 */
class KeystoreDevices(private val prefs: Prefs) : DeviceStore {
    private val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun sealer(): SecretKey {
        (keystore.getEntry(SEALER, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(SEALER, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    private fun seal(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // A sealer the keystore can no longer use (a blob it fails to upgrade) is made again.
        runCatching { cipher.init(Cipher.ENCRYPT_MODE, sealer()) }.onFailure {
            runCatching { keystore.deleteEntry(SEALER) }
            cipher.init(Cipher.ENCRYPT_MODE, sealer())
        }
        return DmCrypto.b64(cipher.iv) + "." + DmCrypto.b64(cipher.doFinal(plain))
    }

    private fun unseal(text: String): ByteArray {
        val (iv, body) = text.split('.', limit = 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, sealer(), GCMParameterSpec(128, DmCrypto.unb64(iv)))
        }
        return cipher.doFinal(DmCrypto.unb64(body))
    }

    override fun key(accountId: Long): DeviceKey {
        val sealed = prefs.get("dm.key.$accountId")
        val public = prefs.get("dm.pub.$accountId")
        if (!sealed.isNullOrEmpty() && !public.isNullOrEmpty()) {
            runCatching { return DmCrypto.softwareKey(DmCrypto.privateKey(unseal(sealed)), public) }
        }
        val pair = DmCrypto.newPair()
        val key = DmCrypto.softwareKey(pair)
        store(accountId, key.pkcs8()!!, key.publicKey)
        prefs.put("dm.device.$accountId", "")
        return key
    }

    private fun store(accountId: Long, pkcs8: ByteArray, publicKey: String) {
        prefs.put("dm.key.$accountId", seal(pkcs8))
        prefs.put("dm.pub.$accountId", publicKey)
    }

    override fun adopt(accountId: Long, carried: DmCrypto.CarriedKey) {
        store(accountId, carried.pkcs8, carried.publicKey)
        prefs.put("dm.device.$accountId", carried.deviceId)
    }

    override fun deviceId(accountId: Long): String? = prefs.get("dm.device.$accountId")?.takeIf { it.isNotEmpty() }

    override fun saveDeviceId(accountId: Long, id: String) = prefs.put("dm.device.$accountId", id)

    override fun forget(accountId: Long) {
        prefs.put("dm.key.$accountId", "")
        prefs.put("dm.pub.$accountId", "")
        prefs.put("dm.device.$accountId", "")
    }

    private companion object {
        const val SEALER = "juntos-dm-sealer"
    }
}
