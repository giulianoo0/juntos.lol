package lol.juntos.app.social

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.launch
import lol.juntos.core.social.DmCrypto
import lol.juntos.core.social.Inbox
import lol.juntos.design.Field
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.design.Segmented
import lol.juntos.design.ToastHost
import lol.juntos.design.pop
import lol.juntos.design.rememberToastState
import lol.juntos.design.settle

private enum class KeyMode(val label: String) { Show("Desta tela"), Use("De outro aparelho") }

/** The message key between one's own devices: this one's as a QR and text, or another's read in. */
@Composable
fun KeyScreen(inbox: Inbox, onBack: () -> Unit) {
    val c = Juntos.colors
    var mode by remember { mutableStateOf(KeyMode.Show) }
    val toast = rememberToastState()
    Box(Modifier.fillMaxSize().background(c.frameGround)) {
        Column(Modifier.fillMaxSize()) {
            TopBar(
                title = { Text("Chave das mensagens", color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f)) },
                onBack = onBack,
            )
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Segmented(KeyMode.entries, mode, { mode = it }, { it.label }, Modifier.fillMaxWidth(), fill = true)
                val enter = pop<Float>()
                val exit = settle<Float>()
                AnimatedContent(mode, transitionSpec = { fadeIn(enter) togetherWith fadeOut(exit) }, label = "key-mode") { shown ->
                    when (shown) {
                        KeyMode.Show -> ShowKey(inbox) { text -> toast.show(text) }
                        KeyMode.Use -> UseKey(inbox, onDone = onBack) { text -> toast.show(text) }
                    }
                }
            }
        }
        ToastHost(toast, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
    }
}

private fun qrBitmap(text: String, size: Int = 720): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L))
    val pixels = IntArray(matrix.width * matrix.height) { i -> if (matrix[i % matrix.width, i / matrix.width]) 0xFF111111.toInt() else 0xFFFFFFFF.toInt() }
    return Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.ARGB_8888)
}

@Composable
private fun ShowKey(inbox: Inbox, say: suspend (String) -> Unit) {
    val c = Juntos.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val key = remember { inbox.exportKey() }
    var revealed by remember { mutableStateOf(false) }
    val clear by animateDpAsState(if (revealed) 0.dp else 16.dp, pop(), label = "qr-blur")
    val grow by animateFloatAsState(if (revealed) 1f else 0.94f, pop(), label = "qr-scale")
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (key == null) {
            Text("Esta chave não sai deste aparelho", color = c.textMuted, fontSize = JuntosTextSize.sm, modifier = Modifier.padding(24.dp))
            return@Column
        }
        val bitmap = remember(key) { qrBitmap(key).asImageBitmap() }
        val interaction = remember { MutableInteractionSource() }
        Box(
            Modifier.widthIn(max = 300.dp).fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(28.dp)).background(Color.White)
                .clickable(interaction, indication = null, role = Role.Button, enabled = !revealed) { revealed = true }
                .semantics { contentDescription = if (revealed) "QR da chave" else "Mostrar" }
                .padding(22.dp),
            contentAlignment = Alignment.Center,
        ) {
            Image(bitmap, contentDescription = null, filterQuality = FilterQuality.None,
                modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = grow; scaleY = grow }.blur(clear))
            if (!revealed) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Rounded.Visibility, contentDescription = null, tint = Color(0xFF111111), modifier = Modifier.size(20.dp))
                    Text("Mostrar", color = Color(0xFF111111), fontSize = JuntosTextSize.sm, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Pill(
            "Copiar chave",
            onClick = {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("juntos", key).apply {
                    description.extras = android.os.PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
                })
                scope.launch { say("Chave copiada") }
            },
            modifier = Modifier.fillMaxWidth(),
            tone = PillTone.Soft,
            size = PillSize.Lg,
            icon = Icons.Rounded.ContentCopy,
        )
    }
}

@Composable
private fun UseKey(inbox: Inbox, onDone: () -> Unit, say: suspend (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var typed by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    fun submit(text: String) {
        if (busy || text.isBlank()) return
        busy = true
        scope.launch {
            try {
                inbox.importKey(text)
                say("Chave trocada")
                onDone()
            } catch (failure: DmCrypto.KeyImportException) {
                say(if (failure.otherAccount) "Essa chave é de outra conta" else "Chave inválida")
            } catch (_: Exception) {
                say("Chave inválida")
            } finally {
                busy = false
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Pill(
            "Ler QR",
            onClick = {
                val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
                GmsBarcodeScanning.getClient(context, options).startScan()
                    .addOnSuccessListener { code -> code.rawValue?.let { typed = it; submit(it) } }
                    .addOnFailureListener { scope.launch { say("Não deu para abrir a câmera") } }
            },
            modifier = Modifier.fillMaxWidth(),
            tone = PillTone.Soft,
            size = PillSize.Lg,
            icon = Icons.Rounded.QrCodeScanner,
        )
        Field(typed, { typed = it }, label = "Chave", placeholder = "juntos-key:…", mono = true, onSubmit = { submit(typed) })
        Pill(
            "Usar esta chave",
            onClick = { submit(typed) },
            modifier = Modifier.fillMaxWidth(),
            tone = PillTone.Brand,
            size = PillSize.Lg,
            enabled = typed.isNotBlank(),
            loading = busy,
        )
    }
}
