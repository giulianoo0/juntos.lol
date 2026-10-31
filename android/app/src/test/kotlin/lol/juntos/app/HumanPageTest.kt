package lol.juntos.app

import lol.juntos.app.human.turnstilePage
import lol.juntos.app.human.withAppSuffix
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HumanPageTest {
    @Test
    fun `the web view's user agent ends with the app's name and version`() {
        assertEquals("Mozilla/5.0 Chrome/130 JuntosApp/0.1.0", withAppSuffix("Mozilla/5.0 Chrome/130", "0.1.0"))
    }

    @Test
    fun `the suffix is not added twice`() {
        assertEquals("UA JuntosApp/0.1.0", withAppSuffix("UA JuntosApp/0.1.0", "0.1.0"))
    }

    @Test
    fun `the page renders the widget with the server's site key and hands the token to the app`() {
        val page = turnstilePage("0x4AAA-key", dark = true)
        assertTrue(page.contains("challenges.cloudflare.com/turnstile/v0/api.js"))
        assertTrue(page.contains("\"0x4AAA-key\""))
        assertTrue(page.contains("JuntosHuman.token("))
        assertTrue(page.contains("theme: 'dark'"))
    }

    @Test
    fun `the widget asks for the action the server checks, which refuses tokens without it`() {
        assertTrue(turnstilePage("0x4AAA-key", dark = false).contains("action: 'human'"))
    }
}
