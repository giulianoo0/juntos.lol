package lol.juntos.core.social

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Private messages, `juntos-dm-v1`, as web/src/social/crypto.ts seals them, byte for byte:
 * P-256 ECDH between devices, HKDF-SHA256 into a wrapping key, AES-256-GCM for the message
 * and for its key.
 */
object DmCrypto {
    private const val SCHEME = "juntos-dm-v1"
    private val random = SecureRandom()
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    // SubjectPublicKeyInfo of a P-256 key, up to the 65 bytes of the point.
    private val SPKI_PREFIX = hex("3059301306072a8648ce3d020106082a8648ce3d030107034200")

    fun b64(bytes: ByteArray): String = encoder.encodeToString(bytes)
    fun unb64(text: String): ByteArray = decoder.decode(text)
    fun randomBytes(n: Int): ByteArray = ByteArray(n).also(random::nextBytes)

    /** The raw uncompressed point of a P-256 public key. */
    fun rawOf(key: PublicKey): ByteArray {
        val encoded = key.encoded
        require(encoded.size == SPKI_PREFIX.size + 65) { "not a P-256 key" }
        return encoded.copyOfRange(SPKI_PREFIX.size, encoded.size)
    }

    fun publicFromRaw(raw: ByteArray): PublicKey {
        require(raw.size == 65 && raw[0] == 4.toByte()) { "not an uncompressed P-256 point" }
        return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + raw))
    }

    fun hkdf(secret: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(secret)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var filled = 0
        var counter = 1
        while (filled < length) {
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val take = minOf(previous.size, length - filled)
            System.arraycopy(previous, 0, out, filled, take)
            filled += take
            counter++
        }
        return out
    }

    /** The key two devices share for wrapping, from [secret] = ECDH(mine, theirs). */
    fun wrapKey(secret: ByteArray, myDevice: String, theirDevice: String): ByteArray {
        val ids = listOf(myDevice, theirDevice).sorted()
        return hkdf(secret, SCHEME.toByteArray(), "wrap:${ids.joinToString(":")}".toByteArray())
    }

    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, aad: ByteArray, input: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad)
        return cipher.doFinal(input)
    }

    private fun messageAad(from: Long, to: Long, clientId: String) = "$from>$to:$clientId".toByteArray()

    @Serializable
    data class Wrapped(val iv: String, val key: String)

    data class Sealed(val iv: String, val body: String, val keys: Map<String, Wrapped>)

    /** Seals [text] once, its key wrapped for each device id in [recipients] (device id → wrapping key). */
    fun seal(text: String, from: Long, to: Long, clientId: String, recipients: Map<String, ByteArray>): Sealed {
        val messageKey = randomBytes(32)
        val iv = randomBytes(12)
        val plain = JsonObject(mapOf("t" to JsonPrimitive(text))).toString().toByteArray()
        val body = gcm(Cipher.ENCRYPT_MODE, messageKey, iv, messageAad(from, to, clientId), plain)
        val keys = recipients.mapValues { (_, wrap) ->
            val wrapIv = randomBytes(12)
            Wrapped(b64(wrapIv), b64(gcm(Cipher.ENCRYPT_MODE, wrap, wrapIv, clientId.toByteArray(), messageKey)))
        }
        return Sealed(b64(iv), b64(body), keys)
    }

    /** Opens a message with this device's wrapped key; throws when it is not for this device or was altered. */
    fun open(from: Long, to: Long, clientId: String, iv: String, body: String, wrapped: Wrapped, wrapKey: ByteArray): String {
        val messageKey = gcm(Cipher.DECRYPT_MODE, wrapKey, unb64(wrapped.iv), clientId.toByteArray(), unb64(wrapped.key))
        val plain = gcm(Cipher.DECRYPT_MODE, messageKey, unb64(iv), messageAad(from, to, clientId), unb64(body))
        return Json.parseToJsonElement(String(plain)).jsonObject["t"]!!.jsonPrimitive.content
    }

    fun newPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    /** ECDH with a key pair held in memory; its owner can carry it to another device. */
    fun softwareKey(pair: KeyPair = newPair()): DeviceKey = softwareKey(pair.private, b64(rawOf(pair.public as ECPublicKey)))

    fun softwareKey(private: PrivateKey, publicKey: String): DeviceKey = object : DeviceKey {
        override val publicKey: String = publicKey
        override fun agree(peer: PublicKey): ByteArray = KeyAgreement.getInstance("ECDH").run {
            init(private)
            doPhase(peer, true)
            generateSecret()
        }
        override fun pkcs8(): ByteArray = private.encoded
    }

    fun privateKey(pkcs8: ByteArray): PrivateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8))

    /*
     * A device key carried to another device of the same account, as web/src/social/crypto.ts
     * writes it: `juntos-key:` and base64url of {a: account, d: device, p: public, k: PKCS#8}.
     */
    private const val KEY_PREFIX = "juntos-key:"

    @Serializable
    private data class Carried(val a: Long, val d: String, val p: String, val k: String)

    data class CarriedKey(val accountId: Long, val deviceId: String, val publicKey: String, val pkcs8: ByteArray)

    class KeyImportException(val otherAccount: Boolean) : Exception(if (otherAccount) "other_account" else "invalid")

    fun exportKey(accountId: Long, deviceId: String, key: DeviceKey): String? {
        val pkcs8 = key.pkcs8() ?: return null
        val body = Json.encodeToString(Carried.serializer(), Carried(accountId, deviceId, key.publicKey, b64(pkcs8)))
        return KEY_PREFIX + b64(body.toByteArray())
    }

    fun importKey(text: String, accountId: Long): CarriedKey {
        val trimmed = text.filterNot { it.isWhitespace() }
        if (!trimmed.startsWith(KEY_PREFIX)) throw KeyImportException(false)
        val carried = runCatching {
            Json.decodeFromString(Carried.serializer(), String(unb64(trimmed.removePrefix(KEY_PREFIX))))
        }.getOrElse { throw KeyImportException(false) }
        if (carried.a != accountId) throw KeyImportException(true)
        val pkcs8 = runCatching { unb64(carried.k) }.getOrElse { throw KeyImportException(false) }
        val private = runCatching { privateKey(pkcs8) }.getOrElse { throw KeyImportException(false) }
        val public = runCatching { publicFromRaw(unb64(carried.p)) }.getOrElse { throw KeyImportException(false) }
        // The public half travels along; agreeing with a throwaway key on both sides proves it is the private one's.
        val probe = newPair()
        val one = KeyAgreement.getInstance("ECDH").run { init(private); doPhase(probe.public, true); generateSecret() }
        val two = KeyAgreement.getInstance("ECDH").run { init(probe.private); doPhase(public, true); generateSecret() }
        if (!one.contentEquals(two)) throw KeyImportException(false)
        return CarriedKey(carried.a, carried.d, carried.p, pkcs8)
    }

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

/** This device's key pair; the private half leaves only when its owner carries it ([pkcs8]). */
interface DeviceKey {
    /** Raw uncompressed point, base64url. */
    val publicKey: String
    fun agree(peer: PublicKey): ByteArray
    /** The private half to carry, or null where it cannot leave. */
    fun pkcs8(): ByteArray? = null
}
