package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JsJsonTest {
    private val g = Golden.load("json.json")

    @Test
    fun numbersFormatLikeJs() {
        for (c in g.list("numbers")) {
            val n = c.num("n")!!
            assertEquals("String($n)", c.str("s"), Js.numberToString(n).let { if (it == "-0") "0" else it })
            assertEquals("JSON.stringify($n)", c.str("json"), JsJson.stringify(n))
        }
    }

    @Test
    fun nestedStringifyWithIndent() {
        val v = linkedMapOf<String, Any?>(
            "a" to emptyList<Any>(), "b" to emptyMap<String, Any>(), "c" to listOf(1, listOf(2, mapOf("d" to "e"))),
            "f" to null, "g" to true, "h" to 1.5, "i" to -0.0, "j" to 1e21, "k" to 123456789012L,
        )
        assertEquals(g.str("nested"), JsJson.stringify(v, 1))
    }

    @Test
    fun parseIsStrictLikeJsonParse() {
        for (bad in listOf("{a:1}", "{'a':1}", "[1,]", "{\"a\":1,}", "\u0001{}", "\uFEFF{}", "\u00A0{}", "01", "1.", ".5", "+1", "0x10", "NaN", "\"a\u0001\"", "[1] x", "", "{\"a\" 1}", "\"\\x\"", "tru")) {
            assertNull(esc(bad), JsJson.parseOrNull(bad))
        }
        assertEquals(mapOf("a" to 2.0, "b" to JsonNull), JsJson.parse(" {\"a\":1,\"b\":null,\"a\":2}\r\n"))
        assertEquals(listOf(-0.0, 1500.0, "\u2028/\uD800"), JsJson.parse("[-0,1.5e3,\"\u2028\\/\\ud800\"]"))
    }

    @Test
    fun jsNumberAndTruthiness() {
        assertEquals(16.0, Js.toNumber(" 0x10 "), 0.0)
        assertEquals(0.0, Js.toNumber(""), 0.0)
        assertEquals(7.0, Js.toNumber(listOf(7.0)), 0.0)
        assertEquals(Double.NaN, Js.toNumber(listOf(1.0, 2.0)), 0.0)
        assertEquals(Double.POSITIVE_INFINITY, Js.toNumber("Infinity"), 0.0)
        assertEquals(Double.NaN, Js.toNumber("12abc"), 0.0)
        assertEquals(-2.0, Js.round(-2.5), 0.0)
        assertEquals(3.0, Js.round(2.5), 0.0)
        assertEquals(0.0, Js.round(0.49999999999999994), 0.0)
        assertEquals(true, Js.truthy("0"))
        assertEquals(false, Js.truthy(0.0))
        assertEquals(true, Js.truthy(emptyList<Any>()))
    }
}
