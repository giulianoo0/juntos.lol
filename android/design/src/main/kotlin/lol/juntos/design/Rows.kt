package lol.juntos.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** A row of a popover menu or a sheet's list: the mark, the label, a check when picked. */
@Composable
fun SpringRow(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    danger: Boolean = false,
    checked: Boolean? = null,
) {
    val c = Juntos.colors
    val ink = if (danger) c.dangerInk else c.text
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = JuntosSpacing.touchTarget)
            .clip(RoundedCornerShape(JuntosRadii.xl))
            .background(if (checked == true) c.hover else c.hover.copy(alpha = 0f))
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { if (checked != null) selected = checked }
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) {
            Box(
                Modifier.size(32.dp).clip(RoundedCornerShape(JuntosRadii.lg)).background(if (danger) c.dangerSoft else c.hover),
                contentAlignment = Alignment.Center,
            ) { Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(16.dp)) }
        }
        Text(label, color = ink, fontSize = JuntosTextSize.sm, fontWeight = FontWeight.Medium, maxLines = 1, modifier = Modifier.weight(1f))
        if (checked == true) Icon(JuntosIcons.Check, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(16.dp))
    }
}
