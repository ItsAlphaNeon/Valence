package app.valence.core

/**
 * `JSON.parse` / `JSON.stringify` with the desktop's exact semantics. org.json is not used for this:
 * it is lenient (unquoted keys, single quotes, control characters as whitespace), and the JVM and
 * Android copies disagree on duplicate keys, number types and whether `/` is escaped.
 *
 * Parsed values: [JsonNull], [Boolean], [Double], [String], [List], [Map] (insertion-ordered; a
 * duplicate key keeps the last value, like JS).
 */
internal object JsJson {
    class SyntaxError(msg: String) : Exception(msg)

    fun parse(text: String): Any {
        val p = Parser(text)
        p.ws()
        val v = p.value(0)
        p.ws()
        if (p.i != text.length) throw SyntaxError("Unexpected token at ${p.i}")
        return v
    }

    /** Like [parse], returning null instead of throwing. */
    fun parseOrNull(text: String): Any? = try {
        parse(text)
    } catch (_: SyntaxError) {
        null
    }

    private class Parser(val s: String) {
        var i = 0

        fun ws() {
            while (i < s.length) {
                val c = s[i]
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++ else break
            }
        }

        fun fail(): Nothing = throw SyntaxError("Unexpected token at $i")

        fun value(depth: Int): Any {
            if (depth > 1000) fail()
            if (i >= s.length) fail()
            return when (s[i]) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", JsonNull)
                else -> num()
            }
        }

        fun lit(word: String, v: Any): Any {
            if (!s.startsWith(word, i)) fail()
            i += word.length
            return v
        }

        fun obj(depth: Int): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++
            ws()
            if (i < s.length && s[i] == '}') {
                i++
                return m
            }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') fail()
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') fail()
                i++
                ws()
                m[k] = value(depth + 1)
                ws()
                if (i >= s.length) fail()
                when (s[i]) {
                    ',' -> i++
                    '}' -> {
                        i++
                        return m
                    }
                    else -> fail()
                }
            }
        }

        fun arr(depth: Int): List<Any?> {
            val a = ArrayList<Any?>()
            i++
            ws()
            if (i < s.length && s[i] == ']') {
                i++
                return a
            }
            while (true) {
                ws()
                a.add(value(depth + 1))
                ws()
                if (i >= s.length) fail()
                when (s[i]) {
                    ',' -> i++
                    ']' -> {
                        i++
                        return a
                    }
                    else -> fail()
                }
            }
        }

        fun str(): String {
            i++
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) fail()
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (i >= s.length) fail()
                        when (s[i++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail()
                                var v = 0
                                for (j in 0 until 4) {
                                    val d = Character.digit(s[i + j], 16)
                                    if (d < 0 || s[i + j].code > 127) fail()
                                    v = v * 16 + d
                                }
                                i += 4
                                sb.append(v.toChar())
                            }
                            else -> fail()
                        }
                    }
                    c.code < 0x20 -> fail()
                    else -> sb.append(c)
                }
            }
        }

        fun num(): Double {
            val start = i
            if (i < s.length && s[i] == '-') i++
            if (i >= s.length) fail()
            if (s[i] == '0') {
                i++
            } else if (s[i] in '1'..'9') {
                while (i < s.length && s[i] in '0'..'9') i++
            } else {
                fail()
            }
            if (i < s.length && s[i] == '.') {
                i++
                if (i >= s.length || s[i] !in '0'..'9') fail()
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i >= s.length || s[i] !in '0'..'9') fail()
                while (i < s.length && s[i] in '0'..'9') i++
            }
            return s.substring(start, i).toDouble()
        }
    }

    // --- stringify ----------------------------------------------------------------------------

    /** `JSON.stringify(string)` (well-formed: lone surrogates escaped, `/` and U+2028 left alone). */
    fun quote(s: String, out: StringBuilder = StringBuilder()): StringBuilder {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c.code < 0x20 -> out.append("\\u").append(hex4(c.code))
                c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                    out.append(c).append(s[i + 1])
                    i++
                }
                c.isSurrogate() -> out.append("\\u").append(hex4(c.code))
                else -> out.append(c)
            }
            i++
        }
        return out.append('"')
    }

    private fun hex4(v: Int): String = Integer.toHexString(v).padStart(4, '0')

    /**
     * `JSON.stringify(value, null, indent)` for Kotlin values: Map (insertion order), List, String,
     * Boolean, Int/Long (integers), Double (JS number formatting; non-finite -> null), null -> null.
     * Map entries whose value is [Undefined] are skipped, like JS `undefined` properties.
     */
    fun stringify(v: Any?, indent: Int = 0): String {
        val sb = StringBuilder()
        write(sb, v, if (indent > 0) " ".repeat(minOf(indent, 10)) else "", "")
        return sb.toString()
    }

    /** Marker for a property JSON.stringify drops. */
    object Undefined

    private fun write(sb: StringBuilder, v: Any?, gap: String, cur: String) {
        when (v) {
            null, JsonNull -> sb.append("null")
            is String -> quote(v, sb)
            is Boolean -> sb.append(v)
            is Int, is Long, is Short, is Byte -> sb.append(v.toString())
            is Number -> {
                val d = v.toDouble()
                sb.append(if (d.isNaN() || d.isInfinite()) "null" else Js.numberToString(d))
            }
            is Map<*, *> -> {
                val entries = v.entries.filter { it.value != Undefined }
                if (entries.isEmpty()) {
                    sb.append("{}")
                    return
                }
                val inner = cur + gap
                sb.append('{')
                entries.forEachIndexed { idx, e ->
                    if (idx > 0) sb.append(',')
                    if (gap.isNotEmpty()) sb.append('\n').append(inner)
                    quote(e.key.toString(), sb)
                    sb.append(':')
                    if (gap.isNotEmpty()) sb.append(' ')
                    write(sb, e.value, gap, inner)
                }
                if (gap.isNotEmpty()) sb.append('\n').append(cur)
                sb.append('}')
            }
            is List<*> -> {
                if (v.isEmpty()) {
                    sb.append("[]")
                    return
                }
                val inner = cur + gap
                sb.append('[')
                v.forEachIndexed { idx, e ->
                    if (idx > 0) sb.append(',')
                    if (gap.isNotEmpty()) sb.append('\n').append(inner)
                    write(sb, if (e == Undefined) null else e, gap, inner)
                }
                if (gap.isNotEmpty()) sb.append('\n').append(cur)
                sb.append(']')
            }
            else -> quote(v.toString(), sb)
        }
    }
}
