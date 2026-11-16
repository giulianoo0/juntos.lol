package lol.juntos.core.social

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DmCryptoTest {
    private fun wrap(mine: DeviceKey, myId: String, theirs: DeviceKey, theirId: String) =
        DmCrypto.wrapKey(mine.agree(DmCrypto.publicFromRaw(DmCrypto.unb64(theirs.publicKey))), myId, theirId)

    @Test fun opensWhereSealedAndNowhereElse() {
        val ana = DmCrypto.softwareKey()
        val bia = DmCrypto.softwareKey()
        val eve = DmCrypto.softwareKey()
        val sealed = DmCrypto.seal("oi, bora?", 1, 2, "cli-1", mapOf("b" to wrap(ana, "a", bia, "b")))
        val atBia = wrap(bia, "b", ana, "a")
        assertEquals("oi, bora?", DmCrypto.open(1, 2, "cli-1", sealed.iv, sealed.body, sealed.keys.getValue("b"), atBia))
        assertThrows(Exception::class.java) {
            DmCrypto.open(1, 2, "cli-1", sealed.iv, sealed.body, sealed.keys.getValue("b"), wrap(eve, "b", ana, "a"))
        }
        assertThrows(Exception::class.java) {
            DmCrypto.open(3, 2, "cli-1", sealed.iv, sealed.body, sealed.keys.getValue("b"), atBia)
        }
    }

    // The same vector web/src/social/crypto.test.ts opens: the two ends agree byte for byte.
    @Test fun opensWhatTheSiteSealed() {
        val vector = Json.parseToJsonElement(javaClass.getResource("/dm-vector.json")!!.readText()).jsonObject
        fun s(key: String) = vector[key]!!.jsonPrimitive.content
        val jwk = vector["recipientPrivateJwk"]!!.jsonObject
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
        val d = BigInteger(1, DmCrypto.unb64(jwk["d"]!!.jsonPrimitive.content))
        val private = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, params))
        val recipient = DmCrypto.softwareKey(KeyPair(DmCrypto.publicFromRaw(DmCrypto.unb64(s("recipientPublicKey"))), private))
        val secret = recipient.agree(DmCrypto.publicFromRaw(DmCrypto.unb64(s("senderPublicKey"))))
        val wrapKey = DmCrypto.wrapKey(secret, s("recipientDevice"), s("senderDevice"))
        val message = vector["message"]!!.jsonObject
        val wrapped = vector["wrapped"]!!.jsonObject
        val text = DmCrypto.open(
            message["from"]!!.jsonPrimitive.content.toLong(), message["to"]!!.jsonPrimitive.content.toLong(),
            message["clientId"]!!.jsonPrimitive.content, message["iv"]!!.jsonPrimitive.content, message["body"]!!.jsonPrimitive.content,
            DmCrypto.Wrapped(wrapped["iv"]!!.jsonPrimitive.content, wrapped["key"]!!.jsonPrimitive.content), wrapKey,
        )
        assertEquals(s("text"), text)
    }

    @Test fun carriesTheKeyTheSiteWrote() {
        val vector = Json.parseToJsonElement(javaClass.getResource("/dm-vector.json")!!.readText()).jsonObject
        fun s(key: String) = vector[key]!!.jsonPrimitive.content
        val account = s("carriedAccount").toLong()
        val carried = DmCrypto.importKey(s("carried"), account)
        assertEquals(s("carriedPublic"), carried.publicKey)
        assertEquals(s("recipientDevice"), carried.deviceId)
        val key = DmCrypto.softwareKey(DmCrypto.privateKey(carried.pkcs8), carried.publicKey)
        // It opens the vector's message: it is the same device now.
        val secret = key.agree(DmCrypto.publicFromRaw(DmCrypto.unb64(s("senderPublicKey"))))
        val wrapKey = DmCrypto.wrapKey(secret, s("recipientDevice"), s("senderDevice"))
        val message = vector["message"]!!.jsonObject
        val wrapped = vector["wrapped"]!!.jsonObject
        assertEquals(s("text"), DmCrypto.open(
            message["from"]!!.jsonPrimitive.content.toLong(), message["to"]!!.jsonPrimitive.content.toLong(),
            message["clientId"]!!.jsonPrimitive.content, message["iv"]!!.jsonPrimitive.content, message["body"]!!.jsonPrimitive.content,
            DmCrypto.Wrapped(wrapped["iv"]!!.jsonPrimitive.content, wrapped["key"]!!.jsonPrimitive.content), wrapKey,
        ))
        // And what it writes reads back the same; another account's key is refused.
        val again = DmCrypto.importKey(DmCrypto.exportKey(account, carried.deviceId, key)!!, account)
        assertEquals(carried.publicKey, again.publicKey)
        val refused = runCatching { DmCrypto.importKey(s("carried"), account + 1) }.exceptionOrNull()
        assertEquals(true, (refused as DmCrypto.KeyImportException).otherAccount)
        val other = DmCrypto.softwareKey()
        val forged = DmCrypto.exportKey(account, "x", DmCrypto.softwareKey(DmCrypto.privateKey(carried.pkcs8), other.publicKey))!!
        assertEquals(false, (runCatching { DmCrypto.importKey(forged, account) }.exceptionOrNull() as DmCrypto.KeyImportException).otherAccount)
    }
}
